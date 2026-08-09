import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOffsets } from "./session-offsets.js";

const dirs: string[] = [];
const newDb = () => {
  const d = mkdtempSync(join(tmpdir(), "tokenops-offsets-"));
  dirs.push(d);
  return join(d, "offsets.db");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SessionOffsets", () => {
  it("returns null for a file it has never seen", () => {
    const s = new SessionOffsets(newDb());
    expect(s.get("/some/file.jsonl")).toBeNull();
    s.close();
  });

  it("round-trips an offset", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 1234, 5000);
    expect(s.get("/a.jsonl")).toEqual({ offset: 1234, size: 5000 });
    s.close();
  });

  it("overwrites on repeat set", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 10, 100);
    s.set("/a.jsonl", 20, 200);
    expect(s.get("/a.jsonl")).toEqual({ offset: 20, size: 200 });
    s.close();
  });

  it("persists across instances so a restart resumes", () => {
    const path = newDb();
    const first = new SessionOffsets(path);
    first.set("/a.jsonl", 99, 500);
    first.close();

    const second = new SessionOffsets(path);
    expect(second.get("/a.jsonl")).toEqual({ offset: 99, size: 500 });
    second.close();
  });

  it("keeps separate offsets per file", () => {
    const s = new SessionOffsets(newDb());
    s.set("/a.jsonl", 1, 10);
    s.set("/b.jsonl", 2, 20);
    expect(s.get("/a.jsonl")).toEqual({ offset: 1, size: 10 });
    expect(s.get("/b.jsonl")).toEqual({ offset: 2, size: 20 });
    s.close();
  });
});
