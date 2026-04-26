const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const initDB = async () => {
    try {
        // Bảng 1: Thông tin chung của đơn hàng
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(255),
                total_amount INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)");
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency
            ON orders (user_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL
        `);

        // Bảng 2: Chi tiết từng món trong đơn hàng
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                product_id VARCHAR(255) NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                price INTEGER NOT NULL,
                color VARCHAR(50),
                size INTEGER,
                quantity INTEGER NOT NULL,
                total INTEGER NOT NULL
            );
        `);
        console.log('📦 Các bảng [orders, order_items] đã sẵn sàng!');
    } catch (err) {
        console.error('❌ Lỗi tạo bảng Đơn hàng:', err.message);
    }
};

module.exports = { pool, initDB };