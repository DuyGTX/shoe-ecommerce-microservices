const amqp = require("amqplib");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool } = require("./db");
const userRoutes = require("./routes/userRoutes");
const { sleep } = require("./utils/httpClient");
const { register, httpRequestDurationSeconds, httpRequestsTotal } = require("./metrics");
const openApiSpec = require("./openapi.json");

const app = express();
app.use(cors());
app.use(express.json());

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
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();
    connection.on("error", (err) => {
      console.error("❌ RabbitMQ connection error:", err.message);
    });
    connection.on("close", async () => {
      console.warn("⚠️ RabbitMQ disconnected, retrying in 3s...");
      await sleep(3000);
      consumeRabbitMQ();
    });
    
    await channel.assertExchange("clear_cart_dlx", "direct", { durable: true });
    await channel.assertQueue("clear_cart_dlq", { durable: true });
    await channel.bindQueue("clear_cart_dlq", "clear_cart_dlx", "clear_cart_failed");

    await channel.assertQueue("clear_cart_queue_v2", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "clear_cart_dlx" },
    });

    // 2. Chỉ nhận 1 tin nhắn mỗi lần
    channel.prefetch(1);

    console.log("📨 Đang chờ thư từ Bưu điện RabbitMQ...");

    channel.consume(
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
            channel.ack(msg);
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
              channel.nack(msg, false, false);
              return;
            }

            channel.sendToQueue("clear_cart_queue_v2", msg.content, {
              persistent: true,
              headers: { ...(msg.properties.headers || {}), "x-retry-count": retryCount + 1 },
            });
            channel.ack(msg);
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
app.listen(PORT, () => {
  console.log(`🚀 User Service đang chạy tại http://localhost:${PORT}`);
});
