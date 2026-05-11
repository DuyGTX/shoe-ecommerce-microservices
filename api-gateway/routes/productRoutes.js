const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const createProductRoutes = ({ buildServiceHeaders }) => {
    const router = express.Router();

    router.use('/products', createProxyMiddleware({
        target: 'http://product-service:3002',
        changeOrigin: true,
        pathRewrite: { '^/api/products': '' },
        onProxyReq: (proxyReq, req) => {
            Object.entries(buildServiceHeaders(req)).forEach(([key, value]) => {
                proxyReq.setHeader(key, value);
            });
        }
    }));

    return router;
};

module.exports = { createProductRoutes };