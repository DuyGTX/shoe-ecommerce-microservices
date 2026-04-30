module.exports = {
  explorer: true,
  swaggerOptions: {
    urls: [
      { name: 'User Service', url: '/api-docs/specs/user-service.json' },
      { name: 'Product Service', url: '/api-docs/specs/product-service.json' },
      { name: 'Order Service', url: '/api-docs/specs/order-service.json' },
    ],
  },
};