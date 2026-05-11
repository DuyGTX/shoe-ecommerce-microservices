const express = require('express');

const createOrderRoutes = ({ buildServiceHeaders, requestWithRetry, forwardGatewayError }) => {
    const router = express.Router();

    router.get('/orders/health', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'get',
                url: 'http://order-service:3003/health',
                headers: buildServiceHeaders(req),
                timeout: 1500
            }, { retries: 2, delayMs: 200 });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Order health check failed', 503));
        }
    });

    router.post('/orders/checkout', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'post',
                url: 'http://order-service:3003/checkout',
                data: {},
                headers: {
                    ...buildServiceHeaders(req, { forwardAuthorization: true }),
                    'x-idempotency-key': req.headers['x-idempotency-key']
                },
                timeout: 5000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway order checkout failed'));
        }
    });

    router.get('/orders/history', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'get',
                url: 'http://order-service:3003/history',
                headers: buildServiceHeaders(req, { forwardAuthorization: true }),
                timeout: 5000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway order history failed'));
        }
    });

    return router;
};

module.exports = { createOrderRoutes };