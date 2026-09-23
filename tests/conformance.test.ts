/**
 * Conformance suite for the Plugin API v1 mock host (R-SDK-3).
 *
 * Runs every declarative fixture under `conformance/cases` and asserts the
 * fixture set covers the closed v1 event set and the required conformance
 * categories. Fixtures are validated against the accepted manifest linter
 * before execution; a failing case fails this suite.
 */

import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConformanceCaseFile,
  runConformanceDirectory,
} from "../src/conformance.js";
import {
  CAPABILITY_GATED_SURFACE,
  EVENT_KINDS,
  HOST_PARITY_SOURCE,
  MOCK_LIMITS,
  NAMESPACE_HOST_PARITY,
  PLUGIN_API_VERSION,
  SNAPSHOT_SCOPE_ONLY,
  V1_SURFACE_FUNCTIONS,
} from "../src/host-surface.js";
import { MockHost } from "../src/mock-host.js";
import { MANIFEST_MAX_BYTES } from "../src/schema.js";

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
      "pending-host",
    ]) {
      expect(tags.has(required)).toBe(true);
    }
  });

  test("pending-host fixtures assert E_NOT_IMPLEMENTED for deferred calls", () => {
    let deferredCalls = 0;
    for (const conformanceCase of readCases()) {
      for (const step of conformanceCase.steps) {
        if (
          step.op === "call" &&
          typeof step.surface === "string" &&
          (step.surface.startsWith("services.") ||
            step.surface.startsWith("env."))
        ) {
          deferredCalls += 1;
          const expected = step.expect as
            { denial?: { code?: string; class?: string } } | undefined;
          expect(expected?.denial?.code).toBe("E_NOT_IMPLEMENTED");
          expect(expected?.denial?.class).toBe("runtime");
        }
      }
    }
    expect(deferredCalls).toBeGreaterThan(0);
  });

  test("oversized fixture manifests are rejected before being read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitty-sdk-conformance-"));
    try {
      const casesDir = join(dir, "cases");
      const manifestsDir = join(dir, "manifests");
      mkdirSync(casesDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(
        join(manifestsDir, "huge.toml"),
        "x".repeat(MANIFEST_MAX_BYTES + 1),
      );
      writeFileSync(
        join(casesDir, "case.json"),
        JSON.stringify({
          name: "oversized manifest",
          description: "A manifest above the accepted byte bound.",
          manifest: "manifests/huge.toml",
          steps: [],
        }),
      );
      const result = await runConformanceCaseFile(join(casesDir, "case.json"), {
        rootDir: dir,
      });
      expect(result.passed).toBe(false);
      expect(result.error ?? "").toContain("fixture manifest exceeds");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("case exceeding timeout with timeoutMs: 0 fails with passed: false and exceeded error", async () => {
    const result = await runConformanceCaseFile(
      join(CASES_DIR, "01-deny-by-default.json"),
      {
        rootDir: CONFORMANCE_DIR,
        timeoutMs: 0,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.error ?? "").toContain("exceeded 0 ms");
  });

  test("normal conformance case well within timeout passes cleanly", async () => {
    const result = await runConformanceCaseFile(
      join(CASES_DIR, "01-deny-by-default.json"),
      {
        rootDir: CONFORMANCE_DIR,
        timeoutMs: 5000,
      },
    );
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.assertions.length).toBeGreaterThan(0);
  });

  test("between-step monotonic elapsed time check triggers timeout and cleans up active host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitty-sdk-budget-active-"));
    const disposeSpy = spyOn(MockHost.prototype, "dispose");
    try {
      const casesDir = join(dir, "cases");
      const manifestsDir = join(dir, "manifests");
      mkdirSync(casesDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(
        join(manifestsDir, "minimal.toml"),
        readFileSync(join(CONFORMANCE_DIR, "manifests", "minimal.toml")),
      );
      writeFileSync(
        join(casesDir, "step-timeout.json"),
        JSON.stringify({
          name: "step-timeout-case",
          description: "A case that triggers timeout between steps.",
          manifest: "manifests/minimal.toml",
          steps: [
            { op: "begin-activation" },
            { op: "end-activation" },
            { op: "advance-time", ms: 10 },
          ],
        }),
      );

      let callCount = 0;
      let virtualNow = 1000;
      const nowSpy = spyOn(performance, "now").mockImplementation(() => {
        callCount++;
        // Advance clock past the 50ms budget after initial setup and activation steps
        if (callCount > 3) {
          virtualNow += 100;
        }
        return virtualNow;
      });

      try {
        const result = await runConformanceCaseFile(
          join(casesDir, "step-timeout.json"),
          {
            rootDir: dir,
            timeoutMs: 50,
          },
        );
        expect(result.passed).toBe(false);
        expect(result.error ?? "").toContain("step-timeout-case");
        expect(result.error ?? "").toContain("exceeded 50 ms");
        expect(disposeSpy).toHaveBeenCalled();
        expect(result.assertions).toHaveLength(3); // manifest, begin-activation, end-activation
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      disposeSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("between-step monotonic elapsed time check cleans up suspended host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitty-sdk-budget-suspended-"));
    const disposeSpy = spyOn(MockHost.prototype, "dispose");
    try {
      const casesDir = join(dir, "cases");
      const manifestsDir = join(dir, "manifests");
      mkdirSync(casesDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(
        join(manifestsDir, "minimal.toml"),
        readFileSync(join(CONFORMANCE_DIR, "manifests", "minimal.toml")),
      );
      writeFileSync(
        join(casesDir, "suspend-timeout.json"),
        JSON.stringify({
          name: "suspend-timeout-case",
          description: "A case that triggers timeout while suspended.",
          manifest: "manifests/minimal.toml",
          steps: [
            { op: "begin-activation" },
            { op: "end-activation" },
            { op: "suspend" },
            { op: "advance-time", ms: 10 },
          ],
        }),
      );

      let callCount = 0;
      let virtualNow = 1000;
      const nowSpy = spyOn(performance, "now").mockImplementation(() => {
        callCount++;
        // Advance clock past budget after suspension
        if (callCount > 4) {
          virtualNow += 100;
        }
        return virtualNow;
      });

      try {
        const result = await runConformanceCaseFile(
          join(casesDir, "suspend-timeout.json"),
          {
            rootDir: dir,
            timeoutMs: 50,
          },
        );
        expect(result.passed).toBe(false);
        expect(result.error ?? "").toContain("suspend-timeout-case");
        expect(result.error ?? "").toContain("exceeded 50 ms");
        expect(disposeSpy).toHaveBeenCalled();
        expect(result.assertions).toHaveLength(4); // manifest, begin-activation, end-activation, suspend
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      disposeSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
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
      hostParity: {
        repository: string;
        commit: string;
        pr: number;
        namespaces: Record<string, string>;
      };
      functions: Array<{
        path: string;
        errors: string[];
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

    const parity = surface.hostParity;
    expect(parity.repository).toBe(HOST_PARITY_SOURCE.repository);
    expect(parity.commit).toBe(HOST_PARITY_SOURCE.commit);
    expect(parity.pr).toBe(HOST_PARITY_SOURCE.pr);
    expect(new Map(Object.entries(parity.namespaces))).toEqual(
      new Map(
        NAMESPACE_HOST_PARITY.map(
          (entry) => [entry.namespace, entry.status] as const,
        ),
      ),
    );
    for (const fn of surface.functions) {
      const status = parity.namespaces[fn.path.split(".")[0] ?? ""];
      if (status === "deferred") {
        expect(fn.errors).toEqual(["E_NOT_IMPLEMENTED"]);
      } else {
        expect(fn.errors).not.toContain("E_NOT_IMPLEMENTED");
      }
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
