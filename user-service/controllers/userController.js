const userService = require("../services/userService");

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
  catch (err) { console.error("Lỗi API Register:", err); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const login = async (req, res) => {
  try { return sendResult(res, await userService.login(req.body)); }
  catch (err) { console.error("Lỗi API Login:", err); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const addToCart = async (req, res) => {
  try { return sendResult(res, await userService.addToCart(req)); }
  catch (err) { console.error("Lỗi khi gọi Product Service:", err.message); return res.status(500).json({ message: "Hệ thống đang quá tải. Vui lòng thử lại sau!" }); }
};

const getProfile = async (req, res) => {
  try { return res.status(200).json(await userService.getProfile(req.user.id)); }
  catch (err) { return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const getCart = async (req, res) => {
  try { return res.status(200).json(await userService.getCart(req.user.id)); }
  catch (err) { console.error("Lỗi khi lấy giỏ hàng:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const updateCart = async (req, res) => {
  try { return sendResult(res, await userService.updateCart(req)); }
  catch (err) { console.error("Lỗi API Update Cart:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const updateProfile = async (req, res) => {
  try { return sendResult(res, await userService.updateProfile(req.user.id, req.body)); }
  catch (err) { console.error("Lỗi API Update Profile:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const changePassword = async (req, res) => {
  try { return sendResult(res, await userService.changePassword(req.user.id, req.body)); }
  catch (err) { console.error("Lỗi API Change Password:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const removeCartItem = async (req, res) => {
  try { return sendResult(res, await userService.removeCartItem(req.user.id, req.params.cartItemId)); }
  catch (err) { console.error("Lỗi API Delete Cart:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

const clearCart = async (req, res) => {
  try { return res.status(200).json(await userService.clearCart(req.user.id)); }
  catch (err) { console.error("Lỗi API Clear Cart:", err.message); return res.status(500).json({ message: "Lỗi máy chủ nội bộ" }); }
};

module.exports = { health, register, login, addToCart, getProfile, getCart, updateCart, updateProfile, changePassword, removeCartItem, clearCart };