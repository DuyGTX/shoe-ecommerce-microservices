const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requestWithRetry, withRequestIdHeader } = require("../utils/httpClient");

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validateRegisterInput = ({ email, password, full_name }) => {
  if (!email || !password || !full_name) return "Vui lòng điền đầy đủ email, mật khẩu và họ tên.";
  if (!isValidEmail(email)) return "Email không đúng định dạng.";
  if (String(password).length < 6) return "Mật khẩu phải có ít nhất 6 ký tự.";
  return null;
};

const validateCartPayload = ({ productId, quantity, color, size }) => {
  if (!productId || !color || size === undefined || quantity === undefined) return "Thiếu thông tin sản phẩm cần thêm vào giỏ hàng.";
  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) return "Số lượng phải là số nguyên dương.";
  if (!Number.isInteger(Number(size)) || Number(size) <= 0) return "Size phải là số nguyên dương.";
  return null;
};

const health = async () => {
  await pool.query("SELECT 1");
  return { service: "user-service", status: "ok", checks: { postgres: "up" } };
};

const register = async ({ email, password, full_name }) => {
  const validationError = validateRegisterInput({ email, password, full_name });
  if (validationError) return { status: 400, body: { message: validationError } };

  const userExists = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (userExists.rows.length > 0) return { status: 400, body: { message: "Email này đã được sử dụng!" } };

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);
  const newUser = await pool.query(
    "INSERT INTO users (email, password, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name",
    [email, hashedPassword, full_name],
  );

  return { status: 201, body: { message: "Đăng ký tài khoản thành công!", user: newUser.rows[0] } };
};

const login = async ({ email, password }) => {
  if (!email || !password) return { status: 400, body: { message: "Email và mật khẩu là bắt buộc." } };
  if (!isValidEmail(email)) return { status: 400, body: { message: "Email không đúng định dạng." } };

  const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (userResult.rows.length === 0) return { status: 401, body: { message: "Email hoặc mật khẩu không đúng!" } };

  const user = userResult.rows[0];
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return { status: 401, body: { message: "Email hoặc mật khẩu không đúng!" } };

  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "1d" });
  return { status: 200, body: { message: "Đăng nhập thành công!", token, user: { id: user.id, full_name: user.full_name, email: user.email } } };
};

const fetchProduct = async (req, productId) => {
  const response = await requestWithRetry({
    method: "get",
    url: `http://product-service:3002/${productId}`,
    ...withRequestIdHeader(req),
    timeout: 4000,
  });
  return response.data.data;
};

const addToCart = async (req) => {
  const userId = req.user.id;
  const { productId, quantity, color, size } = req.body;
  const validationError = validateCartPayload({ productId, quantity, color, size });
  if (validationError) return { status: 400, body: { message: validationError } };

  const normalizedQuantity = Number(quantity);
  const normalizedSize = Number(size);
  const product = await fetchProduct(req, productId);
  if (!product) return { status: 404, body: { message: "Sản phẩm không tồn tại!" } };

  const variant = product.variants.find((v) => v.color === color && v.size === normalizedSize);
  if (!variant || variant.stock < normalizedQuantity) return { status: 400, body: { message: "Sản phẩm này đã hết hàng hoặc không đủ số lượng!" } };

  const finalPrice = product.salePrice ? product.salePrice : product.price;
  const total = finalPrice * normalizedQuantity;
  const checkCart = await pool.query(
    "SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2 AND color = $3 AND size = $4",
    [userId, productId, color, normalizedSize],
  );

  if (checkCart.rows.length > 0) {
    await pool.query("UPDATE cart_items SET quantity = quantity + $1, total = total + $2 WHERE id = $3", [normalizedQuantity, total, checkCart.rows[0].id]);
  } else {
    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, product_name, price, color, size, quantity, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, productId, product.name, finalPrice, color, normalizedSize, normalizedQuantity, total],
    );
  }

  return { status: 200, body: { message: "Đã thêm thành công vào giỏ hàng của bạn!", cartItem: { productName: product.name, price: finalPrice, color, size: normalizedSize, quantity: normalizedQuantity, total } } };
};

const getProfile = async (userId) => {
  const userResult = await pool.query("SELECT id, email, full_name, created_at FROM users WHERE id = $1", [userId]);
  return { message: "Chào mừng bạn đến với khu vực VIP!", data: userResult.rows[0] };
};

const getCart = async (userId) => {
  const cartResult = await pool.query("SELECT * FROM cart_items WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
  const grandTotal = cartResult.rows.reduce((sum, item) => sum + item.total, 0);
  return { message: "Lấy dữ liệu giỏ hàng thành công!", totalItems: cartResult.rows.length, grandTotal, data: cartResult.rows };
};

const updateCart = async (req) => {
  const userId = req.user.id;
  const { cartItemId, quantity } = req.body;
  const normalizedQuantity = Number(quantity);

  if (!Number.isInteger(Number(cartItemId)) || Number(cartItemId) <= 0) return { status: 400, body: { message: "cartItemId không hợp lệ." } };
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) return { status: 400, body: { message: "Số lượng phải lớn hơn 0. Nếu muốn xóa, hãy dùng chức năng Xóa." } };

  const cartItemResult = await pool.query("SELECT * FROM cart_items WHERE id = $1 AND user_id = $2", [Number(cartItemId), userId]);
  if (cartItemResult.rows.length === 0) return { status: 404, body: { message: "Không tìm thấy sản phẩm này trong giỏ hàng!" } };

  const item = cartItemResult.rows[0];
  const product = await fetchProduct(req, item.product_id);
  const variant = product.variants.find((v) => v.color === item.color && v.size === item.size);
  if (!variant || variant.stock < normalizedQuantity) return { status: 400, body: { message: `Kho hàng chỉ còn tối đa ${variant ? variant.stock : 0} sản phẩm!` } };

  await pool.query("UPDATE cart_items SET quantity = $1, total = $2 WHERE id = $3", [normalizedQuantity, item.price * normalizedQuantity, Number(cartItemId)]);
  return { status: 200, body: { message: "Cập nhật số lượng thành công!" } };
};

const updateProfile = async (userId, { full_name }) => {
  if (!full_name || String(full_name).trim().length < 2) return { status: 400, body: { message: "Họ tên phải có ít nhất 2 ký tự." } };
  const result = await pool.query("UPDATE users SET full_name = $1 WHERE id = $2 RETURNING id, email, full_name, created_at", [String(full_name).trim(), userId]);
  return { status: 200, body: { message: "Cập nhật hồ sơ thành công!", data: result.rows[0] } };
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
  if (!currentPassword || !newPassword) return { status: 400, body: { message: "Vui lòng nhập mật khẩu hiện tại và mật khẩu mới." } };
  if (String(newPassword).length < 6) return { status: 400, body: { message: "Mật khẩu mới phải có ít nhất 6 ký tự." } };

  const userResult = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
  if (userResult.rows.length === 0) return { status: 404, body: { message: "Không tìm thấy người dùng." } };
  const isMatch = await bcrypt.compare(currentPassword, userResult.rows[0].password);
  if (!isMatch) return { status: 400, body: { message: "Mật khẩu hiện tại không đúng." } };

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, userId]);
  return { status: 200, body: { message: "Đổi mật khẩu thành công!" } };
};

const removeCartItem = async (userId, cartItemId) => {
  const result = await pool.query("DELETE FROM cart_items WHERE id = $1 AND user_id = $2 RETURNING id", [cartItemId, userId]);
  if (result.rowCount === 0) return { status: 404, body: { message: "Sản phẩm không tồn tại hoặc đã bị xóa!" } };
  return { status: 200, body: { message: "Đã vứt sản phẩm ra khỏi giỏ hàng!" } };
};

const clearCart = async (userId) => {
  await pool.query("DELETE FROM cart_items WHERE user_id = $1", [userId]);
  return { message: "Đã dọn sạch giỏ hàng!" };
};

module.exports = { health, register, login, addToCart, getProfile, getCart, updateCart, updateProfile, changePassword, removeCartItem, clearCart };