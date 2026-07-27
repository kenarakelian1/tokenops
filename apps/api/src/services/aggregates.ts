import type { DailyAggregate } from "../db/schema.js";
import type { AggregateListFilters, EventsRepo } from "./events-repo.js";

export type AggregateDto = {
  userId: string;
  day: string;
  machineId: string;
  app: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  eventCount: number;
};

export function aggregateToDto(row: DailyAggregate): AggregateDto {
  return {
    userId: row.userId,
    day: row.day,
    machineId: row.machineId,
    app: row.app,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: Number(row.costUsd),
    eventCount: row.eventCount,
  };
}

export async function listAggregates(
  repo: EventsRepo,
  userId: string,
  filters: AggregateListFilters,
): Promise<AggregateDto[]> {
  const rows = await repo.listAggregates(userId, filters);
  return rows.map(aggregateToDto);
}

/** UTC calendar day (YYYY-MM-DD) for an event timestamp. */
export function dayKeyFromTimestamp(timestamp: string | Date): string {
  const d =
    typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  return d.toISOString().slice(0, 10);
}
