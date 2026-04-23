const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const redis = require('redis'); // <--- [THÊM MỚI] Import thư viện Redis
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 1. KẾT NỐI DB, CLOUDINARY & REDIS
// ---------------------------------------------------------
mongoose.connect(process.env.MONGO_URI || process.env.MONGO_URL) // <--- Cập nhật để nhận 1 trong 2 biến
    .then(() => console.log('🍃 Đã kết nối thành công với MongoDB!'))
    .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'shoe_ecommerce_products', 
        allowed_formats: ['jpg', 'png', 'jpeg'],
    },
});
const upload = multer({ storage: storage });

// [THÊM MỚI] Khởi tạo kết nối Redis
// Trỏ đến tên container 'redis-cache' trong docker-compose.yml
const redisClient = redis.createClient({ url: 'redis://redis-cache:6379' });

// Xử lý lỗi Redis nếu có
redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Bắt đầu kết nối
redisClient.connect().then(() => {
    console.log('🚀 Đã kết nối thành công với Redis!');
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
    res.status(200).json({ message: 'Product Service đang hoạt động mượt mà!' });
});

app.post('/upload-image', upload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Vui lòng chọn ảnh!' });
        res.status(200).json({ message: 'Upload thành công!', imageUrl: req.file.path });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi upload ảnh', error: err.message });
    }
});

app.post('/add', async (req, res) => {
    try {
        const newProduct = new Product(req.body);
        const savedProduct = await newProduct.save();
        
        // [THÊM MỚI] Xóa Cache khi có sản phẩm mới để dữ liệu luôn cập nhật
        await redisClient.del('products_all');
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
        const products = await Product.find(); 

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
        const { gender, brand, category } = req.query; 
        let queryObj = {}; 
        
        if (gender) queryObj.gender = gender;
        if (brand) queryObj.brand = brand;
        if (category) queryObj.category = category;

        const products = await Product.find(queryObj);
        res.status(200).json({ total: products.length, data: products });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi tìm kiếm', error: err.message });
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