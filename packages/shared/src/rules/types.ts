export type RuleId =
  | "frontier_trivial"
  | "full_document_io"
  | "context_bloat";

export interface RuleHit {
  ruleId: RuleId;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
}
