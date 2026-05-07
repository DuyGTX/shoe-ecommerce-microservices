const amqp = require("amqplib");

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
      connection.on("error", (error) => logger.error("rabbitmq_connection_error", { error }));
      connection.on("close", () => {
        connection = undefined;
        channel = undefined;
        logger.warn("rabbitmq_connection_closed");
      });
      logger.info("rabbitmq_connected");
    } catch (error) {
      logger.error("rabbitmq_connect_failed", { error });
    }
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
    getReady: () => Boolean(channel),
  };
};

module.exports = { createMessageBroker };