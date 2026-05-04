const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { v2: cloudinary } = require('cloudinary');
const redis = require('redis'); // <--- [THÊM MỚI] Import thư viện Redis
const amqp = require('amqplib');
require('dotenv').config();

const { register, httpRequestDurationSeconds, httpRequestsTotal } = require('./metrics');
const openApiSpec = require('./openapi.json');
const { sleep } = require('./utils/sleep');
const { createProductService } = require('./services/productService');
const { createStockService } = require('./services/stockService');
const { createProductRoutes } = require('./routes/productRoutes');

const app = express();

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:5173', 'http://api-gateway:3000'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(helmet());
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
}));
app.use(express.json({ limit: '10kb' }));

const log = (level, message, extra = {}) => {
    const payload = {
        level,
        service: 'product-service',
        message,
        timestamp: new Date().toISOString(),
        ...extra,
    };
    console.log(JSON.stringify(payload));
};

const REDIS_URL = process.env.REDIS_URL || 'redis://redis-cache:6379';
const RABBITMQ_URL = process.env.RABBITMQ_URL;
let rabbitConnection;
let rabbitChannel;
let isShuttingDown = false;

// ---------------------------------------------------------
// 1. KẾT NỐI DB, CLOUDINARY & REDIS
// ---------------------------------------------------------
const connectMongoWithRetry = async () => {
    const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL;
    let lastError;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
            await mongoose.connect(mongoUri);
            console.log('🍃 Đã kết nối thành công với MongoDB!');
            return;
        } catch (err) {
            lastError = err;
            console.error(`❌ Kết nối MongoDB thất bại (lần ${attempt}/5):`, err.message);
            await sleep(1000 * attempt);
        }
    }

    console.error('❌ Không thể kết nối MongoDB sau nhiều lần thử:', lastError?.message);
};

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// [THÊM MỚI] Khởi tạo kết nối Redis
// Trỏ đến tên container 'redis-cache' trong docker-compose.yml
const redisClient = redis.createClient({ url: REDIS_URL });
let redisReady = false;

// Xử lý lỗi Redis nếu có
redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('ready', () => {
    redisReady = true;
    console.log('🚀 Đã kết nối thành công với Redis!');
});
redisClient.on('end', () => {
    redisReady = false;
    console.warn('⚠️ Redis connection closed.');
});

const connectRedisWithRetry = async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
            if (!redisClient.isOpen) {
                await redisClient.connect();
            }
            return;
        } catch (err) {
            console.error(`❌ Kết nối Redis thất bại (lần ${attempt}/5):`, err.message);
            await sleep(1000 * attempt);
        }
    }
};

const productService = createProductService({
    redisClient,
    getRedisReady: () => redisReady,
    getRabbitReady: () => Boolean(rabbitChannel),
});

const stockService = createStockService({
    getRabbitChannel: () => rabbitChannel,
    setRabbitChannel: (channel) => {
        rabbitChannel = channel;
    },
    clearProductCache: productService.clearProductCache,
    log,
});

const connectRabbitMQ = async () => {
    if (!RABBITMQ_URL) {
        log('warn', 'rabbitmq_url_missing');
        return;
    }

    try {
        rabbitConnection = await amqp.connect(RABBITMQ_URL);
        rabbitConnection.on('error', (err) => log('error', 'rabbitmq_connection_error', { error: err.message }));
        rabbitConnection.on('close', async () => {
            rabbitConnection = undefined;
            rabbitChannel = undefined;
            if (isShuttingDown) return;
            log('warn', 'rabbitmq_disconnected_retrying');
            await sleep(3000);
            connectRabbitMQ();
        });

        await stockService.bindStockConsumers(rabbitConnection);

        log('info', 'rabbitmq_connected');
    } catch (err) {
        log('error', 'rabbitmq_connect_failed', { error: err.message });
        await sleep(3000);
        connectRabbitMQ();
    }
};

connectMongoWithRetry();
connectRedisWithRetry();
connectRabbitMQ();

app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    res.setHeader('x-request-id', req.requestId);

    res.on('finish', () => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        const latencyMs = Math.round(durationSeconds * 1000);
        const route = req.route?.path || req.baseUrl || req.path || 'unknown';
        const labels = { method: req.method, route, status_code: String(res.statusCode) };
        httpRequestDurationSeconds.observe(labels, durationSeconds);
        httpRequestsTotal.inc(labels);
        log('info', 'request_completed', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            latencyMs,
        });
    });

    next();
});

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.get('/swagger.json', (req, res) => {
    res.json(openApiSpec);
});

app.use('/', createProductRoutes({ productService }));

// ---------------------------------------------------------
const PORT = process.env.PORT || 3002;
const server = app.listen(PORT, () => {
    console.log(`📦 Product Service đang chạy tại http://localhost:${PORT}`);
});

const closeServer = () => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
});

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'graceful_shutdown_started', { signal });

    const shutdownTimeout = setTimeout(() => {
        log('error', 'graceful_shutdown_timeout', { timeoutMs: 10000 });
        process.exit(1);
    }, 10000);

    try {
        await closeServer();
        if (rabbitChannel) await rabbitChannel.close();
        if (rabbitConnection) await rabbitConnection.close();
        await mongoose.connection.close();
        if (redisClient.isOpen) await redisClient.quit();
        clearTimeout(shutdownTimeout);
        log('info', 'graceful_shutdown_completed', { signal });
        process.exit(0);
    } catch (error) {
        clearTimeout(shutdownTimeout);
        log('error', 'graceful_shutdown_failed', { signal, error: error.message });
        process.exit(1);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));