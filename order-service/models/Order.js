const createOrderModel = ({ pool }) => ({
  async ping() {
    return pool.query("SELECT 1");
  },

  async findReplayByKey(userId, key) {
    return pool.query(
      "SELECT id, total_amount, status FROM orders WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
      [userId, key],
    );
  },

  async createOrderWithItems(client, { userId, idempotencyKey, grandTotal, cartItems }) {
    const newOrder = await client.query(
      "INSERT INTO orders (user_id, idempotency_key, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, idempotencyKey, grandTotal, "PENDING"],
    );
    const orderId = newOrder.rows[0].id;

    for (let item of cartItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, color, size, quantity, total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          item.product_id,
          item.product_name,
          item.price,
          item.color,
          item.size,
          item.quantity,
          item.total,
        ],
      );
    }

    return orderId;
  },

  async confirmPendingOrder(orderId) {
    return pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 AND status = $3 RETURNING user_id",
      ["CONFIRMED", orderId, "PENDING"],
    );
  },

  async cancelPendingOrder(orderId) {
    return pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 AND status = $3",
      ["CANCELLED", orderId, "PENDING"],
    );
  },

  async findStatusById(orderId) {
    return pool.query("SELECT id, status FROM orders WHERE id = $1", [orderId]);
  },

  async findById(orderId) {
    return pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  },

  async findByIdAndUser(orderId, userId) {
    return pool.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [orderId, userId],
    );
  },

  async findItems(orderId) {
    return pool.query("SELECT * FROM order_items WHERE order_id = $1", [orderId]);
  },

  async expireOrder(orderId) {
    return pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 AND status IN ($3, $4) RETURNING *",
      ["EXPIRED", orderId, "PENDING", "CANCELLED"],
    );
  },

  async updateStatus(orderId, status) {
    return pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
      [status, orderId],
    );
  },

  async updateOrderStatus(orderId, status) {
    return pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id = $2 AND LOWER(status) NOT IN ('paid', 'failed')
       RETURNING *`,
      [status, orderId],
    );
  },

  async findByUser(userId) {
    return pool.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
  },
});

module.exports = { createOrderModel };