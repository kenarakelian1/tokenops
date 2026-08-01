import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  budgetUsdMonthly: numeric("budget_usd_monthly", {
    precision: 12,
    scale: 4,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const pats = pgTable(
  "pats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("pats_token_hash_uidx").on(t.tokenHash)],
);

export const machines = pgTable(
  "machines",
  {
    machineId: text("machine_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastQueueDepth: integer("last_queue_depth").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.machineId] })],
);

export const usageEvents = pgTable("usage_events", {
  eventId: text("event_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  machineId: text("machine_id").notNull(),
  machineName: text("machine_name").notNull(),
  app: text("app").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
  latencyMs: integer("latency_ms"),
  sessionId: text("session_id"),
  features: jsonb("features").notNull(),
  hasContent: boolean("has_content").notNull().default(false),
});

export const eventContent = pgTable("event_content", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => usageEvents.eventId, { onDelete: "cascade" }),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const dailyAggregates = pgTable(
  "daily_aggregates",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    machineId: text("machine_id").notNull(),
    app: text("app").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    eventCount: integer("event_count").notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [t.userId, t.day, t.machineId, t.app, t.model],
    }),
  ],
);

/** open | dismissed */
export type RecommendationStatus = "open" | "dismissed";

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    estimatedWastedTokens: integer("estimated_wasted_tokens").notNull(),
    estimatedWastedUsd: numeric("estimated_wasted_usd", {
      precision: 14,
      scale: 8,
    }),
    eventIds: jsonb("event_ids").notNull().$type<string[]>(),
    /** Dedupe key: typically first event_id (or hash of event_ids). */
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().$type<RecommendationStatus>().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("recommendations_user_rule_dedupe_uidx").on(
      t.userId,
      t.ruleId,
      t.dedupeKey,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Pat = typeof pats.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type EventContentRow = typeof eventContent.$inferSelect;
export type DailyAggregate = typeof dailyAggregates.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
