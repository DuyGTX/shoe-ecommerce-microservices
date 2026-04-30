const mongoose = require('mongoose');

const inventoryLogSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    action: { type: String, required: true, enum: ['RESERVE_STOCK', 'RELEASE_EXPIRED_STOCK'] },
    items: [{ productId: String, color: String, size: Number, quantity: Number }],
    createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

inventoryLogSchema.index({ orderId: 1, action: 1 }, { unique: true });
inventoryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('InventoryLog', inventoryLogSchema);