const { buildPaymentUrl, verifySecureHash } = require("../utils/vnpayConfig");

const TERMINAL_STATUSES = new Set(["success", "failed"]);

const extractOrderId = (txnRef) => {
  const [orderId] = String(txnRef || "").split("-");
  return Number(orderId);
};

const createPaymentService = ({ paymentTransactionModel, messageBroker, logger }) => ({
  async health() {
    await paymentTransactionModel.ping();
    return {
      statusCode: 200,
      body: {
        service: "payment-service",
        status: "ok",
        checks: {
          postgres: "up",
          rabbitmq: messageBroker?.getReady?.() ? "up" : "down",
        },
      },
    };
  },

  async createPaymentUrl({ orderId, amount, ipAddr, orderInfo, bankCode, orderType, requestId }) {
    logger.info("payment_url_create_started", { requestId, orderId, amount, ipAddr });

    const existingTransaction = await paymentTransactionModel.findByOrderId(orderId);
    if (existingTransaction?.status === "pending" && existingTransaction.payment_url) {
      logger.info("payment_url_create_idempotent_pending_reused", {
        requestId,
        orderId,
        transactionId: existingTransaction.id,
      });
      return {
        statusCode: 200,
        body: {
          message: "Da ton tai URL thanh toan dang cho xu ly.",
          data: {
            transactionId: existingTransaction.id,
            transactionRef: existingTransaction.transaction_ref,
            paymentUrl: existingTransaction.payment_url,
          },
        },
      };
    }

    const vnpTxnRef = `${orderId}-${Date.now()}`;
    const paymentUrl = buildPaymentUrl({
      amount,
      bankCode,
      clientIp: ipAddr,
      orderId: vnpTxnRef,
      orderInfo: orderInfo || `Thanh toan don hang ${orderId}`,
      orderType,
    });

    const transaction = await paymentTransactionModel.create({
      order_id: orderId,
      amount,
      status: "pending",
      vnp_txn_ref: vnpTxnRef,
      payment_url: paymentUrl,
    });

    logger.info("payment_url_created", {
      requestId,
      orderId,
      amount,
      transactionId: transaction.id,
      vnpTxnRef,
    });

    return {
      statusCode: 201,
      body: {
        message: "Tao URL thanh toan VNPay thanh cong.",
        data: {
          transactionId: transaction.id,
          transactionRef: vnpTxnRef,
          paymentUrl,
        },
      },
    };
  },

  async processIpn(query, requestId) {
    logger.info("vnpay_ipn_received", { requestId, payload: query });

    const isValidSignature = verifySecureHash(query);
    if (!isValidSignature) {
      logger.error("vnpay_ipn_invalid_secure_hash", { requestId, payload: query });
      throw new Error("Invalid VNPay secure hash.");
    }

    const vnpTxnRef = query.vnp_TxnRef;
    const orderId = extractOrderId(vnpTxnRef);
    if (!orderId) {
      logger.error("vnpay_ipn_invalid_order_id", { requestId, vnpTxnRef, payload: query });
      throw new Error("Invalid VNPay transaction reference.");
    }

    const transaction = await paymentTransactionModel.findByOrderId(orderId);
    if (!transaction) {
      logger.error("vnpay_ipn_transaction_not_found", { requestId, orderId, vnpTxnRef });
      throw new Error("Payment transaction not found.");
    }

    if (TERMINAL_STATUSES.has(transaction.status)) {
      logger.info("vnpay_ipn_idempotent_ignored", {
        requestId,
        orderId,
        status: transaction.status,
        vnpTxnRef,
      });
      return { RspCode: "00", Message: "Confirm Success" };
    }

    const success = query.vnp_ResponseCode === "00";
    const status = success ? "success" : "failed";
    const updatedTransaction = await paymentTransactionModel.updateStatus(
      orderId,
      status,
      vnpTxnRef,
      query.vnp_ResponseCode,
      query,
    );

    const routingKey = success ? "payment.completed" : "payment.failed";
    const eventPayload = {
      orderId,
      amount: updatedTransaction?.amount || transaction.amount,
      status,
      vnpTxnRef,
      vnpResponseCode: query.vnp_ResponseCode,
      processedAt: new Date().toISOString(),
    };

    await messageBroker?.publishEvent?.(routingKey, eventPayload);
    logger.info("vnpay_ipn_processed", {
      requestId,
      orderId,
      status,
      routingKey,
      vnpResponseCode: query.vnp_ResponseCode,
    });

    return { RspCode: "00", Message: "Confirm Success" };
  },
});

module.exports = { createPaymentService };