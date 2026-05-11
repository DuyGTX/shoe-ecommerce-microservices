const { randomUUID } = require('crypto');

const requestId = (req, res, next) => {
  req.requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

module.exports = { requestId };
