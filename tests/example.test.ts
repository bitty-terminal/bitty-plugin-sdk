/**
 * Executable check for the bundled minimal Lua example (P1-7).
 *
 * `lua/examples/minimal-init.lua` is run under a recording shim
 * (`tests/lua/minimal-example-recorder.lua`) when a `lua` interpreter is on
 * PATH (override with `LUA`). The recorded call sequence is then replayed into
 * the TypeScript mock host, which owns argument-shape validation, so the
 * example cannot claim shapes the host rejects. When no interpreter is
 * available the test is skipped explicitly (CI's `just check` image has none);
 * the deterministic companion-manifest test still runs and pins the
 * declarations the example relies on.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXCLUSIVE_CLAIM_SLOTS } from "../src/host-surface.js";
import { loadManifestModel } from "../src/manifest-model.js";
import { lintManifestSource } from "../src/manifest.js";
import { MockHost } from "../src/mock-host.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE_PATH = join(REPO_ROOT, "lua/examples/minimal-init.lua");
const FULL_EXAMPLE_PATH = join(
  REPO_ROOT,
  "docs/examples/full-bitty-plugin.toml",
);
const COMPANION_MANIFEST_PATH = join(
  REPO_ROOT,
  "lua/examples/minimal-init.bitty-plugin.toml",
);
const RECORDER_PATH = join(REPO_ROOT, "tests/lua/minimal-example-recorder.lua");

const LUA = findLua();

/** Locate a Lua interpreter without spawning a shell; `LUA` overrides. */
function findLua(): string | undefined {
  const override = process.env.LUA;
  if (override !== undefined && override !== "" && existsSync(override)) {
    return override;
  }
  const names = ["lua", "lua5.4", "lua5.3", "luajit"];
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

interface RecordedCall {
  readonly op: string;
  readonly args: unknown;
  readonly result?: string;
}

/** Run the example under the Lua recorder and parse its JSON transcript. */
function recordExampleTranscript(lua: string): RecordedCall[] {
  const proc = spawnSync(lua, [RECORDER_PATH, EXAMPLE_PATH], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(`lua recorder failed: ${proc.stderr || proc.stdout}`);
  }
  return JSON.parse(proc.stdout.trim()) as RecordedCall[];
}

/**
 * Replay a recorded example transcript into one activated mock host.
 *
 * Symbolic handle tokens recorded by the shim are resolved to the real
 * handles the host creates, and `__function__` markers become inert stubs so
 * the host validates every definition shape.
 */
function replay(host: MockHost, calls: readonly RecordedCall[]): void {
  const handles = new Map<string, number>();
  const stub = (): null => null;

  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === "__function__") return stub;
      return handles.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map((entry) => resolve(entry));
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(value)) {
        output[key] = resolve(member);
      }
      return output;
    }
    return value;
  };

  for (const call of calls) {
    const args = resolve(call.args) as Record<string, unknown>;
    let returned: unknown;
    switch (call.op) {
      case "commands.register":
        returned = host.bitty.commands.register({
          ...args,
          run: stub,
        } as never);
        break;
      case "events.subscribe":
        returned = host.bitty.events.subscribe(String(args["kind"]), stub);
        break;
      case "keymaps.suggest":
        returned = host.bitty.keymaps.suggest(args as never);
        break;
      case "settings.get":
        returned = host.bitty.settings.get(String(args["key"]));
        break;
      case "settings.set":
        returned = host.bitty.settings.set(
          String(args["key"]),
          args["value"] as never,
        );
        break;
      case "store.get":
        returned = host.bitty.store.get(String(args["key"]));
        break;
      case "store.set":
        returned = host.bitty.store.set(
          String(args["key"]),
          args["value"] as never,
        );
        break;
      case "notify.show":
        returned = host.bitty.notify.show(args as never);
        break;
      case "ui.mount":
        returned = host.bitty.ui.mount(
          String(args["slot"]),
          args["component"] as Record<string, unknown>,
        );
        break;
      case "ui.update":
        returned = host.bitty.ui.update(
          Number(args["handle"]),
          args["component"] as Record<string, unknown>,
        );
        break;
      case "terminal.snapshot":
        returned = host.bitty.terminal.snapshot(args as never);
        break;
      case "services.get":
        returned = host.bitty.services.get(
          String(args["iface"]),
          args["opts"] as never,
        );
        break;
      case "services.provide":
        returned = host.bitty.services.provide(
          String(args["iface"]),
          args["impl"] as never,
        );
        break;
      case "tasks.spawn":
        returned = host.bitty.tasks.spawn(stub);
        break;
      case "timers.create":
        returned = host.bitty.timers.create(Number(args["delay"]), stub);
        break;
      default:
        throw new Error(`unhandled example op ${call.op}`);
    }
    if (call.result !== undefined) {
      handles.set(call.result, returned as number);
    }
  }
}

describe("runnable minimal example", () => {
  test("companion manifest declares the example surface", () => {
    const source = readFileSync(COMPANION_MANIFEST_PATH, "utf8");
    const lint = lintManifestSource(source);
    expect(lint.diagnostics).toEqual([]);
    expect(lint.valid).toBe(true);

    const model = loadManifestModel(source);
    expect(model.pluginId).toBe("xuepoo.example");
    expect(model.commands).toContain("xuepoo.example:hello");
    expect(model.events).toContain("terminal.title-changed");
    expect(model.providedServices.get("example.greeter")).toBe("1.0.0");
    for (const capability of [
      "platform.notify",
      "ui.rich",
      "terminal.semantic-read",
    ]) {
      expect(model.capabilities).toContain(capability);
    }
  });

  test.skipIf(LUA === undefined)(
    "lua/examples/minimal-init.lua executes through the mock host",
    () => {
      const transcript = recordExampleTranscript(LUA as string);
      const ops = transcript.map((entry) => entry.op);
      // bitty.services.get/provide are WIRED on the current host (bitty
      // #1391): the example provides and resolves live, while bitty.env
      // stays DEFERRED (bitty #1303) and every env call fails closed with
      // E_NOT_IMPLEMENTED.
      for (const op of [
        "commands.register",
        "events.subscribe",
        "keymaps.suggest",
        "terminal.snapshot",
        "ui.mount",
        "ui.update",
        "store.set",
        "store.get",
        "settings.set",
        "settings.get",
        "tasks.spawn",
        "timers.create",
      ]) {
        expect(ops).toContain(op);
      }
      expect(ops).toContain("services.get");
      expect(ops).toContain("services.provide");
      const host = new MockHost({
        manifestSource: readFileSync(COMPANION_MANIFEST_PATH, "utf8"),
      });
      host.grant("platform.notify");
      host.grant("ui.rich");
      host.grant("terminal.semantic-read");
      host.beginActivation();
      replay(host, transcript);
      host.endActivation();
      expect(host.currentState).toBe("active");
      expect(host.manifest.providedServices.get("example.greeter")).toBe(
        "1.0.0",
      );
    },
  );
});

describe("shipped manifest examples", () => {
  test("full example claims satisfy every exclusive UI slot", () => {
    const source = readFileSync(FULL_EXAMPLE_PATH, "utf8");
    const model = loadManifestModel(source);
    // Guard against a vacuous loop if the exclusive-claim set ever empties.
    expect(EXCLUSIVE_CLAIM_SLOTS.length).toBeGreaterThan(0);
    for (const slot of EXCLUSIVE_CLAIM_SLOTS) {
      expect(model.claims).toContain(slot);
    }

    // Mounting proves the host accepts the shipped claim token; before the
    // `tabline` fix the example declared `workspaceline` and failed with
    // E_UI_CLAIM_REQUIRED here.
    const host = new MockHost({ manifestSource: source });
    host.grant("ui.rich");
    host.beginActivation();
    for (const slot of EXCLUSIVE_CLAIM_SLOTS) {
      expect(
        host.bitty.ui.mount(slot, { kind: "Text", text: "claim" }),
      ).toBeGreaterThan(0);
    }
    host.endActivation();
    expect(host.currentState).toBe("active");
  });
});
