const express = require('express');
const multer = require('multer');

const { requireAdmin } = require('../middlewares/adminMiddleware');
const { validate } = require('../middlewares/validateMiddleware');
const { createProductController } = require('../controllers/productController');
const {
    addProductSchema,
    updateProductSchema,
    searchProductsSchema,
    productIdSchema,
} = require('../validations/productValidation');

const upload = multer({ storage: multer.memoryStorage() });

const createProductRoutes = ({ productService }) => {
    const router = express.Router();
    const controller = createProductController({ productService });

    router.get('/health', controller.health);
    router.post('/upload-image', requireAdmin, upload.single('image'), controller.uploadImage);
    router.post('/add', requireAdmin, validate(addProductSchema), controller.addProduct);
    router.get('/all', controller.getAllProducts);
    router.get('/search', validate(searchProductsSchema), controller.searchProducts);
    router.patch('/:id', requireAdmin, validate(updateProductSchema), controller.updateProduct);
    router.delete('/:id', requireAdmin, validate(productIdSchema), controller.deleteProduct);
    router.get('/:id', validate(productIdSchema), controller.getProductById);

    return router;
};

module.exports = { createProductRoutes };