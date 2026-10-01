/**
 * Wraps an async route handler so rejected promises are forwarded to
 * Express's error-handling middleware instead of crashing the process.
 * Usage: router.get('/', asyncHandler(async (req, res) => {...}))
 */
const asyncHandler = (requestHandler) => (req, res, next) => {
  Promise.resolve(requestHandler(req, res, next)).catch(next);
};

export default asyncHandler;
