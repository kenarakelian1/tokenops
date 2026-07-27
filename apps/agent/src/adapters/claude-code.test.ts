import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseClaudeCodeLine,
  parseClaudeCodeLog,
  resolveClaudeCodeLogPath,
  watchClaudeCodeLog,
} from "./claude-code.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "claude-code-usage.jsonl",
);

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenops-claude-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timeout waiting for condition"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("parseClaudeCodeLine / parseClaudeCodeLog", () => {
  it("parses fixture lines into claude-code events", () => {
    const fixtureText = readFileSync(fixturePath, "utf8");
    const events = parseClaudeCodeLog(fixtureText);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]!.app).toBe("claude-code");
    expect(events[0]!.provider).toBe("anthropic");
    expect(events[0]!.inputTokens).toBeGreaterThan(0);
    expect(events[0]!.outputTokens).toBeGreaterThan(0);
    expect(events[0]!.model).toBe("claude-sonnet-4");
    expect(events[0]!.sessionId).toBe("sess-fixture-1");
    expect(events[0]!.hasContent).toBe(true);
    expect(events[0]!.costUsd).not.toBeNull();
    expect(events[0]!.features.promptChars).toBeGreaterThan(0);
    expect(events[0]!.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns null for blank, comment, and invalid lines", () => {
    expect(parseClaudeCodeLine("")).toBeNull();
    expect(parseClaudeCodeLine("   ")).toBeNull();
    expect(parseClaudeCodeLine("# comment")).toBeNull();
    expect(parseClaudeCodeLine("not-json")).toBeNull();
    expect(parseClaudeCodeLine("{}")).toBeNull();
    expect(
      parseClaudeCodeLine(
        JSON.stringify({ model: "claude-haiku", inputTokens: 1 }),
      ),
    ).toBeNull();
  });

  it("accepts snake_case aliases", () => {
    const event = parseClaudeCodeLine(
      JSON.stringify({
        timestamp: "2026-07-27T12:00:00.000Z",
        model: "claude-haiku",
        input_tokens: 10,
        output_tokens: 5,
        session_id: "s1",
        request_preview: "hi",
        response_preview: "hello",
      }),
      { machineId: "m1", machineName: "desk" },
    );
    expect(event).not.toBeNull();
    expect(event!.inputTokens).toBe(10);
    expect(event!.outputTokens).toBe(5);
    expect(event!.sessionId).toBe("s1");
    expect(event!.machineId).toBe("m1");
    expect(event!.machineName).toBe("desk");
  });

  it("skips invalid lines inside a multi-line log", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-07-27T12:00:00.000Z",
        model: "claude-haiku",
        inputTokens: 1,
        outputTokens: 1,
      }),
      "BAD",
      "",
      JSON.stringify({
        timestamp: "2026-07-27T12:01:00.000Z",
        model: "claude-haiku",
        inputTokens: 2,
        outputTokens: 2,
      }),
    ].join("\n");
    const events = parseClaudeCodeLog(text);
    expect(events).toHaveLength(2);
    expect(events[0]!.inputTokens).toBe(1);
    expect(events[1]!.inputTokens).toBe(2);
  });
});

describe("resolveClaudeCodeLogPath", () => {
  it("appends default filename when path is a directory", () => {
    const dir = tmpDir();
    expect(resolveClaudeCodeLogPath(dir)).toBe(
      join(dir, "claude-code-usage.jsonl"),
    );
  });

  it("returns file path as-is", () => {
    const file = join(tmpDir(), "custom.jsonl");
    expect(resolveClaudeCodeLogPath(file)).toBe(file);
  });
});

describe("watchClaudeCodeLog", () => {
  it("tails append-only lines and emits events", async () => {
    const dir = tmpDir();
    const logPath = join(dir, "claude-code-usage.jsonl");
    writeFileSync(logPath, "", "utf8");

    const events: ReturnType<typeof parseClaudeCodeLine>[] = [];
    const handle = watchClaudeCodeLog(
      logPath,
      (e) => {
        events.push(e);
      },
      {
        machineId: "watch-m",
        machineName: "watch-box",
        pollIntervalMs: 50,
      },
    );

    try {
      appendFileSync(
        logPath,
        JSON.stringify({
          timestamp: "2026-07-27T13:00:00.000Z",
          model: "claude-haiku",
          inputTokens: 42,
          outputTokens: 7,
          sessionId: "live-1",
        }) + "\n",
        "utf8",
      );

      await waitFor(() => events.length >= 1);
      expect(events[0]!.app).toBe("claude-code");
      expect(events[0]!.inputTokens).toBe(42);
      expect(events[0]!.machineId).toBe("watch-m");
      expect(events[0]!.machineName).toBe("watch-box");
    } finally {
      handle.close();
    }
  });

  it("fromStart replays existing content then accepts appends", async () => {
    const dir = tmpDir();
    const logPath = join(dir, "usage.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-07-27T14:00:00.000Z",
        model: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 20,
      }) + "\n",
      "utf8",
    );

    const events: Array<{ inputTokens: number }> = [];
    const handle = watchClaudeCodeLog(logPath, (e) => events.push(e), {
      fromStart: true,
      pollIntervalMs: 50,
    });

    try {
      await waitFor(() => events.length >= 1);
      expect(events[0]!.inputTokens).toBe(100);

      appendFileSync(
        logPath,
        JSON.stringify({
          timestamp: "2026-07-27T14:01:00.000Z",
          model: "claude-sonnet-4",
          inputTokens: 200,
          outputTokens: 30,
        }) + "\n",
        "utf8",
      );
      await waitFor(() => events.length >= 2);
      expect(events[1]!.inputTokens).toBe(200);
    } finally {
      handle.close();
    }
  });

  it("waits for log file creation under a directory path", async () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    const events: Array<{ model: string }> = [];
    const handle = watchClaudeCodeLog(dir, (e) => events.push(e), {
      fromStart: true,
      pollIntervalMs: 50,
      machineId: "m-dir",
    });

    try {
      const logPath = join(dir, "claude-code-usage.jsonl");
      writeFileSync(
        logPath,
        JSON.stringify({
          timestamp: "2026-07-27T15:00:00.000Z",
          model: "claude-opus-4",
          inputTokens: 9,
          outputTokens: 3,
        }) + "\n",
        "utf8",
      );
      await waitFor(() => events.length >= 1);
      expect(events[0]!.model).toBe("claude-opus-4");
    } finally {
      handle.close();
    }
  });
});
