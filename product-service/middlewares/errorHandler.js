const { AppError } = require('./AppError');

const normalizeDetails = (details) => {
  if (!details) return [];
  return Array.isArray(details) ? details : [details];
};

const extractDetails = (err) => err.details
  || err.errors
  || err.response?.data?.error?.details
  || err.response?.data?.errors;

const resolveMessage = (err, statusCode) => {
  if (err instanceof AppError || err.isOperational || statusCode < 500) {
    return err.response?.data?.error?.message
      || err.response?.data?.message
      || err.message
      || 'Request failed.';
  }

  return 'Internal server error.';
};

const createErrorHandler = (logger) => (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || err.response?.status || 500;
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  const requestId = req.requestId || req.headers['x-request-id'] || res.getHeader('x-request-id') || 'unknown';
  const details = normalizeDetails(extractDetails(err));

  const activeLogger = logger || req.app?.locals?.logger;
  if (activeLogger) {
    activeLogger.error('request_error', {
      requestId,
      statusCode: safeStatusCode,
      message: err.message,
      error: err,
    });
  }

  return res.status(safeStatusCode).json({
    success: false,
    error: {
      code: safeStatusCode,
      message: resolveMessage(err, safeStatusCode),
      requestId,
      details,
      timestamp: new Date().toISOString(),
    },
  });
};

const errorHandler = createErrorHandler();

module.exports = { createErrorHandler, errorHandler };
