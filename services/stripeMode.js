import ApiError from "../utils/ApiError.js";

// Never infer the operating mode from a secret or a browser request.
export function stripeMode(env = process.env) {
  const mode = env.STRIPE_MODE ?? "test";
  if (mode !== "test" && mode !== "live") throw new ApiError(503, "STRIPE_MODE must be exactly test or live.");
  return mode;
}
