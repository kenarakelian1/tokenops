import { z } from "zod";

export const ModelTierSchema = z.enum(["frontier", "mid", "small", "unknown"]);

export const EventGrainSchema = z.enum(["request", "aggregate"]);
export type EventGrain = z.infer<typeof EventGrainSchema>;

export const UsageFeaturesSchema = z.object({
  promptChars: z.number().optional(),
  responseChars: z.number().optional(),
  messageCount: z.number().optional(),
  codeFenceCount: z.number().optional(),
  largePasteScore: z.number().optional(),
  fileDumpScore: z.number().optional(),
  modelTier: ModelTierSchema,
  newContentRatio: z.number().optional(),
});

export const UsageEventSchema = z.object({
  eventId: z.string().min(1),
  timestamp: z.string().min(1),
  machineId: z.string().min(1),
  machineName: z.string(),
  app: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nullable(),
  latencyMs: z.number().optional(),
  sessionId: z.string().optional(),
  /**
   * How this event was derived. Absent means "request" — every producer except
   * the OTEL receiver emits per-request records.
   */
  grain: EventGrainSchema.optional(),
  features: UsageFeaturesSchema,
  hasContent: z.boolean(),
  /** Cache tokens, reported separately. Still counted inside inputTokens. */
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
  content: z
    .object({
      requestBody: z.unknown().optional(),
      responseBody: z.unknown().optional(),
    })
    .optional(),
});

export const IngestBatchSchema = z.object({
  events: z.array(UsageEventSchema),
});

export type UsageFeatures = z.infer<typeof UsageFeaturesSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

export function parseUsageEvent(input: unknown): UsageEvent {
  return UsageEventSchema.parse(input);
}
