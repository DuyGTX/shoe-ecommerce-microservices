const amqp = require('amqplib');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { pool, initDB } = require('./db');


const app = express();
app.use(cors());
app.use(express.json());

initDB();
let rabbitChannel;
const connectRabbitMQ = async () => {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        // Đảm bảo hòm thư tên là 'clear_cart_queue' luôn tồn tại
        await rabbitChannel.assertQueue('clear_cart_queue'); 
        console.log('🐇 Đã kết nối Bưu điện RabbitMQ thành công!');
    } catch (error) {
        console.error('❌ Lỗi kết nối RabbitMQ:', error.message);
    }
};
connectRabbitMQ();

// Middleware Bảo Vệ
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ message: 'Từ chối truy cập!' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        req.tokenString = token; // Lưu lại chuỗi token để lát nữa Order Service dùng đi gọi cửa Service khác
        next();
    } catch (err) {
        res.status(401).json({ message: 'Token không hợp lệ!' });
    }
};

// API: THỰC HIỆN THANH TOÁN (CHECKOUT)
app.post('/checkout', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const config = { headers: { Authorization: `Bearer ${req.tokenString}` } };

        // 1. NHẤC MÁY GỌI USER SERVICE: "Lấy cho tôi giỏ hàng của sếp lớn!"
        const cartResponse = await axios.get('http://localhost:3001/cart', config);
        const cartItems = cartResponse.data.data;
        const grandTotal = cartResponse.data.grandTotal;

        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({ message: 'Giỏ hàng của bạn đang trống!' });
        }

        // 2. LƯU VÀO DATABASE ĐƠN HÀNG
        // 2a. Tạo vỏ đơn hàng
        const newOrder = await pool.query(
            'INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, $3) RETURNING id',
            [userId, grandTotal, 'Success']
        );
        const orderId = newOrder.rows[0].id;

        // 2b. Đổ từng món trong giỏ vào bảng chi tiết đơn hàng
        for (let item of cartItems) {
            await pool.query(
                `INSERT INTO order_items (order_id, product_id, product_name, price, color, size, quantity, total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [orderId, item.product_id, item.product_name, item.price, item.color, item.size, item.quantity, item.total]
            );
        }

        // Lệnh cũ (ĐÃ XÓA): await axios.delete('http://localhost:3001/cart/clear', config);
        
        // 3. GỬI THƯ BÁO XÓA GIỎ HÀNG QUA RABBITMQ (BẤT ĐỒNG BỘ)
        const message = JSON.stringify({ userId: userId });
        rabbitChannel.sendToQueue('clear_cart_queue', Buffer.from(message));
        console.log(`✉️ Đã gửi thư yêu cầu xóa giỏ hàng của User ID: ${userId}`);
        res.status(200).json({
            message: '🎉 Chốt đơn thành công! (Dữ liệu đang được xử lý ngầm)',
            orderId: orderId,
            totalPaid: grandTotal
        });

    } catch (err) {
        console.error('Lỗi quá trình thanh toán:', err.message);
        res.status(500).json({ message: 'Lỗi khi xử lý đơn hàng!' });
    }
});
// ---------------------------------------------------------
// API: XEM LỊCH SỬ MUA HÀNG (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.get('/history', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id; // Lấy ID khách hàng từ Token

        // 1. Tìm tất cả các "Vỏ đơn hàng" của khách này (Sắp xếp mới nhất lên đầu)
        const ordersResult = await pool.query(
            'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        const orders = ordersResult.rows;

        // Nếu chưa mua gì thì báo về luôn
        if (orders.length === 0) {
            return res.status(200).json({ 
                message: 'Bạn chưa có đơn hàng nào!', 
                data: [] 
            });
        }

        // 2. Với mỗi đơn hàng, lấy chi tiết các món đồ bên trong
        for (let order of orders) {
            const itemsResult = await pool.query(
                'SELECT * FROM order_items WHERE order_id = $1',
                [order.id]
            );
            // Gắn mảng chi tiết vào trong object của đơn hàng đó
            order.items = itemsResult.rows; 
        }

        res.status(200).json({
            message: 'Lấy lịch sử mua hàng thành công!',
            totalOrders: orders.length,
            data: orders
        });

    } catch (err) {
        console.error('Lỗi API Lịch sử đơn hàng:', err.message);
        res.status(500).json({ message: 'Lỗi khi lấy dữ liệu đơn hàng!' });
    }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
    console.log(`🚀 Order Service đang chạy tại http://localhost:${PORT}`);
});