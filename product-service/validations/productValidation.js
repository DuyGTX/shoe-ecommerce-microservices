const { z } = require('zod');

const objectId = z.string({ error: 'id là bắt buộc.' })
    .regex(/^[0-9a-fA-F]{24}$/, 'id không đúng định dạng Mongo ObjectId.');

const nonEmptyString = (fieldName) => z.string({ error: `${fieldName} là bắt buộc.` })
    .trim()
    .min(1, `${fieldName} là bắt buộc.`);

const money = (fieldName) => z.coerce.number({ error: `${fieldName} phải là số.` })
    .positive(`${fieldName} phải là số dương.`);

const optionalMoney = (fieldName) => z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number({ error: `${fieldName} phải là số.` })
        .positive(`${fieldName} phải là số dương.`)
        .nullable()
        .optional(),
);

const imageUrl = z.string({ error: 'URL hình ảnh phải là chuỗi.' })
    .trim()
    .url('URL hình ảnh không hợp lệ.');

const variantSchema = z.object({
    color: nonEmptyString('Màu sắc'),
    size: z.coerce.number({ error: 'Size phải là số nguyên dương.' })
        .int('Size phải là số nguyên dương.')
        .positive('Size phải là số nguyên dương.'),
    stock: z.coerce.number({ error: 'Tồn kho phải là số nguyên không âm.' })
        .int('Tồn kho phải là số nguyên không âm.')
        .nonnegative('Tồn kho phải là số nguyên không âm.'),
});

const productBodySchema = z.object({
    name: nonEmptyString('Tên sản phẩm'),
    gender: z.enum(['Nam', 'Nữ', 'Unisex'], { error: 'Giới tính phải là Nam, Nữ hoặc Unisex.' }),
    brand: nonEmptyString('Thương hiệu'),
    category: nonEmptyString('Danh mục'),
    thumbnail: imageUrl.optional(),
    images: z.array(imageUrl).optional(),
    price: money('Giá'),
    salePrice: optionalMoney('Giá khuyến mãi'),
    variants: z.array(variantSchema, { error: 'Biến thể sản phẩm là bắt buộc.' })
        .min(1, 'Sản phẩm phải có ít nhất một biến thể.'),
});

const updateProductBodySchema = productBodySchema.partial().refine(
    (payload) => Object.keys(payload).length > 0,
    { message: 'Cần cung cấp ít nhất một trường để cập nhật.' },
);

const productIdParamsSchema = z.object({
    id: objectId,
});

const searchProductsSchema = {
    query: z.object({
        gender: z.enum(['Nam', 'Nữ', 'Unisex']).optional(),
        brand: nonEmptyString('Thương hiệu').optional(),
        category: nonEmptyString('Danh mục').optional(),
        keyword: nonEmptyString('Từ khóa').optional(),
        minPrice: z.coerce.number({ error: 'minPrice phải là số.' }).nonnegative('minPrice phải là số không âm.').optional(),
        maxPrice: z.coerce.number({ error: 'maxPrice phải là số.' }).nonnegative('maxPrice phải là số không âm.').optional(),
    }).refine(
        ({ minPrice, maxPrice }) => minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice,
        { path: ['minPrice'], message: 'minPrice không được lớn hơn maxPrice.' },
    ),
};

const addProductSchema = { body: productBodySchema };
const updateProductSchema = { params: productIdParamsSchema, body: updateProductBodySchema };
const productIdSchema = { params: productIdParamsSchema };

module.exports = {
    addProductSchema,
    updateProductSchema,
    searchProductsSchema,
    productIdSchema,
};