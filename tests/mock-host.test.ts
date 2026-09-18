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
  type HostDiagnostic,
} from "../src/host-diagnostics.js";
import {
  ENV_MAX_VALUE_BYTES,
  EVENT_KINDS,
  EVENT_MAX_BYTES,
  MOCK_LIMITS,
  PLUGIN_API_VERSION,
  UI_SLOTS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
} from "../src/host-surface.js";
import { MockHost } from "../src/mock-host.js";
import type { JsonValue } from "../src/json-schema.js";

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
"env:FIXTURE_KEY" = true

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
    ] as const) {
      expect(host.bitty[namespace]).toBeDefined();
    }
  });

  test("closed v1 event set matches the accepted classes", () => {
    expect(EVENT_KINDS).toHaveLength(17);
    const byClass = { lifecycle: 0, observation: 0, interception: 0 };
    for (const spec of EVENT_KINDS) byClass[spec.class] += 1;
    expect(byClass).toEqual({ lifecycle: 4, observation: 9, interception: 4 });
    expect(EVENT_KINDS.map((entry) => entry.kind)).toContain(
      "plugin.activated",
    );
    expect(EVENT_KINDS.map((entry) => entry.kind)).toContain(
      "intercept.open-url",
    );
  });

  test("accepted host codes stay separate from mock-owned codes", () => {
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.CAPABILITY_DENIED)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.STORE_QUOTA)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.BUDGET_TASK)).toBe(true);
    expect(ACCEPTED_HOST_CODES.has(HOST_CODES.REGISTRATION_CLOSED)).toBe(false);
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
    const host = makeHost(MANIFEST.replace('"env:FIXTURE_KEY" = true\n', ""));
    expect(host.bitty.env).toBeUndefined();
  });

  test("declared but ungranted env functions fail closed with E_CAPABILITY_DENIED", () => {
    const host = makeHost();
    activate(host);
    expect(host.bitty.env).toBeDefined();
    const diagnostic = denial(() => host.bitty.env?.get("FIXTURE_KEY"));
    expect(diagnostic.code).toBe(HOST_CODES.CAPABILITY_DENIED);
    expect(diagnostic.class).toBe("runtime");
  });

  test("granted env reads only the allowlisted key", () => {
    const host = makeHost(undefined, {
      FIXTURE_KEY: "fixture",
      OTHER_KEY: "other",
    });
    host.grant("env:FIXTURE_KEY");
    activate(host);
    expect(host.bitty.env?.get("FIXTURE_KEY")).toBe("fixture");
    expect(host.bitty.env?.get("OTHER_KEY")).toBeNull();
    expect(host.bitty.env?.has("FIXTURE_KEY")).toBe(true);
    expect(host.bitty.env?.has("OTHER_KEY")).toBe(false);
    expect(host.bitty.env?.get("UNSET_KEY")).toBeNull();
  });

  test("invalid and oversized env keys and values fail with the accepted codes", () => {
    const host = makeHost(undefined, { FIXTURE_KEY: "x".repeat(5000) });
    host.grant("env:FIXTURE_KEY");
    activate(host);
    expect(denial(() => host.bitty.env?.get("lowercase")).code).toBe(
      HOST_CODES.ENV_KEY_INVALID,
    );
    const diagnostic = denial(() => host.bitty.env?.get("FIXTURE_KEY"));
    expect(diagnostic.code).toBe(HOST_CODES.ENV_VALUE_TOO_LARGE);
    expect(ENV_MAX_VALUE_BYTES).toBe(4096);
  });
});

describe("registration window and lifecycle", () => {
  test.each([...UI_SLOTS])(
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

  test.each(EVENT_KINDS.filter((spec) => spec.class !== "lifecycle"))(
    "$kind delivery is detached while suspended",
    (spec) => {
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
    },
  );

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

  test("suspended providers reject saved methods and new resolution", () => {
    const host = makeHost(
      `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
    );
    host.beginActivation();
    let calls = 0;
    host.bitty.services.provide("conformance.greet", { hello: () => ++calls });
    const service = host.bitty.services.get("conformance.greet", {
      version: "^1.0",
    });
    host.endActivation();
    expect(service?.hello?.()).toBe(1);
    host.suspend();
    expect(denial(() => service?.hello?.())).toMatchObject({
      class: "runtime",
      code: HOST_CODES.SERVICE_GONE,
    });
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
    expect(calls).toBe(1);
    host.dispose();
    host.beginActivation();
    host.bitty.services.provide("conformance.greet", { hello: () => "new" });
    host.endActivation();
    expect(denial(() => service?.hello?.()).code).toBe(HOST_CODES.SERVICE_GONE);
    expect(
      host.bitty.services
        .get("conformance.greet", { version: "^1.0" })
        ?.hello?.(),
    ).toBe("new");
  });

  test.each([false, true])(
    "suspended service resolution preserves optional=%s for absent and detached providers",
    (optional) => {
      const host = makeHost(
        `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
      );
      host.beginActivation();
      let calls = 0;
      host.bitty.services.provide("conformance.greet", {
        hello: () => ++calls,
      });
      host.endActivation();
      host.suspend();
      for (const iface of ["conformance.absent", "conformance.greet"]) {
        const resolve = () =>
          host.bitty.services.get(iface, { version: "^1.0", optional });
        if (optional) expect(resolve()).toBeUndefined();
        else {
          expect(denial(resolve)).toMatchObject({
            class: "resolution",
            code: HOST_CODES.SERVICE_RESOLUTION,
          });
        }
      }
      expect(calls).toBe(0);
    },
  );

  test("a service call fails closed when its provider suspends before returning", () => {
    const host = makeHost(
      `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`,
    );
    host.beginActivation();
    host.bitty.services.provide("conformance.greet", {
      hello: () => {
        host.suspend();
        return "unavailable";
      },
    });
    const service = host.bitty.services.get("conformance.greet", {
      version: "^1.0",
    });
    host.endActivation();
    expect(denial(() => service?.hello?.())).toMatchObject({
      class: "runtime",
      code: HOST_CODES.SERVICE_GONE,
    });
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

  test("schema-validated services preserve provider liveness precedence", () => {
    for (const action of ["suspend", "dispose", "removeService"] as const) {
      const host = makeHost(serviceManifest);
      activate(host);
      let calls = 0;
      host.bitty.services.provide("conformance.greet", {
        hello: () => {
          calls += 1;
          if (action === "removeService")
            host.removeService("conformance.greet");
          else host[action]();
          return "invalid result";
        },
      });
      host.endActivation();
      const service = host.bitty.services.get("conformance.greet", {
        version: "^1.0",
      })!;
      expect(denial(() => service.hello!({ value: "hi" })).code).toBe(
        HOST_CODES.SERVICE_GONE,
      );
      expect(denial(() => service.hello!({ value: 1 })).code).toBe(
        HOST_CODES.SERVICE_GONE,
      );
      expect(calls).toBe(1);
    }
  });

  test("table service validates arguments before calling and results before returning", () => {
    const host = makeHost(serviceManifest);
    let calls = 0;
    activate(host);
    host.bitty.services.provide("conformance.greet", {
      hello: () => ++calls,
      invalid: () => {
        calls += 1;
        return "wrong";
      },
    });
    host.endActivation();
    const service = host.bitty.services.get("conformance.greet", {
      version: "^1.0",
    })!;
    const invalidArgs: JsonValue[] = [
      { value: 1 },
      {},
      { value: "too-long-value" },
      { value: "hi", extra: true },
    ];
    for (const args of invalidArgs) {
      expect(denial(() => service.hello!(args)).code).toBe(
        HOST_CODES.ARGS_INVALID,
      );
    }
    expect(calls).toBe(0);
    expect(service.hello!({ value: "hi" })).toBe(1);
    expect(denial(() => service.invalid!({ value: "hi" })).code).toBe(
      HOST_CODES.RESULT_INVALID,
    );
    expect(calls).toBe(2);
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

  test("validating consumers reject string providers without changing legacy resolution", () => {
    const source = `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`;
    const host = new MockHost({
      manifestSource: source,
      schemaValidatingServices: ["conformance.greet"],
    });
    let calls = 0;
    activate(host);
    host.bitty.services.provide("conformance.greet", { hello: () => ++calls });
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
    expect(calls).toBe(0);
    const legacy = makeHost(source);
    activate(legacy);
    legacy.bitty.services.provide("conformance.greet", {
      hello: () => "legacy",
    });
    expect(
      legacy.bitty.services.get("conformance.greet", { version: "^1.0" })!
        .hello!(),
    ).toBe("legacy");
  });

  test("validating consumers accept table providers including optional schema omissions", () => {
    for (const source of [
      serviceManifest,
      serviceManifest.replace(/, args_schema = .* } }\n/, " }\n"),
    ]) {
      const host = new MockHost({
        manifestSource: source,
        schemaValidatingServices: ["conformance.greet"],
      });
      activate(host);
      host.bitty.services.provide("conformance.greet", { hello: () => 1 });
      expect(
        host.bitty.services.get("conformance.greet", { version: "^1.0" })!
          .hello!({ value: "hi" }),
      ).toBe(1);
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
          text: "x".repeat(MOCK_LIMITS.SNAPSHOT_MAX_BYTES),
        }),
      ).code,
    ).toBe(HOST_CODES.UI_COMPONENT_INVALID);
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

  test("services resolve declared providers and fail closed when gone", () => {
    const manifest = `${MANIFEST}
[services.provided]
"conformance.greet" = "1.0.0"
`;
    const host = makeHost(manifest);
    activate(host);
    host.bitty.services.provide("conformance.greet", {
      hello: (args) => `hello ${(args as { name: string }).name}`,
    });
    host.endActivation();
    const get = host.bitty.services.get as unknown as (
      iface: string,
      opts?: unknown,
    ) => unknown;
    const service = host.bitty.services.get("conformance.greet", {
      version: ">=1.0.0",
    });
    expect(service?.hello?.({ name: "ada" })).toBe("hello ada");
    const missingOpts = denial(() => get("conformance.greet"));
    expect(missingOpts.code).toBe(HOST_CODES.SERVICE_VERSION_INVALID);
    expect(missingOpts.class).toBe("validation");
    expect(missingOpts.path).toBe("opts");
    const missingVersion = denial(() => get("conformance.greet", {}));
    expect(missingVersion.code).toBe(HOST_CODES.SERVICE_VERSION_INVALID);
    expect(missingVersion.class).toBe("validation");
    expect(missingVersion.path).toBe("opts.version");
    expect(
      denial(() => get("conformance.greet", { optional: true })).code,
    ).toBe(HOST_CODES.SERVICE_VERSION_INVALID);
    host.removeService("conformance.greet");
    expect(denial(() => service?.hello?.({ name: "ada" })).code).toBe(
      HOST_CODES.SERVICE_GONE,
    );
    expect(
      denial(() =>
        host.bitty.services.get("conformance.greet", { version: ">=1.0.0" }),
      ).code,
    ).toBe(HOST_CODES.SERVICE_RESOLUTION);
    expect(
      host.bitty.services.get("conformance.greet", {
        version: ">=1.0.0",
        optional: true,
      }),
    ).toBeUndefined();
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
    expect(
      withClaim.bitty.ui.mount("tabline", { kind: "Text", text: "x" }),
    ).toBeGreaterThan(0);
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

  test("service method calls isolate arguments and results between caller and provider", () => {
    const source = `${MANIFEST}\n[services.provided]\n"conformance.greet" = "1.0.0"\n`;
    const host = makeHost(source);
    activate(host);

    let retainedServiceArgs: Record<string, unknown> | undefined;
    const providerResponse = {
      ok: true,
      data: { score: 10 },
      flags: ["verified"],
    };

    host.bitty.services.provide("conformance.greet", {
      greet: (args) => {
        retainedServiceArgs = args as Record<string, unknown>;
        if (args && typeof args === "object") {
          (args as Record<string, unknown>).mutatedByProvider = true;
          const payload = (args as Record<string, unknown>).payload;
          if (payload && typeof payload === "object") {
            (payload as Record<string, unknown>).active = false;
          }
        }
        return providerResponse;
      },
    });

    host.endActivation();

    const service = host.bitty.services.get("conformance.greet", {
      version: "^1.0",
    })!;

    const callerArgs = {
      mutatedByProvider: false,
      payload: { active: true },
      items: [1, 2],
    };

    const result = service.greet!(callerArgs) as typeof providerResponse;

    // Mutating args inside provider does not mutate caller's arguments object
    expect(callerArgs.mutatedByProvider).toBe(false);
    expect(callerArgs.payload.active).toBe(true);
    expect(callerArgs.items).toEqual([1, 2]);

    // Mutating callerArgs after call does not mutate provider's retained args
    callerArgs.payload.active = true;
    (callerArgs as Record<string, unknown>).sneaky = "present";
    expect(retainedServiceArgs?.sneaky).toBeUndefined();

    // Mutating service return value does not mutate provider's state
    result.ok = false;
    result.data.score = 0;
    result.flags.push("tampered");

    expect(providerResponse.ok).toBe(true);
    expect(providerResponse.data.score).toBe(10);
    expect(providerResponse.flags).toEqual(["verified"]);

    // Provider mutating its own state after returning does not mutate caller's result
    providerResponse.data.score = 20;
    expect(result.data.score).toBe(0);
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
