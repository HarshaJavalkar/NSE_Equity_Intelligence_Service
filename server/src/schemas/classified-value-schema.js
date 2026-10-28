const { z } = require("zod");

const provenanceSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    sourceReference: z.string().min(1).optional(),
    contentHash: z.string().min(1).optional(),
    inputs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const classifiedValueSchema = z.discriminatedUnion("classification", [
  z
    .object({
      classification: z.literal("REPORTED_NSE"),
      value: z.unknown(),
      provenance: provenanceSchema.extend({ sourceId: z.string().min(1) }),
    })
    .strict(),
  z
    .object({
      classification: z.literal("CALCULATED"),
      value: z.unknown(),
      provenance: provenanceSchema.extend({
        inputs: z.array(z.string().min(1)).min(1),
      }),
    })
    .strict(),
  z
    .object({
      classification: z.literal("EVENT"),
      value: z.record(z.string(), z.unknown()),
      provenance: provenanceSchema.extend({ sourceId: z.string().min(1) }),
    })
    .strict(),
  z
    .object({
      classification: z.literal("DOCUMENT_REFERENCE"),
      value: z
        .object({
          url: z.string().url().optional(),
          archiveRef: z.string().min(1).optional(),
        })
        .strict()
        .refine((reference) => reference.url || reference.archiveRef, {
          message:
            "A document reference must include a URL or archive reference.",
        }),
      provenance: provenanceSchema.extend({ sourceId: z.string().min(1) }),
    })
    .strict(),
  z
    .object({
      classification: z.literal("UNAVAILABLE"),
      value: z.null(),
      reason: z.string().min(1),
    })
    .strict(),
]);

function createClassifiedValue(input) {
  return classifiedValueSchema.parse(input);
}

module.exports = { classifiedValueSchema, createClassifiedValue };
