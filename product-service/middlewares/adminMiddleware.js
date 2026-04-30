const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

const requireAdmin = (req, res, next) => {
    if (!INTERNAL_SERVICE_TOKEN) {
        return res.status(500).json({ message: 'Thiếu cấu hình INTERNAL_SERVICE_TOKEN.' });
    }

    if (req.headers['x-internal-token'] !== INTERNAL_SERVICE_TOKEN) {
        return res.status(403).json({ message: 'Bạn không có quyền thao tác tài nguyên này.' });
    }

    next();
};

module.exports = { requireAdmin };