const amqp = require("amqplib");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { pool, initDB } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestWithRetry = async (config, options = {}) => {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 250;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await axios(config);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw lastError;
};

initDB();
let rabbitChannel;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const requireAdmin = (req, res, next) => {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ message: "Thiếu cấu hình ADMIN_SECRET!" });
  }

  if (req.headers["x-admin-secret"] !== ADMIN_SECRET) {
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
    // Đảm bảo hòm thư tên là 'clear_cart_queue' luôn tồn tại
    await rabbitChannel.assertQueue("clear_cart_queue", { durable: true });
    console.log("🐇 Đã kết nối Bưu điện RabbitMQ thành công!");
  } catch (error) {
    console.error("❌ Lỗi kết nối RabbitMQ:", error.message);
  }
};
connectRabbitMQ();

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

// Middleware Bảo Vệ
const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(403).json({ message: "Từ chối truy cập!" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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

  try {
    const userId = req.user.id;
    const config = { headers: { Authorization: `Bearer ${req.tokenString}` } };

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
      "INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, $3) RETURNING id",
      [userId, grandTotal, "Pending"],
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

    await client.query(
      "UPDATE orders SET status = $1 WHERE id = $2",
      [rabbitChannel ? "QueuedForCartClear" : "AwaitingCartClear", orderId],
    );

    await client.query("COMMIT");
    client.release();

    // 3. GỬI THƯ BÁO XÓA GIỎ HÀNG QUA RABBITMQ (BẤT ĐỒNG BỘ)
    if (!rabbitChannel) {
      return res.status(202).json({
        message: "Đơn hàng đã được tạo, nhưng hàng đợi dọn giỏ chưa sẵn sàng.",
        orderId: orderId,
        totalPaid: grandTotal,
        status: "AwaitingCartClear",
      });
    }

    const message = JSON.stringify({ userId: userId, orderId: orderId });
    rabbitChannel.sendToQueue("clear_cart_queue", Buffer.from(message), {
      persistent: true,
    });
    console.log(`✉️ Đã gửi thư xóa giỏ hàng (Persistent) cho User: ${userId}`);
    res.status(200).json({
      message: "🎉 Chốt đơn thành công! (Dữ liệu đang được xử lý ngầm)",
      orderId: orderId,
      totalPaid: grandTotal,
      status: "QueuedForCartClear",
    });
  } catch (err) {
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
    const allowedStatuses = ["Pending", "QueuedForCartClear", "AwaitingCartClear", "Paid", "Cancelled", "Delivered"];

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
