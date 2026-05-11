const jwt = require("jsonwebtoken");
const { AppError } = require("./AppError");

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return next(new AppError("Unauthorized.", 401));
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return next(new AppError("Server JWT configuration is missing.", 500));
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch (error) {
    return next(new AppError("Unauthorized.", 401));
  }
};

module.exports = { verifyToken };