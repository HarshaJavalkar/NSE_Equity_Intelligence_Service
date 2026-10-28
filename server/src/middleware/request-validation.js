const { AppError } = require("../utils/app-error");

function validateRequest(schemas) {
  return (req, res, next) => {
    const validated = {};

    for (const [key, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(
          new AppError(400, "VALIDATION_FAILED", "Request validation failed.", {
            issues: result.error.issues.map(({ path, message, code }) => ({
              path,
              message,
              code,
            })),
          }),
        );
      }
      validated[key] = result.data;
    }

    req.validated = validated;
    next();
  };
}

module.exports = validateRequest;
