const { AppError } = require("./AppError");

const createAdminMiddleware = ({ internalServiceToken }) => (req, res, next) => {
  if (!internalServiceToken) {
    return next(new AppError("Thiếu cấu hình INTERNAL_SERVICE_TOKEN!", 500));
  }

  if (req.headers["x-internal-token"] !== internalServiceToken) {
    return next(new AppError("Bạn không có quyền truy cập tài nguyên này!", 403));
  }

  next();
};

module.exports = { createAdminMiddleware };