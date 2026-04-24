/* eslint-disable no-console */
const baseUrls = {
  gateway: process.env.GATEWAY_URL || "http://localhost:8000",
  user: process.env.USER_SERVICE_URL || "http://localhost:3001",
  product: process.env.PRODUCT_SERVICE_URL || "http://localhost:3002",
  order: process.env.ORDER_SERVICE_URL || "http://localhost:3003",
};

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 4000);

const withTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const testCases = [
  { name: "gateway health", url: `${baseUrls.gateway}/health`, expected: [200, 503] },
  { name: "user-service health", url: `${baseUrls.user}/health`, expected: [200, 503] },
  { name: "product-service health", url: `${baseUrls.product}/health`, expected: [200, 503] },
  { name: "order-service health", url: `${baseUrls.order}/health`, expected: [200, 503] },
  { name: "product all via gateway", url: `${baseUrls.gateway}/api/products/all`, expected: [200, 500] },
  { name: "user register validation", url: `${baseUrls.gateway}/api/users/register`, method: "POST", body: {}, expected: [400] },
  { name: "order history unauthenticated", url: `${baseUrls.gateway}/api/orders/history`, expected: [401, 403] },
];

const run = async () => {
  console.log("Running smoke tests...");
  let failed = 0;

  for (const testCase of testCases) {
    try {
      const response = await withTimeout(testCase.url, {
        method: testCase.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: testCase.body ? JSON.stringify(testCase.body) : undefined,
      });

      const ok = testCase.expected.includes(response.status);
      if (!ok) {
        failed += 1;
      }

      console.log(
        `${ok ? "PASS" : "FAIL"} | ${testCase.name} | status=${response.status} | expected=${testCase.expected.join(",")}`,
      );
    } catch (error) {
      failed += 1;
      console.log(`FAIL | ${testCase.name} | error=${error.message}`);
    }
  }

  if (failed > 0) {
    console.error(`Smoke test completed with ${failed} failure(s).`);
    process.exit(1);
  }

  console.log("Smoke test completed successfully.");
};

run();