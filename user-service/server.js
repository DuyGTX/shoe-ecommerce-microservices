const amqp = require("amqplib");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
require("dotenv").config();

const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const log = (level, message, extra = {}) => {
  console.log(JSON.stringify({
    level,
    service: "user-service",
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
};

const metrics = {
  requestCount: 0,
  totalLatencyMs: 0,
};

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
      if (!shouldRetryRequest(error)) {
        throw error;
      }

      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }

  circuit.failures += 1;
  if (circuit.failures >= failureThreshold || circuit.state === "HALF_OPEN") {
    circuit.state = "OPEN";
    circuit.openedAt = Date.now();
  }
  throw lastError;
};

const withRequestIdHeader = (req, config = {}) => {
  const merged = { ...config };
  merged.headers = {
    ...(config.headers || {}),
    ...(req.requestId ? { "x-request-id": req.requestId } : {}),
  };
  return merged;
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validateRegisterInput = ({ email, password, full_name }) => {
  if (!email || !password || !full_name) {
    return "Vui lòng điền đầy đủ email, mật khẩu và họ tên.";
  }

  if (!isValidEmail(email)) {
    return "Email không đúng định dạng.";
  }

  if (String(password).length < 6) {
    return "Mật khẩu phải có ít nhất 6 ký tự.";
  }

  return null;
};

const validateCartPayload = ({ productId, quantity, color, size }) => {
  if (!productId || !color || size === undefined || quantity === undefined) {
    return "Thiếu thông tin sản phẩm cần thêm vào giỏ hàng.";
  }

  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
    return "Số lượng phải là số nguyên dương.";
  }

  if (!Number.isInteger(Number(size)) || Number(size) <= 0) {
    return "Size phải là số nguyên dương.";
  }

  return null;
};

const CLEAR_CART_MAX_RETRIES = 3;

app.use((req, res, next) => {
  const startedAt = Date.now();
  req.requestId = req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader("x-request-id", req.requestId);

  res.on("finish", () => {
    const latencyMs = Date.now() - startedAt;
    metrics.requestCount += 1;
    metrics.totalLatencyMs += latencyMs;
    log("info", "request_completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      latencyMs,
    });
  });

  next();
});
// ---------------------------------------------------------
// LÍNH GÁC RABBITMQ (Lắng nghe tin nhắn xóa giỏ hàng)
// ---------------------------------------------------------
const consumeRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();
    connection.on("error", (err) => {
      console.error("❌ RabbitMQ connection error:", err.message);
    });
    connection.on("close", async () => {
      console.warn("⚠️ RabbitMQ disconnected, retrying in 3s...");
      await sleep(3000);
      consumeRabbitMQ();
    });
    
    await channel.assertExchange("clear_cart_dlx", "direct", { durable: true });
    await channel.assertQueue("clear_cart_dlq", { durable: true });
    await channel.bindQueue("clear_cart_dlq", "clear_cart_dlx", "clear_cart_failed");

    await channel.assertQueue("clear_cart_queue_v2", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "clear_cart_dlx" },
    });

    // 2. Chỉ nhận 1 tin nhắn mỗi lần
    channel.prefetch(1);

    console.log("📨 Đang chờ thư từ Bưu điện RabbitMQ...");

    channel.consume(
      "clear_cart_queue_v2",
      async (msg) => {
        if (msg !== null) {
          try {
            const data = JSON.parse(msg.content.toString());
            console.log(`📦 Đang xử lý xóa giỏ hàng cho User ID: ${data.userId}`);

            // THỰC THI LOGIC XỬ LÝ (Đã bỏ dấu //)
            // Đảm bảo biến 'pool' đã được khai báo ở đầu file nhé!
            await pool.query('DELETE FROM cart_items WHERE user_id = $1', [data.userId]);

            // XÁC NHẬN THÀNH CÔNG: Xóa tin khỏi RabbitMQ
            channel.ack(msg);
            console.log("✅ Đã dọn sạch giỏ hàng và gửi xác nhận (Ack)!");
            
          } catch (error) {
            const retryCount = Number(msg.properties.headers?.["x-retry-count"] || 0);

            if (retryCount >= CLEAR_CART_MAX_RETRIES) {
              console.log(JSON.stringify({
                level: "error",
                service: "user-service",
                message: "clear_cart_message_dead_lettered",
                timestamp: new Date().toISOString(),
                retryCount,
                error: error.message,
              }));
              channel.nack(msg, false, false);
              return;
            }

            channel.sendToQueue("clear_cart_queue_v2", msg.content, {
              persistent: true,
              headers: { ...(msg.properties.headers || {}), "x-retry-count": retryCount + 1 },
            });
            channel.ack(msg);
          }
        }
      },
      { noAck: false }
    );
  } catch (error) {
    console.error("❌ Lỗi kết nối RabbitMQ:", error.message);
  }
};

consumeRabbitMQ();
// ---------------------------------------------------------
// 2. CÁC API CỦA USER SERVICE
// ---------------------------------------------------------

// API 1: Test sức khỏe
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      service: "user-service",
      status: "ok",
      checks: {
        postgres: "up",
      },
    });
  } catch (err) {
    res.status(503).json({
      service: "user-service",
      status: "down",
      checks: {
        postgres: "down",
      },
      error: err.message,
    });
  }
});

app.get("/metrics", (req, res) => {
  const avgLatency = metrics.requestCount === 0 ? 0 : Number((metrics.totalLatencyMs / metrics.requestCount).toFixed(2));
  res.status(200).json({
    service: "user-service",
    requestCount: metrics.requestCount,
    avgLatencyMs: avgLatency,
  });
});

// API 2: Đăng ký tài khoản (Sign Up)
app.post("/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    const validationError = validateRegisterInput({
      email,
      password,
      full_name,
    });
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }
    
    const userExists = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email],
    );
    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: "Email này đã được sử dụng!" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await pool.query(
      "INSERT INTO users (email, password, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name",
      [email, hashedPassword, full_name],
    );

    res.status(201).json({
      message: "Đăng ký tài khoản thành công!",
      user: newUser.rows[0],
    });
  } catch (err) {
    console.error("Lỗi API Register:", err);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});

// API 3: Đăng nhập (Sign In) & Cấp JWT
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email và mật khẩu là bắt buộc." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Email không đúng định dạng." });
    }

    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email],
    );
    if (userResult.rows.length === 0) {
      return res
        .status(401)
        .json({ message: "Email hoặc mật khẩu không đúng!" });
    }

    const user = userResult.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Email hoặc mật khẩu không đúng!" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    res.status(200).json({
      message: "Đăng nhập thành công!",
      token: token,
      user: { id: user.id, full_name: user.full_name, email: user.email },
    });
  } catch (err) {
    console.error("Lỗi API Login:", err);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});
// ---------------------------------------------------------
// BẢO VỆ CỬA (MIDDLEWARE KIỂM TRA JWT)
// ---------------------------------------------------------
const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token)
    return res
      .status(403)
      .json({ message: "Bạn chưa cung cấp Thẻ thông hành (Token)." });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Gắn thông tin giải mã được vào request
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ message: "Thẻ thông hành giả mạo hoặc đã hết hạn!" });
  }
};

// ---------------------------------------------------------
// API 4: Thêm sản phẩm vào giỏ hàng (ĐÃ KHÓA BẢO MẬT)
// ---------------------------------------------------------
// Gắn verifyToken vào giữa đường dẫn và hàm xử lý
app.post("/cart/add", verifyToken, async (req, res) => {
  try {
    // Lấy userId CHUẨN từ chính Token (Đã được anh bảo vệ giải mã), KHÔNG lấy từ req.body nữa
    const userId = req.user.id;

    // Body bây giờ chỉ cần thông tin về món hàng
    const { productId, quantity, color, size } = req.body;

    const validationError = validateCartPayload({
      productId,
      quantity,
      color,
      size,
    });
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const normalizedQuantity = Number(quantity);
    const normalizedSize = Number(size);

    // ... (Toàn bộ phần code logic gọi Axios và lưu PostgreSQL ở dưới GIỮ NGUYÊN) ...
    const response = await requestWithRetry({
      method: "get",
      url: `http://product-service:3002/${productId}`,
      ...withRequestIdHeader(req),
      timeout: 4000,
    });
    const product = response.data.data;

    if (!product)
      return res.status(404).json({ message: "Sản phẩm không tồn tại!" });

    const variant = product.variants.find(
      (v) => v.color === color && v.size === normalizedSize,
    );

    if (!variant || variant.stock < normalizedQuantity) {
      return res
        .status(400)
        .json({ message: "Sản phẩm này đã hết hàng hoặc không đủ số lượng!" });
    }

    const finalPrice = product.salePrice ? product.salePrice : product.price;
    const total = finalPrice * normalizedQuantity;

    const checkCart = await pool.query(
      "SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2 AND color = $3 AND size = $4",
      [userId, productId, color, normalizedSize],
    );

    if (checkCart.rows.length > 0) {
      await pool.query(
        "UPDATE cart_items SET quantity = quantity + $1, total = total + $2 WHERE id = $3",
        [normalizedQuantity, total, checkCart.rows[0].id],
      );
    } else {
      await pool.query(
        `INSERT INTO cart_items (user_id, product_id, product_name, price, color, size, quantity, total) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          productId,
          product.name,
          finalPrice,
          color,
          normalizedSize,
          normalizedQuantity,
          total,
        ],
      );
    }

    res.status(200).json({
      message: "Đã thêm thành công vào giỏ hàng của bạn!",
      cartItem: {
        productName: product.name,
        price: finalPrice,
        color,
        size: normalizedSize,
        quantity: normalizedQuantity,
        total,
      },
    });
  } catch (err) {
    console.error("Lỗi khi gọi Product Service:", err.message);
    res
      .status(500)
      .json({ message: "Hệ thống đang quá tải. Vui lòng thử lại sau!" });
  }
});

// API 5: Xem thông tin cá nhân (CẦN CÓ TOKEN)
app.get("/profile", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query(
      "SELECT id, email, full_name, created_at FROM users WHERE id = $1",
      [userId],
    );

    res.status(200).json({
      message: "Chào mừng bạn đến với khu vực VIP!",
      data: userResult.rows[0],
    });
  } catch (err) {
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});
// API 6: Xem giỏ hàng của tôi (CẦN CÓ TOKEN)
app.get("/cart", verifyToken, async (req, res) => {
  try {
    // Lấy ID chuẩn từ Token
    const userId = req.user.id;

    // Truy vấn lấy toàn bộ sản phẩm trong giỏ của user này, sắp xếp mới nhất lên đầu
    const cartResult = await pool.query(
      "SELECT * FROM cart_items WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );

    // Tính tổng tiền toàn bộ giỏ hàng (Grand Total)
    const grandTotal = cartResult.rows.reduce(
      (sum, item) => sum + item.total,
      0,
    );

    res.status(200).json({
      message: "Lấy dữ liệu giỏ hàng thành công!",
      totalItems: cartResult.rows.length,
      grandTotal: grandTotal, // Tổng tiền để in ra màn hình cho khách xem
      data: cartResult.rows,
    });
  } catch (err) {
    console.error("Lỗi khi lấy giỏ hàng:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});
// ---------------------------------------------------------
// API 7: Cập nhật số lượng sản phẩm (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.put("/cart/update", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cartItemId, quantity } = req.body;
    const normalizedQuantity = Number(quantity);

    if (!Number.isInteger(Number(cartItemId)) || Number(cartItemId) <= 0) {
      return res.status(400).json({ message: "cartItemId không hợp lệ." });
    }

    if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
      return res
        .status(400)
        .json({
          message:
            "Số lượng phải lớn hơn 0. Nếu muốn xóa, hãy dùng chức năng Xóa.",
        });
    }

    // 1. Tìm sản phẩm trong giỏ xem có tồn tại không
    const cartItemResult = await pool.query(
      "SELECT * FROM cart_items WHERE id = $1 AND user_id = $2",
      [Number(cartItemId), userId],
    );

    if (cartItemResult.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "Không tìm thấy sản phẩm này trong giỏ hàng!" });
    }
    const item = cartItemResult.rows[0];

    // 2. GỌI ĐIỆN KIỂM TRA KHO (Tránh việc khách tăng số lượng lố hàng tồn kho)
    const response = await requestWithRetry({
      method: "get",
      url: `http://product-service:3002/${item.product_id}`,
      ...withRequestIdHeader(req),
      timeout: 4000,
    });
    const product = response.data.data;
    const variant = product.variants.find(
      (v) => v.color === item.color && v.size === item.size,
    );

    if (!variant || variant.stock < normalizedQuantity) {
      return res
        .status(400)
        .json({
          message: `Kho hàng chỉ còn tối đa ${variant ? variant.stock : 0} sản phẩm!`,
        });
    }

    // 3. Cập nhật Database (Tính lại tổng tiền cho món đó)
    const newTotal = item.price * normalizedQuantity;
    await pool.query(
      "UPDATE cart_items SET quantity = $1, total = $2 WHERE id = $3",
      [normalizedQuantity, newTotal, Number(cartItemId)],
    );

    res.status(200).json({ message: "Cập nhật số lượng thành công!" });
  } catch (err) {
    console.error("Lỗi API Update Cart:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});

app.put("/profile", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name } = req.body;

    if (!full_name || String(full_name).trim().length < 2) {
      return res.status(400).json({ message: "Họ tên phải có ít nhất 2 ký tự." });
    }

    const result = await pool.query(
      "UPDATE users SET full_name = $1 WHERE id = $2 RETURNING id, email, full_name, created_at",
      [String(full_name).trim(), userId],
    );

    res.status(200).json({
      message: "Cập nhật hồ sơ thành công!",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Lỗi API Update Profile:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});

app.put("/change-password", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Vui lòng nhập mật khẩu hiện tại và mật khẩu mới." });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "Mật khẩu mới phải có ít nhất 6 ký tự." });
    }

    const userResult = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy người dùng." });
    }

    const isMatch = await bcrypt.compare(currentPassword, userResult.rows[0].password);
    if (!isMatch) {
      return res.status(400).json({ message: "Mật khẩu hiện tại không đúng." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, userId]);

    res.status(200).json({ message: "Đổi mật khẩu thành công!" });
  } catch (err) {
    console.error("Lỗi API Change Password:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});

// ---------------------------------------------------------
// API 8: Xóa sản phẩm khỏi giỏ hàng (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.delete("/cart/remove/:cartItemId", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const cartItemId = req.params.cartItemId; // Lấy ID trực tiếp từ trên URL

    // Xóa thẳng tay nếu đúng là đồ của user này
    const result = await pool.query(
      "DELETE FROM cart_items WHERE id = $1 AND user_id = $2 RETURNING id",
      [cartItemId, userId],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ message: "Sản phẩm không tồn tại hoặc đã bị xóa!" });
    }

    res.status(200).json({ message: "Đã vứt sản phẩm ra khỏi giỏ hàng!" });
  } catch (err) {
    console.error("Lỗi API Delete Cart:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});
// ---------------------------------------------------------
// API 9: Dọn sạch giỏ hàng sau khi chốt đơn (CẦN CÓ TOKEN)
// ---------------------------------------------------------
app.delete("/cart/clear", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id; // Lấy ID của Sếp Lớn từ Token

    // Xóa TOÀN BỘ các dòng trong bảng cart_items thuộc về user này
    await pool.query("DELETE FROM cart_items WHERE user_id = $1", [userId]);

    res.status(200).json({ message: "Đã dọn sạch giỏ hàng!" });
  } catch (err) {
    console.error("Lỗi API Clear Cart:", err.message);
    res.status(500).json({ message: "Lỗi máy chủ nội bộ" });
  }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 User Service đang chạy tại http://localhost:${PORT}`);
});
