/* eslint-disable no-console */
const baseUrls = {
  gateway: process.env.GATEWAY_URL || "http://localhost:8000",
  user: process.env.USER_SERVICE_URL || "http://localhost:3001",
  product: process.env.PRODUCT_SERVICE_URL || "http://localhost:3002",
  order: process.env.ORDER_SERVICE_URL || "http://localhost:3003",
};

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 4000);
const checkoutReplayWaitMs = Number(process.env.SMOKE_CHECKOUT_REPLAY_WAIT_MS || 300);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const assertStatus = ({ name, response, expected, failedRef }) => {
  const ok = expected.includes(response.status);
  if (!ok) {
    failedRef.count += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${name} | status=${response.status} | expected=${expected.join(",")}`,
  );
  return ok;
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
  const failedRef = { count: 0 };

  for (const testCase of testCases) {
    try {
      const response = await withTimeout(testCase.url, {
        method: testCase.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: testCase.body ? JSON.stringify(testCase.body) : undefined,
      });
      assertStatus({ name: testCase.name, response, expected: testCase.expected, failedRef });
    } catch (error) {
      failedRef.count += 1;
      console.log(`FAIL | ${testCase.name} | error=${error.message}`);
    }
  }

  try {
    console.log("Running E2E flow: Register -> Login -> Cart -> Checkout -> History...");
    const email = randomEmail();
    const password = "12345678";

    const registerRes = await withTimeout(`${baseUrls.gateway}/api/users/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, full_name: "QA Retry" }),
    });
    const registerOk = assertStatus({
      name: "e2e register",
      response: registerRes,
      expected: [201],
      failedRef,
    });
    if (!registerOk) {
      throw new Error("e2e register failed");
    }

    const loginRes = await withTimeout(`${baseUrls.gateway}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = await parseJsonSafe(loginRes);
    const token = loginBody.token;
    if (loginRes.status !== 200 || !token) {
      failedRef.count += 1;
      console.log(`FAIL | checkout retry setup login | status=${loginRes.status} | expected=200`);
      throw new Error("e2e login failed");
    } else {
      console.log("PASS | e2e login | token acquired");
    }

    const productsRes = await withTimeout(`${baseUrls.gateway}/api/products/all`);
    const productsBody = await parseJsonSafe(productsRes);
    const firstProduct = productsBody?.data?.[0];
    const firstVariant = firstProduct?.variants?.[0];

    if (!firstProduct || !firstVariant) {
      failedRef.count += 1;
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
      const addCartOk = assertStatus({
        name: "e2e add to cart",
        response: addCartRes,
        expected: [200],
        failedRef,
      });
      if (!addCartOk) {
        throw new Error("e2e add to cart failed");
      }

      const cartRes = await withTimeout(`${baseUrls.gateway}/api/cart`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const cartBody = await parseJsonSafe(cartRes);
      const cartHasItems = cartRes.status === 200 && Number(cartBody.totalItems || 0) > 0;
      if (!cartHasItems) {
        failedRef.count += 1;
        console.log(`FAIL | e2e cart view | status=${cartRes.status} | expected=200 with totalItems>0`);
        throw new Error("e2e cart view failed");
      } else {
        console.log(`PASS | e2e cart view | totalItems=${cartBody.totalItems}`);
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

      await sleep(checkoutReplayWaitMs);

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
        failedRef.count += 1;
        console.log(`FAIL | checkout first submit | status=${firstCheckoutRes.status} | expected=200/202 with orderId`);
        throw new Error("e2e first checkout failed");
      } else {
        console.log(`PASS | checkout first submit | status=${firstCheckoutRes.status}`);
      }

      if (!secondOk) {
        failedRef.count += 1;
        console.log(`FAIL | checkout idempotent replay | status=${secondCheckoutRes.status} | expected=200 with idempotentReplay=true and same orderId`);
        throw new Error("idempotency replay failed");
      } else {
        console.log("PASS | checkout idempotent replay | second request returned replay=true with same orderId");
      }

      const historyRes = await withTimeout(`${baseUrls.gateway}/api/orders/history`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const historyBody = await parseJsonSafe(historyRes);
      const historyOk = historyRes.status === 200
        && Array.isArray(historyBody.data)
        && historyBody.data.some((order) => Number(order.id) === Number(firstCheckoutBody.orderId));
      if (!historyOk) {
        failedRef.count += 1;
        console.log(`FAIL | e2e order history | status=${historyRes.status} | expected=200 with created order`);
      } else {
        console.log("PASS | e2e order history | created order found");
      }

      const missingKeyRes = await withTimeout(`${baseUrls.gateway}/api/orders/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (missingKeyRes.status !== 400) {
        failedRef.count += 1;
        console.log(`FAIL | checkout missing idempotency key | status=${missingKeyRes.status} | expected=400`);
      } else {
        console.log("PASS | checkout missing idempotency key | status=400");
      }
    }
  } catch (error) {
    failedRef.count += 1;
    console.log(`FAIL | checkout retry integration | error=${error.message}`);
  }

  if (failedRef.count > 0) {
    console.error(`Smoke test completed with ${failedRef.count} failure(s).`);
    process.exit(1);
  }

  console.log("Smoke test completed successfully.");
};

run();