const { z } = require("zod");

const positiveInteger = (fieldName) => z.coerce.number({
  error: `${fieldName} phải là số nguyên dương.`,
}).int(`${fieldName} phải là số nguyên dương.`).positive(`${fieldName} phải là số nguyên dương.`);

const nonEmptyString = (fieldName) => z.string({
  error: `${fieldName} là bắt buộc.`,
}).trim().min(1, `${fieldName} là bắt buộc.`);

const registerSchema = {
  body: z.object({
    email: z.email("Email không đúng định dạng."),
    password: z.string({ error: "Mật khẩu là bắt buộc." }).min(6, "Mật khẩu phải có ít nhất 6 ký tự."),
    full_name: z.string({ error: "Họ tên là bắt buộc." }).trim().min(2, "Họ tên phải có ít nhất 2 ký tự."),
  }),
};

const loginSchema = {
  body: z.object({
    email: z.email("Email không đúng định dạng."),
    password: nonEmptyString("Mật khẩu"),
  }),
};

const addToCartSchema = {
  body: z.object({
    productId: nonEmptyString("productId"),
    quantity: positiveInteger("Số lượng"),
    color: nonEmptyString("Màu sắc"),
    size: positiveInteger("Size"),
  }),
};

const updateCartSchema = {
  body: z.object({
    cartItemId: positiveInteger("cartItemId"),
    quantity: positiveInteger("Số lượng"),
  }),
};

const updateProfileSchema = {
  body: z.object({
    full_name: z.string({ error: "Họ tên là bắt buộc." }).trim().min(2, "Họ tên phải có ít nhất 2 ký tự."),
  }),
};

const changePasswordSchema = {
  body: z.object({
    currentPassword: nonEmptyString("Mật khẩu hiện tại"),
    newPassword: z.string({ error: "Mật khẩu mới là bắt buộc." }).min(6, "Mật khẩu mới phải có ít nhất 6 ký tự."),
  }),
};

const removeCartItemSchema = {
  params: z.object({
    cartItemId: positiveInteger("cartItemId"),
  }),
};

module.exports = {
  registerSchema,
  loginSchema,
  addToCartSchema,
  updateCartSchema,
  updateProfileSchema,
  changePasswordSchema,
  removeCartItemSchema,
};