const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const createPaymentRoutes = ({ buildServiceHeaders }) => {
    const router = express.Router();

    router.use('/payments', createProxyMiddleware({
        target: 'http://payment-service:3004',
        changeOrigin: true,
        pathRewrite: { '^/api/payments': '' },
        onProxyReq: (proxyReq, req) => {
            Object.entries(buildServiceHeaders(req, { forwardAuthorization: true })).forEach(([key, value]) => {
                proxyReq.setHeader(key, value);
            });
        }
    }));

    return router;
};

module.exports = { createPaymentRoutes };