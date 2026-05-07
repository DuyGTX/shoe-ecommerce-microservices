const amqp = require("amqplib");
const { sleep } = require("../utils/sleep");

const ORDER_EVENTS_EXCHANGE = "order_events";
const STOCK_EVENTS_EXCHANGE = "stock_events";
const PAYMENT_EVENTS_EXCHANGE = "payment_events";
const STOCK_RESERVED_QUEUE = "order_stock_reserved_queue";
const STOCK_FAILED_QUEUE = "order_stock_failed_queue";
const PAYMENT_COMPLETED_QUEUE = "order_payment_completed_queue";
const PAYMENT_FAILED_QUEUE = "order_payment_failed_queue";

const createMessageBroker = ({ rabbitmqUrl, logger }) => {
  let rabbitConnection;
  let rabbitChannel;
  let isShuttingDown = false;
  let orderService;

  const publishOrderCreated = (orderId, items) => {
    if (!rabbitChannel) {
      logger.warn("rabbitmq_publish_skipped", { event: "order.created", orderId, reason: "channel_not_ready" });
      return false;
    }
    const payload = { orderId, items };
    const published = rabbitChannel.publish(
      ORDER_EVENTS_EXCHANGE,
      "order.created",
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
    );
    logger.info("rabbitmq_event_published", {
      exchange: ORDER_EVENTS_EXCHANGE,
      routingKey: "order.created",
      orderId,
      itemCount: items.length,
      published,
    });
    return published;
  };

  const publishCartClearRequested = (userId, orderId) => {
    if (!rabbitChannel) {
      logger.warn("rabbitmq_publish_skipped", { queue: "clear_cart_queue_v2", userId, orderId, reason: "channel_not_ready" });
      return false;
    }
    const message = JSON.stringify({ userId, orderId });
    const published = rabbitChannel.sendToQueue("clear_cart_queue_v2", Buffer.from(message), { persistent: true });
    logger.info("rabbitmq_event_published", {
      queue: "clear_cart_queue_v2",
      event: "cart.clear_requested",
      userId,
      orderId,
      published,
    });
    return published;
  };

  const publishStockReleaseRequested = (orderId, items = [], reason = "payment_failed") => {
    if (!rabbitChannel) {
      logger.warn("rabbitmq_publish_skipped", {
        exchange: STOCK_EVENTS_EXCHANGE,
        routingKey: "stock.release_requested",
        orderId,
        reason: "channel_not_ready",
      });
      return false;
    }

    const payload = { orderId, reason, items };
    const published = rabbitChannel.publish(
      STOCK_EVENTS_EXCHANGE,
      "stock.release_requested",
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
    );

    logger.info("rabbitmq_event_published", {
      exchange: STOCK_EVENTS_EXCHANGE,
      routingKey: "stock.release_requested",
      orderId,
      reason,
      itemCount: items.length,
      published,
    });
    return published;
  };

  const consumeStockEvents = async () => {
    rabbitChannel.consume(STOCK_RESERVED_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const { orderId } = JSON.parse(msg.content.toString());
        logger.info("rabbitmq_event_consumed", { queue: STOCK_RESERVED_QUEUE, event: "stock.reserved", orderId });
        await orderService.confirmOrderStockReserved(orderId);
        rabbitChannel.ack(msg);
        logger.info("rabbitmq_message_acked", { queue: STOCK_RESERVED_QUEUE, event: "stock.reserved", orderId });
      } catch (err) {
        logger.error("stock_reserved_consume_failed", { error: err });
        rabbitChannel.nack(msg, false, true);
        logger.warn("rabbitmq_message_nacked", { queue: STOCK_RESERVED_QUEUE, event: "stock.reserved", requeue: true });
      }
    });

    rabbitChannel.consume(STOCK_FAILED_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const { orderId, reason } = JSON.parse(msg.content.toString());
        logger.info("rabbitmq_event_consumed", { queue: STOCK_FAILED_QUEUE, event: "stock.failed", orderId, reason });
        await orderService.cancelOrderStockFailed(orderId, reason);
        rabbitChannel.ack(msg);
        logger.info("rabbitmq_message_acked", { queue: STOCK_FAILED_QUEUE, event: "stock.failed", orderId });
      } catch (err) {
        logger.error("stock_failed_consume_failed", { error: err });
        rabbitChannel.nack(msg, false, true);
        logger.warn("rabbitmq_message_nacked", { queue: STOCK_FAILED_QUEUE, event: "stock.failed", requeue: true });
      }
    });
  };

  const consumePaymentEvents = async () => {
    rabbitChannel.consume(PAYMENT_COMPLETED_QUEUE, async (msg) => {
      if (!msg) return;
      const routingKey = msg.fields.routingKey;
      let orderId;
      try {
        ({ orderId } = JSON.parse(msg.content.toString()));
        logger.info("rabbitmq_event_consumed", { queue: PAYMENT_COMPLETED_QUEUE, routingKey, orderId, status: "paid" });
        await orderService.updateOrderStatus(orderId, "paid");
        rabbitChannel.ack(msg);
        logger.info("rabbitmq_message_acked", { queue: PAYMENT_COMPLETED_QUEUE, routingKey, orderId, status: "paid" });
      } catch (err) {
        logger.error("payment_completed_consume_failed", { error: err, queue: PAYMENT_COMPLETED_QUEUE, routingKey, orderId });
        rabbitChannel.nack(msg, false, true);
        logger.warn("rabbitmq_message_nacked", { queue: PAYMENT_COMPLETED_QUEUE, routingKey, orderId, requeue: true });
      }
    });

    rabbitChannel.consume(PAYMENT_FAILED_QUEUE, async (msg) => {
      if (!msg) return;
      const routingKey = msg.fields.routingKey;
      let orderId;
      try {
        ({ orderId } = JSON.parse(msg.content.toString()));
        logger.info("rabbitmq_event_consumed", { queue: PAYMENT_FAILED_QUEUE, routingKey, orderId, status: "failed" });
        const result = await orderService.updateOrderStatus(orderId, "failed");
        if (result.updated) {
          const items = await orderService.getOrderItemsForSaga(orderId);
          publishStockReleaseRequested(orderId, items, "payment_failed");
        }
        rabbitChannel.ack(msg);
        logger.info("rabbitmq_message_acked", { queue: PAYMENT_FAILED_QUEUE, routingKey, orderId, status: "failed" });
      } catch (err) {
        logger.error("payment_failed_consume_failed", { error: err, queue: PAYMENT_FAILED_QUEUE, routingKey, orderId });
        rabbitChannel.nack(msg, false, true);
        logger.warn("rabbitmq_message_nacked", { queue: PAYMENT_FAILED_QUEUE, routingKey, orderId, requeue: true });
      }
    });
  };

  const connect = async () => {
    if (isShuttingDown) return;

    try {
      rabbitConnection = await amqp.connect(rabbitmqUrl);
      rabbitChannel = await rabbitConnection.createChannel();
      rabbitConnection.on("error", (err) => {
        logger.error("rabbitmq_connection_error", { error: err });
      });
      rabbitConnection.on("close", async () => {
        rabbitConnection = undefined;
        rabbitChannel = undefined;
        if (isShuttingDown) return;
        logger.warn("rabbitmq_disconnected_retrying", { retryInMs: 3000 });
        await sleep(3000);
        connect();
      });
      await rabbitChannel.assertExchange(ORDER_EVENTS_EXCHANGE, "topic", { durable: true });
      await rabbitChannel.assertExchange(STOCK_EVENTS_EXCHANGE, "topic", { durable: true });
      await rabbitChannel.assertExchange(PAYMENT_EVENTS_EXCHANGE, "topic", { durable: true });
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

      await rabbitChannel.assertQueue(PAYMENT_COMPLETED_QUEUE, { durable: true });
      await rabbitChannel.bindQueue(PAYMENT_COMPLETED_QUEUE, PAYMENT_EVENTS_EXCHANGE, "payment.completed");
      await rabbitChannel.assertQueue(PAYMENT_FAILED_QUEUE, { durable: true });
      await rabbitChannel.bindQueue(PAYMENT_FAILED_QUEUE, PAYMENT_EVENTS_EXCHANGE, "payment.failed");

      await consumeStockEvents();
      await consumePaymentEvents();
      logger.info("rabbitmq_connected", {
        exchanges: [ORDER_EVENTS_EXCHANGE, STOCK_EVENTS_EXCHANGE, PAYMENT_EVENTS_EXCHANGE, "clear_cart_dlx"],
        queues: ["clear_cart_queue_v2", "clear_cart_dlq", STOCK_RESERVED_QUEUE, STOCK_FAILED_QUEUE, PAYMENT_COMPLETED_QUEUE, PAYMENT_FAILED_QUEUE],
      });
    } catch (error) {
      logger.error("rabbitmq_connect_failed", { error });
    }
  };

  const close = async () => {
    isShuttingDown = true;
    if (rabbitChannel) {
      await rabbitChannel.close();
      rabbitChannel = undefined;
      logger.info("rabbitmq_channel_closed");
    }
    if (rabbitConnection) {
      await rabbitConnection.close();
      rabbitConnection = undefined;
      logger.info("rabbitmq_connection_closed");
    }
  };

  return {
    connect,
    close,
    publishOrderCreated,
    publishCartClearRequested,
    getRabbitReady: () => Boolean(rabbitChannel),
    setOrderService: (service) => {
      orderService = service;
    },
  };
};

module.exports = { createMessageBroker };