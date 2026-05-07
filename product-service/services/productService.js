const mongoose = require('mongoose');
const { v2: cloudinary } = require('cloudinary');

const Product = require('../models/Product');

const CACHE_KEY = 'products_all';

const createProductService = ({ redisClient, getRedisReady, getRabbitReady, logger }) => {
    const clearProductCache = async () => {
        await redisClient.del(CACHE_KEY);
    };

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

    const getHealth = () => {
        const mongoReady = mongoose.connection.readyState === 1;
        const rabbitReady = getRabbitReady();
        const redisReady = getRedisReady();
        const serviceReady = mongoReady && redisReady && rabbitReady;

        return {
            httpStatus: serviceReady ? 200 : 503,
            body: {
                service: 'product-service',
                status: serviceReady ? 'ok' : 'degraded',
                checks: {
                    mongo: mongoReady ? 'up' : 'down',
                    redis: redisReady ? 'up' : 'down',
                    rabbitmq: rabbitReady ? 'up' : 'down'
                }
            },
        };
    };

    const uploadImage = async (file) => {
        const uploaded = await uploadImageToCloudinary(file.buffer);
        return uploaded.secure_url;
    };

    const addProduct = async (payload) => {
        const newProduct = new Product(payload);
        const savedProduct = await newProduct.save();
        await clearProductCache();
        logger.info('product_cache_cleared', { reason: 'product_created' });
        return savedProduct;
    };

    const getAllProducts = async () => {
        const cachedProducts = await redisClient.get(CACHE_KEY);

        if (cachedProducts) {
            logger.info('product_cache_hit', { cacheKey: CACHE_KEY });
            return { fromCache: true, body: JSON.parse(cachedProducts) };
        }

        logger.info('product_cache_miss', { cacheKey: CACHE_KEY });
        const products = await Product.find().sort({ createdAt: -1 }); 
        const body = { total: products.length, data: products };
        await redisClient.setEx(CACHE_KEY, 60, JSON.stringify(body));
        return { fromCache: false, body };
    };

    const searchProducts = async ({ gender, brand, category, keyword, minPrice, maxPrice }) => {
        let queryObj = {}; 
        
        if (gender) queryObj.gender = gender;
        if (brand) queryObj.brand = brand;
        if (category) queryObj.category = category;
        if (keyword) queryObj.name = { $regex: keyword, $options: 'i' };
        if (minPrice || maxPrice) {
            queryObj.price = {};
            if (minPrice) queryObj.price.$gte = minPrice;
            if (maxPrice) queryObj.price.$lte = maxPrice;
        }

        const products = await Product.find(queryObj).sort({ createdAt: -1 });
        return { total: products.length, data: products };
    };

    const updateProduct = async (id, payload) => {
        const updatedProduct = await Product.findByIdAndUpdate(
            id,
            payload,
            { new: true, runValidators: true }
        );

        if (updatedProduct) {
            await clearProductCache();
        }

        return updatedProduct;
    };

    const deleteProduct = async (id) => {
        const deletedProduct = await Product.findByIdAndDelete(id);

        if (deletedProduct) {
            await clearProductCache();
        }

        return deletedProduct;
    };

    const getProductById = async (id) => Product.findById(id);

    const rollbackStock = async ({ orderId, items = [], reason = 'payment_failed' }) => {
        if (!Array.isArray(items) || items.length === 0) {
            logger.warn('stock_release_requested_empty_items', { orderId, reason });
            return { processedCount: 0, skippedCount: 0 };
        }

        const session = await mongoose.startSession();
        let processedCount = 0;
        let skippedCount = 0;

        try {
            await session.withTransaction(async () => {
                for (const item of items) {
                    const productId = item?.productId;
                    const quantity = Number(item?.quantity);
                    const color = item?.color;
                    const size = Number(item?.size);

                    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || !color || !Number.isFinite(size)) {
                        skippedCount += 1;
                        logger.warn('stock_release_item_invalid', { orderId, reason, item });
                        continue;
                    }

                    const result = await Product.updateOne(
                        {
                            _id: productId,
                            variants: { $elemMatch: { color, size } },
                        },
                        { $inc: { 'variants.$.stock': quantity } },
                        { session },
                    );

                    if (result.modifiedCount !== 1) {
                        skippedCount += 1;
                        logger.warn('stock_release_item_not_found', { orderId, reason, productId, color, size, quantity });
                        continue;
                    }

                    processedCount += 1;
                }
            });

            await clearProductCache();
            logger.info('product_cache_cleared', { reason: 'stock_rollback', orderId });
            logger.info('stock_release_requested_processed', {
                orderId,
                reason,
                requestedCount: items.length,
                processedCount,
                skippedCount,
            });

            return { processedCount, skippedCount };
        } finally {
            await session.endSession();
        }
    };

    return {
        clearProductCache,
        getHealth,
        uploadImage,
        addProduct,
        getAllProducts,
        searchProducts,
        updateProduct,
        deleteProduct,
        getProductById,
        rollbackStock,
    };
};

module.exports = { createProductService };