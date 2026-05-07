const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { pool } = require("./db");
const logger = require("./utils/logger");
const { createMessageBroker } = require("./utils/messageBroker");
const { createPaymentTransactionModel } = require("./models/PaymentTransaction");
const { createPaymentService } = require("./services/paymentService");
const { createPaymentController } = require("./controllers/paymentController");
const { createPaymentRoutes } = require("./routes/paymentRoutes");

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

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  req.requestId = req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader("x-request-id", req.requestId);

  res.on("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    logger.info("request_completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      latencyMs: Math.round(durationSeconds * 1000),
    });
  });

  next();
});

const messageBroker = createMessageBroker({ rabbitmqUrl: process.env.RABBITMQ_URL, logger });
const paymentTransactionModel = createPaymentTransactionModel({ pool });
const paymentService = createPaymentService({ paymentTransactionModel, logger });
const paymentController = createPaymentController({ paymentService, logger });

app.use("/", createPaymentRoutes({ paymentController }));

app.use((err, req, res, next) => {
  logger.error("unhandled_request_error", { error: err, requestId: req.requestId });
  return res.status(500).json({ message: "Internal server error." });
});

messageBroker.connect();

const PORT = process.env.PORT || 3004;
const server = app.listen(PORT, () => {
  logger.info("payment_service_started", { port: PORT, url: `http://localhost:${PORT}` });
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