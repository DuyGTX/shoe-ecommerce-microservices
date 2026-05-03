jest.mock("../utils/httpClient", () => ({
  requestWithRetry: jest.fn(),
}));

const { requestWithRetry } = require("../utils/httpClient");
const { createOrderService } = require("../services/orderService");

const cartItems = [
  {
    product_id: "shoe-001",
    product_name: "Runner Pro",
    price: 1200000,
    color: "black",
    size: "42",
    quantity: 2,
    total: 2400000,
  },
];

const createTestContext = () => {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  };
  const orderModel = {
    findReplayByKey: jest.fn().mockResolvedValue({ rows: [] }),
    createOrderWithItems: jest.fn().mockResolvedValue(101),
  };
  const publishOrderCreated = jest.fn();
  const publishCartClearRequested = jest.fn();
  const log = jest.fn();
  const service = createOrderService({
    pool,
    orderModel,
    getRabbitReady: jest.fn(() => true),
    publishOrderCreated,
    publishCartClearRequested,
    log,
  });

  return { client, pool, orderModel, publishOrderCreated, publishCartClearRequested, log, service };
};

describe("orderService.checkout", () => {
  beforeEach(() => {
    requestWithRetry.mockResolvedValue({
      data: {
        data: cartItems,
        grandTotal: 2400000,
      },
    });
  });

  it("creates a valid order and publishes the RabbitMQ event", async () => {
    const { client, orderModel, publishOrderCreated, service } = createTestContext();

    const result = await service.checkout({
      userId: 7,
      tokenString: "valid-token",
      requestId: "req-001",
      idempotencyKey: "checkout-key-001",
    });

    expect(result).toEqual({
      statusCode: 202,
      body: {
        message: "Đơn hàng đã được tạo PENDING, hệ thống đang giữ kho.",
        orderId: 101,
        totalPaid: 2400000,
        status: "PENDING",
      },
    });
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(orderModel.createOrderWithItems).toHaveBeenCalledTimes(1);
    expect(orderModel.createOrderWithItems).toHaveBeenCalledWith(client, {
      userId: 7,
      idempotencyKey: "checkout-key-001",
      grandTotal: 2400000,
      cartItems,
    });
    expect(publishOrderCreated).toHaveBeenCalledTimes(1);
    expect(publishOrderCreated).toHaveBeenCalledWith(101, [
      {
        productId: "shoe-001",
        quantity: 2,
        color: "black",
        size: "42",
      },
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent replay and creates only one order for the same key", async () => {
    const { orderModel, publishOrderCreated, service } = createTestContext();
    const replayRow = { id: 101, total_amount: 2400000, status: "PENDING" };

    orderModel.findReplayByKey
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replayRow] });

    const payload = {
      userId: 7,
      tokenString: "valid-token",
      requestId: "req-002",
      idempotencyKey: "same-checkout-key",
    };

    const firstResult = await service.checkout(payload);
    const secondResult = await service.checkout(payload);

    expect(firstResult).toEqual({
      statusCode: 202,
      body: {
        message: "Đơn hàng đã được tạo PENDING, hệ thống đang giữ kho.",
        orderId: 101,
        totalPaid: 2400000,
        status: "PENDING",
      },
    });
    expect(secondResult).toEqual({
      statusCode: 200,
      body: {
        message: "Yêu cầu checkout đã được xử lý trước đó.",
        orderId: 101,
        totalPaid: 2400000,
        status: "PENDING",
        idempotentReplay: true,
      },
    });
    expect(orderModel.createOrderWithItems).toHaveBeenCalledTimes(1);
    expect(publishOrderCreated).toHaveBeenCalledTimes(1);
    expect(requestWithRetry).toHaveBeenCalledTimes(1);
  });
});