const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');

const app = express();
app.use(cors());

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