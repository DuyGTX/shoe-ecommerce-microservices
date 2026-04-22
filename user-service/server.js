const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

// Lấy pool và initDB từ file db.js
const { pool, initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json()); 

// ---------------------------------------------------------
// 1. TỰ ĐỘNG TẠO BẢNG DATABASE
// ---------------------------------------------------------
// Gọi hàm tạo bảng cart_items (từ db.js)
initDB();

// Tự động tạo thêm bảng users (nếu chưa có)
const initUsersTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('📦 Bảng [users] trong PostgreSQL đã sẵn sàng!');
    } catch (err) {
        console.error('❌ Lỗi tạo bảng users:', err);
    }
};
initUsersTable();

// ---------------------------------------------------------
// 2. CÁC API CỦA USER SERVICE
// ---------------------------------------------------------

// API 1: Test sức khỏe
app.get('/health', (req, res) => {
    res.status(200).json({ message: 'User Service đang hoạt động bình thường!' });
});

// API 2: Đăng ký tài khoản (Sign Up)
app.post('/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;

        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: 'Email này đã được sử dụng!' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            'INSERT INTO users (email, password, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name',
            [email, hashedPassword, full_name]
        );

        res.status(201).json({
            message: 'Đăng ký tài khoản thành công!',
            user: newUser.rows[0]
        });
    } catch (err) {
        console.error('Lỗi API Register:', err);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// API 3: Đăng nhập (Sign In) & Cấp JWT
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng!' });
        }
        
        const user = userResult.rows[0];

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng!' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email }, 
            process.env.JWT_SECRET, 
            { expiresIn: '1d' }
        );

        res.status(200).json({
            message: 'Đăng nhập thành công!',
            token: token,
            user: { id: user.id, full_name: user.full_name, email: user.email }
        });
    } catch (err) {
        console.error('Lỗi API Login:', err);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});
// ---------------------------------------------------------
// BẢO VỆ CỬA (MIDDLEWARE KIỂM TRA JWT)
// ---------------------------------------------------------
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(403).json({ message: 'Bạn chưa cung cấp Thẻ thông hành (Token).' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Gắn thông tin giải mã được vào request
        next(); 
    } catch (err) {
        return res.status(401).json({ message: 'Thẻ thông hành giả mạo hoặc đã hết hạn!' });
    }
};

// ---------------------------------------------------------
// API 4: Thêm sản phẩm vào giỏ hàng (ĐÃ KHÓA BẢO MẬT)
// ---------------------------------------------------------
// Gắn verifyToken vào giữa đường dẫn và hàm xử lý
app.post('/cart/add', verifyToken, async (req, res) => {
    try {
        // Lấy userId CHUẨN từ chính Token (Đã được anh bảo vệ giải mã), KHÔNG lấy từ req.body nữa
        const userId = req.user.id; 
        
        // Body bây giờ chỉ cần thông tin về món hàng
        const { productId, quantity, color, size } = req.body;

        // ... (Toàn bộ phần code logic gọi Axios và lưu PostgreSQL ở dưới GIỮ NGUYÊN) ...
        const response = await axios.get(`http://localhost:3002/${productId}`);
        const product = response.data.data;

        if (!product) return res.status(404).json({ message: 'Sản phẩm không tồn tại!' });

        const variant = product.variants.find(v => v.color === color && v.size === size);

        if (!variant || variant.stock < quantity) {
            return res.status(400).json({ message: 'Sản phẩm này đã hết hàng hoặc không đủ số lượng!' });
        }

        const finalPrice = product.salePrice ? product.salePrice : product.price;
        const total = finalPrice * quantity;

        const checkCart = await pool.query(
            'SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2 AND color = $3 AND size = $4',
            [userId, productId, color, size]
        );

        if (checkCart.rows.length > 0) {
            await pool.query(
                'UPDATE cart_items SET quantity = quantity + $1, total = total + $2 WHERE id = $3',
                [quantity, total, checkCart.rows[0].id]
            );
        } else {
            await pool.query(
                `INSERT INTO cart_items (user_id, product_id, product_name, price, color, size, quantity, total) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [userId, productId, product.name, finalPrice, color, size, quantity, total]
            );
        }

        res.status(200).json({
            message: 'Đã thêm thành công vào giỏ hàng của bạn!',
            cartItem: { productName: product.name, price: finalPrice, color, size, quantity, total }
        });
    } catch (err) {
        console.error('Lỗi khi gọi Product Service:', err.message);
        res.status(500).json({ message: 'Hệ thống đang quá tải. Vui lòng thử lại sau!' });
    }
});



// API 5: Xem thông tin cá nhân (CẦN CÓ TOKEN)
app.get('/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userResult = await pool.query(
            'SELECT id, email, full_name, created_at FROM users WHERE id = $1',
            [userId]
        );

        res.status(200).json({
            message: 'Chào mừng bạn đến với khu vực VIP!',
            data: userResult.rows[0]
        });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});
// API 6: Xem giỏ hàng của tôi (CẦN CÓ TOKEN)
app.get('/cart', verifyToken, async (req, res) => {
    try {
        // Lấy ID chuẩn từ Token
        const userId = req.user.id;

        // Truy vấn lấy toàn bộ sản phẩm trong giỏ của user này, sắp xếp mới nhất lên đầu
        const cartResult = await pool.query(
            'SELECT * FROM cart_items WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );

        // Tính tổng tiền toàn bộ giỏ hàng (Grand Total)
        const grandTotal = cartResult.rows.reduce((sum, item) => sum + item.total, 0);

        res.status(200).json({
            message: 'Lấy dữ liệu giỏ hàng thành công!',
            totalItems: cartResult.rows.length,
            grandTotal: grandTotal, // Tổng tiền để in ra màn hình cho khách xem
            data: cartResult.rows
        });
    } catch (err) {
        console.error('Lỗi khi lấy giỏ hàng:', err.message);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});
// ---------------------------------------------------------
// API 7: Cập nhật số lượng sản phẩm (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.put('/cart/update', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { cartItemId, newQuantity } = req.body; // Nhận ID của dòng trong giỏ hàng và số lượng mới

        if (newQuantity <= 0) {
            return res.status(400).json({ message: 'Số lượng phải lớn hơn 0. Nếu muốn xóa, hãy dùng chức năng Xóa.' });
        }

        // 1. Tìm sản phẩm trong giỏ xem có tồn tại không
        const cartItemResult = await pool.query(
            'SELECT * FROM cart_items WHERE id = $1 AND user_id = $2', 
            [cartItemId, userId]
        );
        
        if (cartItemResult.rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy sản phẩm này trong giỏ hàng!' });
        }
        const item = cartItemResult.rows[0];

        // 2. GỌI ĐIỆN KIỂM TRA KHO (Tránh việc khách tăng số lượng lố hàng tồn kho)
        const response = await axios.get(`http://localhost:3002/${item.product_id}`);
        const product = response.data.data;
        const variant = product.variants.find(v => v.color === item.color && v.size === item.size);

        if (!variant || variant.stock < newQuantity) {
            return res.status(400).json({ message: `Kho hàng chỉ còn tối đa ${variant ? variant.stock : 0} sản phẩm!` });
        }

        // 3. Cập nhật Database (Tính lại tổng tiền cho món đó)
        const newTotal = item.price * newQuantity;
        await pool.query(
            'UPDATE cart_items SET quantity = $1, total = $2 WHERE id = $3',
            [newQuantity, newTotal, cartItemId]
        );

        res.status(200).json({ message: 'Cập nhật số lượng thành công!' });
    } catch (err) {
        console.error('Lỗi API Update Cart:', err.message);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// ---------------------------------------------------------
// API 8: Xóa sản phẩm khỏi giỏ hàng (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.delete('/cart/remove/:cartItemId', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const cartItemId = req.params.cartItemId; // Lấy ID trực tiếp từ trên URL

        // Xóa thẳng tay nếu đúng là đồ của user này
        const result = await pool.query(
            'DELETE FROM cart_items WHERE id = $1 AND user_id = $2 RETURNING id', 
            [cartItemId, userId]
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Sản phẩm không tồn tại hoặc đã bị xóa!' });
        }

        res.status(200).json({ message: 'Đã vứt sản phẩm ra khỏi giỏ hàng!' });
    } catch (err) {
        console.error('Lỗi API Delete Cart:', err.message);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});
// ---------------------------------------------------------
// API 9: Dọn sạch giỏ hàng sau khi chốt đơn (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.delete('/cart/clear', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id; // Lấy ID của Sếp Lớn từ Token

        // Xóa TOÀN BỘ các dòng trong bảng cart_items thuộc về user này
        await pool.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

        res.status(200).json({ message: 'Đã dọn sạch giỏ hàng!' });
    } catch (err) {
        console.error('Lỗi API Clear Cart:', err.message);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 User Service đang chạy tại http://localhost:${PORT}`);
});