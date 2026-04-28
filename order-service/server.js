const amqp = require("amqplib");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const log = (level, message, extra = {}) => {
  console.log(JSON.stringify({
    level,
    service: "order-service",
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
};

const metrics = {
  requestCount: 0,
  totalLatencyMs: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const circuitBreakers = new Map();
const getServiceKey = (url) => new URL(url).host;
const shouldRetryRequest = (error) => {
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return true;
  if (!error.response) return true;
  return error.response.status >= 500;
};
const getCircuit = (serviceKey) => {
  if (!circuitBreakers.has(serviceKey)) {
    circuitBreakers.set(serviceKey, { state: "CLOSED", failures: 0, openedAt: 0 });
  }
  return circuitBreakers.get(serviceKey);
};
const requestWithRetry = async (config, options = {}) => {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 250;
  const failureThreshold = options.failureThreshold ?? 3;
  const resetTimeoutMs = options.resetTimeoutMs ?? 10000;
  const serviceKey = options.serviceKey || getServiceKey(config.url);
  const circuit = getCircuit(serviceKey);
  let lastError;

  if (circuit.state === "OPEN") {
    if (Date.now() - circuit.openedAt < resetTimeoutMs) {
      const error = new Error(`Circuit breaker is open for ${serviceKey}`);
      error.code = "CIRCUIT_OPEN";
      throw error;
    }
    circuit.state = "HALF_OPEN";
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await axios(config);
      circuit.state = "CLOSED";
      circuit.failures = 0;
      circuit.openedAt = 0;
      return response;
    } catch (error) {
      lastError = error;
      if (!shouldRetryRequest(error)) {
        throw error;
      }

      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }

  circuit.failures += 1;
  if (circuit.failures >= failureThreshold || circuit.state === "HALF_OPEN") {
    circuit.state = "OPEN";
    circuit.openedAt = Date.now();
  }
  throw lastError;
};

let rabbitChannel;
const ORDER_EVENTS_EXCHANGE = "order_events";
const STOCK_EVENTS_EXCHANGE = "stock_events";
const STOCK_RESERVED_QUEUE = "order_stock_reserved_queue";
const STOCK_FAILED_QUEUE = "order_stock_failed_queue";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const JWT_SECRET_CURRENT = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS;

app.use((req, res, next) => {
  const startedAt = Date.now();
  req.requestId = req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader("x-request-id", req.requestId);

  res.on("finish", () => {
    const latencyMs = Date.now() - startedAt;
    metrics.requestCount += 1;
    metrics.totalLatencyMs += latencyMs;
    log("info", "request_completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      latencyMs,
    });
  });

  next();
});

const requireAdmin = (req, res, next) => {
  if (!INTERNAL_SERVICE_TOKEN) {
    return res.status(500).json({ message: "Thiếu cấu hình INTERNAL_SERVICE_TOKEN!" });
  }

  if (req.headers["x-internal-token"] !== INTERNAL_SERVICE_TOKEN) {
    return res.status(403).json({ message: "Bạn không có quyền truy cập tài nguyên này!" });
  }

  next();
};

const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();
    connection.on("error", (err) => {
      console.error("❌ RabbitMQ connection error:", err.message);
    });
    connection.on("close", async () => {
      console.warn("⚠️ RabbitMQ disconnected, retrying in 3s...");
      rabbitChannel = undefined;
      await sleep(3000);
      connectRabbitMQ();
    });
    await rabbitChannel.assertExchange(ORDER_EVENTS_EXCHANGE, "topic", { durable: true });
    await rabbitChannel.assertExchange(STOCK_EVENTS_EXCHANGE, "topic", { durable: true });
    await rabbitChannel.assertExchange("clear_cart_dlx", "direct", { durable: true });
    await rabbitChannel.assertQueue("clear_cart_dlq", { durable: true });
    await rabbitChannel.bindQueue("clear_cart_dlq", "clear_cart_dlx", "clear_cart_failed");

    // Main queue forwards unrecoverable cart-clear failures to the DLQ.
    await rabbitChannel.assertQueue("clear_cart_queue_v2", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "clear_cart_dlx" },
    });

    await rabbitChannel.assertQueue(STOCK_RESERVED_QUEUE, { durable: true });
    await rabbitChannel.bindQueue(STOCK_RESERVED_QUEUE, STOCK_EVENTS_EXCHANGE, "stock.reserved");
    await rabbitChannel.assertQueue(STOCK_FAILED_QUEUE, { durable: true });
    await rabbitChannel.bindQueue(STOCK_FAILED_QUEUE, STOCK_EVENTS_EXCHANGE, "stock.failed");

    await consumeStockEvents();
    console.log("🐇 Đã kết nối Bưu điện RabbitMQ thành công!");
  } catch (error) {
    console.error("❌ Lỗi kết nối RabbitMQ:", error.message);
  }
};
connectRabbitMQ();

const publishOrderCreated = (orderId, items) => {
  if (!rabbitChannel) return false;
  const payload = { orderId, items };
  return rabbitChannel.publish(
    ORDER_EVENTS_EXCHANGE,
    "order.created",
    Buffer.from(JSON.stringify(payload)),
    { persistent: true, contentType: "application/json" },
  );
};

const publishCartClearRequested = (userId, orderId) => {
  if (!rabbitChannel) return false;
  const message = JSON.stringify({ userId, orderId });
  return rabbitChannel.sendToQueue("clear_cart_queue_v2", Buffer.from(message), { persistent: true });
};

const consumeStockEvents = async () => {
  rabbitChannel.consume(STOCK_RESERVED_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const { orderId } = JSON.parse(msg.content.toString());
      const updated = await pool.query(
        "UPDATE orders SET status = $1 WHERE id = $2 AND status = $3 RETURNING user_id",
        ["CONFIRMED", orderId, "PENDING"],
      );
      if (updated.rows.length > 0) {
        publishCartClearRequested(updated.rows[0].user_id, orderId);
        log("info", "stock_reserved_order_confirmed", { orderId });
      }
      rabbitChannel.ack(msg);
    } catch (err) {
      log("error", "stock_reserved_consume_failed", { error: err.message });
      rabbitChannel.nack(msg, false, true);
    }
  });

  rabbitChannel.consume(STOCK_FAILED_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const { orderId, reason } = JSON.parse(msg.content.toString());
      await pool.query(
        "UPDATE orders SET status = $1 WHERE id = $2 AND status = $3",
        ["CANCELLED", orderId, "PENDING"],
      );
      log("warn", "stock_failed_order_cancelled", { orderId, reason });
      rabbitChannel.ack(msg);
    } catch (err) {
      log("error", "stock_failed_consume_failed", { error: err.message });
      rabbitChannel.nack(msg, false, true);
    }
  });
};

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const rabbitReady = Boolean(rabbitChannel);
    return res.status(rabbitReady ? 200 : 503).json({
      service: "order-service",
      status: rabbitReady ? "ok" : "degraded",
      checks: {
        postgres: "up",
        rabbitmq: rabbitReady ? "up" : "down",
      },
    });
  } catch (err) {
    return res.status(503).json({
      service: "order-service",
      status: "down",
      checks: {
        postgres: "down",
        rabbitmq: rabbitChannel ? "up" : "down",
      },
      error: err.message,
    });
  }
});

app.get("/metrics", (req, res) => {
  const avgLatency = metrics.requestCount === 0 ? 0 : Number((metrics.totalLatencyMs / metrics.requestCount).toFixed(2));
  res.status(200).json({
    service: "order-service",
    requestCount: metrics.requestCount,
    avgLatencyMs: avgLatency,
  });
});

// Middleware Bảo Vệ
const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(403).json({ message: "Từ chối truy cập!" });
  try {
    try {
      req.user = jwt.verify(token, JWT_SECRET_CURRENT);
    } catch (primaryError) {
      if (!JWT_SECRET_PREVIOUS) {
        throw primaryError;
      }
      req.user = jwt.verify(token, JWT_SECRET_PREVIOUS);
    }
    req.tokenString = token; // Lưu lại chuỗi token để lát nữa Order Service dùng đi gọi cửa Service khác
    next();
  } catch (err) {
    res.status(401).json({ message: "Token không hợp lệ!" });
  }
};

// API: THỰC HIỆN THANH TOÁN (CHECKOUT)
app.post("/checkout", verifyToken, async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;
  const replayByKey = async (userId, key) => {
    const replay = await pool.query(
      "SELECT id, total_amount, status FROM orders WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
      [userId, key],
    );
    if (replay.rows.length === 0) {
      return null;
    }
    return {
      message: "Yêu cầu checkout đã được xử lý trước đó.",
      orderId: replay.rows[0].id,
      totalPaid: replay.rows[0].total_amount,
      status: replay.rows[0].status,
      idempotentReplay: true,
    };
  };

  try {
    const userId = req.user.id;
    const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();

    if (!idempotencyKey || idempotencyKey.length < 8) {
      client.release();
      return res.status(400).json({ message: "Thiếu hoặc sai định dạng x-idempotency-key." });
    }

    const existingPayload = await replayByKey(userId, idempotencyKey);
    if (existingPayload) {
      client.release();
      return res.status(200).json(existingPayload);
    }

    const config = {
      headers: {
        Authorization: `Bearer ${req.tokenString}`,
        "x-request-id": req.requestId,
      },
    };

    // 1. NHẤC MÁY GỌI USER SERVICE: "Lấy cho tôi giỏ hàng của sếp lớn!"
    const cartResponse = await requestWithRetry({
      method: "get",
      url: "http://user-service:3001/cart",
      ...config,
      timeout: 5000,
    });
    const cartItems = cartResponse.data.data;
    const grandTotal = cartResponse.data.grandTotal;

    if (!cartItems || cartItems.length === 0) {
      client.release();
      return res.status(400).json({ message: "Giỏ hàng của bạn đang trống!" });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    // 2. LƯU VÀO DATABASE ĐƠN HÀNG
    // 2a. Tạo vỏ đơn hàng
    const newOrder = await client.query(
      "INSERT INTO orders (user_id, idempotency_key, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, idempotencyKey, grandTotal, "PENDING"],
    );
    const orderId = newOrder.rows[0].id;

    // 2b. Đổ từng món trong giỏ vào bảng chi tiết đơn hàng
    for (let item of cartItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, color, size, quantity, total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          item.product_id,
          item.product_name,
          item.price,
          item.color,
          item.size,
          item.quantity,
          item.total,
        ],
      );
    }

    await client.query("COMMIT");
    client.release();

    const reserveItems = cartItems.map((item) => ({
      productId: item.product_id,
      quantity: Number(item.quantity),
      color: item.color,
      size: item.size,
    }));

    if (!rabbitChannel) {
      return res.status(202).json({
        message: "Đơn hàng đã được tạo PENDING, nhưng RabbitMQ chưa sẵn sàng để giữ kho.",
        orderId: orderId,
        totalPaid: grandTotal,
        status: "PENDING",
      });
    }

    publishOrderCreated(orderId, reserveItems);
    log("info", "order_created_event_published", { orderId, items: reserveItems.length });
    res.status(202).json({
      message: "Đơn hàng đã được tạo PENDING, hệ thống đang giữ kho.",
      orderId: orderId,
      totalPaid: grandTotal,
      status: "PENDING",
    });
  } catch (err) {
    if (err.code === "23505") {
      const replayPayload = await pool.query(
        "SELECT id, total_amount, status FROM orders WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
        [req.user.id, String(req.headers["x-idempotency-key"] || "").trim()],
      );
      client.release();
      if (replayPayload.rows.length > 0) {
        return res.status(200).json({
          message: "Yêu cầu checkout đã được xử lý trước đó.",
          orderId: replayPayload.rows[0].id,
          totalPaid: replayPayload.rows[0].total_amount,
          status: replayPayload.rows[0].status,
          idempotentReplay: true,
        });
      }
    }

    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    client.release();
    console.error("Lỗi quá trình thanh toán:", err.message);
    res.status(500).json({ message: "Lỗi khi xử lý đơn hàng!" });
  }
});

app.patch("/:orderId/status", requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const { status } = req.body;
    const allowedStatuses = ["PENDING", "CONFIRMED", "PAID", "CANCELLED", "Delivered"];

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "orderId không hợp lệ!" });
    }

    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Trạng thái đơn hàng không hợp lệ!" });
    }

    const result = await pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
      [status, orderId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng để cập nhật!" });
    }

    res.status(200).json({
      message: "Cập nhật trạng thái đơn hàng thành công!",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Lỗi API Update Order Status:", err.message);
    res.status(500).json({ message: "Lỗi khi cập nhật trạng thái đơn hàng!" });
  }
});
// ---------------------------------------------------------
// API: XEM LỊCH SỬ MUA HÀNG (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.get("/history", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id; // Lấy ID khách hàng từ Token

    // 1. Tìm tất cả các "Vỏ đơn hàng" của khách này (Sắp xếp mới nhất lên đầu)
    const ordersResult = await pool.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    const orders = ordersResult.rows;

    // Nếu chưa mua gì thì báo về luôn
    if (orders.length === 0) {
      return res.status(200).json({
        message: "Bạn chưa có đơn hàng nào!",
        data: [],
      });
    }

    // 2. Với mỗi đơn hàng, lấy chi tiết các món đồ bên trong
    for (let order of orders) {
      const itemsResult = await pool.query(
        "SELECT * FROM order_items WHERE order_id = $1",
        [order.id],
      );
      // Gắn mảng chi tiết vào trong object của đơn hàng đó
      order.items = itemsResult.rows;
    }

    res.status(200).json({
      message: "Lấy lịch sử mua hàng thành công!",
      totalOrders: orders.length,
      data: orders,
    });
  } catch (err) {
    console.error("Lỗi API Lịch sử đơn hàng:", err.message);
    res.status(500).json({ message: "Lỗi khi lấy dữ liệu đơn hàng!" });
  }
});

app.get("/:orderId", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "orderId không hợp lệ!" });
    }

    const orderResult = await pool.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [orderId, userId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng!" });
    }

    const itemsResult = await pool.query(
      "SELECT * FROM order_items WHERE order_id = $1",
      [orderId],
    );

    res.status(200).json({
      message: "Lấy chi tiết đơn hàng thành công!",
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (err) {
    console.error("Lỗi API Chi tiết đơn hàng:", err.message);
    res.status(500).json({ message: "Lỗi khi lấy chi tiết đơn hàng!" });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`🚀 Order Service đang chạy tại http://localhost:${PORT}`);
});
