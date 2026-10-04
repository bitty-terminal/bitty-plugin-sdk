/**
 * Mock-host behavior tests for Plugin API v1 (R-SDK-3).
 *
 * Every assertion maps to the accepted contract: ADR 0009 resolutions
 * (LUA-OQ-1..12) and the accepted Plugin API v1 Lua Surface RFC. The mock host
 * must be no more permissive than the production host contract: ungranted
 * capabilities fail closed with the typed denial, registration is confined to
 * the activation window, generation-owned handles are invalid after disposal,
 * and the closed v1 event set round-trips with bounded immutable payloads.
 */

import { describe, expect, test } from "bun:test";

import {
  ACCEPTED_HOST_CODES,
  HOST_CODES,
  HostError,
  MOCK_HOST_CODES,
  type HostDiagnostic,
} from "../src/host-diagnostics.js";
import {
  ENV_MAX_VALUE_BYTES,
  EVENT_KINDS,
  EVENT_MAX_BYTES,
  MOCK_LIMITS,
  PLUGIN_API_VERSION,
  UI_HOSTED_SLOTS,
  UI_SLOTS,
  UI_UNAVAILABLE_SLOT_REASONS,
  UI_UNAVAILABLE_SLOTS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
} from "../src/host-surface.js";
import { MockHost, MOCK_PLUGIN_API_VERSION } from "../src/mock-host.js";

const MANIFEST = `
[plugin]
id = "conformance.basic"
name = "Conformance Basic"
version = "1.0.0"
description = "Mock-host unit fixture."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
platform.notify = true
ui.rich = true
ui.overlay = true
terminal.semantic-read = true
"env.read:FIXTURE_KEY" = true

[lazy]
commands = [
  "conformance.basic:hello",
  "conformance.basic:echo",
  "conformance.basic:bad-result",
]
events = [
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
]
`;

function makeHost(
  manifestSource = MANIFEST,
  environment: Readonly<Record<string, string>> = { FIXTURE_KEY: "fixture" },
): MockHost {
  return new MockHost({ manifestSource, environment });
}

function denial(run: () => unknown): HostDiagnostic {
  try {
    run();
  } catch (cause) {
    if (cause instanceof HostError) return cause.diagnostic;
    throw cause;
  }
  throw new Error("expected a HostError");
}

function activate(host: MockHost): void {
  host.beginActivation();
}

describe("surface", () => {
  test("module root reports the accepted api version and namespaces", () => {
    const host = makeHost();
    expect(host.bitty.api_version).toBe(PLUGIN_API_VERSION);
    expect(PLUGIN_API_VERSION).toBe("1.0.0");
    for (const namespace of [
      "commands",
      "events",
      "keymaps",
      "settings",
      "store",
      "notify",
      "ui",
      "terminal",
      "services",
      "tasks",
      "timers",
      "debug",
      "workspace",
      "process",
    ] as const) {
      expect(host.bitty[namespace]).toBeDefined();
    }
  });

  test("closed v1 event set matches the accepted classes", () => {
    expect(EVENT_KINDS).toHaveLength(23);
    const byClass = { lifecycle: 0, observation: 0, interception: 0 };
    for (const spec of EVENT_KINDS) byClass[spec.class] += 1;
    expect(byClass).toEqual({ lifecycle: 4, observation: 15, interception: 4 });
    expect(EVENT_KINDS.map((entry) => entry.kind)).toContain(
      "plugin.activated",
    );
    expect(EVENT_KINDS.map((entry) => entry.kind)).toContain(
      "intercept.open-url",
    );
    expect(EVENT_KINDS.map((entry) => entry.kind)).toContain(
      "overlay.released",
    );
  });

  test("accepted host codes stay separate from mock-owned codes", () => {
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.CAPABILITY_DENIED)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.STORE_QUOTA)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.BUDGET_TASK)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.UI_UNAVAILABLE)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.UI_ALREADY_CAPTURED)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.UI_NOT_OWNER)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.REGISTRATION_CLOSED)).toBe(false);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.NOT_IMPLEMENTED)).toBe(false);
    expect(MOCK_HOST_CODES.has(HOST_CODES.NOT_IMPLEMENTED)).toBe(true);
  });
});

describe("deny-by-default capabilities", () => {
  test("declared but ungranted fails closed with the typed denial", () => {
    const host = makeHost();
    activate(host);
    const diagnostic = denial(() => host.bitty.notify.show({ title: "hello" }));
    expect(diagnostic.code).toBe(HOST_CODES.CAPABILITY_DENIED);
    expect(diagnostic.class).toBe("runtime");
    expect(host.notifications).toHaveLength(0);
  });

  test("granted capability works and is captured host-side", () => {
    const host = makeHost();
    host.grant("platform.notify");
    activate(host);
    expect(host.bitty.notify.show({ title: "hello", urgency: "low" })).toBe(
      true,
    );
    expect(host.notifications).toEqual([
      { title: "hello", urgency: "low", body: undefined },
    ]);
  });

  test("revocation fails closed again", () => {
    const host = makeHost();
    host.grant("platform.notify");
    activate(host);
    expect(host.bitty.notify.show({ title: "hello" })).toBe(true);
    host.revoke("platform.notify");
    const diagnostic = denial(() => host.bitty.notify.show({ title: "hello" }));
    expect(diagnostic.code).toBe(HOST_CODES.CAPABILITY_DENIED);
    expect(host.notifications).toHaveLength(1);
  });

  test("a grant for an undeclared capability cannot be exercised", () => {
    const host = makeHost(MANIFEST.replace("platform.notify = true\n", ""));
    host.grant("platform.notify");
    activate(host);
    const diagnostic = denial(() => host.bitty.notify.show({ title: "hello" }));
    expect(diagnostic.code).toBe(HOST_CODES.CAPABILITY_DENIED);
  });

  test("every gated surface maps to its accepted capability", () => {
    const host = makeHost();
    activate(host);
    expect(
      denial(() => host.bitty.ui.mount("top", { kind: "Text", text: "hi" }))
        .code,
    ).toBe(HOST_CODES.CAPABILITY_DENIED);
    expect(
      denial(() => host.bitty.terminal.snapshot({ scope: "semantic" })).code,
    ).toBe(HOST_CODES.CAPABILITY_DENIED);
  });
});

describe("env carve-out (ADR 0006 / ADR 0009 LUA-OQ-2)", () => {
  test("bitty.env is absent unless the manifest declares an env capability", () => {
    const host = makeHost(
      MANIFEST.replace('"env.read:FIXTURE_KEY" = true\n', ""),
    );
    expect(host.bitty.env).toBeUndefined();
  });

  test("declared env functions fail with E_NOT_IMPLEMENTED, granted or not", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.env).toBeDefined();
    for (const call of [
      () => host.bitty.env?.get("FIXTURE_KEY"),
      () => host.bitty.env?.has("FIXTURE_KEY"),
    ]) {
      const ungranted = denial(call);
      expect(ungranted.code).toBe(HOST_CODES.NOT_IMPLEMENTED);
      expect(ungranted.class).toBe("runtime");
    }
    host.grant("env.read:FIXTURE_KEY");
    for (const call of [
      () => host.bitty.env?.get("FIXTURE_KEY"),
      () => host.bitty.env?.has("FIXTURE_KEY"),
    ]) {
      expect(denial(call).code).toBe(HOST_CODES.NOT_IMPLEMENTED);
    }
  });

  test("granted env reads stay deferred with E_NOT_IMPLEMENTED (bitty #1303)", () => {
    const host = makeHost(undefined, {
      FIXTURE_KEY: "fixture",
      OTHER_KEY: "other",
    });
    host.grant("env.read:FIXTURE_KEY");
    activate(host);
    expect(denial(() => host.bitty.env?.get("FIXTURE_KEY")).code).toBe(
      HOST_CODES.NOT_IMPLEMENTED,
    );
    expect(denial(() => host.bitty.env?.has("FIXTURE_KEY")).code).toBe(
      HOST_CODES.NOT_IMPLEMENTED,
    );
  });

  test("deferred env wins before key validation with E_NOT_IMPLEMENTED", () => {
    const host = makeHost(undefined, { FIXTURE_KEY: "x".repeat(5000) });
    host.grant("env.read:FIXTURE_KEY");
    activate(host);
    expect(denial(() => host.bitty.env?.get("lowercase")).code).toBe(
      HOST_CODES.NOT_IMPLEMENTED,
    );
    expect(denial(() => host.bitty.env?.get("FIXTURE_KEY")).code).toBe(
      HOST_CODES.NOT_IMPLEMENTED,
    );
    expect(ENV_MAX_VALUE_BYTES).toBe(4096);
  });
});

describe("host parity (bitty #1303 freeze, #1391 services re-wire)", () => {
  test("deferred env fails with E_NOT_IMPLEMENTED; wired services resolve", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.services).toBeDefined();
    expect(host.bitty.env).toBeDefined();
    expect(typeof host.bitty.services.get).toBe("function");
    expect(typeof host.bitty.services.provide).toBe("function");
    expect(typeof host.bitty.env?.get).toBe("function");
    expect(typeof host.bitty.env?.has).toBe("function");
    for (const call of [
      () => host.bitty.env?.get("FIXTURE_KEY"),
      () => host.bitty.env?.has("FIXTURE_KEY"),
    ]) {
      const diagnostic = denial(call);
      expect(diagnostic.code).toBe(HOST_CODES.NOT_IMPLEMENTED);
      expect(diagnostic.class).toBe("runtime");
    }
    // No provider registered: wired resolution fails closed, not deferred.
    expect(
      denial(() =>
        host.bitty.services.get("conformance.greet", { version: ">=1.0.0" }),
      ),
    ).toMatchObject({
      class: "resolution",
      code: HOST_CODES.SERVICE_RESOLUTION,
    });
    host.endActivation();
  });

  test("deferred env ignores grants, shapes, and lifecycle; wired services enforce declaration and version", () => {
    const host = makeHost();
    host.grant("env.read:FIXTURE_KEY");
    host.beginActivation();
    expect(
      denial(() =>
        host.bitty.services.provide("anything.undeclared", {
          hello: () => null,
        }),
      ),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.SERVICE_UNDECLARED,
    });
    const get = host.bitty.services.get as unknown as (
      iface: string,
      opts?: unknown,
    ) => unknown;
    expect(denial(() => get("anything")).code).toBe(
      HOST_CODES.SERVICE_VERSION_INVALID,
    );
    expect(denial(() => host.bitty.env?.get("lowercase")).code).toBe(
      HOST_CODES.NOT_IMPLEMENTED,
    );
    host.endActivation();
    host.suspend();
    expect(
      denial(() => host.bitty.services.get("anything", { version: ">=1.0.0" })),
    ).toMatchObject({
      class: "resolution",
      code: HOST_CODES.SERVICE_RESOLUTION,
    });
    host.dispose();
    expect(
      denial(() => host.bitty.services.get("anything", { version: ">=1.0.0" })),
    ).toMatchObject({
      class: "runtime",
      code: HOST_CODES.GENERATION_DISPOSED,
    });
  });

  test("wired keymaps and tasks keep full bindings", () => {
    const host = makeHost();
    activate(host);
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => null,
    });
    const suggestion = host.bitty.keymaps.suggest({
      chord: "ctrl+p",
      command: "conformance.basic:hello",
    });
    expect(suggestion).toBeGreaterThan(0);
    const task = host.bitty.tasks.spawn(() => null);
    expect(task).toBeGreaterThan(0);
    expect(host.bitty.tasks.cancel(task)).toBe(true);
  });
});

describe("registration window and lifecycle", () => {
  test.each([...UI_HOSTED_SLOTS])(
    "ui.mount requires activation for slot %s",
    (slot) => {
      const host = makeHost(
        MANIFEST.replace("[lazy]", '[lazy]\nclaims = ["tabline"]'),
      );
      host.grant("ui.rich");
      host.grant("ui.overlay");
      const mount = () =>
        host.bitty.ui.mount(slot, { kind: "Text", text: "panel" });
      expect(denial(mount)).toMatchObject({
        code: HOST_CODES.GENERATION_DISPOSED,
        class: "runtime",
      });
      host.beginActivation();
      const block = mount();
      expect(block).toBeGreaterThan(0);
      host.endActivation();
      expect(denial(mount)).toMatchObject({
        code: HOST_CODES.REGISTRATION_CLOSED,
        class: "validation",
      });
      expect(
        host.bitty.ui.update(block, { kind: "Text", text: "updated" }),
      ).toBe(true);
      host.suspend();
      expect(denial(mount)).toMatchObject({
        code: HOST_CODES.REGISTRATION_CLOSED,
        class: "validation",
      });
      host.dispose();
      expect(denial(mount)).toMatchObject({
        code: HOST_CODES.GENERATION_DISPOSED,
        class: "runtime",
      });
      host.beginActivation();
      expect(denial(mount).code).toBe(HOST_CODES.CAPABILITY_DENIED);
      host.grant("ui.rich");
      host.grant("ui.overlay");
      expect(mount()).toBeGreaterThan(block);
      expect(host.bitty.ui.update(block, { kind: "Text", text: "stale" })).toBe(
        false,
      );
    },
  );

  test("hosted and unavailable slots partition the accepted slot set", () => {
    expect(UI_UNAVAILABLE_SLOTS).toEqual(["tabline", "overlay", "terminal"]);
    expect([...UI_HOSTED_SLOTS, ...UI_UNAVAILABLE_SLOTS].sort()).toEqual(
      [...UI_SLOTS].sort(),
    );
  });

  test.each([...UI_UNAVAILABLE_SLOTS])(
    "ui.mount on unhosted slot %s fails closed with E_UI_UNAVAILABLE",
    (slot) => {
      // Every gate before placement is satisfied: ui.rich and ui.overlay are
      // granted and tabline is claimed, so only the unhosted slot remains.
      const host = makeHost(
        MANIFEST.replace("[lazy]", '[lazy]\nclaims = ["tabline"]'),
      );
      host.grant("ui.rich");
      host.grant("ui.overlay");
      const mount = () =>
        host.bitty.ui.mount(slot, { kind: "Text", text: "panel" });
      // Lifecycle guards still run first.
      expect(denial(mount).code).toBe(HOST_CODES.GENERATION_DISPOSED);
      host.beginActivation();
      expect(denial(mount)).toEqual({
        class: "runtime",
        code: HOST_CODES.UI_UNAVAILABLE,
        message: `UI slot '${slot}' ${UI_UNAVAILABLE_SLOT_REASONS[slot]}`,
        path: "slot",
      });
      // Placement is rejected before component validation and budgets.
      expect(
        denial(() => host.bitty.ui.mount(slot, { kind: "Image", src: "x" }))
          .code,
      ).toBe(HOST_CODES.UI_UNAVAILABLE);
      // A rejected mount admits no block, so a hosted slot still works.
      expect(
        host.bitty.ui.mount("top", { kind: "Text", text: "ok" }),
      ).toBeGreaterThan(0);
      host.endActivation();
      expect(denial(mount).code).toBe(HOST_CODES.REGISTRATION_CLOSED);
    },
  );

  test("lifecycle callbacks cannot mount after activation closes", () => {
    const host = makeHost();
    host.grant("ui.rich");
    host.beginActivation();
    const diagnostics: HostDiagnostic[] = [];
    for (const event of [
      "plugin.activated",
      "plugin.suspended",
      "plugin.disposed",
    ]) {
      host.bitty.events.subscribe(event, () => {
        diagnostics.push(
          denial(() =>
            host.bitty.ui.mount("top", { kind: "Text", text: "late" }),
          ),
        );
      });
    }
    host.endActivation();
    host.suspend();
    host.dispose();
    expect(diagnostics).toHaveLength(3);
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toMatchObject({
        code: HOST_CODES.REGISTRATION_CLOSED,
        class: "validation",
      });
    }
    expect(host.handlerViolations).toHaveLength(0);
  });

  test("UI activation and live updates retain capability denial", () => {
    const host = makeHost();
    host.beginActivation();
    const mount = () =>
      host.bitty.ui.mount("top", { kind: "Text", text: "panel" });
    expect(denial(mount).code).toBe(HOST_CODES.CAPABILITY_DENIED);
    host.grant("ui.rich");
    const block = mount();
    host.revoke("ui.rich");
    expect(denial(mount).code).toBe(HOST_CODES.CAPABILITY_DENIED);
    host.endActivation();
    const update = () =>
      host.bitty.ui.update(block, { kind: "Text", text: "updated" });
    expect(denial(update).code).toBe(HOST_CODES.CAPABILITY_DENIED);
    host.grant("ui.rich");
    expect(update()).toBe(true);
    const undeclared = makeHost(MANIFEST.replace("ui.rich = true\n", ""));
    undeclared.grant("ui.rich");
    undeclared.beginActivation();
    expect(
      denial(() =>
        undeclared.bitty.ui.mount("top", { kind: "Text", text: "denied" }),
      ).code,
    ).toBe(HOST_CODES.CAPABILITY_DENIED);
  });

  test("registration is valid only while the generation is activating", () => {
    const host = makeHost();
    activate(host);
    const handle = host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => "hello",
    });
    expect(handle).toBeGreaterThan(0);
    host.endActivation();
    const diagnostic = denial(() =>
      host.bitty.commands.register({
        id: "echo",
        title: "Echo",
        run: () => "echo",
      }),
    );
    expect(diagnostic.code).toBe(HOST_CODES.REGISTRATION_CLOSED);
    expect(diagnostic.class).toBe("validation");
  });

  test("unreserved and duplicate command names are rejected", () => {
    const host = makeHost();
    activate(host);
    expect(
      denial(() =>
        host.bitty.commands.register({
          id: "unknown",
          title: "Unknown",
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.COMMAND_UNDECLARED);
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => "hello",
    });
    expect(
      denial(() =>
        host.bitty.commands.register({
          id: "hello",
          title: "Hello again",
          run: () => "hello",
        }),
      ).code,
    ).toBe(HOST_CODES.COMMAND_DUPLICATE);
  });

  test("plugin.activated is delivered after registration closes", () => {
    const host = makeHost();
    activate(host);
    const received: string[] = [];
    host.bitty.events.subscribe("plugin.activated", (event) => {
      received.push(event.kind);
    });
    host.endActivation();
    expect(received).toEqual(["plugin.activated"]);
  });

  test("dispose delivers plugin.disposed and invalidates generation handles", () => {
    const host = makeHost();
    activate(host);
    const received: string[] = [];
    host.bitty.events.subscribe("plugin.disposed", (event) => {
      received.push(event.kind);
    });
    const task = host.bitty.tasks.spawn(() => 1);
    const timer = host.bitty.timers.create(10, () => 1);
    host.endActivation();
    host.dispose();
    expect(received).toEqual(["plugin.disposed"]);
    const diagnostic = denial(() => host.bitty.store.get("anything"));
    expect(diagnostic.code).toBe(HOST_CODES.GENERATION_DISPOSED);
    activate(host);
    host.endActivation();
    expect(host.bitty.tasks.cancel(task)).toBe(false);
    expect(host.bitty.timers.cancel(timer)).toBe(false);
  });

  test("store persists across generation disposal and reload", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.store.set("counter", 3)).toBe(true);
    host.endActivation();
    host.dispose();
    activate(host);
    expect(host.bitty.store.get("counter")).toBe(3);
  });

  test("ui.update returns false for a stale generation handle", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    const block = host.bitty.ui.mount("top", { kind: "Text", text: "one" });
    host.endActivation();
    expect(host.bitty.ui.update(block, { kind: "Text", text: "two" })).toBe(
      true,
    );
    host.dispose();
    activate(host);
    // Consent is per generation: re-authorize before using the surface.
    host.grant("ui.rich");
    expect(host.bitty.ui.update(block, { kind: "Text", text: "three" })).toBe(
      false,
    );
  });

  test("lifecycle state transitions are bounded", () => {
    const host = makeHost();
    expect(denial(() => host.endActivation()).code).toBe(
      HOST_CODES.LIFECYCLE_STATE,
    );
    activate(host);
    expect(denial(() => host.beginActivation()).code).toBe(
      HOST_CODES.LIFECYCLE_STATE,
    );
    host.endActivation();
    expect(host.suspend()).toBeUndefined();
    expect(denial(() => host.suspend()).code).toBe(HOST_CODES.LIFECYCLE_STATE);
  });
});

describe("suspended dispatch", () => {
  test("commands fail closed without running retained registrations", () => {
    const host = makeHost();
    host.beginActivation();
    let calls = 0;
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => ++calls,
    });
    host.endActivation();
    expect(host.dispatchCommand("conformance.basic:hello")).toBe(1);
    host.suspend();
    expect(
      denial(() => host.dispatchCommand("conformance.basic:hello")),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.LIFECYCLE_STATE,
    });
    expect(calls).toBe(1);
  });

  // Workspace kinds need a granted workspace.read at activation; their
  // suspended detachment is covered by the workspace domain suite below.
  // Overlay release kinds carry owner/reason payloads and suspend-revoke is
  // covered by the overlay focusable-surface suite below.
  test.each(
    EVENT_KINDS.filter(
      (spec) =>
        spec.class !== "lifecycle" &&
        !spec.kind.startsWith("workspace.") &&
        spec.kind !== "overlay.released",
    ),
  )("$kind delivery is detached while suspended", (spec) => {
    const host = makeHost();
    host.beginActivation();
    let calls = 0;
    host.bitty.events.subscribe(spec.kind, () => {
      calls += 1;
      return false;
    });
    host.endActivation();
    host.suspend();
    const payload =
      spec.class === "interception"
        ? { action: "fixture", origin: "fixture", preview: "fixture" }
        : spec.kind === "terminal.opened"
          ? { terminal_id: 1, runtime_id: 1, generation: 1 }
          : spec.kind === "terminal.closed"
            ? { terminal_id: 1, runtime_id: 1, reason: "closed" }
            : spec.kind === "terminal.title-changed"
              ? { terminal_id: 1, runtime_id: 1, title: "fixture" }
              : spec.kind === "terminal.cwd-changed"
                ? { terminal_id: 1, runtime_id: 1, cwd: "fixture" }
                : spec.kind === "focus.changed" ||
                    spec.kind === "selection.changed"
                  ? { view_id: 1 }
                  : spec.kind === "process.exited"
                    ? { terminal_id: 1, runtime_id: 1, exit_code: 0 }
                    : {};
    expect(host.publish(spec.kind, payload)).toEqual({
      delivered: 0,
      vetoed: false,
    });
    expect(calls).toBe(0);
  });

  test.each(["observation", "interception", "task", "timer"] as const)(
    "suspension inside a %s callback stops the remaining batch",
    (surface) => {
      const host = makeHost();
      host.beginActivation();
      const calls: string[] = [];
      const first = () => {
        calls.push("first");
        host.suspend();
      };
      const second = () => calls.push("second");
      if (surface === "task") {
        host.bitty.tasks.spawn(first);
        host.bitty.tasks.spawn(second);
      } else if (surface === "timer") {
        host.bitty.timers.create(0, first);
        host.bitty.timers.create(0, second);
      } else {
        const kind =
          surface === "observation" ? "terminal.bell" : "intercept.paste";
        host.bitty.events.subscribe(kind, first);
        host.bitty.events.subscribe(kind, second);
      }
      host.endActivation();
      if (surface === "task") host.drainTasks();
      else if (surface === "timer") host.advanceTimers(0);
      else {
        expect(
          host.publish(
            surface === "observation" ? "terminal.bell" : "intercept.paste",
            surface === "observation"
              ? {}
              : { action: "paste", origin: "fixture", preview: "fixture" },
          ),
        ).toEqual({ delivered: 1, vetoed: false });
      }
      expect(calls).toEqual(["first"]);
    },
  );

  describe.each([false, true])("suspension cleanup reload=%s", (reload) => {
    test.each(["observation", "interception", "timer"] as const)(
      "disposal stops snapshotted %s callbacks",
      (surface) => {
        const host = makeHost();
        host.beginActivation();
        const calls: string[] = [];
        const kind =
          surface === "observation" ? "terminal.bell" : "intercept.paste";
        const register = (callback: () => unknown) => {
          if (surface === "timer") host.bitty.timers.create(0, callback);
          else host.bitty.events.subscribe(kind, callback);
        };
        host.bitty.events.subscribe("plugin.disposed", () => {
          calls.push("disposed");
        });
        host.bitty.events.subscribe("plugin.suspended", () => {
          host.dispose();
          if (reload) {
            host.beginActivation();
            register(() => calls.push("new"));
            host.endActivation();
          }
        });
        register(() => {
          calls.push("first");
          host.suspend();
        });
        register(() => calls.push("stale"));
        host.endActivation();
        const dispatch = () => {
          if (surface === "timer") host.advanceTimers(0);
          else {
            expect(
              host.publish(
                kind,
                surface === "observation"
                  ? {}
                  : { action: "paste", origin: "fixture", preview: "fixture" },
              ),
            ).toEqual({ delivered: 1, vetoed: false });
          }
        };
        dispatch();
        expect(calls).toEqual(["first", "disposed"]);
        expect(host.currentState).toBe(reload ? "active" : "disposed");
        expect(host.handlerViolations).toHaveLength(0);
        if (reload) {
          dispatch();
          expect(calls).toEqual(["first", "disposed", "new"]);
        }
      },
    );
  });

  test("queued tasks and timers stay detached and cancellable until disposal", () => {
    const host = makeHost();
    host.beginActivation();
    let calls = 0;
    const task = host.bitty.tasks.spawn(() => ++calls);
    const timer = host.bitty.timers.create(0, () => ++calls);
    host.endActivation();
    host.suspend();
    host.drainTasks();
    host.advanceTimers(1);
    expect(calls).toBe(0);
    expect(host.bitty.tasks.cancel(task)).toBe(true);
    expect(host.bitty.timers.cancel(timer)).toBe(true);
    host.dispose();
    host.beginActivation();
    host.endActivation();
    host.drainTasks();
    host.advanceTimers(1);
    expect(calls).toBe(0);
    expect(host.bitty.tasks.cancel(task)).toBe(false);
    expect(host.bitty.timers.cancel(timer)).toBe(false);
  });

  test("lifecycle cleanup retains store and grants without reopening ordinary dispatch", () => {
    const host = makeHost();
    host.grant("platform.notify");
    host.beginActivation();
    host.bitty.store.set("retained", "value");
    const lifecycle: string[] = [];
    const results: unknown[] = [];
    const denials: HostDiagnostic[] = [];
    let ordinary = 0;
    host.bitty.events.subscribe("terminal.bell", () => ++ordinary);
    host.bitty.tasks.spawn(() => ++ordinary);
    host.bitty.timers.create(0, () => ++ordinary);
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => ++ordinary,
    });
    for (const kind of [
      "plugin.suspended",
      "plugin.disposed",
      "handler.violation",
    ]) {
      host.bitty.events.subscribe(kind, () => {
        lifecycle.push(kind);
        results.push(host.bitty.store.get("retained"));
        results.push(host.isGranted("platform.notify"));
        results.push(host.publish("terminal.bell"));
        host.drainTasks();
        host.advanceTimers(0);
        denials.push(
          denial(() => host.dispatchCommand("conformance.basic:hello")),
        );
      });
    }
    host.bitty.events.subscribe("plugin.suspended", () => {
      throw new Error("cleanup failure");
    });
    host.endActivation();
    host.suspend();
    expect(host.currentState).toBe("suspended");
    host.revoke("platform.notify");
    expect(denial(() => host.bitty.notify.show({ title: "denied" })).code).toBe(
      HOST_CODES.CAPABILITY_DENIED,
    );
    host.grant("platform.notify");
    host.dispose();
    expect(lifecycle).toEqual([
      "plugin.suspended",
      "handler.violation",
      "plugin.disposed",
    ]);
    expect(results).toEqual(
      Array.from({ length: 3 }, () => [
        "value",
        true,
        { delivered: 0, vetoed: false },
      ]).flat(),
    );
    expect(denials).toHaveLength(3);
    expect(
      denials.every((entry) => entry.code === HOST_CODES.LIFECYCLE_STATE),
    ).toBe(true);
    expect(ordinary).toBe(0);
    expect(host.handlerViolations).toHaveLength(1);
    host.beginActivation();
    expect(host.bitty.store.get("retained")).toBe("value");
    expect(host.isGranted("platform.notify")).toBe(false);
  });

  test("wired services park resolution while suspended and re-provide after reload", () => {
    const host = makeHost(
      `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
    );
    host.beginActivation();
    const handle = host.bitty.services.provide("conformance.greet", {
      hello: () => 1,
    });
    expect(handle).toBeGreaterThan(0);
    host.endActivation();
    expect(
      typeof host.bitty.services.get("conformance.greet", { version: "^1.0" })
        ?.hello,
    ).toBe("function");
    host.suspend();
    expect(
      denial(() =>
        host.bitty.services.get("conformance.greet", { version: "^1.0" }),
      ),
    ).toMatchObject({
      class: "resolution",
      code: HOST_CODES.SERVICE_RESOLUTION,
    });
    expect(
      host.bitty.services.get("conformance.greet", {
        version: "^1.0",
        optional: true,
      }),
    ).toBeUndefined();
    host.dispose();
    host.beginActivation();
    const reloaded = host.bitty.services.provide("conformance.greet", {
      hello: () => "new",
    });
    expect(reloaded).toBeGreaterThan(0);
    host.endActivation();
    expect(
      typeof host.bitty.services.get("conformance.greet", { version: "^1.0" })
        ?.hello,
    ).toBe("function");
  });

  test.each([false, true])(
    "suspended wired resolution fails closed for optional=%s",
    (optional) => {
      const host = makeHost(
        `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
      );
      host.beginActivation();
      host.bitty.services.provide("conformance.greet", { hello: () => 1 });
      host.endActivation();
      host.suspend();
      for (const iface of ["conformance.absent", "conformance.greet"]) {
        if (optional) {
          expect(
            host.bitty.services.get(iface, { version: "^1.0", optional }),
          ).toBeUndefined();
        } else {
          expect(
            denial(() =>
              host.bitty.services.get(iface, { version: "^1.0", optional }),
            ).code,
          ).toBe(HOST_CODES.SERVICE_RESOLUTION);
        }
      }
    },
  );

  test("undeclared provision fails before any provider runs", () => {
    const host = makeHost(
      `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
    );
    host.beginActivation();
    let calls = 0;
    expect(
      denial(() =>
        host.bitty.services.provide("conformance.absent", {
          hello: () => ++calls,
        }),
      ).code,
    ).toBe(HOST_CODES.SERVICE_UNDECLARED);
    expect(calls).toBe(0);
    host.endActivation();
  });
});

describe("closed event set round-trips", () => {
  test("every kind is known and unknown kinds are rejected", () => {
    const host = makeHost();
    activate(host);
    expect(
      denial(() =>
        host.bitty.events.subscribe("terminal.raw-changed", () => {}),
      ).code,
    ).toBe(HOST_CODES.EVENT_UNKNOWN);
    const limited = makeHost(
      MANIFEST.replace(/events = \[[\s\S]*?\n\]/, 'events = ["terminal.bell"]'),
    );
    activate(limited);
    expect(
      denial(() => limited.bitty.events.subscribe("terminal.opened", () => {}))
        .code,
    ).toBe(HOST_CODES.EVENT_UNDECLARED);
  });

  test("observation events deliver frozen envelopes with bounded payloads", () => {
    const host = makeHost();
    activate(host);
    const events: unknown[] = [];
    host.bitty.events.subscribe("terminal.opened", (event) => {
      events.push(event);
    });
    host.endActivation();
    const result = host.publish("terminal.opened", {
      terminal_id: 1,
      runtime_id: 2,
      generation: 3,
    });
    expect(result).toEqual({ delivered: 1, vetoed: false });
    const event = events[0] as {
      kind: string;
      sequence: number;
      payload: Record<string, unknown>;
    };
    expect(event.kind).toBe("terminal.opened");
    expect(event.sequence).toBeGreaterThan(0);
    expect(event.payload).toEqual({
      terminal_id: 1,
      runtime_id: 2,
      generation: 3,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  test("payload validation rejects missing fields and oversized payloads", () => {
    const host = makeHost();
    activate(host);
    host.bitty.events.subscribe("terminal.opened", () => {});
    host.endActivation();
    expect(denial(() => host.publish("terminal.opened", {})).code).toBe(
      HOST_CODES.EVENT_PAYLOAD_INVALID,
    );
    const oversized = {
      title: "x".repeat(EVENT_MAX_BYTES),
      terminal_id: 1,
      runtime_id: 2,
    };
    expect(
      denial(() => host.publish("terminal.title-changed", oversized)).code,
    ).toBe(HOST_CODES.EVENT_PAYLOAD_TOO_LARGE);
  });

  test("interception handlers veto with false and approve otherwise", () => {
    const host = makeHost();
    activate(host);
    host.bitty.events.subscribe("intercept.paste", () => false);
    host.endActivation();
    expect(
      host.publish("intercept.paste", {
        action: "paste",
        origin: "user",
        preview: "abc",
      }),
    ).toEqual({ delivered: 1, vetoed: true });
    const approving = makeHost();
    activate(approving);
    approving.bitty.events.subscribe("intercept.paste", () => undefined);
    approving.endActivation();
    expect(
      approving.publish("intercept.paste", {
        action: "paste",
        origin: "user",
        preview: "abc",
      }),
    ).toEqual({ delivered: 1, vetoed: false });
  });

  test("interception payloads reject fields outside the bounded preview shape", () => {
    const host = makeHost();
    activate(host);
    host.bitty.events.subscribe("intercept.paste", () => true);
    host.endActivation();
    expect(
      denial(() =>
        host.publish("intercept.paste", {
          action: "paste",
          origin: "user",
          preview: "abc",
          text: "forbidden",
        }),
      ).code,
    ).toBe(HOST_CODES.EVENT_PAYLOAD_INVALID);
  });

  test("handler violation messages stay bounded", () => {
    const host = makeHost();
    activate(host);
    host.bitty.events.subscribe("terminal.bell", () => {
      throw new Error("x".repeat(4096));
    });
    host.endActivation();
    host.publish("terminal.bell", {});
    const violation = host.handlerViolations[0];
    expect(violation).toBeDefined();
    expect((violation?.message.length ?? 0) <= 515).toBe(true);
  });

  test("throwing handlers are recorded and do not stop delivery", () => {
    const host = makeHost();
    activate(host);
    const delivered: number[] = [];
    host.bitty.events.subscribe("terminal.bell", () => {
      throw new Error("boom");
    });
    host.bitty.events.subscribe("terminal.bell", (event) => {
      delivered.push(event.sequence);
    });
    host.endActivation();
    expect(host.publish("terminal.bell", {})).toEqual({
      delivered: 2,
      vetoed: false,
    });
    expect(delivered).toHaveLength(1);
    expect(host.handlerViolations).toHaveLength(1);
    expect(host.handlerViolations[0]?.code).toBe(HOST_CODES.HANDLER_VIOLATION);
  });
});

describe("static schema enforcement", () => {
  const argsSchema = {
    type: "object",
    properties: { value: { type: "string", maxLength: 8 } },
    required: ["value"],
    additionalProperties: false,
  };
  const resultSchema = { type: "integer", minimum: 0 };
  const commandManifest = MANIFEST.replace(
    '"conformance.basic:echo",',
    '{ id = "conformance.basic:echo", args_schema = { type = "object", properties = { value = { type = "string", maxLength = 8 } }, required = ["value"], additionalProperties = false }, result_schema = { type = "integer", minimum = 0 } },',
  );
  const serviceManifest = `${MANIFEST}
[services.provided]
"conformance.greet" = { version = "1.0.0", args_schema = { type = "object", properties = { value = { type = "string", maxLength = 8 } }, required = ["value"], additionalProperties = false }, result_schema = { type = "integer", minimum = 0 } }
`;

  test("reordered static command schemas register and enforce both directions", () => {
    const host = makeHost(commandManifest);
    let calls = 0;
    activate(host);
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      args_schema: {
        additionalProperties: false,
        required: ["value"],
        properties: { value: { maxLength: 8, type: "string" } },
        type: "object",
      },
      result_schema: { minimum: 0, type: "integer" },
      run: () => ++calls,
    });
    host.endActivation();
    expect(
      host.dispatchCommand("conformance.basic:echo", { value: "hi" }),
    ).toBe(1);
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", { value: 1 }))
        .code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(calls).toBe(1);
  });

  for (const field of ["args_schema", "result_schema"] as const) {
    for (const schema of [undefined, { type: "boolean" }]) {
      test(`static command rejects ${field} ${schema === undefined ? "omission" : "mismatch"}`, () => {
        const host = makeHost(commandManifest);
        let calls = 0;
        activate(host);
        const diagnostic = denial(() =>
          host.bitty.commands.register({
            id: "echo",
            title: "Echo",
            args_schema: argsSchema,
            result_schema: resultSchema,
            [field]: schema,
            run: () => ++calls,
          }),
        );
        expect(diagnostic.code).toBe(HOST_CODES.SCHEMA_INVALID);
        expect(diagnostic.class).toBe("validation");
        expect(
          denial(() => host.dispatchCommand("conformance.basic:echo", {})).code,
        ).toBe(HOST_CODES.COMMAND_UNDECLARED);
        expect(calls).toBe(0);
      });
    }
  }

  for (const field of ["args_schema", "result_schema"] as const) {
    for (const location of ["root", "properties", "items"] as const) {
      for (const staticArray of [false, true]) {
        test(`singleton type equivalence in ${field} ${location} with static ${staticArray ? "array" : "scalar"}`, () => {
          const staticType = staticArray ? '["string"]' : '"string"';
          const runtimeType = staticArray ? "string" : ["string"];
          const variants = {
            root: {
              declaration: `{ type = ${staticType} }`,
              schema: { type: runtimeType },
              valid: "hello",
              invalid: 1,
            },
            properties: {
              declaration: `{ type = "object", additionalProperties = false, required = ["value"], properties = { value = { type = ${staticType} } } }`,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["value"],
                properties: { value: { type: runtimeType } },
              },
              valid: { value: "hello" },
              invalid: { value: 1 },
            },
            items: {
              declaration: `{ type = "array", items = { type = ${staticType} } }`,
              schema: { type: "array", items: { type: runtimeType } },
              valid: ["hello"],
              invalid: [1],
            },
          };
          const { declaration, schema, valid, invalid } = variants[location];
          const source = MANIFEST.replace(
            '"conformance.basic:echo",',
            `{ id = "conformance.basic:echo", ${field} = ${declaration} },`,
          );
          const host = makeHost(source);
          let result: unknown = valid;
          let calls = 0;
          activate(host);
          host.bitty.commands.register({
            id: "echo",
            title: "Echo",
            [field]: schema,
            run: () => {
              calls += 1;
              return result;
            },
          });
          host.endActivation();
          expect(host.dispatchCommand("conformance.basic:echo", valid)).toEqual(
            valid,
          );
          result = invalid;
          expect(
            denial(() =>
              host.dispatchCommand("conformance.basic:echo", invalid),
            ).code,
          ).toBe(
            field === "args_schema"
              ? HOST_CODES.ARGS_INVALID
              : HOST_CODES.RESULT_INVALID,
          );
          expect(calls).toBe(field === "args_schema" ? 1 : 2);
        });
      }
    }
  }

  test("canonicalization treats schema sets as unordered but preserves array values", () => {
    const source = MANIFEST.replace(
      '"conformance.basic:echo",',
      '{ id = "conformance.basic:echo", args_schema = { type = "object", additionalProperties = false, required = ["first", "second"], properties = { first = { type = ["string", "null"], enum = ["a", "b"] }, second = { type = "array", items = { type = "integer" }, default = [1, 2] } } } },',
    );
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["second", "first"],
      properties: {
        second: { default: [1, 2], items: { type: "integer" }, type: "array" },
        first: { enum: ["b", "a"], type: ["null", "string"] },
      },
    };
    const host = makeHost(source);
    activate(host);
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      args_schema: schema,
      run: () => true,
    });
    expect(
      host.dispatchCommand("conformance.basic:echo", {
        first: "a",
        second: [1],
      }),
    ).toBe(true);
    const mismatch = makeHost(source);
    activate(mismatch);
    schema.properties.second.default.reverse();
    expect(
      denial(() =>
        mismatch.bitty.commands.register({
          id: "echo",
          title: "Echo",
          args_schema: schema,
          run: () => true,
        }),
      ).code,
    ).toBe(HOST_CODES.SCHEMA_INVALID);
  });

  test("empty static command metadata differs from a string reservation", () => {
    const source = MANIFEST.replace(
      '"conformance.basic:echo",',
      '{ id = "conformance.basic:echo" },',
    );
    const host = makeHost(source);
    activate(host);
    expect(
      denial(() =>
        host.bitty.commands.register({
          id: "echo",
          title: "Echo",
          args_schema: argsSchema,
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.SCHEMA_INVALID);
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      run: () => null,
    });
    expect(host.dispatchCommand("conformance.basic:echo", {})).toBeNull();
  });

  test("registered static contracts cannot drift through the original definition", () => {
    const host = makeHost(commandManifest);
    activate(host);
    const schema = { type: "integer", minimum: 0 };
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      args_schema: argsSchema,
      result_schema: schema,
      run: () => "wrong",
    });
    schema.type = "string";
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", { value: "hi" }),
      ).code,
    ).toBe(HOST_CODES.RESULT_INVALID);
  });

  test("wired services park on suspend/dispose and die on removal", () => {
    for (const action of ["suspend", "dispose", "removeService"] as const) {
      const host = makeHost(serviceManifest);
      activate(host);
      const handle = host.bitty.services.provide("conformance.greet", {
        hello: () => 1,
      });
      expect(handle).toBeGreaterThan(0);
      host.endActivation();
      if (action === "removeService") host.removeService("conformance.greet");
      else host[action]();
      if (action === "dispose") {
        expect(
          denial(() =>
            host.bitty.services.get("conformance.greet", {
              version: "^1.0",
            }),
          ),
        ).toMatchObject({
          class: "runtime",
          code: HOST_CODES.GENERATION_DISPOSED,
        });
      } else {
        expect(
          denial(() =>
            host.bitty.services.get("conformance.greet", {
              version: "^1.0",
            }),
          ).code,
        ).toBe(HOST_CODES.SERVICE_RESOLUTION);
      }
    }
  });

  test("wired provision validates impl shape before schema validation", () => {
    const host = makeHost(serviceManifest);
    let calls = 0;
    activate(host);
    expect(
      denial(() =>
        host.bitty.services.provide("conformance.greet", {
          hello: () => ++calls,
          invalid: "not-a-function",
        } as never),
      ).code,
    ).toBe(HOST_CODES.DEF_INVALID);
    expect(calls).toBe(0);
    host.endActivation();
  });

  test("unsupported static service schemas fail at manifest validation", () => {
    expect(() =>
      makeHost(
        serviceManifest.replace(
          'type = "integer", minimum = 0',
          'type = "string", format = "email"',
        ),
      ),
    ).toThrow("manifest rejected: services.schema");
  });

  test("validating consumers require table-form providers", () => {
    const source = `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`;
    const host = new MockHost({
      manifestSource: source,
      schemaValidatingServices: ["conformance.greet"],
    });
    activate(host);
    // String-form provider: provide succeeds, but a schema-validating
    // consumer cannot resolve it.
    const handle = host.bitty.services.provide("conformance.greet", {
      hello: () => 1,
    });
    expect(handle).toBeGreaterThan(0);
    expect(
      denial(() =>
        host.bitty.services.get("conformance.greet", { version: "^1.0" }),
      ).code,
    ).toBe(HOST_CODES.SERVICE_RESOLUTION);
    expect(
      host.bitty.services.get("conformance.greet", {
        version: "^1.0",
        optional: true,
      }),
    ).toBeUndefined();
    host.endActivation();
    // Non-validating consumer resolves the same string-form provider.
    const legacy = makeHost(source);
    activate(legacy);
    const legacyHandle = legacy.bitty.services.provide("conformance.greet", {
      hello: () => "legacy",
    });
    expect(legacyHandle).toBeGreaterThan(0);
    legacy.endActivation();
    expect(
      typeof legacy.bitty.services.get("conformance.greet", {
        version: "^1.0",
      })?.hello,
    ).toBe("function");
  });

  test("table-form providers resolve for validating consumers with schema-checked calls", () => {
    const sources = [
      serviceManifest,
      serviceManifest.replace(/, args_schema = .* } }\n/, " }\n"),
    ];
    for (const [index, source] of sources.entries()) {
      const host = new MockHost({
        manifestSource: source,
        schemaValidatingServices: ["conformance.greet"],
      });
      activate(host);
      const handle = host.bitty.services.provide("conformance.greet", {
        hello: () => 1,
      });
      expect(handle).toBeGreaterThan(0);
      host.endActivation();
      // Version-only table form still carries a (possibly empty) schema
      // record, so validating consumers resolve it; only string-form
      // providers are unresolvable (covered above).
      const resolved = host.bitty.services.get("conformance.greet", {
        version: "^1.0",
      });
      if (typeof resolved?.hello !== "function") {
        throw new Error(
          "validating consumer should resolve table-form provider",
        );
      }
      const hello = resolved.hello as (args: unknown) => unknown;
      expect(hello({ value: "hi" })).toBe(1);
      if (index === 0) {
        // Declared args_schema is enforced on calls...
        expect(denial(() => hello({ value: "way-too-long" })).code).toBe(
          HOST_CODES.ARGS_INVALID,
        );
      } else {
        // ...while the schema-omission variant validates nothing.
        expect(hello({ value: "way-too-long" })).toBe(1);
      }
    }
  });
});

describe("commands and bounded schemas", () => {
  test("dispatch validates args before run and results after run", () => {
    const host = makeHost();
    let calls = 0;
    activate(host);
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      args_schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      result_schema: { type: "string" },
      run: (args) => {
        calls += 1;
        return (args as { value: string }).value;
      },
    });
    host.endActivation();
    expect(
      host.dispatchCommand("conformance.basic:echo", { value: "hi" }),
    ).toBe("hi");
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", { value: 1 }))
        .code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(calls).toBe(1);
  });

  test("invalid result and unsupported schema keywords fail closed", () => {
    const host = makeHost();
    activate(host);
    host.bitty.commands.register({
      id: "bad-result",
      title: "Bad result",
      result_schema: { type: "integer" },
      run: () => "not an integer",
    });
    expect(
      denial(() => host.dispatchCommand("conformance.basic:bad-result", {}))
        .code,
    ).toBe(HOST_CODES.RESULT_INVALID);
    expect(
      denial(() =>
        host.bitty.commands.register({
          id: "hello",
          title: "Pattern",
          args_schema: { type: "string", pattern: "^a+$" },
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.SCHEMA_INVALID);
  });
});

describe("store, ui, terminal, services, tasks, and timers", () => {
  test("store enforces key grammar, value bounds, and quota", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.store.set("good.key-1", { a: [1, 2] })).toBe(true);
    expect(host.bitty.store.get("good.key-1")).toEqual({ a: [1, 2] });
    expect(host.bitty.store.set("good.key-1", null)).toBe(true);
    expect(host.bitty.store.get("good.key-1")).toBeNull();
    expect(denial(() => host.bitty.store.set("Bad", 1)).code).toBe(
      HOST_CODES.STORE_KEY_INVALID,
    );
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < MOCK_LIMITS.STORE_MAX_DEPTH + 1; i += 1) {
      const next: Record<string, unknown> = {};
      cursor["child"] = next;
      cursor = next;
    }
    expect(denial(() => host.bitty.store.set("deep", deep as never)).code).toBe(
      HOST_CODES.STORE_VALUE_INVALID,
    );
    const chunk = "x".repeat(2048);
    let quota: HostDiagnostic | undefined;
    for (let i = 0; i < 200 && quota === undefined; i += 1) {
      try {
        host.bitty.store.set(`chunk-${i}`, chunk);
      } catch (cause) {
        if (cause instanceof HostError) quota = cause.diagnostic;
        else throw cause;
      }
    }
    expect(quota?.code).toBe(HOST_CODES.STORE_QUOTA);
  });

  test("nested stored and settings values are validated recursively before serialization", () => {
    const host = makeHost();
    activate(host);

    const invalidNestedValues: Array<[string, unknown, string]> = [
      ["nested NaN", { a: [Number.NaN] }, "value contains a non-finite number"],
      [
        "nested Infinity",
        { a: [Number.POSITIVE_INFINITY] },
        "value contains a non-finite number",
      ],
      [
        "nested -Infinity",
        { a: [Number.NEGATIVE_INFINITY] },
        "value contains a non-finite number",
      ],
      [
        "nested function",
        { nested: { fn: () => {} } },
        "value is not JSON-compatible data",
      ],
      [
        "nested symbol",
        { s: Symbol("sym") },
        "value is not JSON-compatible data",
      ],
      ["nested bigint", { b: 10n }, "value is not JSON-compatible data"],
      [
        "nested undefined property",
        { u: undefined },
        "value is not JSON-compatible data",
      ],
      [
        "nested undefined in array",
        { arr: [undefined] },
        "value is not JSON-compatible data",
      ],
      ["nested Date", { d: new Date() }, "value contains a non-plain object"],
      [
        "nested RegExp",
        { reg: /pattern/ },
        "value contains a non-plain object",
      ],
      ["nested Map", { m: new Map() }, "value contains a non-plain object"],
      ["nested Set", { s: new Set() }, "value contains a non-plain object"],
    ];

    for (const [desc, val, expectedMessage] of invalidNestedValues) {
      const storeDiag = denial(() =>
        host.bitty.store.set("invalid.key", val as never),
      );
      expect(storeDiag.code).toBe(HOST_CODES.STORE_VALUE_INVALID);
      expect(storeDiag.message).toBe(expectedMessage);

      const settingsDiag = denial(() =>
        host.bitty.settings.set("invalid.key", val as never),
      );
      expect(settingsDiag.code).toBe(HOST_CODES.STORE_VALUE_INVALID);
      expect(settingsDiag.message).toBe(expectedMessage);
    }

    // Rejected operations preserve any previously stored values without mutating them
    const originalStore = { safe: 42, text: "original" };
    expect(host.bitty.store.set("persisted.key", originalStore)).toBe(true);
    expect(host.bitty.store.get("persisted.key")).toEqual(originalStore);

    expect(
      denial(() =>
        host.bitty.store.set("persisted.key", {
          safe: 99,
          bad: [Number.NaN],
        } as never),
      ).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(
      denial(() =>
        host.bitty.store.set("persisted.key", {
          safe: 99,
          bad: () => {},
        } as never),
      ).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(host.bitty.store.get("persisted.key")).toEqual(originalStore);

    const originalSettings = { enabled: true, level: 1 };
    expect(host.bitty.settings.set("config.key", originalSettings)).toBe(true);
    expect(host.bitty.settings.get("config.key")).toEqual(originalSettings);

    expect(
      denial(() =>
        host.bitty.settings.set("config.key", {
          enabled: false,
          bad: 99n,
        } as never),
      ).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(
      denial(() =>
        host.bitty.settings.set("config.key", {
          enabled: false,
          bad: new Date(),
        } as never),
      ).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(host.bitty.settings.get("config.key")).toEqual(originalSettings);

    // Valid nested JSON data continues to round-trip correctly
    const validData = {
      title: "Bitty Plugin",
      version: 1,
      ratio: 3.14159,
      enabled: true,
      disabled: false,
      empty: null,
      tags: ["terminal", "editor", null, 42],
      matrix: [
        [1, 2],
        [3, 4],
      ],
      meta: {
        author: "dev",
        permissions: ["store.read", "store.write"],
        nested: {
          deep: {
            leaf: "ok",
          },
        },
      },
    };

    expect(host.bitty.store.set("valid.nested", validData)).toBe(true);
    expect(host.bitty.store.get("valid.nested")).toEqual(validData);

    expect(host.bitty.settings.set("valid.settings", validData)).toBe(true);
    expect(host.bitty.settings.get("valid.settings")).toEqual(validData);
  });

  test("cyclic references fail typed across store, settings, ui, and snapshot", () => {
    const host = makeHost();
    host.grant("ui.rich");
    host.grant("terminal.semantic-read");
    activate(host);

    const cyclicStore: Record<string, unknown> = {};
    cyclicStore.self = cyclicStore;
    expect(
      denial(() => host.bitty.store.set("cycle", cyclicStore as never)).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);

    const cyclicSettings: Record<string, unknown> = { list: [] };
    (cyclicSettings.list as unknown[]).push(cyclicSettings);
    expect(
      denial(() => host.bitty.settings.set("cycle", cyclicSettings as never))
        .code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);

    const cyclicMount: Record<string, unknown> = { kind: "Row", children: [] };
    (cyclicMount.children as unknown[]).push(cyclicMount);
    expect(denial(() => host.bitty.ui.mount("top", cyclicMount)).code).toBe(
      HOST_CODES.UI_COMPONENT_INVALID,
    );

    const cyclicText: Record<string, unknown> = { kind: "Text", text: "x" };
    cyclicText.self = cyclicText;
    expect(denial(() => host.bitty.ui.mount("top", cyclicText)).code).toBe(
      HOST_CODES.UI_COMPONENT_INVALID,
    );

    const block = host.bitty.ui.mount("top", { kind: "Row", children: [] });
    const cyclicUpdate: Record<string, unknown> = {
      kind: "Row",
      children: [],
    };
    (cyclicUpdate.children as unknown[]).push(cyclicUpdate);
    expect(denial(() => host.bitty.ui.update(block, cyclicUpdate)).code).toBe(
      HOST_CODES.UI_COMPONENT_INVALID,
    );

    const cyclicSnapshot: Record<string, unknown> = { rows: [] };
    (cyclicSnapshot.rows as unknown[]).push(cyclicSnapshot);
    expect(denial(() => host.setTerminalSnapshot(cyclicSnapshot)).code).toBe(
      HOST_CODES.DEF_INVALID,
    );
  });

  test("deep acyclic shared-reference graphs are bounded, not exponential", () => {
    const host = makeHost();
    host.grant("ui.rich");
    host.grant("terminal.semantic-read");
    activate(host);

    // A diamond DAG: 25 real objects but 2^25 expanded tree nodes. This is
    // the shape that previously triggered exponential path re-exploration.
    const buildDag = (): Record<string, unknown> => {
      let node: Record<string, unknown> = { value: 0 };
      for (let level = 0; level < 24; level += 1) {
        node = { left: node, right: node };
      }
      return node;
    };
    const buildComponentDag = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { kind: "Text", text: "leaf" };
      for (let level = 0; level < levels; level += 1) {
        node = { kind: "Row", children: [node, node] };
      }
      return node;
    };

    // Store and settings reject the over-deep graph through the bounded walk.
    expect(
      denial(() => host.bitty.store.set("dag", buildDag() as never)).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(
      denial(() => host.bitty.settings.set("dag", buildDag() as never)).code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);

    // UI rejects the over-deep graph with the existing typed component failure.
    expect(
      denial(() => host.bitty.ui.mount("top", buildComponentDag(24))).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
    const block = host.bitty.ui.mount("top", { kind: "Row", children: [] });
    expect(
      denial(() => host.bitty.ui.update(block, buildComponentDag(24))).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
    // A shallower DAG passes the depth guard and is stopped by the bounded
    // byte measurement instead of serializing the exponential expansion.
    expect(
      denial(() => host.bitty.ui.mount("top", buildComponentDag(14))).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);

    // The acyclic copy is accepted, but the exponentially expanded JSON size
    // is rejected by the existing snapshot bound instead of hanging.
    host.setTerminalSnapshot(buildDag());
    expect(
      denial(() => host.bitty.terminal.snapshot({ scope: "semantic" })).code,
    ).toBe(HOST_CODES.SNAPSHOT_TOO_LARGE);
  });

  test("small acyclic shared-reference values are accepted", () => {
    const host = makeHost();
    activate(host);
    // Depth 6 diamond: 127 expanded nodes, inside the store depth, node, and
    // byte bounds; sharing must not be mistaken for a cycle.
    let node: Record<string, unknown> = { value: 0 };
    for (let level = 0; level < 6; level += 1) {
      node = { left: node, right: node };
    }
    expect(host.bitty.store.set("dag", node as never)).toBe(true);
    expect(host.bitty.store.get("dag")).toEqual(node as never);
  });

  test("aliased component depth is independent of traversal order and placement", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);

    // A shared subtree that is legal at a shallow placement but would breach
    // the depth bound at a deep one: aliasing it must not let the shallow
    // validation excuse the deep placement.
    const maxDepth = MOCK_LIMITS.UI_MAX_DEPTH;
    const sharedHeight = 4;
    const deepDepth = maxDepth - 2;
    const wrap = (
      inner: Record<string, unknown>,
      levels: number,
    ): Record<string, unknown> => {
      let node = inner;
      for (let level = 0; level < levels; level += 1) {
        node = { kind: "Row", children: [node] };
      }
      return node;
    };
    const shared = wrap({ kind: "Text", text: "leaf" }, sharedHeight - 1);
    // Shared subtree at depth 1 (deepest node at 4) and at depth 14 (deepest
    // node at 17, past the bound) in the same logical tree.
    const shallow = wrap(shared, 1);
    const deepOnly = wrap(shared, deepDepth);
    const shallowFirst = { kind: "Row", children: [shared, deepOnly] };
    const deepFirst = { kind: "Row", children: [deepOnly, shared] };

    // The shared subtree alone at a shallow placement is accepted.
    expect(typeof host.bitty.ui.mount("top", shallow)).toBe("number");

    // The same subtree reached only through the deep placement is rejected.
    expect(denial(() => host.bitty.ui.mount("top", deepOnly)).code).toBe(
      HOST_CODES.UI_COMPONENT_INVALID,
    );

    // Placing it both shallow and deep in one tree must give the deep-only
    // verdict regardless of which reference is visited first.
    for (const tree of [shallowFirst, deepFirst]) {
      expect(denial(() => host.bitty.ui.mount("top", tree)).code).toBe(
        HOST_CODES.UI_COMPONENT_INVALID,
      );
    }

    const block = host.bitty.ui.mount("top", { kind: "Row", children: [] });
    expect(denial(() => host.bitty.ui.update(block, shallowFirst)).code).toBe(
      HOST_CODES.UI_COMPONENT_INVALID,
    );
  });

  test("cyclic notify payloads fail typed instead of throwing from serialization", () => {
    const host = makeHost();
    host.grant("platform.notify");
    activate(host);
    const payload: Record<string, unknown> = { title: "x" };
    payload.self = payload;
    expect(denial(() => host.bitty.notify.show(payload as never)).code).toBe(
      HOST_CODES.EVENT_PAYLOAD_TOO_LARGE,
    );
  });

  test("ui accepts v1 nodes and rejects excluded node kinds and slots", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    const block = host.bitty.ui.mount("top", {
      kind: "Row",
      children: [{ kind: "Text", text: "hi" }],
    });
    expect(block).toBeGreaterThan(0);
    expect(UI_V1_NODE_KINDS).toContain("List");
    expect(UI_V1_EXCLUDED_NODE_KINDS).toContain("Image");
    expect(UI_SLOTS).toContain("overlay");
    expect(
      denial(() =>
        host.bitty.ui.mount("statusline", { kind: "Image", src: "x" }),
      ).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
    expect(
      denial(() =>
        host.bitty.ui.mount("top", {
          kind: "Text",
          text: "x".repeat(MOCK_LIMITS.UI_MAX_TEXT_BYTES + 1),
        }),
      ).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
    // A component at exactly the text cap is accepted (the host's semantic
    // text budget runs before the generous marshalling byte cap).
    expect(
      typeof host.bitty.ui.mount("top", {
        kind: "Text",
        text: "x".repeat(MOCK_LIMITS.UI_MAX_TEXT_BYTES),
      }),
    ).toBe("number");
    expect(
      denial(() => host.bitty.ui.mount("nowhere", { kind: "Text", text: "x" }))
        .code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
  });

  test("overlay slot requires ui.overlay in addition to ui.rich", () => {
    const host = makeHost(MANIFEST.replace("ui.overlay = true\n", ""));
    host.grant("ui.rich");
    activate(host);
    expect(
      denial(() => host.bitty.ui.mount("overlay", { kind: "Text", text: "x" }))
        .code,
    ).toBe(HOST_CODES.CAPABILITY_DENIED);
    expect(
      host.bitty.ui.mount("top", { kind: "Text", text: "x" }),
    ).toBeGreaterThan(0);
  });

  test("overlay stays unavailable even with ui.overlay granted", () => {
    const host = makeHost();
    host.grant("ui.rich");
    host.grant("ui.overlay");
    activate(host);
    expect(
      denial(() => host.bitty.ui.mount("overlay", { kind: "Text", text: "x" })),
    ).toMatchObject({ code: HOST_CODES.UI_UNAVAILABLE, class: "runtime" });
  });

  test("terminal snapshot rejects raw scope and oversized snapshots", () => {
    const host = makeHost();
    host.grant("terminal.semantic-read");
    activate(host);
    const snapshot = {
      version: 1 as const,
      terminal_id: 7,
      runtime_id: 9,
      generation: 1,
      snapshot_generation: 2,
      width: 80,
      height: 1,
      rows: [{ text: "hello", spans: [] }],
      cursor: { row: 0, col: 5, visible: true },
      modes: { alternate_screen: false },
      title: "fixture",
    };
    host.setTerminalSnapshot(snapshot);
    expect(host.bitty.terminal.snapshot({ scope: "semantic" })).toEqual(
      snapshot,
    );
    expect(
      denial(() => host.bitty.terminal.snapshot({ scope: "raw" })).code,
    ).toBe(HOST_CODES.SNAPSHOT_SCOPE_UNSUPPORTED);
    host.setTerminalSnapshot({
      ...snapshot,
      title: "x".repeat(MOCK_LIMITS.SNAPSHOT_MAX_BYTES),
    });
    expect(
      denial(() => host.bitty.terminal.snapshot({ scope: "semantic" })).code,
    ).toBe(HOST_CODES.SNAPSHOT_TOO_LARGE);
  });

  test("wired services validate version requirements before resolving", () => {
    const manifest = `${MANIFEST}
[services.provided]
"conformance.greet" = "1.0.0"
`;
    const host = makeHost(manifest);
    activate(host);
    const handle = host.bitty.services.provide("conformance.greet", {
      hello: (args) => `hello ${(args as { name: string }).name}`,
    });
    expect(handle).toBeGreaterThan(0);
    host.endActivation();
    const get = host.bitty.services.get as unknown as (
      iface: string,
      opts?: unknown,
    ) => unknown;
    expect(get("conformance.greet", { version: ">=1.0.0" })).toBeDefined();
    for (const opts of [undefined, {}, { optional: true }]) {
      // The mock requires an explicit version requirement even for optional
      // resolution (stricter than the host, never more permissive).
      expect(denial(() => get("conformance.greet", opts)).code).toBe(
        HOST_CODES.SERVICE_VERSION_INVALID,
      );
    }
    expect(
      denial(() => get("conformance.greet", { version: ">=9.9.9" })).code,
    ).toBe(HOST_CODES.SERVICE_RESOLUTION);
    host.removeService("conformance.greet");
    expect(
      denial(() =>
        host.bitty.services.get("conformance.greet", { version: ">=1.0.0" }),
      ).code,
    ).toBe(HOST_CODES.SERVICE_RESOLUTION);
  });

  test.each([0, 10])(
    "queued timer cancellation preserves eligible timers at delay %s",
    (delay) => {
      const host = makeHost();
      host.beginActivation();
      const calls: string[] = [];
      const cancellations: boolean[] = [];
      const first = host.bitty.timers.create(delay, () => {
        calls.push("first");
        cancellations.push(host.bitty.timers.cancel(first));
        cancellations.push(host.bitty.timers.cancel(cancelled));
        cancellations.push(host.bitty.timers.cancel(cancelled));
      });
      const cancelled = host.bitty.timers.create(delay, () =>
        calls.push("cancelled"),
      );
      host.bitty.timers.create(delay + 1, () => calls.push("future"));
      host.bitty.timers.create(delay, () => calls.push("eligible"));
      host.endActivation();

      host.advanceTimers(delay);
      expect(cancellations).toEqual([false, true, false]);
      expect(calls).toEqual(["first", "eligible"]);
      host.advanceTimers(1);
      host.advanceTimers(0);
      expect(calls).toEqual(["first", "eligible", "future"]);
      expect(host.handlerViolations).toHaveLength(0);
    },
  );

  test("queued timers remain one-shot when a callback advances the clock", () => {
    const host = makeHost();
    host.beginActivation();
    const calls: string[] = [];
    host.bitty.timers.create(0, () => {
      calls.push("first");
      host.advanceTimers(0);
    });
    const second = host.bitty.timers.create(0, () => calls.push("second"));
    host.bitty.timers.create(0, () => calls.push("third"));
    host.endActivation();

    host.advanceTimers(0);
    expect(calls).toEqual(["first", "second", "third"]);
    expect(host.bitty.timers.cancel(second)).toBe(false);
    host.advanceTimers(0);
    expect(calls).toEqual(["first", "second", "third"]);
    expect(host.handlerViolations).toHaveLength(0);
  });

  test.each([false, true])(
    "queued timer disposal invalidates the remaining batch with reload=%s",
    (reload) => {
      const host = makeHost();
      host.beginActivation();
      const calls: string[] = [];
      host.bitty.timers.create(0, () => {
        calls.push("first");
        host.dispose();
        if (reload) {
          host.beginActivation();
          host.bitty.timers.create(0, () => calls.push("new"));
          host.endActivation();
        }
      });
      const stale = host.bitty.timers.create(0, () => calls.push("stale"));
      host.endActivation();
      const generation = host.currentGeneration;

      host.advanceTimers(0);
      expect(calls).toEqual(["first"]);
      expect(host.bitty.timers.cancel(stale)).toBe(false);
      expect(host.currentState).toBe(reload ? "active" : "disposed");
      if (reload) {
        expect(host.currentGeneration).toBe(generation + 1);
        host.advanceTimers(0);
        expect(calls).toEqual(["first", "new"]);
      } else {
        expect(denial(() => host.advanceTimers(0)).code).toBe(
          HOST_CODES.GENERATION_DISPOSED,
        );
      }
      expect(host.handlerViolations).toHaveLength(0);
    },
  );

  test("tasks and timers enforce caps and virtual time", () => {
    const host = makeHost();
    activate(host);
    let fires = 0;
    const task = host.bitty.tasks.spawn(() => {
      fires += 1;
    });
    const timer = host.bitty.timers.create(50, () => {
      fires += 1;
    });
    host.endActivation();
    host.drainTasks();
    expect(fires).toBe(1);
    host.advanceTimers(49);
    expect(fires).toBe(1);
    host.advanceTimers(1);
    expect(fires).toBe(2);
    expect(host.bitty.timers.cancel(timer)).toBe(false);
    expect(host.bitty.tasks.cancel(task)).toBe(false);
    host.dispose();
    activate(host);
    expect(() => {
      for (let i = 0; i < MOCK_LIMITS.TASKS_MAX + 2; i += 1) {
        host.bitty.tasks.spawn(() => null);
      }
    }).toThrow(HostError);
    expect(host.bitty.timers.create(1, () => null)).toBeGreaterThan(0);
  });

  test("settings stay inside the plugin namespace", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.settings.set("view.density", "compact")).toBe(true);
    expect(host.bitty.settings.get("view.density")).toBe("compact");
    expect(host.bitty.settings.set("theme.colors.accent", "#fff")).toBe(true);
    expect(host.bitty.settings.get("theme.colors.accent")).toBe("#fff");
    // A nested `plugins` component is an ordinary key inside the namespace.
    expect(host.bitty.settings.set("view.plugins.enabled", true)).toBe(true);
    expect(host.bitty.settings.get("view.plugins.enabled")).toBe(true);
    for (const escaped of ["plugins.xuepoo.other.secret", "plugins"]) {
      expect(denial(() => host.bitty.settings.get(escaped)).code).toBe(
        HOST_CODES.SETTINGS_KEY_INVALID,
      );
      expect(denial(() => host.bitty.settings.set(escaped, 1)).code).toBe(
        HOST_CODES.SETTINGS_KEY_INVALID,
      );
    }
    expect(denial(() => host.bitty.settings.get("..escape")).code).toBe(
      HOST_CODES.SETTINGS_KEY_INVALID,
    );
  });
});

describe("contract alignment", () => {
  test("terminal snapshot defaults an omitted scope to semantic", () => {
    const host = makeHost();
    host.grant("terminal.semantic-read");
    activate(host);
    const snapshot = {
      version: 1,
      terminal_id: 7,
      runtime_id: 9,
      generation: 1,
      snapshot_generation: 2,
      width: 80,
      height: 1,
      rows: [{ text: "hello", spans: [] }],
      cursor: { row: 0, col: 5, visible: true },
      modes: { alternate_screen: false },
      title: "fixture",
    };
    host.setTerminalSnapshot(snapshot);
    expect(host.bitty.terminal.snapshot()).toEqual(snapshot);
    expect(host.bitty.terminal.snapshot({})).toEqual(snapshot);
    expect(
      denial(() => host.bitty.terminal.snapshot({ scope: "raw" })).code,
    ).toBe(HOST_CODES.SNAPSHOT_SCOPE_UNSUPPORTED);
  });

  test("payload-less events reject unknown fields", () => {
    const host = makeHost();
    activate(host);
    host.endActivation();
    for (const kind of [
      "terminal.bell",
      "config.reloaded",
      "plugin.activated",
      "handler.violation",
    ]) {
      expect(host.publish(kind, {})).toEqual({ delivered: 0, vetoed: false });
      expect(denial(() => host.publish(kind, { extra: 1 })).code).toBe(
        HOST_CODES.EVENT_PAYLOAD_INVALID,
      );
    }
    // Declared-field payloads still tolerate optional extra identity fields.
    expect(
      host.publish("selection.changed", { view_id: 1, terminal_id: 2 }),
    ).toEqual({ delivered: 0, vetoed: false });
  });

  test("tasks and timers are creation-window-only and generation-owned", () => {
    const host = makeHost();
    activate(host);
    let ran = 0;
    const task = host.bitty.tasks.spawn(() => {
      ran += 1;
    });
    const timer = host.bitty.timers.create(10, () => {
      ran += 1;
    });
    host.endActivation();
    expect(denial(() => host.bitty.tasks.spawn(() => null)).code).toBe(
      HOST_CODES.REGISTRATION_CLOSED,
    );
    expect(denial(() => host.bitty.timers.create(10, () => null)).code).toBe(
      HOST_CODES.REGISTRATION_CLOSED,
    );
    host.drainTasks();
    expect(ran).toBe(1);
    host.dispose();
    activate(host);
    host.endActivation();
    host.drainTasks();
    host.advanceTimers(1000);
    expect(ran).toBe(1);
    expect(host.bitty.tasks.cancel(task)).toBe(false);
    expect(host.bitty.timers.cancel(timer)).toBe(false);
  });

  test("grants do not linger across generations", () => {
    const host = makeHost();
    host.grant("platform.notify");
    activate(host);
    host.endActivation();
    expect(host.bitty.notify.show({ title: "hi" })).toBe(true);
    host.dispose();
    expect(host.isGranted("platform.notify")).toBe(false);
    activate(host);
    host.endActivation();
    expect(denial(() => host.bitty.notify.show({ title: "hi" })).code).toBe(
      HOST_CODES.CAPABILITY_DENIED,
    );
  });

  test("exclusive-claim UI slots require a matching claim declaration", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    expect(
      denial(() => host.bitty.ui.mount("tabline", { kind: "Text", text: "x" }))
        .code,
    ).toBe(HOST_CODES.UI_CLAIM_REQUIRED);
    // statusline composes and needs no exclusive claim
    expect(
      host.bitty.ui.mount("statusline", { kind: "Text", text: "x" }),
    ).toBeGreaterThan(0);

    const withClaim = makeHost(
      MANIFEST.replace(
        '"intercept.open-url",\n]\n',
        '"intercept.open-url",\n]\nclaims = ["tabline"]\n',
      ),
    );
    withClaim.grant("ui.rich");
    withClaim.beginActivation();
    // The claim gate passes, but tabline has no host surface yet (CTX-0923).
    expect(
      denial(() =>
        withClaim.bitty.ui.mount("tabline", { kind: "Text", text: "x" }),
      ),
    ).toMatchObject({ code: HOST_CODES.UI_UNAVAILABLE, class: "runtime" });
  });

  test("key chords are trimmed, case-insensitive, and alias-aware", () => {
    const host = makeHost();
    activate(host);
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => "hello",
    });
    for (const chord of [
      "Ctrl+P",
      "CTRL+p",
      "Shift+Alt+H",
      "opt+Left",
      "pgup",
      "Ctrl+Shift+V",
      " Control + p ",
    ]) {
      expect(
        host.bitty.keymaps.suggest({
          chord,
          command: "conformance.basic:hello",
        }),
      ).toBeGreaterThan(0);
    }
    expect(
      denial(() =>
        host.bitty.keymaps.suggest({
          chord: "p",
          command: "conformance.basic:hello",
        }),
      ).code,
    ).toBe(HOST_CODES.KEYMAP_CHORD_INVALID);
    expect(
      denial(() =>
        host.bitty.keymaps.suggest({
          chord: "ctrl+ctrl+p",
          command: "conformance.basic:hello",
        }),
      ).code,
    ).toBe(HOST_CODES.KEYMAP_CHORD_INVALID);
  });
});

describe("isolation across settings and call boundaries", () => {
  test("mutating an object returned by settings.get does not mutate internal settings or future reads", () => {
    const host = makeHost();
    activate(host);
    const initial = {
      theme: "dark",
      layout: { compact: true },
      tags: ["nav", "status"],
    };
    expect(host.bitty.settings.set("view.preferences", initial)).toBe(true);

    // Caller mutation of the original object passed to set does not affect internal settings
    initial.theme = "light";
    initial.layout.compact = false;
    initial.tags.push("extra");

    const read1 = host.bitty.settings.get("view.preferences") as typeof initial;
    expect(read1).toEqual({
      theme: "dark",
      layout: { compact: true },
      tags: ["nav", "status"],
    });

    // Caller mutation of the object returned by get does not affect host internal settings
    read1.theme = "high-contrast";
    read1.layout.compact = false;
    read1.tags.push("sidebar");

    const read2 = host.bitty.settings.get("view.preferences");
    expect(read2).toEqual({
      theme: "dark",
      layout: { compact: true },
      tags: ["nav", "status"],
    });

    // Prior state remains unchanged after validation failures
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(
      denial(() => host.bitty.settings.set("view.preferences", cyclic as never))
        .code,
    ).toBe(HOST_CODES.STORE_VALUE_INVALID);
    expect(host.bitty.settings.get("view.preferences")).toEqual({
      theme: "dark",
      layout: { compact: true },
      tags: ["nav", "status"],
    });
  });

  test("command dispatch isolates arguments from caller mutation and return values from provider mutation", () => {
    const host = makeHost();
    activate(host);
    let retainedArgs: Record<string, unknown> | undefined;
    const providerState = {
      status: "ready",
      metrics: { count: 42 },
      entries: ["first", "second"],
    };

    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      run: (args) => {
        retainedArgs = args as Record<string, unknown>;
        if (args && typeof args === "object") {
          (args as Record<string, unknown>).modifiedByRun = true;
          const nested = (args as Record<string, unknown>).nested;
          if (nested && typeof nested === "object") {
            (nested as Record<string, unknown>).flag = false;
          }
        }
        return providerState;
      },
    });

    host.endActivation();

    const callerArgs = {
      modifiedByRun: false,
      nested: { flag: true },
      options: ["a", "b"],
    };

    const result = host.dispatchCommand(
      "conformance.basic:echo",
      callerArgs,
    ) as typeof providerState;

    // Mutating args inside run did not mutate caller's arguments object
    expect(callerArgs.modifiedByRun).toBe(false);
    expect(callerArgs.nested.flag).toBe(true);
    expect(callerArgs.options).toEqual(["a", "b"]);

    // Mutating callerArgs after dispatch does not mutate what the command retained
    callerArgs.nested.flag = true;
    (callerArgs as Record<string, unknown>).extra = "leaked";
    expect(retainedArgs?.extra).toBeUndefined();

    // Mutating command return value does not mutate provider's state
    result.status = "corrupted";
    result.metrics.count = 999;
    result.entries.push("third");

    expect(providerState.status).toBe("ready");
    expect(providerState.metrics.count).toBe(42);
    expect(providerState.entries).toEqual(["first", "second"]);

    // Provider mutating its own state after returning does not mutate caller's result
    providerState.metrics.count = 100;
    expect(result.metrics.count).toBe(999);
  });

  test("invalid provision shape runs no provider code", () => {
    const source = `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`;
    const host = makeHost(source);
    activate(host);
    let calls = 0;
    expect(
      denial(() =>
        host.bitty.services.provide("conformance.greet", {
          greet: () => ++calls,
          broken: 42,
        } as never),
      ).code,
    ).toBe(HOST_CODES.DEF_INVALID);
    expect(calls).toBe(0);
    host.endActivation();
  });

  test("schema validation failure leaves prior state unchanged across commands and services", () => {
    const host = makeHost();
    activate(host);
    let runCalls = 0;
    const providerState = { ok: true, nested: { counter: 5 } };
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      args_schema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      result_schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          nested: {
            type: "object",
            properties: { counter: { type: "integer" } },
            required: ["counter"],
            additionalProperties: false,
          },
        },
        required: ["ok", "nested"],
        additionalProperties: false,
      },
      run: () => {
        runCalls += 1;
        return providerState;
      },
    });
    host.endActivation();

    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", { count: "invalid" }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(runCalls).toBe(0);
    expect(providerState.nested.counter).toBe(5);

    const res = host.dispatchCommand("conformance.basic:echo", {
      count: 1,
    }) as typeof providerState;
    expect(runCalls).toBe(1);
    res.nested.counter = 999;
    expect(providerState.nested.counter).toBe(5);
  });
});

describe("manifest integration", () => {
  test("the mock host refuses an invalid manifest", () => {
    expect(
      () =>
        new MockHost({
          manifestSource: MANIFEST.replace(
            'id = "conformance.basic"',
            'id = "Bad"',
          ),
        }),
    ).toThrow();
  });
});

describe("Plugin API version compatibility", () => {
  function manifestWithPluginApi(range?: string): string {
    if (range === undefined) {
      return MANIFEST.replace('plugin-api = "^1.0"\n', "");
    }
    return MANIFEST.replace('plugin-api = "^1.0"', `plugin-api = "${range}"`);
  }

  test("mock host exports default MOCK_PLUGIN_API_VERSION as 1.0.0", () => {
    expect(MOCK_PLUGIN_API_VERSION).toBe("1.0.0");
  });

  test("compatible plugin_api ranges begin activation successfully", () => {
    const compatibleRanges = ["^1.0.0", "~1.0", ">=1.0.0"];
    for (const range of compatibleRanges) {
      const host = new MockHost({
        manifestSource: manifestWithPluginApi(range),
      });
      expect(host.manifest.pluginApiRange).toBe(range);
      expect(host.pluginApiVersion).toBe(MOCK_PLUGIN_API_VERSION);
      expect(host.currentState).toBe("created");
      expect(host.currentGeneration).toBe(0);

      host.beginActivation();

      expect(host.currentState).toBe("activating");
      expect(host.currentGeneration).toBe(1);
      host.endActivation();
      expect(host.currentState).toBe("active");
    }
  });

  test("incompatible plugin_api ranges fail beginActivation and do not advance generation or state", () => {
    const incompatibleRanges = ["^2.0.0", "<1.0.0"];
    for (const range of incompatibleRanges) {
      const host = new MockHost({
        manifestSource: manifestWithPluginApi(range),
      });
      expect(host.manifest.pluginApiRange).toBe(range);
      expect(host.currentState).toBe("created");
      expect(host.currentGeneration).toBe(0);

      const err = denial(() => host.beginActivation());
      expect(err.code).toBe(HOST_CODES.LIFECYCLE_STATE);
      expect(err.class).toBe("validation");
      expect(err.message).toBe(
        `plugin requires Plugin API '${range}', but mock host provides 1.0.0`,
      );

      // Does not advance generation or state
      expect(host.currentState).toBe("created");
      expect(host.currentGeneration).toBe(0);
    }
  });

  test("manifest without plugin_api range succeeds as default unconstrained", () => {
    const host = new MockHost({
      manifestSource: manifestWithPluginApi(undefined),
    });
    expect(host.manifest.pluginApiRange).toBeUndefined();
    expect(host.currentState).toBe("created");
    expect(host.currentGeneration).toBe(0);

    host.beginActivation();

    expect(host.currentState).toBe("activating");
    expect(host.currentGeneration).toBe(1);
    host.endActivation();
    expect(host.currentState).toBe("active");
  });

  test("custom pluginApiVersion in MockHostOptions validates against custom host bridge version", () => {
    const v2Manifest = manifestWithPluginApi("^2.0.0");

    // Default host fails against ^2.0.0
    const defaultHost = new MockHost({ manifestSource: v2Manifest });
    expect(defaultHost.pluginApiVersion).toBe("1.0.0");
    expect(defaultHost.bitty.api_version).toBe("1.0.0");
    const defaultErr = denial(() => defaultHost.beginActivation());
    expect(defaultErr.code).toBe(HOST_CODES.LIFECYCLE_STATE);
    expect(defaultHost.currentState).toBe("created");
    expect(defaultHost.currentGeneration).toBe(0);

    // Custom host with pluginApiVersion 2.0.0 succeeds against ^2.0.0
    const customHost = new MockHost({
      manifestSource: v2Manifest,
      pluginApiVersion: "2.0.0",
    });
    expect(customHost.pluginApiVersion).toBe("2.0.0");
    expect(customHost.bitty.api_version).toBe("2.0.0");
    customHost.beginActivation();
    expect(customHost.currentState).toBe("activating");
    expect(customHost.currentGeneration).toBe(1);

    // Custom host with pluginApiVersion 2.0.0 rejects ^1.0.0
    const v1Manifest = manifestWithPluginApi("^1.0.0");
    const incompatibleCustomHost = new MockHost({
      manifestSource: v1Manifest,
      pluginApiVersion: "2.0.0",
    });
    const customErr = denial(() => incompatibleCustomHost.beginActivation());
    expect(customErr.code).toBe(HOST_CODES.LIFECYCLE_STATE);
    expect(customErr.message).toBe(
      "plugin requires Plugin API '^1.0.0', but mock host provides 2.0.0",
    );
    expect(incompatibleCustomHost.currentState).toBe("created");
    expect(incompatibleCustomHost.currentGeneration).toBe(0);
  });
});

describe("tools.git activation (Layer-2 CTX-0425)", () => {
  const TOOLS_MANIFEST = `${MANIFEST}\n[tools.git]\nrequired = true\nversion = ">=2.30"\n`;
  const OPTIONAL_MANIFEST = `${MANIFEST}\n[tools.git]\nrequired = false\nversion = ">=2.30"\n`;

  test("tool codes are mock-owned until an accepted contract fixes them verbatim", () => {
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.TOOL_ABSENT)).toBe(false);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.TOOL_MISMATCH)).toBe(false);
    expect(MOCK_HOST_CODES.has(HOST_CODES.TOOL_ABSENT)).toBe(true);
    expect(MOCK_HOST_CODES.has(HOST_CODES.TOOL_MISMATCH)).toBe(true);
  });

  test("manifest model exposes the accepted [tools.git] declaration", async () => {
    const { loadManifestModel } = await import("../src/manifest-model.js");
    const model = loadManifestModel(TOOLS_MANIFEST);
    expect(model.toolsGit).toEqual({ required: true, version: ">=2.30" });
    const plain = loadManifestModel(MANIFEST);
    expect(plain.toolsGit).toBeUndefined();
  });

  test("present git satisfying the range proceeds through activation", () => {
    const host = new MockHost({
      manifestSource: TOOLS_MANIFEST,
      toolsGitVersion: "2.44.0",
    });
    expect(host.manifest.toolsGit).toEqual({
      required: true,
      version: ">=2.30",
    });
    host.beginActivation();
    expect(host.currentState).toBe("activating");
    host.endActivation();
    expect(host.currentState).toBe("active");
  });

  test("absent git fails closed with E_TOOL_ABSENT and never opens the window", () => {
    for (const toolsGitVersion of [undefined, null] as const) {
      const host = new MockHost({
        manifestSource: TOOLS_MANIFEST,
        ...(toolsGitVersion === undefined ? {} : { toolsGitVersion }),
      });
      const diagnostic = denial(() => host.beginActivation());
      expect(diagnostic.code).toBe(HOST_CODES.TOOL_ABSENT);
      expect(diagnostic.class).toBe("resolution");
      expect(diagnostic.path).toBe("tools.git");
      expect(host.currentState).toBe("created");
      expect(host.currentGeneration).toBe(0);
    }
  });

  test("mismatched or malformed git fails closed with E_TOOL_MISMATCH", () => {
    for (const toolsGitVersion of ["2.20.0", "not-a-version"]) {
      const host = new MockHost({
        manifestSource: TOOLS_MANIFEST,
        toolsGitVersion,
      });
      const diagnostic = denial(() => host.beginActivation());
      expect(diagnostic.code).toBe(HOST_CODES.TOOL_MISMATCH);
      expect(diagnostic.class).toBe("validation");
      expect(diagnostic.path).toBe("tools.git.version");
      expect(host.currentState).toBe("created");
      expect(host.currentGeneration).toBe(0);
    }
  });

  test("optional required=false never gates activation", () => {
    for (const toolsGitVersion of [undefined, null, "2.20.0"] as const) {
      const host = new MockHost({
        manifestSource: OPTIONAL_MANIFEST,
        ...(toolsGitVersion === undefined ? {} : { toolsGitVersion }),
      });
      expect(host.manifest.toolsGit).toEqual({
        required: false,
        version: ">=2.30",
      });
      host.beginActivation();
      expect(host.currentState).toBe("activating");
      host.endActivation();
      expect(host.currentState).toBe("active");
    }
  });

  test("manifests without [tools.git] ignore the injected tool version", () => {
    const host = new MockHost({ manifestSource: MANIFEST });
    host.beginActivation();
    expect(host.currentState).toBe("activating");
  });
});

describe("mock boundary hardening (SDK-006..SDK-012)", () => {
  test("schema-less dispatch normalizes bridge values (SDK-006)", () => {
    const host = makeHost();
    host.beginActivation();
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      run: (args) => args,
    });
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => undefined,
    });
    host.endActivation();

    // Cyclic args are rejected even with no args_schema.
    const cyclicArgs: Record<string, unknown> = {};
    cyclicArgs["self"] = cyclicArgs;
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", cyclicArgs))
        .code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // Non-plain prototypes are rejected.
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", { d: new Date() }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", { m: new Map() }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // Non-data scalar args are rejected.
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", { fn: () => null }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", { big: 10n }))
        .code,
    ).toBe(HOST_CODES.ARGS_INVALID);
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", {
          n: Number.POSITIVE_INFINITY,
        }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // Over-deep args are rejected independently of a schema.
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < MOCK_LIMITS.BRIDGE_MAX_DEPTH + 1; i += 1) {
      const next: Record<string, unknown> = {};
      cursor["child"] = next;
      cursor = next;
    }
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", deep)).code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // Over-byte args are rejected independently of a schema.
    expect(
      denial(() =>
        host.dispatchCommand("conformance.basic:echo", {
          blob: "x".repeat(MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES + 1),
        }),
      ).code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // Over-node args are rejected independently of a schema.
    const wide = {
      items: Array.from({ length: MOCK_LIMITS.BRIDGE_MAX_NODES + 1 }, () => 0),
    };
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", wide)).code,
    ).toBe(HOST_CODES.ARGS_INVALID);

    // A Lua `nil` return marshals to `undefined` and is a valid empty result.
    expect(host.dispatchCommand("conformance.basic:hello", {})).toBeUndefined();
  });

  test("a huge string arg is byte-bounded during the scan, not serialized (SDK-006)", () => {
    const host = makeHost();
    host.beginActivation();
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      run: (args) => args,
    });
    host.endActivation();
    // A single 32 MiB string leaf passes the node/depth caps; the byte counter
    // rejects it with the typed bridge bound before `JSON.stringify` runs.
    const diagnostic = denial(() =>
      host.dispatchCommand("conformance.basic:echo", {
        blob: "x".repeat(32 * 1024 * 1024),
      }),
    );
    expect(diagnostic.code).toBe(HOST_CODES.ARGS_INVALID);
    expect(diagnostic.message).toBe(
      `args: value exceeds ${MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES} bytes`,
    );
  });

  test("schema-less command results cross the same bounded bridge (SDK-006)", () => {
    const host = makeHost();
    host.beginActivation();
    let result: unknown = { ok: true };
    host.bitty.commands.register({
      id: "echo",
      title: "Echo",
      run: () => result,
    });
    host.endActivation();
    expect(host.dispatchCommand("conformance.basic:echo", {})).toEqual({
      ok: true,
    });

    result = { d: new Date() };
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", {})).code,
    ).toBe(HOST_CODES.RESULT_INVALID);

    const cyclicResult: Record<string, unknown> = {};
    cyclicResult["self"] = cyclicResult;
    result = cyclicResult;
    expect(
      denial(() => host.dispatchCommand("conformance.basic:echo", {})).code,
    ).toBe(HOST_CODES.RESULT_INVALID);
  });

  test("reentrant disposal is idempotent and never double-delivers (SDK-007)", () => {
    const host = makeHost();
    activate(host);
    const received: string[] = [];
    let reentered = false;
    host.bitty.events.subscribe("plugin.disposed", () => {
      received.push("disposed");
      if (!reentered) {
        reentered = true;
        host.dispose();
      }
    });
    host.endActivation();
    host.dispose();
    expect(received).toEqual(["disposed"]);
    expect(host.currentState).toBe("disposed");
    expect(host.handlerViolations).toHaveLength(0);

    // The event is still observed before generation invalidation: the
    // handler can read the store during disposal.
    const reloaded = makeHost();
    activate(reloaded);
    reloaded.bitty.store.set("seen", 1);
    const observed: unknown[] = [];
    reloaded.bitty.events.subscribe("plugin.disposed", () => {
      observed.push(reloaded.bitty.store.get("seen"));
      reloaded.dispose();
    });
    reloaded.endActivation();
    reloaded.dispose();
    expect(observed).toEqual([1]);
  });

  test("task draining stops at a generation boundary (SDK-008)", () => {
    const host = makeHost();
    activate(host);
    const calls: string[] = [];
    host.bitty.tasks.spawn(() => {
      calls.push("old-first");
      host.suspend();
      host.dispose();
      host.beginActivation();
      host.bitty.tasks.spawn(() => calls.push("new-generation"));
      host.endActivation();
    });
    host.bitty.tasks.spawn(() => calls.push("old-second"));
    host.endActivation();
    host.drainTasks();
    // The old-generation drain must not run the newly queued task.
    expect(calls).toEqual(["old-first"]);
    // The new generation's own drain runs it once.
    host.drainTasks();
    expect(calls).toEqual(["old-first", "new-generation"]);
  });

  test("command callback faults enter the error boundary and record a violation (SDK-009)", () => {
    const host = makeHost();
    activate(host);
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => {
        throw new Error("command exploded");
      },
    });
    const received: string[] = [];
    host.bitty.events.subscribe("handler.violation", (event) => {
      received.push(event.kind);
    });
    host.endActivation();
    const diagnostic = denial(() =>
      host.dispatchCommand("conformance.basic:hello", {}),
    );
    expect(diagnostic.class).toBe("runtime");
    expect(diagnostic.code).toBe(HOST_CODES.COMMAND_CALLBACK_FAILED);
    expect(diagnostic.message).toContain("command exploded");
    expect(host.handlerViolations).toHaveLength(1);
    expect(host.handlerViolations[0]?.code).toBe(HOST_CODES.HANDLER_VIOLATION);
    // The violation is delivered through the shared `recordViolation` path.
    expect(received).toEqual(["handler.violation"]);
  });

  test("identity event fields are nonnegative safe integers while exit_code stays signed (SDK-010)", () => {
    const host = makeHost();
    activate(host);
    host.endActivation();

    // Accepted signed status: a negative exit_code is valid.
    expect(
      host.publish("process.exited", {
        terminal_id: 1,
        runtime_id: 2,
        exit_code: -9,
      }),
    ).toEqual({ delivered: 0, vetoed: false });
    expect(
      host.publish("process.exited", {
        terminal_id: 1,
        runtime_id: 2,
        exit_code: 0,
      }),
    ).toEqual({ delivered: 0, vetoed: false });
    // The accepted status is `i32` (`bitty-runtime` `registry.rs`): both
    // bounds are accepted...
    for (const exitCode of [
      MOCK_LIMITS.EXIT_CODE_MIN,
      MOCK_LIMITS.EXIT_CODE_MAX,
    ]) {
      expect(
        host.publish("process.exited", {
          terminal_id: 1,
          runtime_id: 2,
          exit_code: exitCode,
        }),
      ).toEqual({ delivered: 0, vetoed: false });
    }
    // ...values outside the signed 32-bit range are rejected.
    for (const exitCode of [
      MOCK_LIMITS.EXIT_CODE_MIN - 1,
      MOCK_LIMITS.EXIT_CODE_MAX + 1,
      1.5,
    ]) {
      expect(
        denial(() =>
          host.publish("process.exited", {
            terminal_id: 1,
            runtime_id: 2,
            exit_code: exitCode,
          }),
        ).code,
      ).toBe(HOST_CODES.EVENT_PAYLOAD_INVALID);
    }

    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        denial(() =>
          host.publish("terminal.opened", {
            terminal_id: bad,
            runtime_id: 1,
            generation: 1,
          }),
        ).code,
      ).toBe(HOST_CODES.EVENT_PAYLOAD_INVALID);
      expect(
        denial(() =>
          host.publish("terminal.opened", {
            terminal_id: 1,
            runtime_id: bad,
            generation: 1,
          }),
        ).code,
      ).toBe(HOST_CODES.EVENT_PAYLOAD_INVALID);
    }
    // Zero and the max safe integer are accepted identities.
    expect(
      host.publish("terminal.opened", {
        terminal_id: 0,
        runtime_id: Number.MAX_SAFE_INTEGER,
        generation: 1,
      }),
    ).toEqual({ delivered: 0, vetoed: false });

    host.grant("terminal.semantic-read");
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        denial(() => host.bitty.terminal.snapshot({ terminal_id: bad })).code,
      ).toBe(HOST_CODES.DEF_INVALID);
    }
    expect(host.bitty.terminal.snapshot({ terminal_id: 0 })).toBeInstanceOf(
      Object,
    );
  });

  test("UI node budget rejects 2049 nodes and accepts 2048 (SDK-011)", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    const children = (count: number): Record<string, unknown>[] =>
      Array.from({ length: count }, () => ({ kind: "Text", text: "" }));
    // 2048 nodes total: the Row wrapper plus 2047 leaves.
    expect(
      typeof host.bitty.ui.mount("top", {
        kind: "Row",
        children: children(MOCK_LIMITS.UI_MAX_NODES - 1),
      }),
    ).toBe("number");
    // 2049 nodes: Row plus 2048 leaves.
    expect(
      denial(() =>
        host.bitty.ui.mount("top", {
          kind: "Row",
          children: children(MOCK_LIMITS.UI_MAX_NODES),
        }),
      ).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
  });

  test("a single 65-child / ~2000-node scene is one block, not 64 (SDK-011)", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    // A 65-child Row plus nested Text leaves totals under UI_MAX_NODES and is
    // a single mounted block: the draft wrongly counted one block per node.
    const children: Record<string, unknown>[] = [];
    for (let i = 0; i < 65; i += 1) {
      const grandchildren = Array.from({ length: 30 }, () => ({
        kind: "Text",
        text: "x",
      }));
      children.push({ kind: "Column", children: grandchildren });
    }
    const scene = { kind: "Row", children };
    const nodes = 1 + 65 * (1 + 30);
    expect(nodes).toBeGreaterThan(2000);
    expect(nodes).toBeLessThanOrEqual(MOCK_LIMITS.UI_MAX_NODES);
    // The whole scene is one mounted block and is accepted.
    expect(typeof host.bitty.ui.mount("top", scene as never)).toBe("number");
  });

  test("UI block budget is per generation: 64 accepted, 65 rejected (SDK-011)", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    for (let i = 0; i < MOCK_LIMITS.UI_MAX_BLOCKS; i += 1) {
      expect(
        typeof host.bitty.ui.mount("top", { kind: "Text", text: "x" }),
      ).toBe("number");
    }
    const diagnostic = denial(() =>
      host.bitty.ui.mount("top", { kind: "Text", text: "x" }),
    );
    expect(diagnostic.class).toBe("budget");
    expect(diagnostic.code).toBe(HOST_CODES.UI_BLOCK_BUDGET);

    // A fresh generation resets the per-generation block budget (consent is
    // per generation, so re-authorize after reloading).
    host.endActivation();
    host.dispose();
    activate(host);
    host.grant("ui.rich");
    expect(typeof host.bitty.ui.mount("top", { kind: "Text", text: "x" })).toBe(
      "number",
    );
  });

  test("UI aggregate text budget accounts updates as a delta (SDK-011)", () => {
    const host = makeHost();
    host.grant("ui.rich");
    activate(host);
    const chunk = 200 * 1024;
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      last = host.bitty.ui.mount("top", {
        kind: "Text",
        text: "x".repeat(chunk),
      });
    }
    // 2,000 KiB retained; another 200 KiB mount would cross the 2 MiB cap.
    expect(
      denial(() =>
        host.bitty.ui.mount("top", { kind: "Text", text: "x".repeat(chunk) }),
      ).code,
    ).toBe(HOST_CODES.UI_BLOCK_BUDGET);

    // Shrinking the block releases aggregate budget.
    expect(host.bitty.ui.update(last, { kind: "Text", text: "x" })).toBe(true);
    const remaining = MOCK_LIMITS.UI_MAX_AGGREGATED_TEXT_BYTES - 9 * chunk;
    // Growing it one byte past the released budget is rejected...
    expect(
      denial(() =>
        host.bitty.ui.update(last, {
          kind: "Text",
          text: "x".repeat(remaining + 1),
        }),
      ).code,
    ).toBe(HOST_CODES.UI_BLOCK_BUDGET);
    // ...and the last good block is retained: the exactly-at-cap value works.
    expect(
      host.bitty.ui.update(last, {
        kind: "Text",
        text: "x".repeat(remaining),
      }),
    ).toBe(true);
  });

  test("command metadata byte/type bounds (SDK-012)", () => {
    const accepting = makeHost();
    activate(accepting);
    // Exactly 128-byte title and 1024-byte description are accepted.
    expect(
      typeof accepting.bitty.commands.register({
        id: "hello",
        title: "x".repeat(MOCK_LIMITS.COMMAND_TITLE_MAX_BYTES),
        description: "d".repeat(MOCK_LIMITS.COMMAND_DESCRIPTION_MAX_BYTES),
        run: () => null,
      }),
    ).toBe("number");
    // Multibyte content is measured in UTF-8 bytes, not code units.
    expect(
      typeof accepting.bitty.commands.register({
        id: "echo",
        title: "\u00e9".repeat(64),
        run: () => null,
      }),
    ).toBe("number");
    accepting.endActivation();

    const rejecting = makeHost();
    activate(rejecting);
    expect(
      denial(() =>
        rejecting.bitty.commands.register({
          id: "hello",
          title: "x".repeat(MOCK_LIMITS.COMMAND_TITLE_MAX_BYTES + 1),
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.DEF_INVALID);
    expect(
      denial(() =>
        rejecting.bitty.commands.register({
          id: "echo",
          title: "t",
          description: "d".repeat(
            MOCK_LIMITS.COMMAND_DESCRIPTION_MAX_BYTES + 1,
          ),
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.DEF_INVALID);
    expect(
      denial(() =>
        rejecting.bitty.commands.register({
          id: "echo",
          title: "t",
          description: 5 as never,
          run: () => null,
        }),
      ).code,
    ).toBe(HOST_CODES.DEF_INVALID);
    rejecting.endActivation();
  });
});

const WORKSPACE_MANIFEST = `
[plugin]
id = "conformance.workspace"
name = "Conformance Workspace"
version = "1.0.0"
description = "Workspace domain fixture (bitty CTX-0889)."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
workspace.read = true
workspace.control = true

[lazy]
events = [
  "workspace.created",
  "workspace.closed",
  "workspace.renamed",
  "workspace.focused",
  "workspace.changed",
]
`;

const DEBUG_MANIFEST = `
[plugin]
id = "conformance.debug"
name = "Conformance Debug"
version = "2.1.0"
description = "Debug namespace fixture (bitty CTX-0897)."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
debug.inspect = true
debug.trace = true
debug.control = true
clipboard.read = true

[lazy]
commands = ["conformance.debug:hello"]
events = ["terminal.bell", "terminal.title-changed", "intercept.paste"]
`;

const WORKSPACE_ROWS = [
  {
    id: 1,
    name: "main",
    active: true,
    panel_count: 2,
    attention: { bell: false, activity: false, exited: false },
  },
  {
    id: 4,
    name: "scratch",
    active: false,
    panel_count: 1,
    attention: { bell: false, activity: false, exited: false },
  },
];

function workspaceHost(grants: readonly string[]): MockHost {
  const host = new MockHost({ manifestSource: WORKSPACE_MANIFEST });
  for (const capability of grants) host.grant(capability);
  return host;
}

describe("workspace domain", () => {
  test("declaring workspace.* events without workspace.read fails activation", () => {
    const host = workspaceHost(["workspace.control"]);
    expect(denial(() => host.beginActivation())).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
  });

  test("list is gated on workspace.read and returns bounded rows", () => {
    const host = new MockHost({
      manifestSource: WORKSPACE_MANIFEST.replace(/events = \[[^\]]*\]/, ""),
    });
    host.beginActivation();
    expect(denial(() => host.bitty.workspace.list())).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    host.grant("workspace.read");
    host.setWorkspaces([
      ...WORKSPACE_ROWS,
      ...Array.from({ length: 20 }, (_, index) => ({
        id: 10 + index,
        name: "x".repeat(40),
        active: false,
        panel_count: 0,
        attention: { bell: false, activity: false, exited: false },
      })),
    ]);
    const rows = host.bitty.workspace.list();
    expect(rows).toHaveLength(MOCK_LIMITS.WORKSPACE_LIST_MAX_ITEMS);
    expect(rows[0]).toEqual(WORKSPACE_ROWS[0]);
    expect([...(rows[2]?.name ?? "")]).toHaveLength(
      MOCK_LIMITS.WORKSPACE_NAME_MAX_CHARS,
    );
  });

  test("read never implies control and control never implies read", () => {
    const readOnly = workspaceHost(["workspace.read"]);
    readOnly.beginActivation();
    expect(denial(() => readOnly.bitty.workspace.new())).toMatchObject({
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    const controlOnly = new MockHost({
      manifestSource: WORKSPACE_MANIFEST.replace(/events = \[[^\]]*\]/, ""),
    });
    controlOnly.grant("workspace.control");
    controlOnly.beginActivation();
    expect(controlOnly.bitty.workspace.next()).toBe(true);
    expect(denial(() => controlOnly.bitty.workspace.list())).toMatchObject({
      code: HOST_CODES.CAPABILITY_DENIED,
    });
  });

  test("mutations validate arguments before the grant and only enqueue", () => {
    const host = workspaceHost(["workspace.read"]);
    host.beginActivation();
    // Bridge validation runs before the capability check.
    expect(denial(() => host.bitty.workspace.focus(0))).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    host.grant("workspace.control");
    expect(host.bitty.workspace.focus(4)).toBe(true);
    expect(host.bitty.workspace.focus({ index: 2 })).toBe(true);
    expect(host.bitty.workspace.new()).toBe(true);
    expect(host.bitty.workspace.next()).toBe(true);
    expect(host.bitty.workspace.close()).toBe(true);
    expect(host.bitty.workspace.close(4)).toBe(true);
    expect(host.bitty.workspace.rename(4, "logs")).toBe(true);
    expect(host.bitty.workspace.move_panel(1)).toBe(true);
    expect(host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 4 },
      { kind: "focus_index", index: 2 },
      { kind: "new" },
      { kind: "next" },
      { kind: "close", id: null },
      { kind: "close", id: 4 },
      { kind: "rename", id: 4, name: "logs" },
      { kind: "move_panel", id: 1 },
    ]);
    expect(host.drainWorkspaceRequests()).toEqual([]);
    for (const run of [
      () => host.bitty.workspace.focus({ index: 0 }),
      () => host.bitty.workspace.focus(1.5),
      () => host.bitty.workspace.close(-1),
      () => host.bitty.workspace.rename(1, "   "),
      () => host.bitty.workspace.rename(1, "bad\nname"),
      () => host.bitty.workspace.move_panel("1" as unknown as number),
    ]) {
      expect(denial(run)).toMatchObject({
        class: "validation",
        code: HOST_CODES.DEF_INVALID,
      });
    }
    expect(
      denial(() =>
        host.bitty.workspace.rename(
          1,
          "n".repeat(MOCK_LIMITS.WORKSPACE_RENAME_MAX_BYTES + 1),
        ),
      ),
    ).toMatchObject({ class: "validation", code: HOST_CODES.DEF_LIMIT });
  });

  test("the bounded request queue drops overflow and returns false", () => {
    const host = workspaceHost(["workspace.read", "workspace.control"]);
    host.beginActivation();
    for (let i = 0; i < MOCK_LIMITS.WORKSPACE_REQUEST_QUEUE_CAPACITY; i += 1) {
      expect(host.bitty.workspace.next()).toBe(true);
    }
    expect(host.bitty.workspace.next()).toBe(false);
    expect(host.workspaceRequestsDropped).toBe(1);
    expect(host.drainWorkspaceRequests()).toHaveLength(
      MOCK_LIMITS.WORKSPACE_REQUEST_QUEUE_CAPACITY,
    );
  });

  test("workspace events carry identity payloads and reach only workspace.read holders", () => {
    const host = workspaceHost(["workspace.read"]);
    host.beginActivation();
    const seen: unknown[] = [];
    host.bitty.events.subscribe("workspace.created", (event) => {
      seen.push(event.payload);
    });
    host.bitty.events.subscribe("workspace.focused", (event) => {
      seen.push(event.payload);
    });
    host.endActivation();
    expect(
      host.publish("workspace.created", { id: 7, name: "new" }),
    ).toMatchObject({ delivered: 1 });
    expect(host.publish("workspace.focused", { id: 7 })).toMatchObject({
      delivered: 1,
    });
    expect(seen).toEqual([{ id: 7, name: "new" }, { id: 7 }]);
    expect(
      denial(() => host.publish("workspace.renamed", { id: 7 })),
    ).toMatchObject({ code: HOST_CODES.EVENT_PAYLOAD_INVALID });
    host.revoke("workspace.read");
    expect(host.publish("workspace.focused", { id: 7 })).toEqual({
      delivered: 0,
      vetoed: false,
    });
    host.grant("workspace.read");
    host.suspend();
    expect(host.publish("workspace.focused", { id: 7 })).toEqual({
      delivered: 0,
      vetoed: false,
    });
  });
});

function debugHost(grants: readonly string[]): MockHost {
  const host = new MockHost({ manifestSource: DEBUG_MANIFEST });
  for (const capability of grants) host.grant(capability);
  return host;
}

describe("debug namespace", () => {
  test("each entry point needs its own grant", () => {
    const host = debugHost(["debug.trace"]);
    host.beginActivation();
    expect(denial(() => host.bitty.debug.inspect("grants"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    const inspectOnly = debugHost(["debug.inspect"]);
    inspectOnly.beginActivation();
    expect(denial(() => inspectOnly.bitty.debug.trace())).toMatchObject({
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    expect(denial(() => inspectOnly.bitty.debug.trace_get(1))).toMatchObject({
      code: HOST_CODES.CAPABILITY_DENIED,
    });
  });

  test("inspect serves sanitized sorted rows and fails closed on panels", () => {
    const host = debugHost(["debug.inspect", "debug.trace"]);
    host.beginActivation();
    host.bitty.commands.register({
      id: "hello",
      title: "Hello",
      run: () => null,
    });
    host.bitty.events.subscribe("terminal.bell", () => null);
    expect(host.bitty.debug.inspect("plugins")).toEqual({
      target: "plugins",
      items: [
        {
          id: "conformance.debug",
          version: "2.1.0",
          state: "activating",
          generation: 1,
        },
      ],
      truncated: false,
    });
    expect(host.bitty.debug.inspect("commands").items).toEqual([
      { plugin: "conformance.debug", id: "hello", title: "Hello" },
    ]);
    expect(host.bitty.debug.inspect("events").items).toEqual([
      { plugin: "conformance.debug", kind: "terminal.bell" },
    ]);
    expect(host.bitty.debug.inspect("grants").items).toEqual([
      "debug.inspect",
      "debug.trace",
    ]);
    expect(denial(() => host.bitty.debug.inspect("panels"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.NOT_IMPLEMENTED,
    });
    expect(denial(() => host.bitty.debug.inspect("secrets"))).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    expect(
      denial(() => host.bitty.debug.inspect(1 as unknown as string)),
    ).toMatchObject({ code: HOST_CODES.DEF_INVALID });
  });

  test("trace options are validated and capped per plugin", () => {
    const host = debugHost(["debug.trace"]);
    host.beginActivation();
    for (const opts of [
      { unknown: true },
      { filter: "" },
      { filter: "a*b*" },
      { filter: "has space" },
      { max_events: 0 },
      { max_events: MOCK_LIMITS.DEBUG_TRACE_MAX_EVENTS + 1 },
      { handle: 1 },
      { enabled: false },
      { enabled: false, handle: 1, filter: "x" },
      { enabled: "yes" },
    ]) {
      expect(denial(() => host.bitty.debug.trace(opts as never))).toMatchObject(
        { class: "validation", code: HOST_CODES.DEF_INVALID },
      );
    }
    const handles: number[] = [];
    for (let i = 0; i < MOCK_LIMITS.DEBUG_TRACES_PER_PLUGIN; i += 1) {
      handles.push(host.bitty.debug.trace({ filter: "terminal.*" }));
    }
    expect(denial(() => host.bitty.debug.trace())).toMatchObject({
      class: "budget",
      code: HOST_CODES.DEF_LIMIT,
    });
    const first = handles[0] ?? 0;
    expect(host.bitty.debug.trace({ enabled: false, handle: first })).toBe(
      first,
    );
    expect(
      denial(() => host.bitty.debug.trace({ enabled: false, handle: first })),
    ).toMatchObject({ code: HOST_CODES.DEF_INVALID });
    expect(host.bitty.debug.trace()).toBeGreaterThan(first);
  });

  test("trace records only declared, filtered events while active and drains once", () => {
    const host = debugHost(["debug.trace"]);
    host.beginActivation();
    const handle = host.bitty.debug.trace({
      filter: "terminal.*",
      max_events: 2,
    });
    host.endActivation();
    host.publish("terminal.bell");
    host.publish("terminal.title-changed", {
      title: "a",
      terminal_id: 1,
      runtime_id: 1,
    });
    host.publish("focus.changed", { view_id: 1 });
    host.publish("terminal.bell");
    const drain = host.bitty.debug.trace_get(handle);
    expect(drain?.dropped).toBe(1);
    expect(drain?.records.map((record) => record.topic)).toEqual([
      "terminal.title-changed",
      "terminal.bell",
    ]);
    expect(drain?.records[0]).toMatchObject({
      sequence: expect.any(Number),
      timestamp: expect.any(Number),
      payload: { title: "a", terminal_id: 1, runtime_id: 1 },
    });
    expect(host.bitty.debug.trace_get(handle)).toEqual({
      records: [],
      dropped: 0,
    });
    expect(host.bitty.debug.trace_get(handle + 100)).toBeNull();
    expect(
      denial(() => host.bitty.debug.trace_get("1" as unknown as number)),
    ).toMatchObject({ code: HOST_CODES.DEF_INVALID });
    host.suspend();
    host.publish("terminal.bell");
    expect(host.bitty.debug.trace_get(handle)?.records).toEqual([]);
  });

  test("trace payloads are redacted for the owner's grants and size-bounded", () => {
    const host = debugHost(["debug.trace"]);
    host.beginActivation();
    const handle = host.bitty.debug.trace();
    host.endActivation();
    host.publish("intercept.paste", {
      action: "paste",
      origin: "keyboard",
      preview: "secret",
    });
    host.publish("terminal.title-changed", {
      title: "t".repeat(MOCK_LIMITS.DEBUG_TRACE_PAYLOAD_MAX_BYTES),
      terminal_id: 1,
      runtime_id: 1,
    });
    const records = host.bitty.debug.trace_get(handle)?.records ?? [];
    expect(records[0]?.payload).toEqual({
      action: "paste",
      origin: "keyboard",
      redacted: true,
    });
    expect(records[1]?.payload).toMatchObject({ truncated: true });
  });

  test("workspace events stop reaching traces once workspace.read is revoked", () => {
    const host = new MockHost({
      manifestSource: WORKSPACE_MANIFEST.replace(
        "workspace.control = true",
        "workspace.control = true\ndebug.trace = true",
      ),
    });
    host.grant("workspace.read");
    host.grant("debug.trace");
    host.beginActivation();
    const handle = host.bitty.debug.trace({ filter: "workspace.*" });
    host.endActivation();
    host.publish("workspace.focused", { id: 1 });
    host.revoke("workspace.read");
    host.publish("workspace.focused", { id: 2 });
    const records = host.bitty.debug.trace_get(handle)?.records ?? [];
    expect(records.map((record) => record.payload)).toEqual([{ id: 1 }]);
  });

  test("traces are dropped with the generation", () => {
    const host = debugHost(["debug.trace"]);
    host.beginActivation();
    const handle = host.bitty.debug.trace();
    host.endActivation();
    host.dispose();
    host.grant("debug.trace");
    host.beginActivation();
    expect(host.bitty.debug.trace_get(handle)).toBeNull();
  });

  test("control stays deferred after bridge argument validation", () => {
    const host = debugHost(["debug.control"]);
    host.beginActivation();
    expect(
      denial(() =>
        host.bitty.debug.control(1 as unknown as string, "conformance.debug"),
      ),
    ).toMatchObject({ class: "validation", code: HOST_CODES.DEF_INVALID });
    expect(
      denial(() =>
        host.bitty.debug.control("reload_plugin", "conformance.debug"),
      ),
    ).toMatchObject({ class: "runtime", code: HOST_CODES.NOT_IMPLEMENTED });
  });
});

const OVERLAY_MANIFEST = `
[plugin]
id = "conformance.overlay"
name = "Conformance Overlay"
version = "1.0.0"
description = "Focusable overlay fixture (W-01, CTX-0065)."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
ui.overlay.focus = true

[lazy]
events = [
  "overlay.released",
]
`;

function overlayHost(
  grants: readonly string[] = ["ui.overlay.focus"],
): MockHost {
  const host = new MockHost({ manifestSource: OVERLAY_MANIFEST });
  for (const capability of grants) host.grant(capability);
  return host;
}

describe("overlay focusable surface (W-01, CTX-0065)", () => {
  test("requires ui.overlay.focus and never mints input.capture", () => {
    const host = overlayHost([]);
    host.beginActivation();
    expect(
      denial(() => host.bitty.ui.overlay.acquire({ title: "x" })),
    ).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    host.grant("ui.overlay.focus");
    const handle = host.bitty.ui.overlay.acquire({ title: "x" });
    expect(handle).toBeGreaterThan(0);
    host.endActivation();
  });

  test("single owner fails closed with E_UI_ALREADY_CAPTURED", () => {
    const host = overlayHost();
    host.beginActivation();
    const first = host.bitty.ui.overlay.acquire({ title: "one" });
    expect(
      denial(() => host.bitty.ui.overlay.acquire({ title: "two" })),
    ).toMatchObject({
      class: "runtime",
      code: HOST_CODES.UI_ALREADY_CAPTURED,
    });
    expect(host.bitty.ui.overlay.poll(first).status).toBe("active");
    host.endActivation();
  });

  test("drains queued input with sticky overflowed and 256-event bound", () => {
    const host = overlayHost();
    host.beginActivation();
    const handle = host.bitty.ui.overlay.acquire({});
    for (let i = 0; i < MOCK_LIMITS.OVERLAY_QUEUE_MAX + 1; i += 1) {
      host.injectOverlayInput({ type: "key", data: { n: i } });
    }
    const result = host.bitty.ui.overlay.poll(handle);
    expect(result.status).toBe("active");
    expect(result.events).toHaveLength(MOCK_LIMITS.OVERLAY_QUEUE_MAX);
    expect(result.overflowed).toBe(true);
    expect(result.seq).toBe(MOCK_LIMITS.OVERLAY_QUEUE_MAX + 1);
    expect(result.events[0]?.seq).toBe(2);
    // Sticky: a second drain stays overflowed with no new events.
    const second = host.bitty.ui.overlay.poll(handle);
    expect(second.events).toHaveLength(0);
    expect(second.overflowed).toBe(true);
    expect(second.seq).toBe(MOCK_LIMITS.OVERLAY_QUEUE_MAX + 1);
    host.endActivation();
  });

  test("4096-byte ceilings reject oversize spec, scene, and input", () => {
    const host = overlayHost();
    host.beginActivation();
    expect(
      denial(() => host.bitty.ui.overlay.acquire({ title: "x".repeat(5000) })),
    ).toMatchObject({ class: "validation", code: HOST_CODES.DEF_INVALID });
    const handle = host.bitty.ui.overlay.acquire({ title: "ok" });
    expect(
      denial(() =>
        host.bitty.ui.overlay.update(handle, {
          kind: "Text",
          text: "x".repeat(5000),
        }),
      ),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.UI_COMPONENT_INVALID,
    });
    expect(
      denial(() =>
        host.injectOverlayInput({
          type: "paste",
          data: { text: "x".repeat(5000) },
        }),
      ),
    ).toMatchObject({ class: "validation", code: HOST_CODES.DEF_INVALID });
    host.endActivation();
  });

  test("update validates v1 scene budgets and non-owners fail E_UI_NOT_OWNER", () => {
    const host = overlayHost();
    host.beginActivation();
    const handle = host.bitty.ui.overlay.acquire({});
    expect(
      host.bitty.ui.overlay.update(handle, { kind: "Text", text: "hi" }),
    ).toBe(true);
    expect(
      denial(() =>
        host.bitty.ui.overlay.update(handle, { kind: "Image", src: "x" }),
      ),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.UI_COMPONENT_INVALID,
    });
    expect(
      denial(() =>
        host.bitty.ui.overlay.update(9999, { kind: "Text", text: "x" }),
      ),
    ).toMatchObject({ class: "runtime", code: HOST_CODES.UI_NOT_OWNER });
    expect(denial(() => host.bitty.ui.overlay.poll(9999))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.UI_NOT_OWNER,
    });
    host.endActivation();
  });

  test("release is idempotent with submitted disposition and observes bus event", () => {
    const host = overlayHost();
    host.beginActivation();
    const seen: unknown[] = [];
    host.bitty.events.subscribe("overlay.released", (event) => {
      seen.push(event.payload);
    });
    host.endActivation();
    const handle = host.bitty.ui.overlay.acquire({ title: "x" });
    expect(host.bitty.ui.overlay.release(handle, "submitted")).toBe(true);
    expect(host.bitty.ui.overlay.poll(handle)).toMatchObject({
      status: "released",
      reason: "submitted",
    });
    // Second release succeeds without changing the recorded reason.
    expect(host.bitty.ui.overlay.release(handle, "cancelled")).toBe(true);
    expect(host.bitty.ui.overlay.poll(handle).reason).toBe("submitted");
    expect(seen).toEqual([
      { owner: "conformance.overlay", reason: "submitted" },
    ]);
    // Invalid reason is a validation error with the session unchanged.
    const second = host.bitty.ui.overlay.acquire({});
    expect(
      denial(() => host.bitty.ui.overlay.release(second, "focus_switched")),
    ).toMatchObject({ class: "validation", code: HOST_CODES.DEF_INVALID });
    expect(host.bitty.ui.overlay.poll(second).status).toBe("active");
  });

  test("idle expiry releases with timeout on the virtual clock", () => {
    const host = overlayHost();
    host.beginActivation();
    host.endActivation();
    const handle = host.bitty.ui.overlay.acquire({});
    host.injectOverlayInput({ type: "key", data: { key: "a" } });
    host.advanceTimers(10_000);
    expect(host.bitty.ui.overlay.poll(handle).status).toBe("active");
    host.advanceTimers(31_000);
    expect(host.bitty.ui.overlay.poll(handle)).toMatchObject({
      status: "released",
      reason: "timeout",
    });
  });

  test("focus switch, crash, and unload revoke with typed reasons", () => {
    const host = overlayHost();
    host.beginActivation();
    const seen: unknown[] = [];
    host.bitty.events.subscribe("overlay.released", (event) => {
      seen.push(event.payload);
    });
    host.endActivation();
    const focus = host.bitty.ui.overlay.acquire({});
    host.simulateOverlayFocusSwitch();
    expect(host.bitty.ui.overlay.poll(focus)).toMatchObject({
      status: "released",
      reason: "focus_switched",
    });
    const crash = host.bitty.ui.overlay.acquire({});
    host.simulateOverlayCrash();
    expect(host.bitty.ui.overlay.poll(crash)).toMatchObject({
      status: "released",
      reason: "crashed",
    });
    const unload = host.bitty.ui.overlay.acquire({});
    host.suspend();
    expect(host.bitty.ui.overlay.poll(unload)).toMatchObject({
      status: "released",
      reason: "unloaded",
    });
    expect(seen).toEqual([
      { owner: "conformance.overlay", reason: "focus_switched" },
      { owner: "conformance.overlay", reason: "crashed" },
      { owner: "conformance.overlay", reason: "unloaded" },
    ]);
  });

  test("stale generation handles fail E_UI_NOT_OWNER", () => {
    const host = overlayHost();
    host.beginActivation();
    host.endActivation();
    const handle = host.bitty.ui.overlay.acquire({});
    host.dispose();
    host.grant("ui.overlay.focus");
    host.beginActivation();
    expect(denial(() => host.bitty.ui.overlay.poll(handle))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.UI_NOT_OWNER,
    });
    expect(denial(() => host.bitty.ui.overlay.release(handle))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.UI_NOT_OWNER,
    });
    expect(host.bitty.ui.overlay.acquire({})).toBeGreaterThan(handle);
    host.endActivation();
  });

  test("safe mode fails acquire with E_UI_UNAVAILABLE and never emits", () => {
    const host = new MockHost({
      manifestSource: OVERLAY_MANIFEST,
      safeMode: true,
    });
    host.grant("ui.overlay.focus");
    host.beginActivation();
    const seen: unknown[] = [];
    host.bitty.events.subscribe("overlay.released", (event) => {
      seen.push(event.payload);
    });
    host.endActivation();
    expect(denial(() => host.bitty.ui.overlay.acquire({}))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.UI_UNAVAILABLE,
    });
    expect(seen).toEqual([]);
  });
});

const COMPOSER_MANIFEST = `
[plugin]
id = "example.composer-unit"
name = "Conformance Composer Unit"
version = "1.0.0"
description = "Submit/editor unit fixture."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
terminal.input.submit = true
process.editor = true
ui.overlay.focus = true

[lazy]
events = [
  "overlay.released",
]
`;

const FIRST_PARTY_MANIFEST = `
[plugin]
id = "bitty.composer"
name = "Conformance Composer First-Party"
version = "1.0.0"
description = "First-party parity fixture."
license = "MIT"

[compat]
plugin-api = "^1.0"

[capabilities]
terminal.input.submit = true
process.editor = true
ui.overlay.focus = true
`;

const THIRD_PARTY_MANIFEST = `
[plugin]
id = "example.composer-clone"
name = "Conformance Composer Third-Party"
version = "1.0.0"
description = "Third-party parity fixture."
license = "MIT"

[compat]
plugin-api = "^1.0"

[capabilities]
terminal.input.submit = true
process.editor = true
ui.overlay.focus = true
`;

function composerHost(
  environment: Readonly<Record<string, string>> = { VISUAL: "nvim" },
  grants: readonly string[] = ["terminal.input.submit", "process.editor"],
): MockHost {
  const host = new MockHost({
    manifestSource: COMPOSER_MANIFEST,
    environment,
  });
  for (const capability of grants) host.grant(capability);
  return host;
}

describe("terminal submit path (W-82, CTX-0068)", () => {
  test("requires declared and granted terminal.input.submit", () => {
    const host = composerHost({}, []);
    host.beginActivation();
    expect(denial(() => host.bitty.terminal.submit("hi"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    host.endActivation();
  });

  test("granted but undeclared stays denied", () => {
    const host = makeHost();
    host.grant("terminal.input.submit");
    host.beginActivation();
    expect(denial(() => host.bitty.terminal.submit("hi"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    host.endActivation();
  });

  test("frames one byte-exact bracketed-paste frame and charges it", () => {
    const host = composerHost();
    host.beginActivation();
    const outcome = host.bitty.terminal.submit("hi");
    expect(outcome).toEqual({ status: "accepted", bytes: 15 });
    expect(host.submitBudgetUsed).toBe(15);
    expect(host.submittedFrames).toHaveLength(1);
    expect(host.submittedFrames[0]).toEqual(
      Buffer.concat([
        Buffer.from("\u001b[200~", "utf8"),
        Buffer.from("hi", "utf8"),
        Buffer.from("\u001b[201~", "utf8"),
        Buffer.from("\r", "utf8"),
      ]),
    );
    host.endActivation();
  });

  test("enforces the 64 KiB cap at the boundary", () => {
    const host = composerHost();
    host.beginActivation();
    const full = "q".repeat(MOCK_LIMITS.COMPOSER_MAX_BYTES);
    expect(host.bitty.terminal.submit(full)).toEqual({
      status: "accepted",
      bytes: MOCK_LIMITS.COMPOSER_MAX_BYTES + 13,
    });
    const over = "q".repeat(MOCK_LIMITS.COMPOSER_MAX_BYTES + 1);
    expect(host.bitty.terminal.submit(over)).toEqual({
      status: "denied",
      deny: "too-large",
      wanted: MOCK_LIMITS.COMPOSER_MAX_BYTES + 1,
    });
    expect(host.submitBudgetUsed).toBe(
      MOCK_LIMITS.COMPOSER_MAX_BYTES + MOCK_LIMITS.SUBMIT_FRAME_OVERHEAD_BYTES,
    );
    host.endActivation();
  });

  test("non-string text fails shape validation", () => {
    const host = composerHost();
    host.beginActivation();
    expect(denial(() => host.bitty.terminal.submit(7 as never))).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    host.endActivation();
  });

  test("refused lease emits nothing and charges nothing", () => {
    const host = composerHost();
    host.beginActivation();
    host.setSubmitLease(false);
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "denied",
      deny: "lease-denied",
    });
    expect(host.submitBudgetUsed).toBe(0);
    expect(host.submittedFrames).toHaveLength(0);
    host.setSubmitLease(true);
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "accepted",
      bytes: 15,
    });
    host.endActivation();
  });

  test("budget exhaustion fails closed and denials never charge", () => {
    const host = new MockHost({
      manifestSource: COMPOSER_MANIFEST,
      environment: { VISUAL: "nvim" },
      submitBudgetBytes: 30,
    });
    host.grant("terminal.input.submit");
    host.beginActivation();
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "accepted",
      bytes: 15,
    });
    // 15 + 19 = 34 > 30: the probe fails before delivery.
    expect(host.bitty.terminal.submit("hello!")).toEqual({
      status: "denied",
      deny: "budget-exceeded",
      used: 15,
      cap: 30,
    });
    expect(host.submitBudgetUsed).toBe(15);
    host.endActivation();
  });

  test("buffered-only frames report unavailable without charging", () => {
    const host = composerHost();
    host.beginActivation();
    host.setSubmitDelivery("buffered");
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "unavailable",
      reason: "buffered-only",
    });
    expect(host.submitBudgetUsed).toBe(0);
    expect(host.submittedFrames).toHaveLength(0);
    host.setSubmitDelivery("live");
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "accepted",
      bytes: 15,
    });
    expect(host.submitBudgetUsed).toBe(15);
    host.endActivation();
  });

  test("no focused view reports unavailable before the lease gate", () => {
    const host = composerHost();
    host.beginActivation();
    host.setSubmitDelivery("none");
    host.setSubmitLease(false);
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "unavailable",
      reason: "no-focused-view",
    });
    host.endActivation();
  });

  test("a new generation starts with a fresh window", () => {
    const host = new MockHost({
      manifestSource: COMPOSER_MANIFEST,
      environment: { VISUAL: "nvim" },
      submitBudgetBytes: 15,
    });
    host.grant("terminal.input.submit");
    host.beginActivation();
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "accepted",
      bytes: 15,
    });
    expect(host.bitty.terminal.submit("hi")).toMatchObject({
      status: "denied",
      deny: "budget-exceeded",
    });
    host.endActivation();
    host.dispose();
    host.grant("terminal.input.submit");
    host.beginActivation();
    expect(host.bitty.terminal.submit("hi")).toEqual({
      status: "accepted",
      bytes: 15,
    });
    expect(host.submitBudgetUsed).toBe(15);
    host.endActivation();
  });
});

describe("external-editor round trip (W-82, CTX-0068)", () => {
  test("requires declared and granted process.editor", () => {
    const host = composerHost({}, []);
    host.beginActivation();
    expect(denial(() => host.bitty.process.editor.start())).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    host.endActivation();
  });

  test("defaults to the safe cancelled seed", () => {
    const host = composerHost();
    host.beginActivation();
    expect(host.bitty.process.editor.start()).toEqual({ status: "cancelled" });
    expect(host.editorTempsCreated).toBe(1);
    expect(host.editorTempsRemoved).toBe(1);
    host.endActivation();
  });

  test("allowlist matches bare names exactly after trimming", () => {
    for (const program of ["nvim", "vim", "vi", "  vim  "]) {
      const host = composerHost({ VISUAL: program });
      host.beginActivation();
      expect(host.bitty.process.editor.start()).toEqual({
        status: "cancelled",
      });
      expect(host.editorTempsCreated).toBe(1);
      host.endActivation();
      host.dispose();
    }
  });

  test("hostile values are denied with no fallback and no temp file", () => {
    const cases: Array<Readonly<Record<string, string>>> = [
      { VISUAL: "nano", EDITOR: "vim" },
      { VISUAL: "VIM" },
      { VISUAL: "/usr/bin/nvim" },
      { VISUAL: "nvim --clean" },
      { VISUAL: "nvim;touch pwned" },
    ];
    for (const environment of cases) {
      const host = composerHost(environment);
      host.beginActivation();
      expect(host.bitty.process.editor.start({ draft: "x" })).toEqual({
        status: "denied",
        deny: "not-allowed",
      });
      expect(host.editorTempsCreated).toBe(0);
      expect(host.editorTempsRemoved).toBe(0);
      host.endActivation();
      host.dispose();
    }
  });

  test("blank VISUAL falls through to EDITOR; both blank is no-editor", () => {
    const fallback = composerHost({ VISUAL: "  ", EDITOR: "vi" });
    fallback.beginActivation();
    expect(fallback.bitty.process.editor.start()).toEqual({
      status: "cancelled",
    });
    fallback.endActivation();
    fallback.dispose();
    const missing = composerHost({});
    missing.beginActivation();
    expect(missing.bitty.process.editor.start()).toEqual({
      status: "denied",
      deny: "no-editor",
    });
    expect(missing.editorTempsCreated).toBe(0);
    missing.endActivation();
    missing.dispose();
  });

  test("timeout defaults to 120 s and clamps to 300 s", () => {
    const host = composerHost();
    host.beginActivation();
    host.bitty.process.editor.start();
    expect(host.lastEditorTimeoutMs).toBe(120_000);
    host.bitty.process.editor.start({ timeout_ms: 999_999 });
    expect(host.lastEditorTimeoutMs).toBe(300_000);
    expect(
      denial(() => host.bitty.process.editor.start({ timeout_ms: 0 })),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    expect(
      denial(() => host.bitty.process.editor.start({ draft: 7 as never })),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    expect(
      denial(() => host.bitty.process.editor.start("x" as never)),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    host.endActivation();
  });

  test("over-cap draft is unavailable with the file removed", () => {
    const host = composerHost();
    host.beginActivation();
    expect(
      host.bitty.process.editor.start({
        draft: "q".repeat(MOCK_LIMITS.COMPOSER_MAX_BYTES + 1),
      }),
    ).toEqual({ status: "unavailable", reason: "too-large" });
    expect(host.editorTempsCreated).toBe(1);
    expect(host.editorTempsRemoved).toBe(1);
    host.endActivation();
  });

  test("edited content echoes bounded UTF-8 with exact outcome keys", () => {
    const host = composerHost();
    host.beginActivation();
    host.setEditorResult({ kind: "edited", content: "edited text" });
    const outcome = host.bitty.process.editor.start({ draft: "hello" });
    expect(outcome).toEqual({ status: "edited", content: "edited text" });
    expect(Object.keys(outcome).sort()).toEqual(["content", "status"]);
    host.setEditorResult({
      kind: "edited",
      content: "q".repeat(MOCK_LIMITS.COMPOSER_MAX_BYTES + 1),
    });
    expect(host.bitty.process.editor.start()).toEqual({
      status: "unavailable",
      reason: "too-large",
    });
    expect(host.editorTempsCreated).toBe(host.editorTempsRemoved);
    host.endActivation();
  });

  test("covers the remaining seeded outcomes without path leakage", () => {
    const host = composerHost();
    host.beginActivation();
    host.setEditorResult({ kind: "non-zero", code: 1 });
    expect(host.bitty.process.editor.start()).toEqual({
      status: "non-zero",
      code: 1,
    });
    host.setEditorResult({ kind: "non-zero", code: null });
    const unknown = host.bitty.process.editor.start();
    expect(unknown).toEqual({ status: "non-zero" });
    expect("code" in unknown).toBe(false);
    host.setEditorResult({ kind: "spawn-failed", detail: "boom" });
    expect(host.bitty.process.editor.start()).toEqual({
      status: "spawn-failed",
      detail: "boom",
    });
    host.setEditorResult({ kind: "timeout" });
    expect(host.bitty.process.editor.start()).toEqual({ status: "timeout" });
    expect(
      denial(() =>
        host.setEditorResult({
          kind: "unavailable",
          reason: "nope",
        } as never),
      ),
    ).toMatchObject({
      class: "validation",
      code: HOST_CODES.DEF_INVALID,
    });
    host.setEditorResult({ kind: "unavailable" });
    expect(host.bitty.process.editor.start()).toEqual({
      status: "unavailable",
      reason: "temp-unavailable",
    });
    expect(host.editorTempsCreated).toBe(host.editorTempsRemoved);
    host.endActivation();
  });

  test("spawn detail truncates to the 256-byte ceiling", () => {
    const host = composerHost();
    host.beginActivation();
    host.setEditorResult({ kind: "spawn-failed", detail: "y".repeat(600) });
    const outcome = host.bitty.process.editor.start();
    expect(outcome.status).toBe("spawn-failed");
    if (outcome.status === "spawn-failed") {
      expect(Buffer.byteLength(outcome.detail, "utf8")).toBe(256);
    }
    host.endActivation();
  });
});

describe("first-party/third-party parity (W-103 S-2, CTX-0068)", () => {
  function parityHost(manifestSource: string): MockHost {
    const host = new MockHost({
      manifestSource,
      environment: { VISUAL: "vim" },
    });
    host.beginActivation();
    return host;
  }

  test("the same operation is denied identically for both principals", () => {
    const first = parityHost(FIRST_PARTY_MANIFEST);
    const third = parityHost(THIRD_PARTY_MANIFEST);
    expect(denial(() => first.bitty.terminal.submit("hi"))).toEqual(
      denial(() => third.bitty.terminal.submit("hi")),
    );
    expect(denial(() => first.bitty.process.editor.start())).toEqual(
      denial(() => third.bitty.process.editor.start()),
    );
    expect(denial(() => first.bitty.ui.overlay.acquire({}))).toEqual(
      denial(() => third.bitty.ui.overlay.acquire({})),
    );
    expect(denial(() => first.bitty.terminal.submit("hi"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.CAPABILITY_DENIED,
    });
    first.endActivation();
    third.endActivation();
    first.dispose();
    third.dispose();
  });

  test("granted principals observe identical success shapes", () => {
    const first = parityHost(FIRST_PARTY_MANIFEST);
    const third = parityHost(THIRD_PARTY_MANIFEST);
    for (const host of [first, third]) {
      host.grant("terminal.input.submit");
      host.grant("process.editor");
      host.grant("ui.overlay.focus");
    }
    expect(first.bitty.terminal.submit("hi")).toEqual(
      third.bitty.terminal.submit("hi"),
    );
    expect(first.bitty.process.editor.start()).toEqual(
      third.bitty.process.editor.start(),
    );
    const firstHandle = first.bitty.ui.overlay.acquire({ title: "p" });
    const thirdHandle = third.bitty.ui.overlay.acquire({ title: "p" });
    expect(typeof firstHandle).toBe("number");
    expect(typeof thirdHandle).toBe("number");
    expect(first.bitty.ui.overlay.release(firstHandle, "cancelled")).toBe(true);
    expect(third.bitty.ui.overlay.release(thirdHandle, "cancelled")).toBe(true);
    first.endActivation();
    third.endActivation();
  });
});

describe("composer compat validation (W-82, CTX-0068)", () => {
  test("plugin-api mismatch fails activation with no partial generation", () => {
    const host = new MockHost({
      manifestSource: `
[plugin]
id = "example.composer-future"
name = "Compat Mismatch"
version = "1.0.0"
description = "Compat fixture."
license = "MIT"

[compat]
plugin-api = "^99.0"

[capabilities]
terminal.input.submit = true
`,
    });
    host.grant("terminal.input.submit");
    expect(denial(() => host.beginActivation())).toMatchObject({
      class: "validation",
      code: HOST_CODES.LIFECYCLE_STATE,
    });
    expect(host.currentState).toBe("created");
    expect(denial(() => host.bitty.terminal.submit("hi"))).toMatchObject({
      class: "runtime",
      code: HOST_CODES.GENERATION_DISPOSED,
    });
  });
});

describe("history-read family (W-139, CTX-0066)", () => {
  const HISTORY_MANIFEST = `
[plugin]
id = "bitty.history-keeper"
name = "History Keeper"
version = "1.0.0"
description = "History fixture."
license = "MIT"

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[capabilities]
history.transcript.read = true
history.commands.read = true
history.kv.read = true
clipboard.write = true
`;

  function historyHost(extra?: Record<string, unknown>): MockHost {
    const host = new MockHost({
      manifestSource: HISTORY_MANIFEST,
      ...(extra ?? {}),
    });
    host.beginActivation();
    return host;
  }

  function queryOpts(
    scope: Record<string, string> | undefined,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(scope === undefined ? {} : { scope }),
      row_count: 4,
      max_bytes: 4096,
      op: "list",
      ...(extra ?? {}),
    };
  }

  test("missing, revoked, scope, capture, and over-bound deny with typed codes", () => {
    const host = historyHost();
    const scope = { panel: "pane-a", workspace: "ws-1" };
    expect(
      denial(() => host.bitty.history.transcript.query(queryOpts(scope))),
    ).toMatchObject({ code: HOST_CODES.HISTORY_MISSING_GRANT });
    host.grant("history.transcript.read");
    expect(
      denial(() => host.bitty.history.transcript.query(queryOpts(scope))),
    ).toMatchObject({ code: HOST_CODES.HISTORY_CAPTURE_DISABLED });
    host.setHistoryCapture("transcript", true);
    expect(
      denial(() => host.bitty.history.transcript.query(queryOpts(undefined))),
    ).toMatchObject({ code: HOST_CODES.HISTORY_SCOPE_MISMATCH });
    expect(
      denial(() =>
        host.bitty.history.transcript.query(queryOpts({ panel: "*" })),
      ),
    ).toMatchObject({ code: HOST_CODES.DEF_INVALID });
    expect(
      denial(() =>
        host.bitty.history.transcript.query(queryOpts(scope, { row_count: 0 })),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_OVER_BOUND });
    host.revoke("history.transcript.read");
    expect(
      denial(() => host.bitty.history.transcript.query(queryOpts(scope))),
    ).toMatchObject({ code: HOST_CODES.HISTORY_REVOKED_GRANT });
    host.endActivation();
  });

  test("safe-mode, trust, purge, budgets, KV isolation, and export gates hold", () => {
    const safe = historyHost({ safeMode: true });
    safe.grant("history.transcript.read");
    safe.setHistoryCapture("transcript", true);
    expect(
      denial(() =>
        safe.bitty.history.transcript.query(
          queryOpts({ panel: "pane-a", workspace: "ws-1" }),
        ),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_SAFE_MODE });
    safe.endActivation();

    const untrusted = historyHost({ trustLevel: "L4" });
    untrusted.grant("history.transcript.read");
    untrusted.setHistoryCapture("transcript", true);
    expect(
      denial(() =>
        untrusted.bitty.history.transcript.query(
          queryOpts({ panel: "pane-a", workspace: "ws-1" }),
        ),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_TRUST_DENIED });
    untrusted.endActivation();

    const host = historyHost();
    host.grant("history.commands.read");
    host.setHistoryCapture("commands", true);
    host.setHistoryRows("commands", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "gone",
        purged: true,
      },
    ]);
    expect(
      denial(() =>
        host.bitty.history.commands.query(
          queryOpts({ panel: "pane-a", workspace: "ws-1" }),
        ),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_UNAVAILABLE });

    host.grant("history.kv.read");
    host.setHistoryRows("kv", [
      { seq: 0, body: "own", owner: "bitty.history-keeper" },
      { seq: 1, body: "foreign", owner: "example.other" },
    ]);
    const kv = host.bitty.history.kv.query({
      row_count: 4,
      max_bytes: 4096,
      op: "list",
    });
    expect(kv.records.map((record) => record.body)).toEqual(["own"]);
    expect(kv.total_in_scope).toBe(1);

    host.setHistoryRows("commands", [
      { panel: "pane-a", workspace: "ws-1", seq: 0, body: "live" },
    ]);
    for (let index = 0; index < 3; index += 1) {
      const page = host.bitty.history.commands.query(
        queryOpts({ panel: "pane-a", workspace: "ws-1" }, { row_count: 1 }),
      );
      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.label).toBe("untrusted-observation");
      expect(page.records[0]?.redacted).toBe(true);
      expect(page.freshness).toBe("point-in-time-no-guarantee");
    }
    expect(
      denial(() =>
        host.bitty.history.commands.query(
          queryOpts({ panel: "pane-a", workspace: "ws-1" }, { row_count: 1 }),
        ),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_OVER_BOUND });

    expect(
      denial(() => host.bitty.selection.copy({ text: "hi" })),
    ).toMatchObject({ code: HOST_CODES.CAPABILITY_DENIED });
    host.grant("clipboard.write");
    expect(host.bitty.selection.copy({ text: "hi" })).toEqual({
      text: "hi",
      truncated: false,
    });
    host.endActivation();
  });

  test("grants never bundle sources and history never implies export", () => {
    const host = historyHost();
    host.grant("history.transcript.read");
    host.setHistoryCapture("transcript", true);
    expect(
      denial(() =>
        host.bitty.history.commands.query(
          queryOpts({ panel: "pane-a", workspace: "ws-1" }),
        ),
      ),
    ).toMatchObject({ code: HOST_CODES.HISTORY_MISSING_GRANT });
    expect(
      denial(() => host.bitty.selection.copy({ text: "hi" })),
    ).toMatchObject({ code: HOST_CODES.CAPABILITY_DENIED });
    host.endActivation();
  });
});
