import { randomBytes, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "./password.js";

/**
 * scripts/set-password.mjs re-implements the scrypt parameters from
 * password.ts because it runs without a build step. If password.ts ever
 * changes its key length, salt length, or stored format, the script would
 * silently write hashes the API cannot verify — locking the owner out of the
 * instance it exists to rescue. These tests pin the two together.
 */

const scryptAsync = promisify(scrypt);

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const scriptSource = read("../../scripts/set-password.mjs");
const passwordSource = read("./password.ts");

function constant(source: string, name: string): string | undefined {
  return new RegExp(`const ${name} = (\\d+);`).exec(source)?.[1];
}

describe("set-password.mjs stays compatible with the API's hashing", () => {
  it.each(["KEYLEN", "SALTLEN"])("uses the same %s as password.ts", (name) => {
    const fromApi = constant(passwordSource, name);
    expect(fromApi, `${name} not found in password.ts`).toBeDefined();
    expect(constant(scriptSource, name)).toBe(fromApi);
  });

  it("writes the scrypt$<salt>$<hash> format the API parses", () => {
    expect(scriptSource).toContain(
      "`scrypt$${salt.toString(\"base64\")}$${derived.toString(\"base64\")}`",
    );
  });

  it("produces a hash verifyPassword accepts", async () => {
    const keylen = Number(constant(scriptSource, "KEYLEN"));
    const saltlen = Number(constant(scriptSource, "SALTLEN"));
    const salt = randomBytes(saltlen);
    const derived = (await scryptAsync("correct-horse", salt, keylen)) as Buffer;
    const stored = `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;

    await expect(verifyPassword("correct-horse", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong-horse", stored)).resolves.toBe(false);
  });
});
