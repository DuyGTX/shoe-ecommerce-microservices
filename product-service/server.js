const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const redis = require('redis'); // <--- [THÊM MỚI] Import thư viện Redis
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

// ---------------------------------------------------------
// 3. CÁC API CỦA PRODUCT SERVICE
// ---------------------------------------------------------

app.get('/health', (req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    const serviceReady = mongoReady && redisReady;
    res.status(serviceReady ? 200 : 503).json({
        service: 'product-service',
        status: serviceReady ? 'ok' : 'degraded',
        checks: {
            mongo: mongoReady ? 'up' : 'down',
            redis: redisReady ? 'up' : 'down'
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