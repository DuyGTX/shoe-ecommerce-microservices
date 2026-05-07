const createPaymentController = ({ paymentService, logger }) => ({
  async health(req, res) {
    try {
      const result = await paymentService.health();
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      logger.error("health_check_failed", { error });
      return res.status(503).json({
        service: "payment-service",
        status: "down",
        checks: { postgres: "down" },
        error: error.message,
      });
    }
  },

  async createVnpayPayment(req, res) {
    try {
      const result = await paymentService.createVnpayPayment({
        ...req.body,
        clientIp: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        requestId: req.requestId,
      });
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      logger.error("create_vnpay_payment_failed", { error, requestId: req.requestId, orderId: req.body?.orderId });
      return res.status(500).json({ message: "Loi khi tao thanh toan VNPay." });
    }
  },

  async handleVnpayReturn(req, res) {
    try {
      const result = await paymentService.handleVnpayReturn({ query: req.query, requestId: req.requestId });
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      logger.error("handle_vnpay_return_failed", { error, requestId: req.requestId, transactionRef: req.query?.vnp_TxnRef });
      return res.status(500).json({ message: "Loi khi xu ly ket qua VNPay." });
    }
  },
});

module.exports = { createPaymentController };