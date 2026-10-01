/**
 * Custom error class. Throw this from anywhere in the app (controllers,
 * services, middleware) and the centralized errorHandler will turn it
 * into a consistent { success: false, message } JSON response.
 */
class ApiError extends Error {
  constructor(statusCode, message = "Something went wrong", errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.success = false;

    Error.captureStackTrace(this, this.constructor);
  }
}

export default ApiError;
