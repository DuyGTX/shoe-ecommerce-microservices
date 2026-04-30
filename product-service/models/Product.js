const mongoose = require('mongoose');

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

module.exports = mongoose.model('Product', productSchema);