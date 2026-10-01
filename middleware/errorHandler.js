import ApiError from "../utils/ApiError.js";

/**
 * Catches known error types (Mongoose CastError, duplicate key, validation)
 * and normalizes everything into { success: false, message } with the
 * right HTTP status code. Must be registered last, after all routes.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    let statusCode = error.statusCode || 500;
    let message = error.message || "Internal Server Error";

    // Invalid MongoDB ObjectId
    if (error.name === "CastError") {
      statusCode = 400;
      message = `Invalid ${error.path}: ${error.value}`;
    }

    // Mongoose duplicate key (e.g. duplicate email)
    if (error.code === 11000) {
      statusCode = 409;
      const field = Object.keys(error.keyValue || {})[0];
      message = `Duplicate value for field: ${field}`;
    }

    // Mongoose validation errors
    if (error.name === "ValidationError") {
      statusCode = 400;
      message = Object.values(error.errors)
        .map((val) => val.message)
        .join(", ");
    }

    // Invalid / expired JWT
    if (error.name === "JsonWebTokenError") {
      statusCode = 401;
      message = "Invalid token. Please log in again.";
    }
    if (error.name === "TokenExpiredError") {
      statusCode = 401;
      message = "Session expired. Please log in again.";
    }

    error = new ApiError(statusCode, message, error.errors || []);
  }

  const response = {
    success: false,
    message: error.message,
    ...(error.errors?.length ? { errors: error.errors } : {}),
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  };

  return res.status(error.statusCode || 500).json(response);
};

/**
 * Handles requests to routes that don't exist. Registered right before
 * errorHandler.
 */
const notFound = (req, res, next) => {
  const error = new ApiError(404, `Route not found: ${req.originalUrl}`);
  next(error);
};

export { errorHandler, notFound };
