const jwt = require("jsonwebtoken");
const { AppError } = require("./AppError");

const createAuthMiddleware = ({ jwtSecretCurrent, jwtSecretPrevious }) => (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return next(new AppError("Từ chối truy cập!", 403));
  try {
    try {
      req.user = jwt.verify(token, jwtSecretCurrent);
    } catch (primaryError) {
      if (!jwtSecretPrevious) throw primaryError;
      req.user = jwt.verify(token, jwtSecretPrevious);
    }
    req.tokenString = token;
    next();
  } catch (err) {
    return next(new AppError("Token không hợp lệ!", 401));
  }
};

module.exports = { createAuthMiddleware };