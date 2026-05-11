const { AppError } = require('./AppError');

const metricsAuth = (req, res, next) => {
    const expectedToken = process.env.METRICS_TOKEN;

    if (!expectedToken) {
        return next(new AppError('Metrics auth is not configured.', 503));
    }

    const authHeader = req.headers.authorization || '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const providedToken = tokenMatch?.[1]?.trim();

    if (!providedToken) {
        return next(new AppError('Missing metrics bearer token.', 401));
    }

    if (providedToken !== expectedToken) {
        return next(new AppError('Invalid metrics token.', 403));
    }

    return next();
};

module.exports = { metricsAuth };