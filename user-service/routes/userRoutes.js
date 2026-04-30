const express = require("express");
const userController = require("../controllers/userController");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validate } = require("../middlewares/validateMiddleware");
const {
  registerSchema,
  loginSchema,
  addToCartSchema,
  updateCartSchema,
  updateProfileSchema,
  changePasswordSchema,
  removeCartItemSchema,
} = require("../validations/userValidation");

const router = express.Router();

router.get("/health", userController.health);
router.post("/register", validate(registerSchema), userController.register);
router.post("/login", validate(loginSchema), userController.login);
router.post("/cart/add", verifyToken, validate(addToCartSchema), userController.addToCart);
router.get("/profile", verifyToken, userController.getProfile);
router.get("/cart", verifyToken, userController.getCart);
router.put("/cart/update", verifyToken, validate(updateCartSchema), userController.updateCart);
router.put("/profile", verifyToken, validate(updateProfileSchema), userController.updateProfile);
router.put("/change-password", verifyToken, validate(changePasswordSchema), userController.changePassword);
router.delete("/cart/remove/:cartItemId", verifyToken, validate(removeCartItemSchema), userController.removeCartItem);
router.delete("/cart/clear", verifyToken, userController.clearCart);

module.exports = router;