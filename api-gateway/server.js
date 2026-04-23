const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const swaggerDocs = require('./swagger');
const app = express();
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
app.use(cors());

/**
 * @swagger
 * /api/products/all:
 *   get:
 *     summary: Lấy danh sách toàn bộ sản phẩm
 *     tags: [Product Service]
 *     responses:
 *       200:
 *         description: Trả về mảng chứa các đôi giày
 *       500:
 *         description: Lỗi máy chủ hoặc đứt kết nối Mongo
 */

/**
 * @swagger
 * /api/users/register:
 *   post:
 *     summary: Đăng ký tài khoản mới
 *     tags: [User Service]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: "nguyenvana"
 *               email:
 *                 type: string
 *                 example: "nguyenvana@gmail.com"
 *               password:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       201:
 *         description: Đăng ký thành công
 *       400:
 *         description: Thông tin không hợp lệ
 */

/**
 * @swagger
 * /api/users/login:
 *   post:
 *     summary: Đăng nhập
 *     tags: [User Service]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: "nguyenvana@gmail.com"
 *               password:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Đăng nhập thành công, trả về token
 *       401:
 *         description: Sai email hoặc mật khẩu
 */

/**
 * @swagger
 * /api/cart:
 *   get:
 *     summary: Xem giỏ hàng của user hiện tại
 *     tags: [Cart Service]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Trả về chi tiết giỏ hàng và tổng tiền
 *       401:
 *         description: Chưa đăng nhập
 */

/**
 * @swagger
 * /api/cart/add:
 *   post:
 *     summary: Thêm sản phẩm vào giỏ hàng
 *     tags: [Cart Service]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - productId
 *               - quantity
 *               - color
 *               - size
 *             properties:
 *               userId:
 *                 type: integer
 *                 example: 8
 *               productId:
 *                 type: string
 *                 example: "69e7a9ef235018961eec4634"
 *               quantity:
 *                 type: integer
 *                 example: 1
 *               color:
 *                 type: string
 *                 example: "Hồng"
 *               size:
 *                 type: number
 *                 example: 38
 *     responses:
 *       200:
 *         description: Thêm vào giỏ hàng thành công
 *       401:
 *         description: Chưa đăng nhập
 *       500:
 *         description: Lỗi hệ thống
 */

/**
 * @swagger
 * /api/cart/update:
 *   put:
 *     summary: Cập nhật số lượng sản phẩm trong giỏ hàng
 *     tags: [Cart Service]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - cartItemId
 *               - quantity
 *             properties:
 *               cartItemId:
 *                 type: integer
 *                 example: 1
 *               quantity:
 *                 type: integer
 *                 example: 2
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       401:
 *         description: Chưa đăng nhập
 *       500:
 *         description: Lỗi hệ thống
 */

/**
 * @swagger
 * /api/cart/remove/{cartItemId}:
 *   delete:
 *     summary: Xóa sản phẩm khỏi giỏ hàng
 *     tags: [Cart Service]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: cartItemId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID của item trong giỏ hàng
 *         example: 1
 *     responses:
 *       200:
 *         description: Xóa thành công
 *       401:
 *         description: Chưa đăng nhập
 *       500:
 *         description: Lỗi hệ thống
 */

/**
 * @swagger
 * /api/orders/checkout:
 *   post:
 *     summary: Thanh toán giỏ hàng
 *     tags: [Order Service]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Đặt hàng thành công
 *       401:
 *         description: Chưa đăng nhập
 *       400:
 *         description: Giỏ hàng trống
 */

/**
 * @swagger
 * /api/orders/history:
 *   get:
 *     summary: Xem lịch sử đơn hàng
 *     tags: [Order Service]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Trả về danh sách đơn hàng
 *       401:
 *         description: Chưa đăng nhập
 */


// =========================================================
// 1. NHÓM PROXY (TUYỆT ĐỐI KHÔNG ĐỂ express.json Ở TRÊN NHÓM NÀY)
// =========================================================

// Chuyển hướng sang User Service (Cổng 3001)
app.use('/api/users', createProxyMiddleware({ 
    target: 'http://user-service:3001', 
    changeOrigin: true,
    pathRewrite: { '^/api/users': '' } 
}));

// Chuyển hướng sang Product Service (Cổng 3002)
app.use('/api/products', createProxyMiddleware({ 
    target: 'http://product-service:3002', 
    changeOrigin: true,
    pathRewrite: { '^/api/products': '' } 
}));


// =========================================================
// 2. NHÓM CUSTOM ROUTE (PHẢI CÓ express.json Ở ĐÂY ĐỂ ĐỌC BODY)
// =========================================================
app.use(express.json()); // <-- Lính canh bắt đầu đứng từ đây!

// Chuyển hướng Giỏ Hàng bằng Axios
app.post('/api/cart/add', async (req, res) => {
    try {
        // CỰC KỲ QUAN TRỌNG: Phải copy cái Token từ Gateway đưa sang User Service
        const config = {
            headers: { Authorization: req.headers.authorization } 
        };
        
        const response = await axios.post('http://user-service:3001/cart/add', req.body, config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway' });
    }
});
// Chuyển hướng lấy Giỏ Hàng bằng Axios
app.get('/api/cart', async (req, res) => {
    try {
        // Bắt buộc phải bê theo Token từ khách hàng chuyển sang cho User Service
        const config = {
            headers: { Authorization: req.headers.authorization } 
        };
        
        const response = await axios.get('http://user-service:3001/cart', config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway' });
    }
});
// Chuyển hướng Cập nhật Giỏ hàng
app.put('/api/cart/update', async (req, res) => {
    try {
        const config = { headers: { Authorization: req.headers.authorization } };
        const response = await axios.put('http://user-service:3001/cart/update', req.body, config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway' });
    }
});

// Chuyển hướng Xóa sản phẩm khỏi Giỏ hàng
app.delete('/api/cart/remove/:cartItemId', async (req, res) => {
    try {
        const config = { headers: { Authorization: req.headers.authorization } };
        const response = await axios.delete(`http://user-service:3001/cart/remove/${req.params.cartItemId}`, config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway' });
    }
});
// Chuyển hướng Checkout (Thanh toán) sang Order Service (Cổng 3003)
app.post('/api/orders/checkout', async (req, res) => {
    try {
        const config = { headers: { Authorization: req.headers.authorization } };
        // GỌI SANG 3003 NHÉ!
        const response = await axios.post('http://order-service:3003/checkout', {}, config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway Order' });
    }
});
// Chuyển hướng Lịch sử Đơn hàng sang Order Service (Cổng 3003)
app.get('/api/orders/history', async (req, res) => {
    try {
        // Gắn Token vào xe chở hàng
        const config = { headers: { Authorization: req.headers.authorization } };
        
        // Gọi sang 3003 lấy dữ liệu
        const response = await axios.get('http://order-service:3003/history', config);
        res.status(response.status).json(response.data);
    } catch (err) {
        res.status(err.response?.status || 500).json(err.response?.data || { message: 'Lỗi Gateway Order History' });
    }
});
// =========================================================

app.get('/', (req, res) => {
    res.status(200).json({ message: '🚦 API Gateway đang hoạt động mượt mà!' });
});

const PORT = 8000;
app.listen(PORT, () => {
    console.log(`🚦 API Gateway đang đứng gác tại http://localhost:${PORT}`);
});
