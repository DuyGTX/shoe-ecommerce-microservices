const express = require("express");

const createOrderRoutes = ({ orderController, requireAdmin, verifyToken }) => {
  const router = express.Router();

  router.get("/health", orderController.health);
  router.get("/internal/orders/:orderId", requireAdmin, orderController.internalOrderDetail);
  router.patch("/internal/orders/:orderId/expire", requireAdmin, orderController.expireOrder);
  router.post("/checkout", verifyToken, orderController.checkout);
  router.patch("/:orderId/status", requireAdmin, orderController.updateStatus);
  router.get("/history", verifyToken, orderController.history);
  router.get("/:orderId", verifyToken, orderController.detail);

  return router;
};

module.exports = { createOrderRoutes };