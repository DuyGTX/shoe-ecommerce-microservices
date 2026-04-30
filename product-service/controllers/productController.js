const createProductController = ({ productService }) => ({
    health: (req, res) => {
        const health = productService.getHealth();
        res.status(health.httpStatus).json(health.body);
    },

    uploadImage: async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ message: 'Vui lòng chọn ảnh!' });
            const imageUrl = await productService.uploadImage(req.file);
            res.status(200).json({ message: 'Upload thành công!', imageUrl });
        } catch (err) {
            res.status(500).json({ message: 'Lỗi upload ảnh', error: err.message });
        }
    },

    addProduct: async (req, res) => {
        try {
            const savedProduct = await productService.addProduct(req.body);
            res.status(201).json({ message: 'Đã thêm giày mới!', data: savedProduct });
        } catch (err) {
            res.status(500).json({ message: 'Lỗi thêm sản phẩm', error: err.message });
        }
    },

    getAllProducts: async (req, res) => {
        try {
            const result = await productService.getAllProducts();
            res.status(200).json(result.body);
        } catch (err) {
            res.status(500).json({ message: 'Lỗi lấy dữ liệu', error: err.message });
        }
    },

    searchProducts: async (req, res) => {
        try {
            const body = await productService.searchProducts(req.query);
            res.status(200).json(body);
        } catch (err) {
            res.status(500).json({ message: 'Lỗi tìm kiếm', error: err.message });
        }
    },

    updateProduct: async (req, res) => {
        try {
            const updatedProduct = await productService.updateProduct(req.params.id, req.body);

            if (!updatedProduct) {
                return res.status(404).json({ message: 'Không tìm thấy sản phẩm để cập nhật!' });
            }

            res.status(200).json({ message: 'Cập nhật sản phẩm thành công!', data: updatedProduct });
        } catch (err) {
            res.status(500).json({ message: 'Lỗi cập nhật sản phẩm', error: err.message });
        }
    },

    deleteProduct: async (req, res) => {
        try {
            const deletedProduct = await productService.deleteProduct(req.params.id);

            if (!deletedProduct) {
                return res.status(404).json({ message: 'Không tìm thấy sản phẩm để xóa!' });
            }

            res.status(200).json({ message: 'Xóa sản phẩm thành công!' });
        } catch (err) {
            res.status(500).json({ message: 'Lỗi xóa sản phẩm', error: err.message });
        }
    },

    getProductById: async (req, res) => {
        try {
            const product = await productService.getProductById(req.params.id);
            if (!product) return res.status(404).json({ message: 'Không tìm thấy!' });
            res.status(200).json({ data: product });
        } catch (err) {
            res.status(500).json({ message: 'Lỗi định dạng ID', error: err.message });
        }
    },
});

module.exports = { createProductController };