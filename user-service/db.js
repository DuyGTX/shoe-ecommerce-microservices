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

module.exports = { pool };