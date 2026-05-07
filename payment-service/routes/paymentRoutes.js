const express = require("express");
const { createPaymentController } = require("../controllers/paymentController");
const validate = require("../middlewares/validateMiddleware");
const { createPaymentSchema, vnpayIpnSchema } = require("../validations/paymentValidation");

const createPaymentRouter = ({ paymentService, logger }) => {
  const router = express.Router();
  const paymentController = createPaymentController({ paymentService, logger });

  router.get("/health", paymentController.health);
  router.post("/create-url", validate(createPaymentSchema), paymentController.createUrl);
  router.get("/vnpay-ipn", validate(vnpayIpnSchema), paymentController.vnpayIpn);

  return router;
};

module.exports = { createPaymentRouter };