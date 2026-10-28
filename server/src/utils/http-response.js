function sendSuccess(res, { data, requestId, statusCode = 200 }) {
  return res.status(statusCode).json({
    success: true,
    data,
    meta: {
      requestId,
      generatedAt: new Date().toISOString(),
    },
  });
}

function sendError(
  res,
  { statusCode, code, message, requestId, details = undefined },
) {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    meta: {
      requestId,
      generatedAt: new Date().toISOString(),
    },
  });
}

module.exports = { sendError, sendSuccess };
