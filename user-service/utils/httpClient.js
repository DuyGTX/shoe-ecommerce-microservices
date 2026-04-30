const axios = require("axios");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const circuitBreakers = new Map();

const getServiceKey = (url) => new URL(url).host;

const shouldRetryRequest = (error) => {
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return true;
  if (!error.response) return true;
  return error.response.status >= 500;
};

const getCircuit = (serviceKey) => {
  if (!circuitBreakers.has(serviceKey)) {
    circuitBreakers.set(serviceKey, { state: "CLOSED", failures: 0, openedAt: 0 });
  }
  return circuitBreakers.get(serviceKey);
};

const requestWithRetry = async (config, options = {}) => {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 250;
  const failureThreshold = options.failureThreshold ?? 3;
  const resetTimeoutMs = options.resetTimeoutMs ?? 10000;
  const serviceKey = options.serviceKey || getServiceKey(config.url);
  const circuit = getCircuit(serviceKey);
  let lastError;

  if (circuit.state === "OPEN") {
    if (Date.now() - circuit.openedAt < resetTimeoutMs) {
      const error = new Error(`Circuit breaker is open for ${serviceKey}`);
      error.code = "CIRCUIT_OPEN";
      throw error;
    }
    circuit.state = "HALF_OPEN";
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await axios(config);
      circuit.state = "CLOSED";
      circuit.failures = 0;
      circuit.openedAt = 0;
      return response;
    } catch (error) {
      lastError = error;
      if (!shouldRetryRequest(error)) throw error;
      if (attempt < retries) await sleep(delayMs * attempt);
    }
  }

  circuit.failures += 1;
  if (circuit.failures >= failureThreshold || circuit.state === "HALF_OPEN") {
    circuit.state = "OPEN";
    circuit.openedAt = Date.now();
  }
  throw lastError;
};

const withRequestIdHeader = (req, config = {}) => ({
  ...config,
  headers: {
    ...(config.headers || {}),
    ...(req.requestId ? { "x-request-id": req.requestId } : {}),
  },
});

module.exports = { requestWithRetry, sleep, withRequestIdHeader };