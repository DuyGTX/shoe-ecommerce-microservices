const { AppError } = require('../middlewares/AppError');

const createProductController = ({ productService }) => ({
    health: (req, res) => {
        const health = productService.getHealth();
        res.status(health.httpStatus).json(health.body);
    },

    uploadImage: async (req, res, next) => {
        try {
            if (!req.file) return next(new AppError('Vui lòng chọn ảnh!', 400));
            const imageUrl = await productService.uploadImage(req.file);
            res.status(200).json({ message: 'Upload thành công!', imageUrl });
        } catch (err) {
            return next(err);
        }
    },

    addProduct: async (req, res, next) => {
        try {
            const savedProduct = await productService.addProduct(req.body);
            res.status(201).json({ message: 'Đã thêm giày mới!', data: savedProduct });
        } catch (err) {
            return next(err);
        }
    },

    getAllProducts: async (req, res, next) => {
        try {
            const result = await productService.getAllProducts();
            res.status(200).json(result.body);
        } catch (err) {
            return next(err);
        }
    },

    searchProducts: async (req, res, next) => {
        try {
            const body = await productService.searchProducts(req.query);
            res.status(200).json(body);
        } catch (err) {
            return next(err);
        }
    },

    updateProduct: async (req, res, next) => {
        try {
            const updatedProduct = await productService.updateProduct(req.params.id, req.body);

            if (!updatedProduct) {
                return next(new AppError('Không tìm thấy sản phẩm để cập nhật!', 404));
            }

            res.status(200).json({ message: 'Cập nhật sản phẩm thành công!', data: updatedProduct });
        } catch (err) {
            return next(err);
        }
    },

    deleteProduct: async (req, res, next) => {
        try {
            const deletedProduct = await productService.deleteProduct(req.params.id);

            if (!deletedProduct) {
                return next(new AppError('Không tìm thấy sản phẩm để xóa!', 404));
            }

            res.status(200).json({ message: 'Xóa sản phẩm thành công!' });
        } catch (err) {
            return next(err);
        }
    },

    getProductById: async (req, res, next) => {
        try {
            const product = await productService.getProductById(req.params.id);
            if (!product) return next(new AppError('Không tìm thấy!', 404));
            res.status(200).json({ data: product });
        } catch (err) {
            return next(err);
        }
    },
});

module.exports = { createProductController };