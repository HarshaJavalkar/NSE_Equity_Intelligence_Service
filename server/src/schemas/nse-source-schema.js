const { z } = require("zod");

const nseSourceSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    officialPage: z
      .string()
      .url()
      .refine((value) => {
        const hostname = new URL(value).hostname;
        return (
          hostname === "nseindia.com" || hostname.endsWith(".nseindia.com")
        );
      }, "Source page must use an official NSE India domain."),
    discoveryMethod: z.string().min(1),
    reportName: z.string().min(1),
    frequency: z.enum(["TRADING_DAY", "EVENT_DRIVEN", "ON_CHANGE"]),
    expectedFormat: z.string().nullable(),
    dateParameter: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .nullable(),
    parser: z.function().nullable(),
    normalizer: z.function().nullable(),
    enabled: z.boolean(),
    verificationStatus: z.string().min(1),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.enabled &&
      (source.parser === null || source.normalizer === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Enabled sources must define both a parser and normalizer.",
        path: ["enabled"],
      });
    }
  });

module.exports = { nseSourceSchema };
