const createOrderController = ({ orderService, getRabbitReady, logger }) => ({
  async health(req, res) {
    try {
      const result = await orderService.health();
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("health_check_failed", { error: err });
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
      const result = await orderService.internalOrderDetail(req.params.orderId);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("internal_order_detail_failed", { error: err, orderId: req.params.orderId });
      return res.status(500).json({ message: "Lỗi khi lấy thông tin đơn hàng!" });
    }
  },

  async expireOrder(req, res) {
    try {
      const result = await orderService.expireOrder(req.params.orderId);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("internal_order_expire_failed", { error: err, orderId: req.params.orderId });
      return res.status(500).json({ message: "Lỗi khi cập nhật đơn hàng hết hạn!" });
    }
  },

  async checkout(req, res) {
    try {
      const result = await orderService.checkout({
        userId: req.user.id,
        tokenString: req.tokenString,
        requestId: req.requestId,
        idempotencyKey: req.headers["x-idempotency-key"],
      });
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("checkout_request_failed", { error: err, userId: req.user?.id, requestId: req.requestId });
      return res.status(500).json({ message: "Lỗi khi xử lý đơn hàng!" });
    }
  },

  async updateStatus(req, res) {
    try {
      const result = await orderService.updateStatus(req.params.orderId, req.body.status);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("update_order_status_failed", { error: err, orderId: req.params.orderId, status: req.body.status });
      return res.status(500).json({ message: "Lỗi khi cập nhật trạng thái đơn hàng!" });
    }
  },

  async history(req, res) {
    try {
      const result = await orderService.history(req.user.id);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("order_history_failed", { error: err, userId: req.user?.id });
      return res.status(500).json({ message: "Lỗi khi lấy dữ liệu đơn hàng!" });
    }
  },

  async detail(req, res) {
    try {
      const result = await orderService.detail(req.params.orderId, req.user.id);
      return res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error("order_detail_failed", { error: err, orderId: req.params.orderId, userId: req.user?.id });
      return res.status(500).json({ message: "Lỗi khi lấy chi tiết đơn hàng!" });
    }
  },
});

module.exports = { createOrderController };