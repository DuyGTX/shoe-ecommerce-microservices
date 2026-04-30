const createAdminMiddleware = ({ internalServiceToken }) => (req, res, next) => {
  if (!internalServiceToken) {
    return res.status(500).json({ message: "Thiếu cấu hình INTERNAL_SERVICE_TOKEN!" });
  }

  if (req.headers["x-internal-token"] !== internalServiceToken) {
    return res.status(403).json({ message: "Bạn không có quyền truy cập tài nguyên này!" });
  }

  next();
};

module.exports = { createAdminMiddleware };