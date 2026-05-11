const crypto = require("crypto");

const requestIdMiddleware = (req, res, next) => {
  const incomingRequestId = req.headers["x-request-id"];
  req.requestId = incomingRequestId || crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
};

module.exports = { requestIdMiddleware };
