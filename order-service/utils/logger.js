const winston = require("winston");

const normalizeError = winston.format((info) => {
  if (info instanceof Error) {
    return {
      ...info,
      message: info.message,
      name: info.name,
      stack: info.stack,
    };
  }

  if (info.error instanceof Error) {
    info.error = {
      message: info.error.message,
      name: info.error.name,
      stack: info.error.stack,
    };
  }

  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { service: "order-service" },
  format: winston.format.combine(
    normalizeError(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;