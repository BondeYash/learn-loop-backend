import ApiError from "../utils/ApiError.js";
export function razorpayMode(env = process.env) {
  const mode = env.RAZORPAY_MODE ?? "test";
  if (!["test", "live"].includes(mode)) throw new ApiError(503, "RAZORPAY_MODE must be test or live.");
  return mode;
}
export function paymentMode(env = process.env) {
  return razorpayMode(env);
}
