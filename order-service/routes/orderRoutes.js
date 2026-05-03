const express = require("express");

const { validate } = require("../middlewares/validateMiddleware");
const {
  checkoutSchema,
  orderIdSchema,
  updateStatusSchema,
} = require("../validations/orderValidation");

const createOrderRoutes = ({ orderController, requireAdmin, verifyToken }) => {
  const router = express.Router();

  router.get("/health", orderController.health);
  router.get("/internal/orders/:orderId", requireAdmin, validate(orderIdSchema), orderController.internalOrderDetail);
  router.patch("/internal/orders/:orderId/expire", requireAdmin, validate(orderIdSchema), orderController.expireOrder);
  router.post("/checkout", verifyToken, validate(checkoutSchema), orderController.checkout);
  router.patch("/:orderId/status", requireAdmin, validate(updateStatusSchema), orderController.updateStatus);
  router.get("/history", verifyToken, orderController.history);
  router.get("/:orderId", verifyToken, validate(orderIdSchema), orderController.detail);

  return router;
};

module.exports = { createOrderRoutes };