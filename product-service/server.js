const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 1. KẾT NỐI MONGODB & CẤU HÌNH CLOUDINARY
// ---------------------------------------------------------
mongoose.connect(process.env.MONGO_URI)
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

// ---------------------------------------------------------
// 2. ĐỊNH NGHĨA KHUÔN MẪU SẢN PHẨM (GIÀY)
// ---------------------------------------------------------
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    gender: { type: String, enum: ['Nam', 'Nữ', 'Unisex'], required: true },
    brand: { type: String, required: true },
    category: { type: String, required: true },
    thumbnail: { type: String }, // Đã thêm lại trường ảnh
    images: [String],            // Đã thêm lại trường ảnh
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

// API 1: Test sức khỏe
app.get('/health', (req, res) => {
    res.status(200).json({ message: 'Product Service đang hoạt động mượt mà!' });
});

// API 2: Upload ảnh lên Cloudinary
app.post('/upload-image', upload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Vui lòng chọn ảnh!' });
        res.status(200).json({ message: 'Upload thành công!', imageUrl: req.file.path });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi upload ảnh', error: err.message });
    }
});

// API 3: Thêm giày mới
app.post('/add', async (req, res) => {
    try {
        const newProduct = new Product(req.body);
        const savedProduct = await newProduct.save();
        res.status(201).json({ message: 'Đã thêm giày mới!', data: savedProduct });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi thêm sản phẩm', error: err.message });
    }
});

// API 4: Lấy danh sách toàn bộ giày
app.get('/all', async (req, res) => {
    try {
        const products = await Product.find(); 
        res.status(200).json({ total: products.length, data: products });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy dữ liệu', error: err.message });
    }
});

// API 5: Lọc và Tìm kiếm sản phẩm (ĐÃ ĐƯỢC CHUYỂN LÊN TRÊN CÙNG)
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

// API 6: Xem chi tiết 1 đôi giày (LUÔN PHẢI NẰM CUỐI CÙNG TRONG CÁC LỆNH GET)
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