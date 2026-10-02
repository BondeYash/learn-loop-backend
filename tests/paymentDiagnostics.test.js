import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { paymentFailureDiagnostic, reportPaymentFailure, paymentFailureReason, checkoutFailureMessage } from "../services/paymentDiagnostics.js";

test("official Stripe errors retain safe classification and request correlation without private messages or objects", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "parameter_missing", param: "line_items[0][price_data][currency]", statusCode: 400, requestId: "req_fixture", message: "PRIVATE_PROVIDER_MESSAGE", headers: { authorization: "PRIVATE_CREDENTIAL" }, payment_intent: { customer: "PRIVATE_CUSTOMER" }, request_log_url: "PRIVATE_URL" });
  const expected = { event: "stripe_payment_failure", operation: "checkout_create", mode: "live", type: "StripeInvalidRequestError", reason: "request_parameters", code: "parameter_missing", status: 400, requestId: "req_fixture", param: "line_items[0][price_data][currency]" };
  assert.deepEqual(paymentFailureDiagnostic(error,"checkout_create","live"),expected);
  const lines = [], previous = console.error;
  try { console.error = (line) => lines.push(line); reportPaymentFailure(error,"checkout_create","live"); }
  finally { console.error = previous; }
  assert.deepEqual(JSON.parse(lines[0]),expected);assert.doesNotMatch(lines[0],/PRIVATE|message|headers|raw|stack|authorization|customer|https/);
});

test("diagnostic fields reject oversized, arbitrary, credential-like and control-character values", () => {
  const fallback = { event: "stripe_payment_failure", operation: "unknown", mode: "unknown", type: "UnknownError", reason: "unknown" };
  assert.deepEqual(paymentFailureDiagnostic(null,"private operation","private mode"),fallback);
  for(const value of ["sk_live_synthetic","whsec_synthetic","PRIVATE@example.invalid","secret\nforged log","a".repeat(200),{}]) {
    assert.deepEqual(paymentFailureDiagnostic({type:value,code:value,param:value,requestId:value,statusCode:value},value,value),fallback);
  }
  // Prototype names are unknown types, not reasons inherited from an object.
  // "constructor" alone satisfies the existing bounded code-token grammar;
  // test the new type classifier independently of that separate code field.
  for(const type of ["constructor","__proto__","toString"]) assert.deepEqual(paymentFailureDiagnostic({type},"private operation","private mode"),fallback);
  for(const type of ["StripeAuthenticationError","StripePermissionError","StripeRateLimitError","StripeConnectionError","StripeIdempotencyError"]) assert.equal(paymentFailureDiagnostic({type},"order_refresh","test").type,type);
});

test("parameter-free errors emit only fixed reasons and public text, including secret-like message suffixes", () => {
  const privateText = "sk_live_synthetic PRIVATE@example.invalid PRIVATE_CUSTOMER";
  for (const message of ["There are no valid payment method types for the Checkout session.", "No valid payment method types for this Checkout Session. " + privateText]) {
    const error = new Stripe.errors.StripeInvalidRequestError({statusCode:400,message,headers:{"idempotent-replayed":"true"}});
    assert.equal(paymentFailureReason(error),"no_eligible_payment_methods");
    assert.equal(paymentFailureDiagnostic(error,"checkout_create","live").idempotentReplayed,true);
    assert.match(checkoutFailureMessage(error),/^No eligible payment method/);
    assert.doesNotMatch(JSON.stringify([paymentFailureDiagnostic(error,"checkout_create","live"),checkoutFailureMessage(error)]),/PRIVATE|sk_live|message|headers/);
  }
  const unknown=new Stripe.errors.StripeInvalidRequestError({statusCode:400,message:privateText});
  assert.equal(paymentFailureReason(unknown),"invalid_request_unclassified");assert.doesNotMatch(checkoutFailureMessage(unknown),/activation|method|PRIVATE/);
  assert.equal(paymentFailureReason(new Stripe.errors.StripeInvalidRequestError({code:"testmode_charges_only",message:privateText})),"live_activation_required");
  for(const message of ["Prefix: No valid payment method types for this Checkout Session.","No valid payment method types for this Checkout Session."+"a".repeat(2001)]) assert.equal(paymentFailureReason({type:"StripeInvalidRequestError",message}),"invalid_request_unclassified");
});
