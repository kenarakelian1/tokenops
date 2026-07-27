export const TOKENOPS_VERSION = "0.1.0";

export { buildEventId } from "./event-id.js";
export {
  DEFAULT_PRICES,
  estimateCostUsd,
  type PriceRow,
} from "./pricing.js";
export { getModelTier, type ModelTier } from "./model-tier.js";
export {
  UsageEventSchema,
  UsageFeaturesSchema,
  IngestBatchSchema,
  ModelTierSchema,
  parseUsageEvent,
  type UsageEvent,
  type UsageFeatures,
  type IngestBatch,
} from "./schema/event.js";
export { extractFeatures, type ExtractFeaturesInput } from "./features.js";
export { applyPrivacy, type ContentMode } from "./privacy.js";
export {
  runRules,
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  type RuleHit,
  type RuleId,
} from "./rules/index.js";
