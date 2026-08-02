import { describe, it, expect } from "vitest";
import { emptyToUndefined, loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://localhost/tokenops",
  SESSION_SECRET: "test-secret",
  CLERK_SECRET_KEY: "sk_test_x",
};

describe("emptyToUndefined", () => {
  it("turns empty strings into undefined and keeps values", () => {
    expect(
      emptyToUndefined({
        A: "",
        B: "x",
        C: undefined,
      }),
    ).toEqual({ A: undefined, B: "x", C: undefined });
  });
});

describe("loadEnv", () => {
  it("accepts minimal required env", () => {
    const env = loadEnv(base);
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.SESSION_SECRET).toBe(base.SESSION_SECRET);
    expect(env.CLERK_SECRET_KEY).toBe(base.CLERK_SECRET_KEY);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.HOSTED_LIMITS).toBe(false);
    expect(env.CLERK_JWT_KEY).toBeUndefined();
    expect(env.CORS_ORIGIN).toBeUndefined();
    expect(env.RAW_EVENT_RETENTION_DAYS).toBeUndefined();
  });

  it("treats empty optional vars as unset (compose default)", () => {
    const env = loadEnv({
      ...base,
      CLERK_JWT_KEY: "",
      CORS_ORIGIN: "",
      RAW_EVENT_RETENTION_DAYS: "",
    });
    expect(env.CLERK_JWT_KEY).toBeUndefined();
    expect(env.CORS_ORIGIN).toBeUndefined();
    expect(env.RAW_EVENT_RETENTION_DAYS).toBeUndefined();
  });

  it("parses HOSTED_LIMITS and retention when set", () => {
    const env = loadEnv({
      ...base,
      HOSTED_LIMITS: "true",
      RAW_EVENT_RETENTION_DAYS: "14",
      CORS_ORIGIN: "https://app.example.com",
      CLERK_JWT_KEY: "jwk_test",
    });
    expect(env.HOSTED_LIMITS).toBe(true);
    expect(env.RAW_EVENT_RETENTION_DAYS).toBe(14);
    expect(env.CORS_ORIGIN).toBe("https://app.example.com");
    expect(env.CLERK_JWT_KEY).toBe("jwk_test");
  });

  it("rejects a missing CLERK_SECRET_KEY", () => {
    const { CLERK_SECRET_KEY, ...withoutKey } = { ...base, CLERK_SECRET_KEY: "sk_test_x" };
    expect(() => loadEnv(withoutKey)).toThrow(/CLERK_SECRET_KEY/);
  });
});
