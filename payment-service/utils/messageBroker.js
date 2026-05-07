const amqp = require("amqplib");

const PAYMENT_EVENTS_EXCHANGE = "payment_events";

const createMessageBroker = ({ rabbitmqUrl, logger }) => {
  let connection;
  let channel;

  const connect = async () => {
    if (!rabbitmqUrl) {
      logger.warn("rabbitmq_url_missing");
      return;
    }

    try {
      connection = await amqp.connect(rabbitmqUrl);
      channel = await connection.createChannel();
      await channel.assertExchange(PAYMENT_EVENTS_EXCHANGE, "topic", { durable: true });

      connection.on("error", (error) => logger.error("rabbitmq_connection_error", { error }));
      connection.on("close", () => {
        connection = undefined;
        channel = undefined;
        logger.warn("rabbitmq_connection_closed");
      });

      logger.info("rabbitmq_connected", { exchange: PAYMENT_EVENTS_EXCHANGE });
    } catch (error) {
      logger.error("rabbitmq_connect_failed", { error });
    }
  };

  const publishEvent = async (routingKey, message) => {
    if (!channel) {
      logger.error("rabbitmq_publish_failed", { routingKey, reason: "channel_not_ready", message });
      return false;
    }

    const payload = Buffer.from(JSON.stringify(message));
    const published = channel.publish(PAYMENT_EVENTS_EXCHANGE, routingKey, payload, {
      persistent: true,
      contentType: "application/json",
    });

    logger.info("rabbitmq_event_published", {
      exchange: PAYMENT_EVENTS_EXCHANGE,
      routingKey,
      orderId: message?.orderId,
      status: message?.status,
      published,
    });
    return published;
  };

  const close = async () => {
    if (channel) {
      await channel.close();
      channel = undefined;
      logger.info("rabbitmq_channel_closed");
    }

    if (connection) {
      await connection.close();
      connection = undefined;
      logger.info("rabbitmq_connection_closed");
    }
  };

  return {
    connect,
    close,
    publishEvent,
    getReady: () => Boolean(channel),
  };
};

module.exports = { createMessageBroker, PAYMENT_EVENTS_EXCHANGE };