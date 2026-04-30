const { requestWithRetry } = require("../utils/httpClient");

const createReplayPayload = (row) => ({
  message: "Yêu cầu checkout đã được xử lý trước đó.",
  orderId: row.id,
  totalPaid: row.total_amount,
  status: row.status,
  idempotentReplay: true,
});

const createOrderService = ({ pool, orderModel, getRabbitReady, publishOrderCreated, publishCartClearRequested, log }) => {
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
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return { statusCode: 400, body: { message: "orderId không hợp lệ!" } };
      }

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
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return { statusCode: 400, body: { message: "orderId không hợp lệ!" } };
      }

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
        if (!idempotencyKey || idempotencyKey.length < 8) {
          client.release();
          return { statusCode: 400, body: { message: "Thiếu hoặc sai định dạng x-idempotency-key." } };
        }

        const existingPayload = await replayByKey(userId, idempotencyKey);
        if (existingPayload) {
          client.release();
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

        if (!cartItems || cartItems.length === 0) {
          client.release();
          return { statusCode: 400, body: { message: "Giỏ hàng của bạn đang trống!" } };
        }

        await client.query("BEGIN");
        transactionStarted = true;
        const orderId = await orderModel.createOrderWithItems(client, { userId, idempotencyKey, grandTotal, cartItems });
        await client.query("COMMIT");
        client.release();

        const reserveItems = cartItems.map((item) => ({
          productId: item.product_id,
          quantity: Number(item.quantity),
          color: item.color,
          size: item.size,
        }));

        if (!getRabbitReady()) {
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

        publishOrderCreated(orderId, reserveItems);
        log("info", "order_created_event_published", { orderId, items: reserveItems.length });
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
          if (replayPayload.rows.length > 0) return { statusCode: 200, body: createReplayPayload(replayPayload.rows[0]) };
        }

        if (transactionStarted) await client.query("ROLLBACK");
        client.release();
        throw err;
      }
    },

    async updateStatus(orderId, status) {
      const allowedStatuses = ["PENDING", "CONFIRMED", "PAID", "CANCELLED", "EXPIRED", "Delivered"];

      if (!Number.isInteger(orderId) || orderId <= 0) {
        return { statusCode: 400, body: { message: "orderId không hợp lệ!" } };
      }

      if (!status || !allowedStatuses.includes(status)) {
        return { statusCode: 400, body: { message: "Trạng thái đơn hàng không hợp lệ!" } };
      }

      const result = await orderModel.updateStatus(orderId, status);
      if (result.rows.length === 0) {
        return { statusCode: 404, body: { message: "Không tìm thấy đơn hàng để cập nhật!" } };
      }

      return { statusCode: 200, body: { message: "Cập nhật trạng thái đơn hàng thành công!", data: result.rows[0] } };
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
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return { statusCode: 400, body: { message: "orderId không hợp lệ!" } };
      }

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
        log("info", "stock_reserved_order_confirmed", { orderId });
      }
    },

    async cancelOrderStockFailed(orderId, reason) {
      await orderModel.cancelPendingOrder(orderId);
      log("warn", "stock_failed_order_cancelled", { orderId, reason });
    },
  };
};

module.exports = { createOrderService };