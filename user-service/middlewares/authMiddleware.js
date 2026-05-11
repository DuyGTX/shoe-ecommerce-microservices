const jwt = require("jsonwebtoken");
const { AppError } = require("./AppError");

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return next(new AppError("Bạn chưa cung cấp Thẻ thông hành (Token).", 403));
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (err) {
    return next(new AppError("Thẻ thông hành giả mạo hoặc đã hết hạn!", 401));
  }
};

module.exports = { verifyToken };