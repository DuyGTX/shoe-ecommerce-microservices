const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool } = require("./db");
const { register, httpRequestDurationSeconds, httpRequestsTotal } = require("./metrics");
const openApiSpec = require("./openapi.json");
const { createOrderModel } = require("./models/Order");
const { createOrderService } = require("./services/orderService");
const { createMessageBroker } = require("./services/messageBroker");
const { createOrderController } = require("./controllers/orderController");
const { createOrderRoutes } = require("./routes/orderRoutes");
const { createAdminMiddleware } = require("./middlewares/adminMiddleware");
const { createAuthMiddleware } = require("./middlewares/authMiddleware");

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

const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const JWT_SECRET_CURRENT = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS;

const messageBroker = createMessageBroker({ rabbitmqUrl: process.env.RABBITMQ_URL, log });
const orderModel = createOrderModel({ pool });
const orderService = createOrderService({
  pool,
  orderModel,
  getRabbitReady: messageBroker.getRabbitReady,
  publishOrderCreated: messageBroker.publishOrderCreated,
  publishCartClearRequested: messageBroker.publishCartClearRequested,
  log,
});
messageBroker.setOrderService(orderService);

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

const requireAdmin = createAdminMiddleware({ internalServiceToken: INTERNAL_SERVICE_TOKEN });
const verifyToken = createAuthMiddleware({ jwtSecretCurrent: JWT_SECRET_CURRENT, jwtSecretPrevious: JWT_SECRET_PREVIOUS });
const orderController = createOrderController({
  orderService,
  getRabbitReady: messageBroker.getRabbitReady,
  log,
});

app.use("/", createOrderRoutes({ orderController, requireAdmin, verifyToken }));

messageBroker.connect();

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`🚀 Order Service đang chạy tại http://localhost:${PORT}`);
});