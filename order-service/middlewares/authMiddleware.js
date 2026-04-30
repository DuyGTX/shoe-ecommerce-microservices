const jwt = require("jsonwebtoken");

const createAuthMiddleware = ({ jwtSecretCurrent, jwtSecretPrevious }) => (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(403).json({ message: "Từ chối truy cập!" });
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
    res.status(401).json({ message: "Token không hợp lệ!" });
  }
};

module.exports = { createAuthMiddleware };