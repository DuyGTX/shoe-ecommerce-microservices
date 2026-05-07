const express = require("express");
const { validate } = require("../middlewares/validateMiddleware");
const { createPaymentSchema, vnpayReturnSchema } = require("../validations/paymentValidation");

const createPaymentRoutes = ({ paymentController }) => {
  const router = express.Router();

  router.get("/health", paymentController.health);
  router.post("/vnpay/create", validate(createPaymentSchema), paymentController.createVnpayPayment);
  router.get("/vnpay/return", validate(vnpayReturnSchema), paymentController.handleVnpayReturn);

  return router;
};

module.exports = { createPaymentRoutes };