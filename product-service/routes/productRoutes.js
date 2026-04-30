const express = require('express');
const multer = require('multer');

const { requireAdmin } = require('../middlewares/adminMiddleware');
const { createProductController } = require('../controllers/productController');

const upload = multer({ storage: multer.memoryStorage() });

const createProductRoutes = ({ productService }) => {
    const router = express.Router();
    const controller = createProductController({ productService });

    router.get('/health', controller.health);
    router.post('/upload-image', requireAdmin, upload.single('image'), controller.uploadImage);
    router.post('/add', requireAdmin, controller.addProduct);
    router.get('/all', controller.getAllProducts);
    router.get('/search', controller.searchProducts);
    router.patch('/:id', requireAdmin, controller.updateProduct);
    router.delete('/:id', requireAdmin, controller.deleteProduct);
    router.get('/:id', controller.getProductById);

    return router;
};

module.exports = { createProductRoutes };