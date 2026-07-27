import { describe, it, expect } from "vitest";
import { buildEventId } from "./event-id.js";

describe("buildEventId", () => {
  it("is stable for same inputs", () => {
    const a = buildEventId({
      machineId: "m1",
      app: "openai-proxy",
      providerRequestId: "req_1",
      fingerprint: "fp",
      timeBucketSec: 100,
    });
    const b = buildEventId({
      machineId: "m1",
      app: "openai-proxy",
      providerRequestId: "req_1",
      fingerprint: "fp",
      timeBucketSec: 100,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when machine differs", () => {
    const a = buildEventId({
      machineId: "m1", app: "openai-proxy", fingerprint: "fp", timeBucketSec: 1,
    });
    const b = buildEventId({
      machineId: "m2", app: "openai-proxy", fingerprint: "fp", timeBucketSec: 1,
    });
    expect(a).not.toBe(b);
  });
});
