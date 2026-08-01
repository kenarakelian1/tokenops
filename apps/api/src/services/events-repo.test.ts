import { describe, it, expect } from "vitest";
import { createMemoryEventsRepo } from "./events-repo.js";

describe("events-repo", () => {
  it("does not let one user's heartbeat mutate another user's machine row", async () => {
    const repo = createMemoryEventsRepo();

    await repo.upsertMachine("user-a", "machine-1", "alice-laptop", 0);
    await repo.upsertMachine("user-b", "machine-1", "mallory-laptop", 5);

    const alice = await repo.listMachines("user-a");
    expect(alice).toHaveLength(1);
    expect(alice[0]!.name).toBe("alice-laptop");
    expect(alice[0]!.lastQueueDepth).toBe(0);

    const mallory = await repo.listMachines("user-b");
    expect(mallory).toHaveLength(1);
    expect(mallory[0]!.name).toBe("mallory-laptop");
  });
});
