const createOrderController = ({ orderService, getRabbitReady, log }) => ({
  async health(req, res) {
    try {
      const result = await orderService.health();
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      return res.status(503).json({
        service: "order-service",
        status: "down",
        checks: {
          postgres: "down",
          rabbitmq: getRabbitReady() ? "up" : "down",
        },
        error: err.message,
      });
    }
  },

  async internalOrderDetail(req, res) {
    try {
      const result = await orderService.internalOrderDetail(Number(req.params.orderId));
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      log("error", "internal_order_detail_failed", { error: err.message });
      return res.status(500).json({ message: "Lỗi khi lấy thông tin đơn hàng!" });
    }
  },

  async expireOrder(req, res) {
    try {
      const result = await orderService.expireOrder(Number(req.params.orderId));
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      log("error", "internal_order_expire_failed", { error: err.message });
      return res.status(500).json({ message: "Lỗi khi cập nhật đơn hàng hết hạn!" });
    }
  },

  async checkout(req, res) {
    try {
      const result = await orderService.checkout({
        userId: req.user.id,
        tokenString: req.tokenString,
        requestId: req.requestId,
        idempotencyKey: String(req.headers["x-idempotency-key"] || "").trim(),
      });
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      console.error("Lỗi quá trình thanh toán:", err.message);
      return res.status(500).json({ message: "Lỗi khi xử lý đơn hàng!" });
    }
  },

  async updateStatus(req, res) {
    try {
      const result = await orderService.updateStatus(Number(req.params.orderId), req.body.status);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      console.error("Lỗi API Update Order Status:", err.message);
      return res.status(500).json({ message: "Lỗi khi cập nhật trạng thái đơn hàng!" });
    }
  },

  async history(req, res) {
    try {
      const result = await orderService.history(req.user.id);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      console.error("Lỗi API Lịch sử đơn hàng:", err.message);
      return res.status(500).json({ message: "Lỗi khi lấy dữ liệu đơn hàng!" });
    }
  },

  async detail(req, res) {
    try {
      const result = await orderService.detail(Number(req.params.orderId), req.user.id);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      console.error("Lỗi API Chi tiết đơn hàng:", err.message);
      return res.status(500).json({ message: "Lỗi khi lấy chi tiết đơn hàng!" });
    }
  },
});

module.exports = { createOrderController };