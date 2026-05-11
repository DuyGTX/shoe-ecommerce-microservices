const { AppError } = require('./AppError');

const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

const requireAdmin = (req, res, next) => {
    if (!INTERNAL_SERVICE_TOKEN) {
        return next(new AppError('Thiếu cấu hình INTERNAL_SERVICE_TOKEN.', 500));
    }

    if (req.headers['x-internal-token'] !== INTERNAL_SERVICE_TOKEN) {
        return next(new AppError('Bạn không có quyền thao tác tài nguyên này.', 403));
    }

    next();
};

module.exports = { requireAdmin };