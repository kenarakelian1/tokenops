export const TOKENOPS_VERSION = "0.1.0";

export { buildEventId } from "./event-id.js";
export {
  DEFAULT_PRICES,
  estimateCostUsd,
  cheaperSiblingModel,
  type PriceRow,
} from "./pricing.js";
export { getModelTier, type ModelTier } from "./model-tier.js";
export {
  UsageEventSchema,
  UsageFeaturesSchema,
  IngestBatchSchema,
  ModelTierSchema,
  EventGrainSchema,
  parseUsageEvent,
  type UsageEvent,
  type UsageFeatures,
  type IngestBatch,
  type EventGrain,
} from "./schema/event.js";
export {
  extractFeatures,
  deriveNewContentRatio,
  type ExtractFeaturesInput,
} from "./features.js";
export { applyPrivacy, type ContentMode } from "./privacy.js";
export {
  runRules,
  priceCounterfactual,
  priceFinding,
  REQUEST_RULES,
  frontierTrivialRule,
  fullDocumentIoRule,
  contextBloatRule,
  FRONTIER_TRIVIAL_MAX_TOTAL_TOKENS,
  FULL_DOC_MIN_PROMPT_CHARS,
  FULL_DOC_MIN_DUMP_SCORE,
  FULL_DOC_EXCERPT_FRACTION,
  BLOAT_MIN_EVENTS,
  BLOAT_INPUT_GROWTH_RATIO,
  BLOAT_MAX_NEW_CONTENT_RATIO,
  MIN_WASTED_USD,
  MIN_WASTED_TOKENS,
  type RuleHit,
  type RuleId,
  type Severity,
  type Rule,
  type RuleFinding,
  type RuleContext,
  type Counterfactual,
  type Actual,
  type PricedSavings,
  type PricingContext,
} from "./rules/index.js";
export {
  backtest,
  type BacktestInput,
  type BacktestResult,
  type BacktestRow,
  type PricingBasis,
} from "./rules/backtest.js";
export {
  runAggregateRules,
  frontierShareRule,
  cacheEfficiencyRule,
  FRONTIER_SHARE_THRESHOLD,
  CACHE_EFFICIENCY_MIN_READ_RATIO,
  AGGREGATE_RULE_IDS,
  type ModelWindowTotals,
  type AggregateWindow,
} from "./rules/aggregate/index.js";
export * from "./rules/session/index.js";
