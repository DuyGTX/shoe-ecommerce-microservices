const { Pool } = require('pg');
require('dotenv').config();

// 1. Giữ nguyên cách cấu hình cực chuẩn của bạn
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('connect', () => {
    console.log('✅ Đã kết nối thành công với PostgreSQL Database!');
});

pool.on('error', (err) => {
    console.error('❌ Lỗi kết nối Database:', err);
});

// 2. THÊM MỚI: Hàm tự động tạo bảng nếu chưa có
const initDB = async () => {
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS cart_items (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                product_id VARCHAR(255) NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                price INTEGER NOT NULL,
                color VARCHAR(50) NOT NULL,
                size INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                total INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await pool.query(createTableQuery);
        console.log('📦 Bảng [cart_items] đã sẵn sàng!');
    } catch (err) {
        console.error('❌ Lỗi khi khởi tạo bảng PostgreSQL:', err.message);
    }
};

// 3. XUẤT CẢ 2 HÀM (Chú ý đổi thành object)
module.exports = { pool, initDB };