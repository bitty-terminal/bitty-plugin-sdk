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
import {
  CAPABILITY_GATED_SURFACE,
  EVENT_KINDS,
  MOCK_LIMITS,
  PLUGIN_API_VERSION,
  SNAPSHOT_SCOPE_ONLY,
  V1_SURFACE_FUNCTIONS,
} from "../src/host-surface.js";

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

  test("R-SDK-1 surface table agrees with the mock host model", () => {
    const surface = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "surface", "bitty-plugin-api-v1.json"),
        "utf8",
      ),
    ) as {
      module: string;
      api_version: string;
      functions: Array<{
        path: string;
        capabilities: string[];
        conditionalCapabilities?: Array<{ capability: string; when: string }>;
      }>;
      events: Array<{ name: string; class: string }>;
      excludedArgumentLiterals: Array<{
        path: string;
        argument: string;
        value: string;
      }>;
    };
    expect(surface.module).toBe("bitty");
    expect(surface.api_version).toBe(PLUGIN_API_VERSION);

    expect(surface.functions.map((entry) => entry.path).sort()).toEqual(
      [...V1_SURFACE_FUNCTIONS].sort(),
    );
    expect(surface.events.map((entry) => entry.name)).toEqual(
      EVENT_KINDS.map((entry) => entry.kind),
    );
    surface.events.forEach((entry, index) => {
      const spec = EVENT_KINDS[index];
      expect(spec).toBeDefined();
      expect(entry.class.toLowerCase()).toBe(spec?.class ?? "");
    });

    const unconditionalCaps = new Map(
      CAPABILITY_GATED_SURFACE.filter(
        (entry) => !entry.surface.includes(":"),
      ).map((entry) => [
        entry.surface.slice("bitty.".length),
        entry.capability,
      ]),
    );
    const conditionalCaps = new Map(
      CAPABILITY_GATED_SURFACE.filter((entry) =>
        entry.surface.includes(":"),
      ).map((entry) => [
        entry.surface.slice("bitty.".length).split(":")[0] ?? "",
        entry.capability,
      ]),
    );
    for (const fn of surface.functions) {
      const expected = fn.capabilities.join("|");
      const actual = unconditionalCaps.get(fn.path) ?? "";
      expect(actual).toBe(expected);
      const modeledConditional = conditionalCaps.has(fn.path)
        ? [conditionalCaps.get(fn.path) as string]
        : [];
      const surfaceConditional = (fn.conditionalCapabilities ?? [])
        .map((gate) => gate.capability)
        .sort();
      expect(surfaceConditional).toEqual(modeledConditional);
    }

    const excludedRaw = surface.excludedArgumentLiterals.find(
      (entry) =>
        entry.path === "terminal.snapshot" &&
        entry.argument === "scope" &&
        entry.value === "raw",
    );
    expect(excludedRaw).toBeDefined();
    expect(SNAPSHOT_SCOPE_ONLY).toBe("semantic");
  });
});
