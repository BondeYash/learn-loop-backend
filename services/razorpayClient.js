import crypto from "node:crypto";
import ApiError from "../utils/ApiError.js";
import { razorpayMode } from "./paymentSettings.js";

export function razorpayReadiness(env = process.env) {
  let mode;
  try { mode = razorpayMode(env); } catch (error) { return { configured: false, provider: "razorpay", reason: error.message }; }
  const settings = { provider: "razorpay", mode, testMode: mode === "test" };
  const key = env.RAZORPAY_KEY_ID || "", secret = env.RAZORPAY_KEY_SECRET || "", webhook = env.RAZORPAY_WEBHOOK_SECRET || "";
  if (!new RegExp(`^rzp_${mode}_[A-Za-z0-9]+$`).test(key)) return { ...settings, configured: false, reason: "RAZORPAY_KEY_ID must match RAZORPAY_MODE." };
  if (!secret || !webhook) return { ...settings, configured: false, reason: "Configure RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET privately on the backend." };
  if (secret.length < 8 || webhook.length < 16 || /REPLACE|placeholder/i.test(secret + webhook)) return { ...settings, configured: false, reason: "Use valid private Razorpay credentials and a webhook secret of at least 16 characters." };
  try { razorpayOrigin(env); } catch (error) { return { ...settings, configured: false, reason: error.message }; }
  return { ...settings, configured: true };
}
export function requireRazorpaySettings(env = process.env) {
  const settings = razorpayReadiness(env);
  if (!settings.configured) throw new ApiError(503, settings.reason);
  return settings;
}
export function razorpayOrigin(env = process.env) {
  const mode = razorpayMode(env);
  let origin;
  try { origin = new URL(env.CLIENT_URL || (mode === "test" ? "http://localhost:5173" : "")); } catch { throw new ApiError(503, "CLIENT_URL must be the frontend HTTPS origin for live payments."); }
  const local = mode === "test" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !local) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ApiError(503, "CLIENT_URL must be the frontend origin; live payments require HTTPS.");
  return origin;
}
export const validRazorpayId = (id, kind) => typeof id === "string" && new RegExp(`^${kind}_[A-Za-z0-9]{1,100}$`).test(id);
export function validSignature(message, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f\d]{64}$/i.test(signature)) return false;
  return crypto.timingSafeEqual(crypto.createHmac("sha256", secret).update(message).digest(), Buffer.from(signature, "hex"));
}
export function verifyRazorpayEvent(body, signature) {
  requireRazorpaySettings();
  if (!Buffer.isBuffer(body) || !validSignature(body, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) throw new ApiError(400, "Invalid Razorpay webhook signature.");
  let event;
  try { event = JSON.parse(body.toString("utf8")); } catch { throw new ApiError(400, "Invalid Razorpay webhook payload."); }
  if (!event || event.entity !== "event" || typeof event.event !== "string" || !Number.isSafeInteger(event.created_at)) throw new ApiError(400, "Invalid Razorpay webhook event.");
  return event;
}

// Only these fixed provider paths are used. Provider responses and credentials
// are never logged or echoed in errors returned to students.
export function razorpayClient(env = process.env, fetchProvider = fetch) {
  requireRazorpaySettings(env);
  const request = async (path, options = {}) => {
    let response, data;
    try {
      response = await fetchProvider(`https://api.razorpay.com/v1/${path}`, {
        method: options.body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(3500),
        headers: { Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`, "Content-Type": "application/json" },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!response.ok) {
        const error = new ApiError(502, [401, 403].includes(response.status) ? "Razorpay configuration needs attention. Contact the course administrator." : "Razorpay could not complete this request. Retry shortly.");
        error.providerRejected = [400, 401, 403, 422].includes(response.status);
        throw error;
      }
      const text = await response.text();
      if (text.length > 1048576) throw new Error("Provider response exceeds the bound");
      data = JSON.parse(text);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "Razorpay is temporarily unavailable. Retry the same payment attempt.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError(502, "Razorpay returned an invalid response.");
    return data;
  };
  const id = (value, kind) => { if (!validRazorpayId(value, kind)) throw new ApiError(400, "Invalid Razorpay identifier."); return value; };
  return {
    createOrder: (body) => request("orders", { body }),
    fetchOrder: (value) => request(`orders/${id(value, "order")}`),
    fetchOrders: (params) => request(`orders?${new URLSearchParams(params)}`),
    fetchOrderPayments: (value) => request(`orders/${id(value, "order")}/payments`),
    fetchPayment: (value) => request(`payments/${id(value, "pay")}`),
  };
}
