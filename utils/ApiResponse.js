/**
 * Standardized success response shape used across every controller.
 * { success: true, message, data }
 */
class ApiResponse {
  constructor(res, statusCode = 200, message = "Success", data = {}) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }
}

export default ApiResponse;
