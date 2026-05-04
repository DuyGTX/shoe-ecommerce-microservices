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
    };
};

module.exports = { createProductService };