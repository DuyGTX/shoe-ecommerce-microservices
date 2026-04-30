const express = require("express");
const userController = require("../controllers/userController");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/health", userController.health);
router.post("/register", userController.register);
router.post("/login", userController.login);
router.post("/cart/add", verifyToken, userController.addToCart);
router.get("/profile", verifyToken, userController.getProfile);
router.get("/cart", verifyToken, userController.getCart);
router.put("/cart/update", verifyToken, userController.updateCart);
router.put("/profile", verifyToken, userController.updateProfile);
router.put("/change-password", verifyToken, userController.changePassword);
router.delete("/cart/remove/:cartItemId", verifyToken, userController.removeCartItem);
router.delete("/cart/clear", verifyToken, userController.clearCart);

module.exports = router;