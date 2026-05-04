const userService = require("../services/userService");
const logger = require("../utils/logger");

const sendResult = (res, result) => res.status(result.status).json(result.body);

const health = async (req, res) => {
  try {
    return res.status(200).json(await userService.health());
  } catch (err) {
    return res.status(503).json({ service: "user-service", status: "down", checks: { postgres: "down" }, error: err.message });
  }
};

const register = async (req, res) => {
  try { return sendResult(res, await userService.register(req.body)); }
  catch (err) { logger.error("register_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const login = async (req, res) => {
  try { return sendResult(res, await userService.login(req.body)); }
  catch (err) { logger.error("login_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const addToCart = async (req, res) => {
  try { return sendResult(res, await userService.addToCart(req)); }
  catch (err) { logger.error("add_to_cart_api_failed", { error: err }); return res.status(500).json({ message: "Hệ thống đang quá tải. Vui lòng thử lại sau!" }); }
};

const getProfile = async (req, res) => {
  try { return res.status(200).json(await userService.getProfile(req.user.id)); }
  catch (err) { return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const getCart = async (req, res) => {
  try { return res.status(200).json(await userService.getCart(req.user.id)); }
  catch (err) { logger.error("get_cart_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const updateCart = async (req, res) => {
  try { return sendResult(res, await userService.updateCart(req)); }
  catch (err) { logger.error("update_cart_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const updateProfile = async (req, res) => {
  try { return sendResult(res, await userService.updateProfile(req.user.id, req.body)); }
  catch (err) { logger.error("update_profile_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const changePassword = async (req, res) => {
  try { return sendResult(res, await userService.changePassword(req.user.id, req.body)); }
  catch (err) { logger.error("change_password_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const removeCartItem = async (req, res) => {
  try { return sendResult(res, await userService.removeCartItem(req.user.id, req.params.cartItemId)); }
  catch (err) { logger.error("remove_cart_item_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const clearCart = async (req, res) => {
  try { return res.status(200).json(await userService.clearCart(req.user.id)); }
  catch (err) { logger.error("clear_cart_api_failed", { error: err }); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

module.exports = { health, register, login, addToCart, getProfile, getCart, updateCart, updateProfile, changePassword, removeCartItem, clearCart };