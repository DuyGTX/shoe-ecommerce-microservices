const mongoose = require('mongoose');

const Product = require('../models/Product');
const InventoryLog = require('../models/InventoryLog');
const { sleep } = require('../utils/sleep');

const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3003';
const ORDER_EVENTS_EXCHANGE = 'order_events';
const STOCK_EVENTS_EXCHANGE = 'stock_events';
const ORDER_CREATED_QUEUE = 'product_order_created_queue';
const STOCK_RELEASE_REQUESTED_QUEUE = 'product_stock_release_queue';
const STOCK_RELEASE_DLX = 'stock_release_dlx';
const STOCK_HOLDING_QUEUE = 'stock_holding_queue';
const STOCK_RELEASE_QUEUE = 'stock_release_queue';
const STOCK_RELEASE_ROUTING_KEY = 'stock.expired';
const STOCK_HOLD_TTL_MS = Number(process.env.STOCK_HOLD_TTL_MS || 300000);

const createStockService = ({ getRabbitChannel, setRabbitChannel, clearProductCache, rollbackStock, logger }) => {
    const publishStockEvent = (routingKey, payload) => {
        const rabbitChannel = getRabbitChannel();
        if (!rabbitChannel) return false;
        return rabbitChannel.publish(
            STOCK_EVENTS_EXCHANGE,
            routingKey,
            Buffer.from(JSON.stringify(payload)),
            { persistent: true, contentType: 'application/json' },
        );
    };

    const publishStockHolding = (payload) => {
        const rabbitChannel = getRabbitChannel();
        if (!rabbitChannel) return false;
        return rabbitChannel.sendToQueue(
            STOCK_HOLDING_QUEUE,
            Buffer.from(JSON.stringify(payload)),
            { persistent: true, contentType: 'application/json' },
        );
    };

    const fetchOrderStatus = async (orderId) => {
        const response = await fetch(`${ORDER_SERVICE_URL}/internal/orders/${orderId}`, {
            headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN || '' },
        });

        if (!response.ok) {
            throw new Error(`Không lấy được trạng thái đơn hàng ${orderId}: HTTP ${response.status}`);
        }

        const body = await response.json();
        return body.data;
    };

    const expireOrder = async (orderId) => {
        if (!INTERNAL_SERVICE_TOKEN) return;
        const response = await fetch(`${ORDER_SERVICE_URL}/internal/orders/${orderId}/expire`, {
            method: 'PATCH',
            headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN },
        });

        if (!response.ok && response.status !== 409) {
            throw new Error(`Không cập nhật được đơn hàng hết hạn ${orderId}: HTTP ${response.status}`);
        }
    };

    const reserveOrderStock = async ({ orderId, items = [] }) => {
        const session = await mongoose.startSession();
        let alreadyProcessed = false;
        try {
            await session.withTransaction(async () => {
                try {
                    await InventoryLog.create([{ orderId: String(orderId), action: 'RESERVE_STOCK', items }], { session });
                } catch (err) {
                    if (err.code === 11000) {
                        alreadyProcessed = true;
                        logger.info('stock_reservation_transaction_committed', { orderId, status: 'COMMITTED', idempotentReplay: true });
                        return;
                    }
                    throw err;
                }

                for (const item of items) {
                    const result = await Product.updateOne(
                        {
                            _id: item.productId,
                            variants: {
                                $elemMatch: {
                                    color: item.color,
                                    size: Number(item.size),
                                    stock: { $gte: Number(item.quantity) },
                                },
                            },
                        },
                        { $inc: { 'variants.$.stock': -Number(item.quantity) } },
                        { session },
                    );

                    if (result.modifiedCount !== 1) {
                        throw new Error(`Không đủ tồn kho cho sản phẩm ${item.productId}`);
                    }
                }
            });

            if (alreadyProcessed) return;

            await clearProductCache();
            publishStockEvent('stock.reserved', { orderId });
            publishStockHolding({
                orderId,
                items: items.map((item) => ({
                    productId: item.productId,
                    color: item.color,
                    size: Number(item.size),
                    quantity: Number(item.quantity),
                })),
            });
            logger.info('stock_reservation_transaction_committed', { orderId, status: 'COMMITTED', itemCount: items.length });
            logger.info('stock_reserved', { orderId, itemCount: items.length });
        } catch (err) {
            logger.warn('stock_reservation_transaction_aborted', { orderId, status: 'ABORTED', reason: err.message, error: err });
            publishStockEvent('stock.failed', { orderId, reason: err.message });
            logger.warn('stock_reservation_failed', { orderId, reason: err.message, error: err });
        } finally {
            await session.endSession();
        }
    };

    const releaseExpiredStock = async ({ orderId, items = [] }) => {
        const order = await fetchOrderStatus(orderId);
        if (!['PENDING', 'CANCELLED'].includes(order.status)) {
            logger.info('stock_release_skipped_order_finalized', { orderId, status: order.status });
            return;
        }

        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                try {
                    await InventoryLog.create([{ orderId: String(orderId), action: 'RELEASE_EXPIRED_STOCK', items }], { session });
                } catch (err) {
                    if (err.code === 11000) {
                        logger.info('stock_release_already_processed', { orderId });
                        return;
                    }
                    throw err;
                }

                for (const item of items) {
                    const result = await Product.updateOne(
                        {
                            _id: item.productId,
                            variants: { $elemMatch: { color: item.color, size: Number(item.size) } },
                        },
                        { $inc: { 'variants.$.stock': Number(item.quantity) } },
                        { session },
                    );

                    if (result.modifiedCount !== 1) {
                        throw new Error(`Không hoàn được tồn kho cho sản phẩm ${item.productId}`);
                    }

                    logger.info('stock_released_after_payment_timeout', {
                        orderId,
                        productId: item.productId,
                        quantity: Number(item.quantity),
                        message: `Đã hoàn lại ${Number(item.quantity)} sản phẩm cho đơn hàng ${orderId} do hết hạn thanh toán.`,
                    });
                }
            });

            logger.info('stock_release_transaction_committed', { orderId, status: 'COMMITTED', itemCount: items.length });

            await clearProductCache();
            if (order.status === 'PENDING') await expireOrder(orderId);
        } catch (err) {
            logger.warn('stock_release_transaction_aborted', { orderId, status: 'ABORTED', reason: err.message, error: err });
            throw err;
        } finally {
            await session.endSession();
        }
    };

    const bindStockConsumers = async (connection) => {
        const rabbitChannel = await connection.createChannel();
        setRabbitChannel(rabbitChannel);

        await rabbitChannel.assertExchange(ORDER_EVENTS_EXCHANGE, 'topic', { durable: true });
        await rabbitChannel.assertExchange(STOCK_EVENTS_EXCHANGE, 'topic', { durable: true });
        await rabbitChannel.assertExchange(STOCK_RELEASE_DLX, 'direct', { durable: true });
        await rabbitChannel.assertQueue(STOCK_HOLDING_QUEUE, {
            durable: true,
            arguments: {
                'x-message-ttl': STOCK_HOLD_TTL_MS,
                'x-dead-letter-exchange': STOCK_RELEASE_DLX,
                'x-dead-letter-routing-key': STOCK_RELEASE_ROUTING_KEY,
            },
        });
        await rabbitChannel.assertQueue(STOCK_RELEASE_QUEUE, { durable: true });
        await rabbitChannel.bindQueue(STOCK_RELEASE_QUEUE, STOCK_RELEASE_DLX, STOCK_RELEASE_ROUTING_KEY);
        await rabbitChannel.assertQueue(STOCK_RELEASE_REQUESTED_QUEUE, { durable: true });
        await rabbitChannel.bindQueue(STOCK_RELEASE_REQUESTED_QUEUE, STOCK_EVENTS_EXCHANGE, 'stock.release_requested');
        await rabbitChannel.assertQueue(ORDER_CREATED_QUEUE, { durable: true });
        await rabbitChannel.bindQueue(ORDER_CREATED_QUEUE, ORDER_EVENTS_EXCHANGE, 'order.created');
        await rabbitChannel.prefetch(5);

        rabbitChannel.consume(ORDER_CREATED_QUEUE, async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString());
                await reserveOrderStock(payload);
                rabbitChannel.ack(msg);
            } catch (err) {
                logger.error('order_created_consume_failed', { error: err });
                rabbitChannel.nack(msg, false, true);
            }
        });

        rabbitChannel.consume(STOCK_RELEASE_QUEUE, async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString());
                await releaseExpiredStock(payload);
                rabbitChannel.ack(msg);
            } catch (err) {
                logger.error('stock_release_consume_failed', { error: err });
                rabbitChannel.nack(msg, false, true);
            }
        });

        rabbitChannel.consume(STOCK_RELEASE_REQUESTED_QUEUE, async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString());
                const { orderId, reason = 'payment_failed', items = [] } = payload;
                logger.info('stock_release_requested_consumed', { orderId, reason, itemCount: items.length });
                await rollbackStock({ orderId, reason, items });
                rabbitChannel.ack(msg);
                logger.info('stock_release_requested_acked', { orderId, reason });
            } catch (err) {
                logger.error('stock_release_requested_consume_failed', { error: err });
                rabbitChannel.nack(msg, false, true);
            }
        });
    };

    return { bindStockConsumers };
};

module.exports = { createStockService };