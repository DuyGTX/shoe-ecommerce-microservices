const { z } = require("zod");

const createPaymentSchema = {
  body: z.object({
    orderId: z.coerce.number().int().positive(),
    amount: z.coerce.number().int().positive(),
    orderInfo: z.string().trim().min(1).max(255),
    bankCode: z.string().trim().max(20).optional(),
    orderType: z.string().trim().max(50).optional(),
  }),
};

const vnpayReturnSchema = {
  query: z.object({
    vnp_TmnCode: z.string().optional(),
    vnp_Amount: z.string().optional(),
    vnp_BankCode: z.string().optional(),
    vnp_BankTranNo: z.string().optional(),
    vnp_CardType: z.string().optional(),
    vnp_PayDate: z.string().optional(),
    vnp_OrderInfo: z.string().optional(),
    vnp_TransactionNo: z.string().optional(),
    vnp_ResponseCode: z.string(),
    vnp_TransactionStatus: z.string().optional(),
    vnp_TxnRef: z.string(),
    vnp_SecureHash: z.string(),
    vnp_SecureHashType: z.string().optional(),
  }).passthrough(),
};

module.exports = {
  createPaymentSchema,
  vnpayReturnSchema,
};