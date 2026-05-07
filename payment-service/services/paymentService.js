const { buildPaymentUrl, verifySecureHash } = require("../utils/vnpayConfig");

const createPaymentService = ({ paymentTransactionModel, logger }) => ({
  async health() {
    await paymentTransactionModel.ping();
    return {
      statusCode: 200,
      body: {
        service: "payment-service",
        status: "ok",
        checks: { postgres: "up" },
      },
    };
  },

  async createVnpayPayment({ orderId, amount, orderInfo, bankCode, orderType, clientIp, requestId }) {
    const transactionRef = `${orderId}-${Date.now()}`;
    const paymentUrl = buildPaymentUrl({
      amount,
      bankCode,
      clientIp,
      orderId: transactionRef,
      orderInfo,
      orderType,
    });

    const transaction = await paymentTransactionModel.createPending({
      orderId,
      amount,
      provider: "VNPAY",
      transactionRef,
      paymentUrl,
    });

    logger.info("vnpay_payment_url_created", { requestId, orderId, transactionRef, amount });
    return {
      statusCode: 201,
      body: {
        message: "Tao URL thanh toan VNPay thanh cong.",
        data: {
          transactionId: transaction.id,
          transactionRef,
          paymentUrl,
        },
      },
    };
  },

  async handleVnpayReturn({ query, requestId }) {
    const isValidSignature = verifySecureHash(query);
    const transactionRef = query.vnp_TxnRef;

    if (!isValidSignature) {
      logger.warn("vnpay_return_invalid_signature", { requestId, transactionRef });
      return { statusCode: 400, body: { message: "Chu ky VNPay khong hop le." } };
    }

    const success = query.vnp_ResponseCode === "00" && (query.vnp_TransactionStatus || "00") === "00";
    const transaction = await paymentTransactionModel.updateVnpayResult({
      transactionRef,
      status: success ? "SUCCESS" : "FAILED",
      responseCode: query.vnp_ResponseCode,
      transactionNo: query.vnp_TransactionNo,
      bankCode: query.vnp_BankCode,
      rawResponse: query,
    });

    logger.info("vnpay_return_processed", {
      requestId,
      transactionRef,
      responseCode: query.vnp_ResponseCode,
      success,
    });

    return {
      statusCode: 200,
      body: {
        message: success ? "Thanh toan VNPay thanh cong." : "Thanh toan VNPay that bai.",
        data: transaction,
      },
    };
  },
});

module.exports = { createPaymentService };