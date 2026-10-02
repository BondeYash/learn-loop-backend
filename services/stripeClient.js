import Stripe from "stripe";
import ApiError from "../utils/ApiError.js";

export const STRIPE_API_VERSION = "2026-09-30.endive";
export function stripeReadiness(env = process.env) {
  const key = env.STRIPE_SECRET_KEY || "", secret = env.STRIPE_WEBHOOK_SECRET || "";
  if (!key || !secret) return { configured: false, testMode: true, reason: "Configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET privately on the backend." };
  if (!key.startsWith("sk_test_") || !secret.startsWith("whsec_") || /REPLACE|placeholder/i.test(key + secret)) return { configured: false, testMode: true, reason: "Payments require a Stripe test secret key and webhook signing secret; live keys are disabled." };
  return { configured: true, testMode: true };
}
export function requireStripeTestSettings(env = process.env) {
  const readiness = stripeReadiness(env);
  if (!readiness.configured) throw new ApiError(503, readiness.reason);
}
let client, lastKey;
export function stripeClient() {
  requireStripeTestSettings();
  if (!client || lastKey !== process.env.STRIPE_SECRET_KEY) {
    lastKey = process.env.STRIPE_SECRET_KEY;
    client = new Stripe(lastKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 1, timeout: 10000 });
  }
  return client;
}
export function verifyStripeEvent(body, signature) {
  if (!Buffer.isBuffer(body) || typeof signature !== "string") throw new ApiError(400, "A signed raw Stripe request is required.");
  let event;
  try { event = stripeClient().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, "Stripe webhook signature is invalid or expired."); }
  if (event.livemode !== false || event.account || event.context) throw new ApiError(400, "Only this account's Stripe test events are accepted.");
  return event;
}
export function trustedCheckoutUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password && !url.port; }
  catch { return false; }
}
