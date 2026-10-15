import ApiError from "../utils/ApiError.js";

// Bound the whole provider operation, including reading its response body.
// Never retry generation automatically: a retry may consume another allowance.
export async function answerWithDeadline(provider, args, timeoutMs = 45000) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new ApiError(504, "The AI service took too long to answer. Your question is saved. Please try again or ask your instructor.");
      reject(error); controller.abort(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => provider.answer({ ...args, signal: controller.signal })), deadline]); }
  finally { clearTimeout(timer); }
}
