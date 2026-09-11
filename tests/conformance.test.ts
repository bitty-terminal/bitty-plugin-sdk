/**
 * Conformance suite for the Plugin API v1 mock host (R-SDK-3).
 *
 * Runs every declarative fixture under `conformance/cases` and asserts the
 * fixture set covers the closed v1 event set and the required conformance
 * categories. Fixtures are validated against the accepted manifest linter
 * before execution; a failing case fails this suite.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runConformanceDirectory } from "../src/conformance.js";
import { EVENT_KINDS, MOCK_LIMITS } from "../src/host-surface.js";

const CONFORMANCE_DIR = join(import.meta.dir, "..", "conformance");
const CASES_DIR = join(CONFORMANCE_DIR, "cases");

interface RawCase {
  readonly name: string;
  readonly tags?: readonly string[];
  readonly steps: ReadonlyArray<Record<string, unknown>>;
}

function readCases(): RawCase[] {
  return readdirSync(CASES_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(CASES_DIR, entry), "utf8")) as RawCase,
    );
}

describe("conformance fixtures", () => {
  test("every case passes against the mock host", async () => {
    const results = await runConformanceDirectory(CASES_DIR, {
      rootDir: CONFORMANCE_DIR,
      timeoutMs: 5000,
    });
    const failures = results
      .filter((result) => !result.passed)
      .map((result) => `${result.name}: ${result.error ?? "unknown"}`);
    expect(failures).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(10);
    for (const result of results) {
      expect(result.assertions.length).toBeGreaterThan(0);
    }
  }, 15000);

  test("fixtures publish and assert every kind of the closed v1 event set", () => {
    const published = new Set<string>();
    for (const conformanceCase of readCases()) {
      for (const step of conformanceCase.steps) {
        if (step.op === "publish" && typeof step.event === "string") {
          published.add(step.event);
        }
      }
    }
    const expected = EVENT_KINDS.map((entry) => entry.kind).sort();
    expect([...published].sort()).toEqual(expected);
  });

  test("fixtures cover the required conformance categories", () => {
    const tags = new Set<string>();
    for (const conformanceCase of readCases()) {
      for (const tag of conformanceCase.tags ?? []) tags.add(tag);
    }
    for (const required of [
      "deny-by-default",
      "capability",
      "env",
      "registration",
      "lifecycle",
      "events",
      "round-trip",
      "interception",
      "commands",
      "schema",
      "store",
      "ui",
      "terminal",
      "services",
      "tasks",
      "timers",
    ]) {
      expect(tags.has(required)).toBe(true);
    }
  });
});

describe("accepted surface agreement", () => {
  test("the closed event set matches the accepted v1 names and classes", () => {
    expect(EVENT_KINDS.map((entry) => entry.kind)).toEqual([
      "plugin.activated",
      "plugin.suspended",
      "plugin.disposed",
      "handler.violation",
      "terminal.opened",
      "terminal.closed",
      "terminal.title-changed",
      "terminal.cwd-changed",
      "terminal.bell",
      "focus.changed",
      "selection.changed",
      "process.exited",
      "config.reloaded",
      "intercept.command-dispatch",
      "intercept.terminal-spawn",
      "intercept.paste",
      "intercept.open-url",
    ]);
    expect(
      EVENT_KINDS.filter((entry) => entry.class === "interception"),
    ).toHaveLength(4);
  });

  test("mock limits mirror the accepted numeric bounds", () => {
    expect(MOCK_LIMITS.TASKS_MAX).toBe(64);
    expect(MOCK_LIMITS.TIMERS_MAX).toBe(32);
    expect(MOCK_LIMITS.STORE_QUOTA_BYTES).toBe(256 * 1024);
    expect(MOCK_LIMITS.STORE_MAX_VALUE_BYTES).toBe(8 * 1024);
    expect(MOCK_LIMITS.STORE_MAX_DEPTH).toBe(8);
    expect(MOCK_LIMITS.SNAPSHOT_MAX_BYTES).toBe(256 * 1024);
    expect(MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES).toBe(16 * 1024);
    expect(MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH).toBe(16);
  });
});
