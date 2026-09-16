import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")) as {
  bin?: Record<string, string>;
};

const BIN_NAME = "bitty-plugin-lint";

function cliEntryPoint(): string {
  const target = packageJson.bin?.[BIN_NAME];
  if (target === undefined) {
    throw new Error(`package.json declares no '${BIN_NAME}' bin entry`);
  }
  return fileURLToPath(new URL(target, PACKAGE_JSON_URL));
}

describe("packaging for dependency consumers", () => {
  test("declares the bitty-plugin-lint bin", () => {
    expect(typeof packageJson.bin?.[BIN_NAME]).toBe("string");
  });

  test("bin entry resolves to an existing entry point with a bun shebang", () => {
    const source = readFileSync(cliEntryPoint(), "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("#!/usr/bin/env bun");
  });

  test.skipIf(process.platform === "win32")(
    "bin entry is executable so installed .bin links run without a build step",
    () => {
      expect(statSync(cliEntryPoint()).mode & 0o111).toBeGreaterThan(0);
    },
  );
});
