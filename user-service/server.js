const amqp = require("amqplib");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { pool } = require("./db");
const userRoutes = require("./routes/userRoutes");
const { sleep } = require("./utils/httpClient");
const { register, httpRequestDurationSeconds, httpRequestsTotal } = require("./metrics");
const openApiSpec = require("./openapi.json");

const app = express();

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://localhost:5173", "http://api-gateway:3000"];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "10kb" }));

const log = (level, message, extra = {}) => {
  console.log(JSON.stringify({
    level,
    service: "user-service",
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
};

const CLEAR_CART_MAX_RETRIES = 3;
let rabbitConnection;
let rabbitChannel;
let isShuttingDown = false;

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  req.requestId = req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader("x-request-id", req.requestId);

  res.on("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const latencyMs = Math.round(durationSeconds * 1000);
    const route = req.route?.path || req.baseUrl || req.path || "unknown";
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDurationSeconds.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
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

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/swagger.json", (req, res) => {
  res.json(openApiSpec);
});
// ---------------------------------------------------------
// LÍNH GÁC RABBITMQ (Lắng nghe tin nhắn xóa giỏ hàng)
// ---------------------------------------------------------
const consumeRabbitMQ = async () => {
  try {
    rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL);
    rabbitChannel = await rabbitConnection.createChannel();
    rabbitConnection.on("error", (err) => {
      console.error("❌ RabbitMQ connection error:", err.message);
    });
    rabbitConnection.on("close", async () => {
      rabbitConnection = null;
      rabbitChannel = null;
      if (isShuttingDown) return;
      console.warn("⚠️ RabbitMQ disconnected, retrying in 3s...");
      await sleep(3000);
      consumeRabbitMQ();
    });
    
    await rabbitChannel.assertExchange("clear_cart_dlx", "direct", { durable: true });
    await rabbitChannel.assertQueue("clear_cart_dlq", { durable: true });
    await rabbitChannel.bindQueue("clear_cart_dlq", "clear_cart_dlx", "clear_cart_failed");

    await rabbitChannel.assertQueue("clear_cart_queue_v2", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "clear_cart_dlx" },
    });

    // 2. Chỉ nhận 1 tin nhắn mỗi lần
    rabbitChannel.prefetch(1);

    console.log("📨 Đang chờ thư từ Bưu điện RabbitMQ...");

    rabbitChannel.consume(
      "clear_cart_queue_v2",
      async (msg) => {
        if (msg !== null) {
          try {
            const data = JSON.parse(msg.content.toString());
            console.log(`📦 Đang xử lý xóa giỏ hàng cho User ID: ${data.userId}`);

            // THỰC THI LOGIC XỬ LÝ (Đã bỏ dấu //)
            // Đảm bảo biến 'pool' đã được khai báo ở đầu file nhé!
            await pool.query('DELETE FROM cart_items WHERE user_id = $1', [data.userId]);

            // XÁC NHẬN THÀNH CÔNG: Xóa tin khỏi RabbitMQ
            rabbitChannel.ack(msg);
            console.log("✅ Đã dọn sạch giỏ hàng và gửi xác nhận (Ack)!");
            
          } catch (error) {
            const retryCount = Number(msg.properties.headers?.["x-retry-count"] || 0);

            if (retryCount >= CLEAR_CART_MAX_RETRIES) {
              console.log(JSON.stringify({
                level: "error",
                service: "user-service",
                message: "clear_cart_message_dead_lettered",
                timestamp: new Date().toISOString(),
                retryCount,
                error: error.message,
              }));
              rabbitChannel.nack(msg, false, false);
              return;
            }

            rabbitChannel.sendToQueue("clear_cart_queue_v2", msg.content, {
              persistent: true,
              headers: { ...(msg.properties.headers || {}), "x-retry-count": retryCount + 1 },
            });
            rabbitChannel.ack(msg);
          }
        }
      },
      { noAck: false }
    );
  } catch (error) {
    console.error("❌ Lỗi kết nối RabbitMQ:", error.message);
  }
};

consumeRabbitMQ();
app.use("/", userRoutes);

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🚀 User Service đang chạy tại http://localhost:${PORT}`);
});

const closeServer = () => new Promise((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("info", "graceful_shutdown_started", { signal });

  const shutdownTimeout = setTimeout(() => {
    log("error", "graceful_shutdown_timeout", { timeoutMs: 10000 });
    process.exit(1);
  }, 10000);

  try {
    await closeServer();
    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConnection) await rabbitConnection.close();
    await pool.end();
    clearTimeout(shutdownTimeout);
    log("info", "graceful_shutdown_completed", { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    log("error", "graceful_shutdown_failed", { signal, error: error.message });
    process.exit(1);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
