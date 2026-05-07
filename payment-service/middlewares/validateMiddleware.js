const { ZodError } = require("zod");

const formatZodError = (error) => error.issues.map((issue) => ({
  path: issue.path.join("."),
  message: issue.message,
}));

const validate = (schemas = {}) => (req, res, next) => {
  try {
    if (schemas.params) req.params = schemas.params.parse(req.params);
    if (schemas.query) req.query = schemas.query.parse(req.query);
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.headers) req.headers = schemas.headers.parse(req.headers);
    return next();
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: "Du lieu dau vao khong hop le.",
        errors: formatZodError(error),
      });
    }

    return next(error);
  }
};

module.exports = { validate };