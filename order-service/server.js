const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
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
const logger = require("./utils/logger");
const { createErrorHandler } = require("./middlewares/errorHandler");

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

const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const JWT_SECRET_CURRENT = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS;

const messageBroker = createMessageBroker({ rabbitmqUrl: process.env.RABBITMQ_URL, logger });
const orderModel = createOrderModel({ pool });
const orderService = createOrderService({
  pool,
  orderModel,
  getRabbitReady: messageBroker.getRabbitReady,
  publishOrderCreated: messageBroker.publishOrderCreated,
  publishCartClearRequested: messageBroker.publishCartClearRequested,
  logger,
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
    logger.info("request_completed", {
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
  logger,
});

app.use("/", createOrderRoutes({ orderController, requireAdmin, verifyToken }));
app.use(createErrorHandler(logger));

messageBroker.connect();

const PORT = process.env.PORT || 3003;
const server = app.listen(PORT, () => {
  logger.info("order_service_started", { port: PORT, url: `http://localhost:${PORT}` });
});

const closeServer = () => new Promise((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("graceful_shutdown_started", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.error("graceful_shutdown_timeout", { timeoutMs: 10000 });
    process.exit(1);
  }, 10000);

  try {
    await closeServer();
    await messageBroker.close();
    await pool.end();
    clearTimeout(shutdownTimeout);
    logger.info("graceful_shutdown_completed", { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error("graceful_shutdown_failed", { signal, error });
    process.exit(1);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));