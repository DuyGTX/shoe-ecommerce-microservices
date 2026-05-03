const { z } = require("zod");

const orderIdParamsSchema = z.object({
  orderId: z.coerce.number({ error: "orderId phải là số nguyên dương." })
    .int("orderId phải là số nguyên dương.")
    .positive("orderId phải là số nguyên dương."),
});

const checkoutItemSchema = z.object({
  productId: z.string({ error: "productId là bắt buộc." })
    .trim()
    .min(1, "productId là bắt buộc."),
  quantity: z.coerce.number({ error: "quantity phải là số nguyên dương." })
    .int("quantity phải là số nguyên dương.")
    .positive("quantity phải là số nguyên dương."),
});

const checkoutItemsBodySchema = z.object({
  items: z.array(checkoutItemSchema, { error: "items phải là mảng sản phẩm." })
    .min(1, "items không được rỗng."),
});

const checkoutHeadersSchema = z.object({
  "x-idempotency-key": z.string({ error: "Thiếu hoặc sai định dạng x-idempotency-key." })
    .trim()
    .min(8, "Thiếu hoặc sai định dạng x-idempotency-key."),
}).passthrough();

const updateStatusBodySchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "PAID", "CANCELLED", "EXPIRED", "Delivered"], {
    error: "Trạng thái đơn hàng không hợp lệ.",
  }),
});

const checkoutSchema = { headers: checkoutHeadersSchema };
const checkoutItemsSchema = { body: checkoutItemsBodySchema };
const orderIdSchema = { params: orderIdParamsSchema };
const updateStatusSchema = { params: orderIdParamsSchema, body: updateStatusBodySchema };

module.exports = {
  checkoutSchema,
  checkoutItemsSchema,
  orderIdSchema,
  updateStatusSchema,
};