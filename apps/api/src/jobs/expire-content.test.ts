import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOSTED_RETENTION_DAYS,
  resolveRetentionDays,
} from "./expire-content.js";

describe("resolveRetentionDays", () => {
  it("returns null when unset (self-host unlimited)", () => {
    expect(resolveRetentionDays({})).toBeNull();
    expect(resolveRetentionDays({ HOSTED_LIMITS: "false" })).toBeNull();
  });

  it("returns 30 when HOSTED_LIMITS=true and no explicit days", () => {
    expect(resolveRetentionDays({ HOSTED_LIMITS: "true" })).toBe(
      DEFAULT_HOSTED_RETENTION_DAYS,
    );
    expect(DEFAULT_HOSTED_RETENTION_DAYS).toBe(30);
  });

  it("uses RAW_EVENT_RETENTION_DAYS when set", () => {
    expect(
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "14" }),
    ).toBe(14);
    expect(
      resolveRetentionDays({
        HOSTED_LIMITS: "true",
        RAW_EVENT_RETENTION_DAYS: "7",
      }),
    ).toBe(7);
    expect(
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "0" }),
    ).toBe(0);
  });

  it("ignores blank RAW_EVENT_RETENTION_DAYS and falls through", () => {
    expect(
      resolveRetentionDays({
        RAW_EVENT_RETENTION_DAYS: "  ",
        HOSTED_LIMITS: "true",
      }),
    ).toBe(30);
    expect(
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "" }),
    ).toBeNull();
  });

  it("throws on invalid RAW_EVENT_RETENTION_DAYS", () => {
    expect(() =>
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "abc" }),
    ).toThrow(/RAW_EVENT_RETENTION_DAYS/);
    expect(() =>
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "-1" }),
    ).toThrow(/RAW_EVENT_RETENTION_DAYS/);
    expect(() =>
      resolveRetentionDays({ RAW_EVENT_RETENTION_DAYS: "1.5" }),
    ).toThrow(/RAW_EVENT_RETENTION_DAYS/);
  });
});
