const createPaymentController = ({ paymentService, logger }) => ({
  async health(req, res) {
    try {
      const result = await paymentService.health();
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      logger.error("health_check_failed", { error, requestId: req.requestId });
      return res.status(503).json({
        service: "payment-service",
        status: "down",
        checks: { postgres: "down" },
        error: error.message,
      });
    }
  },

  async createUrl(req, res, next) {
    try {
      logger.info("create_payment_url_request_received", {
        requestId: req.requestId,
        orderId: req.body?.orderId,
        amount: req.body?.amount,
      });

      const result = await paymentService.createPaymentUrl({
        ...req.body,
        ipAddr: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        requestId: req.requestId,
      });
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      logger.error("create_payment_url_failed", { error, requestId: req.requestId, orderId: req.body?.orderId });
      return next(error);
    }
  },

  async vnpayIpn(req, res) {
    try {
      logger.info("vnpay_ipn_request_received", { requestId: req.requestId, payload: req.query });
      const result = await paymentService.processIpn(req.query, req.requestId);
      return res.status(200).json(result);
    } catch (error) {
      logger.error("vnpay_ipn_failed", {
        error,
        requestId: req.requestId,
        payload: req.query,
        vnpTxnRef: req.query?.vnp_TxnRef,
      });
      return res.status(200).json({ RspCode: "97", Message: error.message || "Fail checksum" });
    }
  },
});

module.exports = { createPaymentController };