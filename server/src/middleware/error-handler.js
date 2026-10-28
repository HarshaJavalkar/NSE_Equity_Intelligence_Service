const { AppError } = require("../utils/app-error");
const { sendError } = require("../utils/http-response");

function notFoundHandler(req, res) {
  return sendError(res, {
    statusCode: 404,
    code: "ROUTE_NOT_FOUND",
    message: "The requested route does not exist.",
    requestId: req.id,
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error instanceof AppError) {
    return sendError(res, {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      requestId: req.id,
    });
  }

  if (error.type === "entity.parse.failed") {
    return sendError(res, {
      statusCode: 400,
      code: "MALFORMED_JSON",
      message: "Request body must contain valid JSON.",
      requestId: req.id,
    });
  }

  if (error.type === "entity.too.large") {
    return sendError(res, {
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the configured limit.",
      requestId: req.id,
    });
  }

  console.error({ requestId: req.id, error: error.message });
  return sendError(res, {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    requestId: req.id,
  });
}

module.exports = { errorHandler, notFoundHandler };
