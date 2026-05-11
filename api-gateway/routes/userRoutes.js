const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const setProxyHeaders = (proxyReq, req, buildServiceHeaders, options = {}) => {
    const headers = buildServiceHeaders(req, options);
    Object.entries(headers).forEach(([key, value]) => {
        proxyReq.setHeader(key, value);
    });
};

const createUserProxyRoutes = ({ buildServiceHeaders }) => {
    const router = express.Router();

    router.use('/users', createProxyMiddleware({
        target: 'http://user-service:3001',
        changeOrigin: true,
        pathRewrite: { '^/api/users': '' },
        onProxyReq: (proxyReq, req) => setProxyHeaders(proxyReq, req, buildServiceHeaders)
    }));

    return router;
};

const createUserJsonRoutes = ({ buildServiceHeaders, requestWithRetry, forwardGatewayError }) => {
    const router = express.Router();

    router.post('/cart/add', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'post',
                url: 'http://user-service:3001/cart/add',
                data: req.body,
                headers: buildServiceHeaders(req, { forwardAuthorization: true }),
                timeout: 4000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway cart add failed'));
        }
    });

    router.get('/cart', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'get',
                url: 'http://user-service:3001/cart',
                headers: buildServiceHeaders(req, { forwardAuthorization: true }),
                timeout: 4000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway cart fetch failed'));
        }
    });

    router.put('/cart/update', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'put',
                url: 'http://user-service:3001/cart/update',
                data: req.body,
                headers: buildServiceHeaders(req, { forwardAuthorization: true }),
                timeout: 4000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway cart update failed'));
        }
    });

    router.delete('/cart/remove/:cartItemId', async (req, res, next) => {
        try {
            const response = await requestWithRetry({
                method: 'delete',
                url: `http://user-service:3001/cart/remove/${req.params.cartItemId}`,
                headers: buildServiceHeaders(req, { forwardAuthorization: true }),
                timeout: 4000
            });
            res.status(response.status).json(response.data);
        } catch (err) {
            return next(forwardGatewayError(err, 'Gateway cart remove failed'));
        }
    });

    return router;
};

module.exports = { createUserProxyRoutes, createUserJsonRoutes };