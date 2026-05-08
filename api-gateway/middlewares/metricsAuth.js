const metricsAuth = (req, res, next) => {
    const expectedToken = process.env.METRICS_TOKEN;

    if (!expectedToken) {
        return res.status(503).json({ message: 'Metrics auth is not configured.' });
    }

    const authHeader = req.headers.authorization || '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const providedToken = tokenMatch?.[1]?.trim();

    if (!providedToken) {
        return res.status(401).json({ message: 'Missing metrics bearer token.' });
    }

    if (providedToken !== expectedToken) {
        return res.status(403).json({ message: 'Invalid metrics token.' });
    }

    return next();
};

module.exports = { metricsAuth };