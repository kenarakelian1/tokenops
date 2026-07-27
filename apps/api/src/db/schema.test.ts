import { describe, it, expect } from "vitest";
import {
  users,
  sessions,
  pats,
  machines,
  usageEvents,
  eventContent,
  dailyAggregates,
  recommendations,
} from "./schema.js";

describe("drizzle schema tables", () => {
  it("exports all expected tables", () => {
    const tables = [
      users,
      sessions,
      pats,
      machines,
      usageEvents,
      eventContent,
      dailyAggregates,
      recommendations,
    ];
    expect(tables).toHaveLength(8);
    for (const table of tables) {
      expect(table).toBeDefined();
    }
  });
});
