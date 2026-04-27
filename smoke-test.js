/* eslint-disable no-console */
const baseUrls = {
  gateway: process.env.GATEWAY_URL || "http://localhost:8000",
  user: process.env.USER_SERVICE_URL || "http://localhost:3001",
  product: process.env.PRODUCT_SERVICE_URL || "http://localhost:3002",
  order: process.env.ORDER_SERVICE_URL || "http://localhost:3003",
};

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 4000);

const randomEmail = () => `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.local`;

const parseJsonSafe = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

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

  try {
    const email = randomEmail();
    const password = "12345678";

    const registerRes = await withTimeout(`${baseUrls.gateway}/api/users/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, full_name: "QA Retry" }),
    });
    if (registerRes.status !== 201) {
      failed += 1;
      console.log(`FAIL | checkout retry setup register | status=${registerRes.status} | expected=201`);
    }

    const loginRes = await withTimeout(`${baseUrls.gateway}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = await parseJsonSafe(loginRes);
    const token = loginBody.token;
    if (loginRes.status !== 200 || !token) {
      failed += 1;
      console.log(`FAIL | checkout retry setup login | status=${loginRes.status} | expected=200`);
    }

    const productsRes = await withTimeout(`${baseUrls.gateway}/api/products/all`);
    const productsBody = await parseJsonSafe(productsRes);
    const firstProduct = productsBody?.data?.[0];
    const firstVariant = firstProduct?.variants?.[0];

    if (!firstProduct || !firstVariant) {
      failed += 1;
      console.log("FAIL | checkout retry setup product seed | reason=no product/variant available");
    } else {
      const addCartRes = await withTimeout(`${baseUrls.gateway}/api/cart/add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          productId: firstProduct._id,
          quantity: 1,
          color: firstVariant.color,
          size: firstVariant.size,
        }),
      });
      if (addCartRes.status !== 200) {
        failed += 1;
        console.log(`FAIL | checkout retry setup add cart | status=${addCartRes.status} | expected=200`);
      }

      const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const checkoutHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-idempotency-key": idempotencyKey,
      };

      const firstCheckoutRes = await withTimeout(`${baseUrls.gateway}/api/orders/checkout`, {
        method: "POST",
        headers: checkoutHeaders,
      });
      const firstCheckoutBody = await parseJsonSafe(firstCheckoutRes);

      const secondCheckoutRes = await withTimeout(`${baseUrls.gateway}/api/orders/checkout`, {
        method: "POST",
        headers: checkoutHeaders,
      });
      const secondCheckoutBody = await parseJsonSafe(secondCheckoutRes);

      const firstOk = [200, 202].includes(firstCheckoutRes.status) && Boolean(firstCheckoutBody.orderId);
      const secondOk = secondCheckoutRes.status === 200
        && secondCheckoutBody.idempotentReplay === true
        && secondCheckoutBody.orderId === firstCheckoutBody.orderId;

      if (!firstOk) {
        failed += 1;
        console.log(`FAIL | checkout first submit | status=${firstCheckoutRes.status} | expected=200/202 with orderId`);
      } else {
        console.log(`PASS | checkout first submit | status=${firstCheckoutRes.status}`);
      }

      if (!secondOk) {
        failed += 1;
        console.log(`FAIL | checkout idempotent replay | status=${secondCheckoutRes.status} | expected=200 with idempotentReplay=true and same orderId`);
      } else {
        console.log("PASS | checkout idempotent replay | second request returned replay=true with same orderId");
      }

      const missingKeyRes = await withTimeout(`${baseUrls.gateway}/api/orders/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (missingKeyRes.status !== 400) {
        failed += 1;
        console.log(`FAIL | checkout missing idempotency key | status=${missingKeyRes.status} | expected=400`);
      } else {
        console.log("PASS | checkout missing idempotency key | status=400");
      }
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL | checkout retry integration | error=${error.message}`);
  }

  if (failed > 0) {
    console.error(`Smoke test completed with ${failed} failure(s).`);
    process.exit(1);
  }

  console.log("Smoke test completed successfully.");
};

run();