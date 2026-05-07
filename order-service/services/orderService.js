const { requestWithRetry } = require("../utils/httpClient");

const createReplayPayload = (row) => ({
  message: "Yêu cầu checkout đã được xử lý trước đó.",
  orderId: row.id,
  totalPaid: row.total_amount,
  status: row.status,
  idempotentReplay: true,
});

const createOrderService = ({ pool, orderModel, getRabbitReady, publishOrderCreated, publishCartClearRequested, logger }) => {
  const replayByKey = async (userId, key) => {
    const replay = await orderModel.findReplayByKey(userId, key);
    if (replay.rows.length === 0) return null;
    return createReplayPayload(replay.rows[0]);
  };

  return {
    async health() {
      await orderModel.ping();
      const rabbitReady = getRabbitReady();
      return {
        statusCode: rabbitReady ? 200 : 503,
        body: {
          service: "order-service",
          status: rabbitReady ? "ok" : "degraded",
          checks: {
            postgres: "up",
            rabbitmq: rabbitReady ? "up" : "down",
          },
        },
      };
    },

    async internalOrderDetail(orderId) {
      const orderResult = await orderModel.findById(orderId);
      if (orderResult.rows.length === 0) {
        return { statusCode: 404, body: { message: "Không tìm thấy đơn hàng!" } };
      }

      const itemsResult = await orderModel.findItems(orderId);
      return {
        statusCode: 200,
        body: {
          message: "Lấy thông tin đơn hàng nội bộ thành công!",
          data: { ...orderResult.rows[0], items: itemsResult.rows },
        },
      };
    },

    async expireOrder(orderId) {
      const result = await orderModel.expireOrder(orderId);
      if (result.rows.length === 0) {
        return { statusCode: 409, body: { message: "Đơn hàng không còn ở trạng thái có thể hết hạn." } };
      }

      return { statusCode: 200, body: { message: "Đơn hàng đã hết hạn thanh toán.", data: result.rows[0] } };
    },

    async checkout({ userId, tokenString, requestId, idempotencyKey }) {
      const client = await pool.connect();
      let transactionStarted = false;

      try {
        logger.info("checkout_started", { userId, requestId, idempotencyKey });
        const existingPayload = await replayByKey(userId, idempotencyKey);
        if (existingPayload) {
          client.release();
          logger.info("checkout_idempotent_replay", { userId, requestId, idempotencyKey, orderId: existingPayload.orderId });
          return { statusCode: 200, body: existingPayload };
        }

        const config = {
          headers: {
            Authorization: `Bearer ${tokenString}`,
            "x-request-id": requestId,
          },
        };

        const cartResponse = await requestWithRetry({
          method: "get",
          url: "http://user-service:3001/cart",
          ...config,
          timeout: 5000,
        });
        const cartItems = cartResponse.data.data;
        const grandTotal = cartResponse.data.grandTotal;
        logger.info("checkout_cart_fetched", { userId, requestId, itemCount: cartItems?.length || 0, grandTotal });

        if (!cartItems || cartItems.length === 0) {
          client.release();
          logger.warn("checkout_empty_cart", { userId, requestId });
          return { statusCode: 400, body: { message: "Giỏ hàng của bạn đang trống!" } };
        }

        await client.query("BEGIN");
        transactionStarted = true;
        logger.info("checkout_transaction_started", { userId, requestId });
        const orderId = await orderModel.createOrderWithItems(client, { userId, idempotencyKey, grandTotal, cartItems });
        logger.info("checkout_order_created", { userId, requestId, orderId, itemCount: cartItems.length, grandTotal });
        await client.query("COMMIT");
        logger.info("checkout_transaction_committed", { userId, requestId, orderId });
        client.release();

        const reserveItems = cartItems.map((item) => ({
          productId: item.product_id,
          quantity: Number(item.quantity),
          color: item.color,
          size: item.size,
        }));

        if (!getRabbitReady()) {
          logger.warn("checkout_rabbitmq_not_ready", { userId, requestId, orderId });
          return {
            statusCode: 202,
            body: {
              message: "Đơn hàng đã được tạo PENDING, nhưng RabbitMQ chưa sẵn sàng để giữ kho.",
              orderId: orderId,
              totalPaid: grandTotal,
              status: "PENDING",
            },
          };
        }

        const published = publishOrderCreated(orderId, reserveItems);
        logger.info("order_created_event_published", { userId, requestId, orderId, itemCount: reserveItems.length, published });
        return {
          statusCode: 202,
          body: {
            message: "Đơn hàng đã được tạo PENDING, hệ thống đang giữ kho.",
            orderId: orderId,
            totalPaid: grandTotal,
            status: "PENDING",
          },
        };
      } catch (err) {
        if (err.code === "23505") {
          const replayPayload = await orderModel.findReplayByKey(userId, idempotencyKey);
          client.release();
          if (replayPayload.rows.length > 0) {
            logger.info("checkout_idempotent_conflict_replayed", { userId, requestId, idempotencyKey, orderId: replayPayload.rows[0].id });
            return { statusCode: 200, body: createReplayPayload(replayPayload.rows[0]) };
          }
        }

        if (transactionStarted) {
          await client.query("ROLLBACK");
          logger.warn("checkout_transaction_rolled_back", { userId, requestId, idempotencyKey });
        }
        client.release();
        logger.error("checkout_failed", { error: err, userId, requestId, idempotencyKey });
        throw err;
      }
    },

    async updateStatus(orderId, status) {
      const result = await orderModel.updateStatus(orderId, status);
      if (result.rows.length === 0) {
        return { statusCode: 404, body: { message: "Không tìm thấy đơn hàng để cập nhật!" } };
      }

      return { statusCode: 200, body: { message: "Cập nhật trạng thái đơn hàng thành công!", data: result.rows[0] } };
    },

    async updateOrderStatus(orderId, status) {
      const current = await orderModel.findStatusById(orderId);
      if (current.rows.length === 0) {
        logger.warn("order_status_update_not_found", { orderId, status });
        return { updated: false, reason: "not_found" };
      }

      const currentStatus = String(current.rows[0].status || "").toLowerCase();
      if (["paid", "failed"].includes(currentStatus)) {
        logger.info("payment_event_idempotent_skipped", { orderId, status, currentStatus });
        return { updated: false, reason: "terminal_status", currentStatus };
      }

      const result = await orderModel.updateOrderStatus(orderId, status);
      logger.info("order_status_updated", {
        orderId,
        status,
        previousStatus: current.rows[0].status,
        updated: result.rows.length > 0,
      });

      return { updated: result.rows.length > 0, order: result.rows[0] || null };
    },

    async history(userId) {
      const ordersResult = await orderModel.findByUser(userId);
      const orders = ordersResult.rows;

      if (orders.length === 0) {
        return { statusCode: 200, body: { message: "Bạn chưa có đơn hàng nào!", data: [] } };
      }

      for (let order of orders) {
        const itemsResult = await orderModel.findItems(order.id);
        order.items = itemsResult.rows;
      }

      return { statusCode: 200, body: { message: "Lấy lịch sử mua hàng thành công!", totalOrders: orders.length, data: orders } };
    },

    async detail(orderId, userId) {
      const orderResult = await orderModel.findByIdAndUser(orderId, userId);
      if (orderResult.rows.length === 0) {
        return { statusCode: 404, body: { message: "Không tìm thấy đơn hàng!" } };
      }

      const itemsResult = await orderModel.findItems(orderId);
      return {
        statusCode: 200,
        body: {
          message: "Lấy chi tiết đơn hàng thành công!",
          data: { ...orderResult.rows[0], items: itemsResult.rows },
        },
      };
    },

    async confirmOrderStockReserved(orderId) {
      const updated = await orderModel.confirmPendingOrder(orderId);
      if (updated.rows.length > 0) {
        publishCartClearRequested(updated.rows[0].user_id, orderId);
        logger.info("stock_reserved_order_confirmed", { orderId, userId: updated.rows[0].user_id });
      }
    },

    async cancelOrderStockFailed(orderId, reason) {
      await orderModel.cancelPendingOrder(orderId);
      logger.warn("stock_failed_order_cancelled", { orderId, reason });
    },

    async getOrderItemsForSaga(orderId) {
      const result = await orderModel.findItems(orderId);
      if (result.rows.length === 0) {
        logger.warn("order_items_for_saga_empty", { orderId });
        return [];
      }

      return result.rows.map((item) => ({
        productId: item.product_id,
        quantity: Number(item.quantity),
        color: item.color,
        size: Number(item.size),
      }));
    },
  };
};

module.exports = { createOrderService };