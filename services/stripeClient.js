import Stripe from "stripe";
import ApiError from "../utils/ApiError.js";
import { stripeMode } from "./stripeMode.js";

export const STRIPE_API_VERSION = "2026-09-30.endive";
export function stripeReadiness(env = process.env) {
  let mode;
  try { mode = stripeMode(env); }
  catch (error) { return { configured: false, mode: null, testMode: null, reason: error.message }; }
  const settings = { mode, testMode: mode === "test" };
  const key = env.STRIPE_SECRET_KEY || "", secret = env.STRIPE_WEBHOOK_SECRET || "";
  if (key && !key.startsWith(`sk_${mode}_`)) return { configured: false, ...settings, reason: "STRIPE_SECRET_KEY does not match STRIPE_MODE." };
  if (!key || !secret) return { configured: false, ...settings, reason: "Configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET privately on the backend." };
  if (!secret.startsWith("whsec_") || /REPLACE|placeholder/i.test(key + secret)) return { configured: false, ...settings, reason: "Payments require a matching Stripe secret key and this mode's webhook signing secret." };
  try { checkoutOrigin(env); }
  catch (error) { return { configured: false, ...settings, reason: error.message }; }
  return { configured: true, ...settings };
}
export function requireStripeSettings(env = process.env) {
  const readiness = stripeReadiness(env);
  if (!readiness.configured) throw new ApiError(503, readiness.reason);
  return readiness;
}
export function validateStripeStartup(env = process.env) {
  const mode = stripeMode(env), key = env.STRIPE_SECRET_KEY || "", secret = env.STRIPE_WEBHOOK_SECRET || "";
  if (key && !key.startsWith(`sk_${mode}_`)) throw new ApiError(503, "STRIPE_SECRET_KEY does not match STRIPE_MODE.");
  if (secret && !secret.startsWith("whsec_")) throw new ApiError(503, "Invalid STRIPE_WEBHOOK_SECRET format.");
  // Missing settings keep payments unavailable while free courses still work.
  if (key && secret) requireStripeSettings(env);
}
export function checkoutOrigin(env = process.env) {
  const mode = stripeMode(env);
  let origin;
  try { origin = new URL(env.CLIENT_URL || (mode === "test" ? "http://localhost:5173" : "")); }
  catch { throw new ApiError(503, "CLIENT_URL must be the verified HTTPS frontend origin for live payments."); }
  const localHttp = mode === "test" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !localHttp) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ApiError(503, "CLIENT_URL must be the verified frontend origin; live payments require HTTPS.");
  return origin;
}
let client, lastKey;
export function stripeClient() {
  requireStripeSettings();
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
  assertStripeEventMode(event);
  return event;
}
export function assertStripeEventMode(event) {
  if (event.livemode !== (stripeMode() === "live") || event.account || event.context) throw new ApiError(400, "Stripe event mode/account does not match this deployment.");
}
export function trustedCheckoutUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password && !url.port; }
  catch { return false; }
}
