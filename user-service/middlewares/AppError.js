class AppError extends Error {
  constructor(message, statusCode = 500, details = [], options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = options.code || statusCode;
    this.details = Array.isArray(details) ? details : [details];
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
