const { Pool } = require('pg');
require('dotenv').config();
const logger = require('./utils/logger');

// 1. Giữ nguyên cách cấu hình cực chuẩn của bạn
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('connect', () => {
    logger.info('postgres_connected');
});

pool.on('error', (err) => {
    logger.error('postgres_connection_error', { error: err });
});

module.exports = { pool };