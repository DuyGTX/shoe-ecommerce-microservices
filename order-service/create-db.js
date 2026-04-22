const { Client } = require('pg');
require('dotenv').config();

// Mẹo: Tạm thời kết nối vào nhà của User Service (shoe_user_db) vì nó đã có sẵn
const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    database: 'shoe_user_db' 
});

const createOrderDatabase = async () => {
    try {
        await client.connect();
        // Ra lệnh xây nhà mới!
        await client.query('CREATE DATABASE shoe_order_db');
        console.log('🎉 BÙM! Đã tạo thành công Database [shoe_order_db]!');
    } catch (err) {
        // Mã lỗi 42P04 nghĩa là database đã được tạo rồi
        if (err.code === '42P04') {
            console.log('✅ Database [shoe_order_db] đã tồn tại sẵn rồi!');
        } else {
            console.error('❌ Lỗi:', err.message);
        }
    } finally {
        await client.end();
    }
};

createOrderDatabase();