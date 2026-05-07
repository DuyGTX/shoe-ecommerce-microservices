const createPaymentTransactionModel = ({ pool }) => ({
  async ping() {
    return pool.query("SELECT 1");
  },

  async createPending({ orderId, amount, provider, transactionRef, paymentUrl }) {
    const result = await pool.query(
      `INSERT INTO payment_transactions
        (order_id, amount, provider, transaction_ref, payment_url, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [orderId, amount, provider, transactionRef, paymentUrl],
    );
    return result.rows[0];
  },

  async findByTransactionRef(transactionRef) {
    const result = await pool.query(
      "SELECT * FROM payment_transactions WHERE transaction_ref = $1",
      [transactionRef],
    );
    return result.rows[0] || null;
  },

  async updateVnpayResult({ transactionRef, status, responseCode, transactionNo, bankCode, rawResponse }) {
    const result = await pool.query(
      `UPDATE payment_transactions
       SET status = $2,
           provider_response_code = $3,
           provider_transaction_no = $4,
           bank_code = $5,
           raw_response = $6,
           paid_at = CASE WHEN $2 = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE paid_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE transaction_ref = $1
       RETURNING *`,
      [transactionRef, status, responseCode, transactionNo, bankCode, rawResponse],
    );
    return result.rows[0] || null;
  },
});

module.exports = { createPaymentTransactionModel };