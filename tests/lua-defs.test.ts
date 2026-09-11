import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  diffDefinitions,
  loadSurface,
  OUTPUT_PATH,
  renderDefinitions,
  validateSurface,
  type Surface,
} from "../scripts/generate-lua-defs.js";
import {
  findLuaLanguageServer,
  runConformance,
} from "../scripts/check-lua-luals.js";

const surface = loadSurface();
const defs = readFileSync(OUTPUT_PATH, "utf8");

const EXPECTED_FUNCTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["L1", "commands.register", "BittyCommandHandle"],
  ["L1", "events.subscribe", "BittySubscriptionHandle"],
  ["L1", "keymaps.suggest", "BittyKeymapHandle"],
  ["L1", "settings.get", "BittySettingsValue"],
  ["L1", "settings.set", "boolean"],
  ["L1", "store.get", "BittyStoreValue|nil"],
  ["L1", "store.set", "boolean"],
  ["L1", "notify.show", "boolean"],
  ["L1", "env.get", "string|nil"],
  ["L1", "env.has", "boolean"],
  ["L1", "services.get", "BittyService|nil"],
  ["L1", "services.provide", "BittyServiceHandle"],
  ["L2", "ui.mount", "BittyBlockHandle"],
  ["L2", "ui.update", "boolean"],
  ["L2", "terminal.snapshot", "BittyTerminalSnapshot"],
  ["L1", "tasks.spawn", "BittyTaskHandle"],
  ["L1", "tasks.cancel", "boolean"],
  ["L1", "timers.create", "BittyTimerHandle"],
  ["L1", "timers.cancel", "boolean"],
];

const EXPECTED_EVENTS: ReadonlyArray<readonly [string, string, string]> = [
  ["plugin.activated", "Lifecycle", "BittyEmptyPayload"],
  ["plugin.suspended", "Lifecycle", "BittyEmptyPayload"],
  ["plugin.disposed", "Lifecycle", "BittyEmptyPayload"],
  ["handler.violation", "Lifecycle", "BittyEmptyPayload"],
  ["terminal.opened", "Observation", "BittyTerminalOpenedPayload"],
  ["terminal.closed", "Observation", "BittyTerminalClosedPayload"],
  ["terminal.title-changed", "Observation", "BittyTerminalTitleChangedPayload"],
  ["terminal.cwd-changed", "Observation", "BittyTerminalCwdChangedPayload"],
  ["terminal.bell", "Observation", "BittyEmptyPayload"],
  ["focus.changed", "Observation", "BittyFocusChangedPayload"],
  ["selection.changed", "Observation", "BittySelectionChangedPayload"],
  ["process.exited", "Observation", "BittyProcessExitedPayload"],
  ["config.reloaded", "Observation", "BittyEmptyPayload"],
  ["intercept.command-dispatch", "Interception", "BittyInterceptPayload"],
  ["intercept.terminal-spawn", "Interception", "BittyInterceptPayload"],
  ["intercept.paste", "Interception", "BittyInterceptPayload"],
  ["intercept.open-url", "Interception", "BittyInterceptPayload"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalized(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

describe("surface table", () => {
  test("passes structural validation", () => {
    expect(validateSurface(surface)).toEqual([]);
  });

  test("pins only accepted contract sources", () => {
    expect(surface.sources.length).toBeGreaterThan(0);
    for (const source of surface.sources) {
      expect(source.status).toBe("accepted");
      expect(source.revision).toMatch(/^[0-9a-f]{7,40}$/);
      expect(source.path).toMatch(/^docs\/.+\.md$/);
    }
  });

  test("declares exactly the accepted L1/L2 function list", () => {
    const actual = surface.functions.map(
      (fn): readonly [string, string, string] => [
        fn.level,
        fn.path,
        fn.returns[0]?.type ?? "",
      ],
    );
    expect(actual).toEqual(EXPECTED_FUNCTIONS.map((entry) => [...entry]));
  });

  test("declares exactly the accepted closed event set", () => {
    const actual = surface.events.map(
      (event): readonly [string, string, string] => [
        event.name,
        event.class,
        event.payload,
      ],
    );
    expect(actual).toEqual(EXPECTED_EVENTS.map((entry) => [...entry]));
  });

  test("binds capabilities only to the accepted gates", () => {
    const gates = new Map(
      surface.functions.map((fn) => [fn.path, [...fn.capabilities].sort()]),
    );
    expect(gates.get("notify.show")).toEqual(["platform.notify"]);
    expect(gates.get("env.get")).toEqual(["env:<KEY>"]);
    expect(gates.get("env.has")).toEqual(["env:<KEY>"]);
    expect(gates.get("ui.mount")).toEqual(["ui.rich"]);
    expect(gates.get("ui.update")).toEqual(["ui.rich"]);
    expect(gates.get("terminal.snapshot")).toEqual(["terminal.semantic-read"]);
    for (const fn of surface.functions) {
      if (
        ![
          "notify.show",
          "env.get",
          "env.has",
          "ui.mount",
          "ui.update",
          "terminal.snapshot",
        ].includes(fn.path)
      ) {
        expect(fn.capabilities).toEqual([]);
      }
    }
  });
});

describe("generated definitions", () => {
  test("are current with the surface table", () => {
    const rendered = renderDefinitions(surface);
    expect(diffDefinitions(rendered, defs).report).toBe("");
  });

  test("declare exactly the table functions with matching parameters", () => {
    const parsed = [
      ...defs.matchAll(
        /^function ([A-Za-z0-9_]+)\.([a-z0-9_]+)\(([^)]*)\) end$/gm,
      ),
    ].map((match) => ({
      namespace: match[1] ?? "",
      name: match[2] ?? "",
      params: (match[3] ?? "").split(", ").filter((entry) => entry !== ""),
    }));
    expect(parsed.length).toBe(surface.functions.length);
    for (const fn of surface.functions) {
      const [prefix, name] = fn.path.split(".");
      const namespaceType = `Bitty${capitalized(prefix ?? "")}Namespace`;
      const found = parsed.find(
        (entry) => entry.namespace === namespaceType && entry.name === name,
      );
      expect(found).toBeDefined();
      expect(found?.params).toEqual(fn.params.map((param) => param.name));
    }
  });

  test("declare every type and no undeclared globals", () => {
    for (const type of surface.types) {
      const pattern = new RegExp(
        `^---@(class|alias) ${escapeRegExp(type.name)}(\\s|$)`,
        "m",
      );
      expect(defs).toMatch(pattern);
    }
    const globals = [
      ...defs.matchAll(/^([A-Za-z_][A-Za-z0-9_]*) = \{\}$/gm),
    ].map((match) => match[1]);
    expect(globals).toEqual(["bitty"]);
    const locals = [
      ...defs.matchAll(/^local ([A-Za-z_][A-Za-z0-9_]*) = \{\}$/gm),
    ].map((match) => match[1]);
    const namespaces = surface.types
      .filter((type) => type.name.endsWith("Namespace"))
      .map((type) => type.name);
    expect(locals).toEqual(namespaces);
    expect(defs).toContain(`---@meta ${surface.module}`);
    expect(defs).not.toMatch(/\bTODO\b|\bFIXME\b|\brequire\s*\(/);
  });

  test("keep the environment namespace absent unless declared", () => {
    const env = surface.types.find((type) => type.name === "BittyEnvNamespace");
    expect(env?.optional).toBe(true);
    expect(defs).toContain("---@field env? BittyEnvNamespace");
  });

  test("accept only the semantic snapshot scope", () => {
    expect(defs).toContain('---@field scope "semantic"');
    expect(defs).not.toContain('"raw"');
  });

  test("omit every excluded identifier", () => {
    for (const exclusion of surface.exclusions) {
      const pattern = new RegExp(`\\b${escapeRegExp(exclusion.path)}\\b`);
      expect(defs).not.toMatch(pattern);
    }
  });

  test("generation check detects a missing function", () => {
    const missing: Surface = {
      ...surface,
      functions: surface.functions.filter((fn) => fn.path !== "timers.cancel"),
    };
    expect(validateSurface(missing)).toEqual([]);
    expect(diffDefinitions(renderDefinitions(missing), defs).equal).toBe(false);
  });

  test("surface validation rejects an unknown namespace", () => {
    const extra: Surface = {
      ...surface,
      functions: [
        ...surface.functions,
        {
          path: "raw.read",
          level: "L1",
          capabilities: [],
          errors: [],
          doc: "Not accepted in v1.",
          params: [],
          returns: [{ type: "table" }],
        },
      ],
    };
    expect(validateSurface(extra)).toContain(
      "raw.read: no BittyRawNamespace type",
    );
  });

  test("surface validation rejects an excluded literal that is declared", () => {
    const widened: Surface = {
      ...surface,
      types: surface.types.map((type) =>
        type.name === "BittySnapshotOpts"
          ? {
              ...type,
              fields: (type.fields ?? []).map((field) =>
                field.name === "scope"
                  ? { ...field, type: '"semantic"|"raw"' }
                  : field,
              ),
            }
          : type,
      ),
    };
    expect(validateSurface(widened)).toContain(
      'terminal.snapshot.scope: excluded literal "raw" must not be a declared type member',
    );
  });
});

const luaLs = findLuaLanguageServer();
describe("LuaLS conformance", () => {
  test.skipIf(luaLs === undefined)(
    "definitions and example parse cleanly and excluded surface is rejected",
    () => {
      const result = runConformance();
      expect(result.skipped).toBe(false);
      expect(result.problems).toEqual([]);
    },
  );
});
