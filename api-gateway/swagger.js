const swaggerJsDoc = require('swagger-jsdoc');

const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'Shoe E-Commerce API',
      version: '1.0.0',
      description: 'Tài liệu API Microservices do DuyGTX phát triển',
      contact: {
        name: 'Backend Developer'
      }
    },
    servers: [
      {
        url: 'http://localhost:8000',
        description: 'API Gateway (Local)'
      }
    ],
    // Cấu hình ổ khóa để nhập Token
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }
      }
    }
  },
  // Nơi hệ thống sẽ quét để tìm các ghi chú API
  apis: ['./server.js'], 
};

module.exports = swaggerJsDoc(swaggerOptions);