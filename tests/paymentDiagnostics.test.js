import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { paymentFailureDiagnostic, reportPaymentFailure } from "../services/paymentDiagnostics.js";

test("official Stripe errors retain safe classification and request correlation without private messages or objects", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "parameter_missing", param: "line_items[0][price_data][currency]", statusCode: 400, requestId: "req_fixture", message: "PRIVATE_PROVIDER_MESSAGE", headers: { authorization: "PRIVATE_CREDENTIAL" }, payment_intent: { customer: "PRIVATE_CUSTOMER" }, request_log_url: "PRIVATE_URL" });
  const expected = { event: "stripe_payment_failure", operation: "checkout_create", mode: "live", type: "StripeInvalidRequestError", code: "parameter_missing", status: 400, requestId: "req_fixture", param: "line_items[0][price_data][currency]" };
  assert.deepEqual(paymentFailureDiagnostic(error,"checkout_create","live"),expected);
  const lines = [], previous = console.error;
  try { console.error = (line) => lines.push(line); reportPaymentFailure(error,"checkout_create","live"); }
  finally { console.error = previous; }
  assert.deepEqual(JSON.parse(lines[0]),expected);assert.doesNotMatch(lines[0],/PRIVATE|message|headers|raw|stack|authorization|customer|https/);
});

test("diagnostic fields reject oversized, arbitrary, credential-like and control-character values", () => {
  const fallback = { event: "stripe_payment_failure", operation: "unknown", mode: "unknown", type: "UnknownError" };
  assert.deepEqual(paymentFailureDiagnostic(null,"private operation","private mode"),fallback);
  for(const value of ["sk_live_synthetic","whsec_synthetic","PRIVATE@example.invalid","secret\nforged log","a".repeat(200),{}]) {
    assert.deepEqual(paymentFailureDiagnostic({type:value,code:value,param:value,requestId:value,statusCode:value},value,value),fallback);
  }
  for(const type of ["StripeAuthenticationError","StripePermissionError","StripeRateLimitError","StripeConnectionError","StripeIdempotencyError"]) assert.equal(paymentFailureDiagnostic({type},"order_refresh","test").type,type);
});
