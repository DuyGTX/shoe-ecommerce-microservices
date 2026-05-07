const crypto = require("crypto");

const VNPAY_VERSION = "2.1.0";
const VNPAY_COMMAND = "pay";
const VNPAY_CURRENCY = "VND";
const VNPAY_LOCALE = "vn";

const formatVnpayDate = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
};

const sortObject = (input) => Object.keys(input)
  .filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== "")
  .sort()
  .reduce((result, key) => {
    result[key] = input[key];
    return result;
  }, {});

const encodeValue = (value) => encodeURIComponent(String(value)).replace(/%20/g, "+");

const buildSignedPayload = (params) => Object.entries(sortObject(params))
  .map(([key, value]) => `${key}=${encodeValue(value)}`)
  .join("&");

const createSecureHash = (params, hashSecret) => crypto
  .createHmac("sha512", hashSecret)
  .update(Buffer.from(buildSignedPayload(params), "utf-8"))
  .digest("hex");

const timingSafeEqualHex = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const buildPaymentUrl = ({
  amount,
  bankCode,
  clientIp,
  orderId,
  orderInfo,
  orderType = "other",
  returnUrl = process.env.VNPAY_RETURN_URL,
  tmnCode = process.env.VNPAY_TMN_CODE,
  hashSecret = process.env.VNPAY_HASH_SECRET,
  vnpUrl = process.env.VNPAY_URL,
  locale = VNPAY_LOCALE,
  createDate = new Date(),
}) => {
  if (!tmnCode || !hashSecret || !vnpUrl || !returnUrl) {
    throw new Error("VNPay configuration is missing.");
  }

  const params = {
    vnp_Version: VNPAY_VERSION,
    vnp_Command: VNPAY_COMMAND,
    vnp_TmnCode: tmnCode,
    vnp_Amount: Number(amount) * 100,
    vnp_CurrCode: VNPAY_CURRENCY,
    vnp_TxnRef: orderId,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: orderType,
    vnp_Locale: locale,
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: clientIp,
    vnp_CreateDate: formatVnpayDate(createDate),
  };

  if (bankCode) params.vnp_BankCode = bankCode;

  const secureHash = createSecureHash(params, hashSecret);
  const query = buildSignedPayload({ ...params, vnp_SecureHash: secureHash });
  return `${vnpUrl}?${query}`;
};

const verifySecureHash = (queryParams, hashSecret = process.env.VNPAY_HASH_SECRET) => {
  if (!hashSecret) throw new Error("VNPay hash secret is missing.");

  const { vnp_SecureHash: secureHash, vnp_SecureHashType, ...unsignedParams } = queryParams;
  if (!secureHash) return false;

  const expectedHash = createSecureHash(unsignedParams, hashSecret);
  return timingSafeEqualHex(secureHash, expectedHash);
};

module.exports = {
  buildPaymentUrl,
  verifySecureHash,
  createSecureHash,
  formatVnpayDate,
  sortObject,
};