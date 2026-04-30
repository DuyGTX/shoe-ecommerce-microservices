const amqp = require("amqplib");
const { sleep } = require("../utils/sleep");

const ORDER_EVENTS_EXCHANGE = "order_events";
const STOCK_EVENTS_EXCHANGE = "stock_events";
const STOCK_RESERVED_QUEUE = "order_stock_reserved_queue";
const STOCK_FAILED_QUEUE = "order_stock_failed_queue";

const createMessageBroker = ({ rabbitmqUrl, log }) => {
  let rabbitChannel;
  let orderService;

  const publishOrderCreated = (orderId, items) => {
    if (!rabbitChannel) return false;
    const payload = { orderId, items };
    return rabbitChannel.publish(
      ORDER_EVENTS_EXCHANGE,
      "order.created",
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
    );
  };

  const publishCartClearRequested = (userId, orderId) => {
    if (!rabbitChannel) return false;
    const message = JSON.stringify({ userId, orderId });
    return rabbitChannel.sendToQueue("clear_cart_queue_v2", Buffer.from(message), { persistent: true });
  };

  const consumeStockEvents = async () => {
    rabbitChannel.consume(STOCK_RESERVED_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const { orderId } = JSON.parse(msg.content.toString());
        await orderService.confirmOrderStockReserved(orderId);
        rabbitChannel.ack(msg);
      } catch (err) {
        log("error", "stock_reserved_consume_failed", { error: err.message });
        rabbitChannel.nack(msg, false, true);
      }
    });

    rabbitChannel.consume(STOCK_FAILED_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const { orderId, reason } = JSON.parse(msg.content.toString());
        await orderService.cancelOrderStockFailed(orderId, reason);
        rabbitChannel.ack(msg);
      } catch (err) {
        log("error", "stock_failed_consume_failed", { error: err.message });
        rabbitChannel.nack(msg, false, true);
      }
    });
  };

  const connect = async () => {
    try {
      const connection = await amqp.connect(rabbitmqUrl);
      rabbitChannel = await connection.createChannel();
      connection.on("error", (err) => {
        console.error("❌ RabbitMQ connection error:", err.message);
      });
      connection.on("close", async () => {
        console.warn("⚠️ RabbitMQ disconnected, retrying in 3s...");
        rabbitChannel = undefined;
        await sleep(3000);
        connect();
      });
      await rabbitChannel.assertExchange(ORDER_EVENTS_EXCHANGE, "topic", { durable: true });
      await rabbitChannel.assertExchange(STOCK_EVENTS_EXCHANGE, "topic", { durable: true });
      await rabbitChannel.assertExchange("clear_cart_dlx", "direct", { durable: true });
      await rabbitChannel.assertQueue("clear_cart_dlq", { durable: true });
      await rabbitChannel.bindQueue("clear_cart_dlq", "clear_cart_dlx", "clear_cart_failed");

      // Main queue forwards unrecoverable cart-clear failures to the DLQ.
      await rabbitChannel.assertQueue("clear_cart_queue_v2", {
        durable: true,
        arguments: { "x-dead-letter-exchange": "clear_cart_dlx" },
      });

      await rabbitChannel.assertQueue(STOCK_RESERVED_QUEUE, { durable: true });
      await rabbitChannel.bindQueue(STOCK_RESERVED_QUEUE, STOCK_EVENTS_EXCHANGE, "stock.reserved");
      await rabbitChannel.assertQueue(STOCK_FAILED_QUEUE, { durable: true });
      await rabbitChannel.bindQueue(STOCK_FAILED_QUEUE, STOCK_EVENTS_EXCHANGE, "stock.failed");

      await consumeStockEvents();
      console.log("🐇 Đã kết nối Bưu điện RabbitMQ thành công!");
    } catch (error) {
      console.error("❌ Lỗi kết nối RabbitMQ:", error.message);
    }
  };

  return {
    connect,
    publishOrderCreated,
    publishCartClearRequested,
    getRabbitReady: () => Boolean(rabbitChannel),
    setOrderService: (service) => {
      orderService = service;
    },
  };
};

module.exports = { createMessageBroker };