const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const redis = require('redis'); // <--- [THÊM MỚI] Import thư viện Redis
const amqp = require('amqplib');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

const metrics = {
    requestCount: 0,
    totalLatencyMs: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis-cache:6379';
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const ORDER_EVENTS_EXCHANGE = 'order_events';
const STOCK_EVENTS_EXCHANGE = 'stock_events';
const ORDER_CREATED_QUEUE = 'product_order_created_queue';
const STOCK_RELEASE_DLX = 'stock_release_dlx';
const STOCK_HOLDING_QUEUE = 'stock_holding_queue';
const STOCK_RELEASE_QUEUE = 'stock_release_queue';
const STOCK_RELEASE_ROUTING_KEY = 'stock.expired';
const STOCK_HOLD_TTL_MS = Number(process.env.STOCK_HOLD_TTL_MS || 300000);
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3003';
let rabbitChannel;

const requireAdmin = (req, res, next) => {
    if (!INTERNAL_SERVICE_TOKEN) {
        return res.status(500).json({ message: 'Thiếu cấu hình INTERNAL_SERVICE_TOKEN.' });
    }

    if (req.headers['x-internal-token'] !== INTERNAL_SERVICE_TOKEN) {
        return res.status(403).json({ message: 'Bạn không có quyền thao tác tài nguyên này.' });
    }

    next();
};

const clearProductCache = async () => {
    await redisClient.del('products_all');
};

const publishStockEvent = (routingKey, payload) => {
    if (!rabbitChannel) return false;
    return rabbitChannel.publish(
        STOCK_EVENTS_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json' },
    );
};

const publishStockHolding = (payload) => {
    if (!rabbitChannel) return false;
    return rabbitChannel.sendToQueue(
        STOCK_HOLDING_QUEUE,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json' },
    );
};

const fetchOrderStatus = async (orderId) => {
    const response = await fetch(`${ORDER_SERVICE_URL}/internal/orders/${orderId}`, {
        headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN || '' },
    });

    if (!response.ok) {
        throw new Error(`Không lấy được trạng thái đơn hàng ${orderId}: HTTP ${response.status}`);
    }

    const body = await response.json();
    return body.data;
};

const expireOrder = async (orderId) => {
    if (!INTERNAL_SERVICE_TOKEN) return;
    const response = await fetch(`${ORDER_SERVICE_URL}/internal/orders/${orderId}/expire`, {
        method: 'PATCH',
        headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN },
    });

    if (!response.ok && response.status !== 409) {
        throw new Error(`Không cập nhật được đơn hàng hết hạn ${orderId}: HTTP ${response.status}`);
    }
};

const reserveOrderStock = async ({ orderId, items = [] }) => {
    const session = await mongoose.startSession();
    let alreadyProcessed = false;
    try {
        await session.withTransaction(async () => {
            try {
                await InventoryLog.create([{ orderId: String(orderId), action: 'RESERVE_STOCK', items }], { session });
            } catch (err) {
                if (err.code === 11000) {
                    alreadyProcessed = true;
                    log('info', 'stock_reservation_transaction_committed', { orderId, status: 'COMMITTED', idempotentReplay: true });
                    return;
                }
                throw err;
            }

            for (const item of items) {
                const result = await Product.updateOne(
                    {
                        _id: item.productId,
                        variants: {
                            $elemMatch: {
                                color: item.color,
                                size: Number(item.size),
                                stock: { $gte: Number(item.quantity) },
                            },
                        },
                    },
                    { $inc: { 'variants.$.stock': -Number(item.quantity) } },
                    { session },
                );

                if (result.modifiedCount !== 1) {
                    throw new Error(`Không đủ tồn kho cho sản phẩm ${item.productId}`);
                }
            }
        });

        if (alreadyProcessed) return;

        await clearProductCache();
        publishStockEvent('stock.reserved', { orderId });
        publishStockHolding({
            orderId,
            items: items.map((item) => ({
                productId: item.productId,
                color: item.color,
                size: Number(item.size),
                quantity: Number(item.quantity),
            })),
        });
        log('info', 'stock_reservation_transaction_committed', { orderId, status: 'COMMITTED', itemCount: items.length });
        log('info', 'stock_reserved', { orderId, itemCount: items.length });
    } catch (err) {
        log('warn', 'stock_reservation_transaction_aborted', { orderId, status: 'ABORTED', reason: err.message });
        publishStockEvent('stock.failed', { orderId, reason: err.message });
        log('warn', 'stock_reservation_failed', { orderId, reason: err.message });
    } finally {
        await session.endSession();
    }
};

const releaseExpiredStock = async ({ orderId, items = [] }) => {
    const order = await fetchOrderStatus(orderId);
    if (!['PENDING', 'CANCELLED'].includes(order.status)) {
        log('info', 'stock_release_skipped_order_finalized', { orderId, status: order.status });
        return;
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            try {
                await InventoryLog.create([{ orderId: String(orderId), action: 'RELEASE_EXPIRED_STOCK', items }], { session });
            } catch (err) {
                if (err.code === 11000) {
                    log('info', 'stock_release_already_processed', { orderId });
                    return;
                }
                throw err;
            }

            for (const item of items) {
                const result = await Product.updateOne(
                    {
                        _id: item.productId,
                        variants: { $elemMatch: { color: item.color, size: Number(item.size) } },
                    },
                    { $inc: { 'variants.$.stock': Number(item.quantity) } },
                    { session },
                );

                if (result.modifiedCount !== 1) {
                    throw new Error(`Không hoàn được tồn kho cho sản phẩm ${item.productId}`);
                }

                log('info', 'stock_released_after_payment_timeout', {
                    orderId,
                    productId: item.productId,
                    quantity: Number(item.quantity),
                    message: `Đã hoàn lại ${Number(item.quantity)} sản phẩm cho đơn hàng ${orderId} do hết hạn thanh toán.`,
                });
            }
        });

        log('info', 'stock_release_transaction_committed', { orderId, status: 'COMMITTED', itemCount: items.length });

        await clearProductCache();
        if (order.status === 'PENDING') await expireOrder(orderId);
    } catch (err) {
        log('warn', 'stock_release_transaction_aborted', { orderId, status: 'ABORTED', reason: err.message });
        throw err;
    } finally {
        await session.endSession();
    }
};

const connectRabbitMQ = async () => {
    if (!RABBITMQ_URL) {
        log('warn', 'rabbitmq_url_missing');
        return;
    }

    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        connection.on('error', (err) => log('error', 'rabbitmq_connection_error', { error: err.message }));
        connection.on('close', async () => {
            rabbitChannel = undefined;
            log('warn', 'rabbitmq_disconnected_retrying');
            await sleep(3000);
            connectRabbitMQ();
        });

        await rabbitChannel.assertExchange(ORDER_EVENTS_EXCHANGE, 'topic', { durable: true });
        await rabbitChannel.assertExchange(STOCK_EVENTS_EXCHANGE, 'topic', { durable: true });
        await rabbitChannel.assertExchange(STOCK_RELEASE_DLX, 'direct', { durable: true });
        await rabbitChannel.assertQueue(STOCK_HOLDING_QUEUE, {
            durable: true,
            arguments: {
                'x-message-ttl': STOCK_HOLD_TTL_MS,
                'x-dead-letter-exchange': STOCK_RELEASE_DLX,
                'x-dead-letter-routing-key': STOCK_RELEASE_ROUTING_KEY,
            },
        });
        await rabbitChannel.assertQueue(STOCK_RELEASE_QUEUE, { durable: true });
        await rabbitChannel.bindQueue(STOCK_RELEASE_QUEUE, STOCK_RELEASE_DLX, STOCK_RELEASE_ROUTING_KEY);
        await rabbitChannel.assertQueue(ORDER_CREATED_QUEUE, { durable: true });
        await rabbitChannel.bindQueue(ORDER_CREATED_QUEUE, ORDER_EVENTS_EXCHANGE, 'order.created');
        await rabbitChannel.prefetch(5);

        rabbitChannel.consume(ORDER_CREATED_QUEUE, async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString());
                await reserveOrderStock(payload);
                rabbitChannel.ack(msg);
            } catch (err) {
                log('error', 'order_created_consume_failed', { error: err.message });
                rabbitChannel.nack(msg, false, true);
            }
        });

        rabbitChannel.consume(STOCK_RELEASE_QUEUE, async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString());
                await releaseExpiredStock(payload);
                rabbitChannel.ack(msg);
            } catch (err) {
                log('error', 'stock_release_consume_failed', { error: err.message });
                rabbitChannel.nack(msg, false, true);
            }
        });

        log('info', 'rabbitmq_connected');
    } catch (err) {
        log('error', 'rabbitmq_connect_failed', { error: err.message });
        await sleep(3000);
        connectRabbitMQ();
    }
};

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

const upload = multer({ storage: multer.memoryStorage() });

const uploadImageToCloudinary = (buffer) => new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
        {
            folder: 'shoe_ecommerce_products',
            resource_type: 'image',
        },
        (error, result) => {
            if (error) {
                return reject(error);
            }
            return resolve(result);
        },
    );

    stream.end(buffer);
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

connectMongoWithRetry();
connectRedisWithRetry();
connectRabbitMQ();

app.use((req, res, next) => {
    const startedAt = Date.now();
    req.requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    res.setHeader('x-request-id', req.requestId);

    res.on('finish', () => {
        const latencyMs = Date.now() - startedAt;
        metrics.requestCount += 1;
        metrics.totalLatencyMs += latencyMs;
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

// ---------------------------------------------------------
// 2. ĐỊNH NGHĨA KHUÔN MẪU SẢN PHẨM (GIÀY)
// ---------------------------------------------------------
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    gender: { type: String, enum: ['Nam', 'Nữ', 'Unisex'], required: true },
    brand: { type: String, required: true },
    category: { type: String, required: true },
    thumbnail: { type: String }, 
    images: [String],            
    price: { type: Number, required: true },
    salePrice: { type: Number, default: null },
    variants: [
        {
            color: { type: String, required: true },
            size: { type: Number, required: true },
            stock: { type: Number, required: true, default: 0 }
        }
    ]
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

const inventoryLogSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    action: { type: String, required: true, enum: ['RESERVE_STOCK', 'RELEASE_EXPIRED_STOCK'] },
    items: [{ productId: String, color: String, size: Number, quantity: Number }],
    createdAt: { type: Date, default: Date.now },
}, { timestamps: true });
inventoryLogSchema.index({ orderId: 1, action: 1 }, { unique: true });
inventoryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });
const InventoryLog = mongoose.model('InventoryLog', inventoryLogSchema);

// ---------------------------------------------------------
// 3. CÁC API CỦA PRODUCT SERVICE
// ---------------------------------------------------------

app.get('/health', (req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    const rabbitReady = Boolean(rabbitChannel);
    const serviceReady = mongoReady && redisReady && rabbitReady;
    res.status(serviceReady ? 200 : 503).json({
        service: 'product-service',
        status: serviceReady ? 'ok' : 'degraded',
        checks: {
            mongo: mongoReady ? 'up' : 'down',
            redis: redisReady ? 'up' : 'down',
            rabbitmq: rabbitReady ? 'up' : 'down'
        }
    });
});

app.get('/metrics', (req, res) => {
    const avgLatency = metrics.requestCount === 0 ? 0 : Number((metrics.totalLatencyMs / metrics.requestCount).toFixed(2));
    res.status(200).json({
        service: 'product-service',
        requestCount: metrics.requestCount,
        avgLatencyMs: avgLatency,
    });
});

app.post('/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Vui lòng chọn ảnh!' });
        const uploaded = await uploadImageToCloudinary(req.file.buffer);
        res.status(200).json({ message: 'Upload thành công!', imageUrl: uploaded.secure_url });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi upload ảnh', error: err.message });
    }
});

app.post('/add', requireAdmin, async (req, res) => {
    try {
        const newProduct = new Product(req.body);
        const savedProduct = await newProduct.save();
        
        // [THÊM MỚI] Xóa Cache khi có sản phẩm mới để dữ liệu luôn cập nhật
        await clearProductCache();
        console.log('🧹 Đã xóa cache vì có sản phẩm mới!');

        res.status(201).json({ message: 'Đã thêm giày mới!', data: savedProduct });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi thêm sản phẩm', error: err.message });
    }
});

// [ĐÃ CẬP NHẬT] API Lấy danh sách toàn bộ giày (Tích hợp Redis)
app.get('/all', async (req, res) => {
    const CACHE_KEY = 'products_all';

    try {
        // 1. Kiểm tra xem dữ liệu đã có trong Redis chưa
        const cachedProducts = await redisClient.get(CACHE_KEY);

        if (cachedProducts) {
            // Nếu có: Trả về ngay lập tức
            console.log("⚡ Cache Hit! - Trả dữ liệu siêu tốc từ Redis");
            return res.status(200).json(JSON.parse(cachedProducts));
        }

        // 2. Nếu không có (Cache Miss): Vào MongoDB lấy dữ liệu
        console.log("🐢 Cache Miss! - Phải chui vào MongoDB lấy dữ liệu");
        const products = await Product.find().sort({ createdAt: -1 }); 

        // 3. Lưu vào Redis để dùng cho lần sau, và set thời gian sống (TTL) là 60 giây
        // Dữ liệu trong Database có thể thay đổi, nên ta lưu tạm 60s thôi.
        await redisClient.setEx(CACHE_KEY, 60, JSON.stringify({ total: products.length, data: products }));

        res.status(200).json({ total: products.length, data: products });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy dữ liệu', error: err.message });
    }
});

app.get('/search', async (req, res) => {
    try {
        const { gender, brand, category, keyword, minPrice, maxPrice } = req.query; 
        let queryObj = {}; 
        
        if (gender) queryObj.gender = gender;
        if (brand) queryObj.brand = brand;
        if (category) queryObj.category = category;
        if (keyword) queryObj.name = { $regex: keyword, $options: 'i' };
        if (minPrice || maxPrice) {
            queryObj.price = {};
            if (minPrice) queryObj.price.$gte = Number(minPrice);
            if (maxPrice) queryObj.price.$lte = Number(maxPrice);
        }

        const products = await Product.find(queryObj).sort({ createdAt: -1 });
        res.status(200).json({ total: products.length, data: products });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi tìm kiếm', error: err.message });
    }
});

app.patch('/:id', requireAdmin, async (req, res) => {
    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedProduct) {
            return res.status(404).json({ message: 'Không tìm thấy sản phẩm để cập nhật!' });
        }

        await clearProductCache();
        res.status(200).json({ message: 'Cập nhật sản phẩm thành công!', data: updatedProduct });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi cập nhật sản phẩm', error: err.message });
    }
});

app.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const deletedProduct = await Product.findByIdAndDelete(req.params.id);

        if (!deletedProduct) {
            return res.status(404).json({ message: 'Không tìm thấy sản phẩm để xóa!' });
        }

        await clearProductCache();
        res.status(200).json({ message: 'Xóa sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi xóa sản phẩm', error: err.message });
    }
});

app.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Không tìm thấy!' });
        res.status(200).json({ data: product });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi định dạng ID', error: err.message });
    }
});

// ---------------------------------------------------------
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`📦 Product Service đang chạy tại http://localhost:${PORT}`);
});