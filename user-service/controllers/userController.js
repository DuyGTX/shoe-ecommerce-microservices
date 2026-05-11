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

const register = async (req, res, next) => {
  try { return sendResult(res, await userService.register(req.body)); }
  catch (err) { logger.error("register_api_failed", { error: err }); return next(err); }
};

const login = async (req, res, next) => {
  try { return sendResult(res, await userService.login(req.body)); }
  catch (err) { logger.error("login_api_failed", { error: err }); return next(err); }
};

const addToCart = async (req, res, next) => {
  try { return sendResult(res, await userService.addToCart(req)); }
  catch (err) { logger.error("add_to_cart_api_failed", { error: err }); return next(err); }
};

const getProfile = async (req, res, next) => {
  try { return res.status(200).json(await userService.getProfile(req.user.id)); }
  catch (err) { return next(err); }
};

const getCart = async (req, res, next) => {
  try { return res.status(200).json(await userService.getCart(req.user.id)); }
  catch (err) { logger.error("get_cart_api_failed", { error: err }); return next(err); }
};

const updateCart = async (req, res, next) => {
  try { return sendResult(res, await userService.updateCart(req)); }
  catch (err) { logger.error("update_cart_api_failed", { error: err }); return next(err); }
};

const updateProfile = async (req, res, next) => {
  try { return sendResult(res, await userService.updateProfile(req.user.id, req.body)); }
  catch (err) { logger.error("update_profile_api_failed", { error: err }); return next(err); }
};

const changePassword = async (req, res, next) => {
  try { return sendResult(res, await userService.changePassword(req.user.id, req.body)); }
  catch (err) { logger.error("change_password_api_failed", { error: err }); return next(err); }
};

const removeCartItem = async (req, res, next) => {
  try { return sendResult(res, await userService.removeCartItem(req.user.id, req.params.cartItemId)); }
  catch (err) { logger.error("remove_cart_item_api_failed", { error: err }); return next(err); }
};

const clearCart = async (req, res, next) => {
  try { return res.status(200).json(await userService.clearCart(req.user.id)); }
  catch (err) { logger.error("clear_cart_api_failed", { error: err }); return next(err); }
};

module.exports = { health, register, login, addToCart, getProfile, getCart, updateCart, updateProfile, changePassword, removeCartItem, clearCart };