const normalizeStatus = (status) => String(status || "pending").toLowerCase();

const createPaymentTransactionModel = ({ pool, logger }) => ({
  async ping() {
    return pool.query("SELECT 1");
  },

  async create(data) {
    const { order_id, orderId, amount, status = "pending", vnp_txn_ref, vnpTxnRef, payment_url, paymentUrl } = data;
    const normalizedOrderId = order_id || orderId;
    const normalizedTxnRef = vnp_txn_ref || vnpTxnRef || `${normalizedOrderId}-${Date.now()}`;

    logger?.info("payment_transaction_create_started", {
      orderId: normalizedOrderId,
      amount,
      status: normalizeStatus(status),
      vnpTxnRef: normalizedTxnRef,
    });

    const result = await pool.query(
      `INSERT INTO payment_transactions
        (order_id, amount, provider, transaction_ref, payment_url, status)
       VALUES ($1, $2, 'VNPAY', $3, $4, $5)
       RETURNING *`,
      [normalizedOrderId, amount, normalizedTxnRef, payment_url || paymentUrl || null, normalizeStatus(status)],
    );

    logger?.info("payment_transaction_created", {
      id: result.rows[0].id,
      orderId: normalizedOrderId,
      status: result.rows[0].status,
      vnpTxnRef: normalizedTxnRef,
    });
    return result.rows[0];
  },

  async updateStatus(order_id, status, vnp_txn_ref, vnp_response_code, rawResponse = null) {
    logger?.info("payment_transaction_update_status_started", {
      orderId: order_id,
      status: normalizeStatus(status),
      vnpTxnRef: vnp_txn_ref,
      vnpResponseCode: vnp_response_code,
    });

    const result = await pool.query(
      `UPDATE payment_transactions
       SET status = $2,
           transaction_ref = COALESCE($3, transaction_ref),
           provider_response_code = $4,
           raw_response = COALESCE($5, raw_response),
           paid_at = CASE WHEN $2 = 'success' THEN CURRENT_TIMESTAMP ELSE paid_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1
       RETURNING *`,
      [order_id, normalizeStatus(status), vnp_txn_ref || null, vnp_response_code || null, rawResponse],
    );

    const transaction = result.rows[0] || null;
    logger?.info("payment_transaction_status_updated", {
      orderId: order_id,
      status: transaction?.status || normalizeStatus(status),
      found: Boolean(transaction),
      vnpTxnRef: transaction?.transaction_ref || vnp_txn_ref,
    });
    return transaction;
  },

  async findByOrderId(order_id) {
    const result = await pool.query(
      `SELECT *
       FROM payment_transactions
       WHERE order_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [order_id],
    );

    logger?.info("payment_transaction_find_by_order_id", {
      orderId: order_id,
      found: Boolean(result.rows[0]),
      status: result.rows[0]?.status,
    });
    return result.rows[0] || null;
  },
});

module.exports = { createPaymentTransactionModel };