# Plugin API v1 mock host and conformance fixtures

Status: implemented by SDK task `CTX-0016` (R-SDK-3) for the cross-repository
gate `CTX-0221`. The task depends on R-SDK-1 (LuaLS definitions) and R-SDK-2
(manifest schema + `bitty-plugin-lint`), both merged. The mock host derives
identifiers from the accepted `bitty-docs` contracts; `tests/conformance.test.ts`
additionally checks the modeled function paths, capability gates, event set,
and raw-snapshot exclusion against the merged R-SDK-1
`surface/bitty-plugin-api-v1.json` table so the mock, types, and docs cannot
drift apart.

The mock host is a **test double**, not a host implementation. It performs no
I/O, spawns no process, opens no network, reads no secret, and holds no real
terminal state. Plugins cannot gain ambient authority through it; it models the
accepted denial, lifecycle, and bounded-data behavior so SDK and plugin
conformance tests can run deterministically on Bun only.

## Contract sources

- Accepted contract:
  [ADR 0009](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0009-plugin-api-v1-lua-surface.md)
  (LUA-OQ-1..12) and the accepted
  [Plugin API v1 Lua Surface RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-api-v1-lua-surface-rfc.md)
  (module root, function surface, closed event set, exclusions).
- `bitty.env` gate and bounds:
  [ADR 0006](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0006-os-env-policy.md).
- Task/timer caps and generation semantics:
  [ADR 0007](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0007-async-gc.md).
- Manifest, capability set, and grant lifecycle:
  [Plugin Platform RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-platform-rfc.md)
  and the merged R-SDK-2 validator (`src/manifest.ts`, `src/capabilities.ts`).
- Bounded JSON Schema model:
  [CLI Contract RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/cli-contract-rfc.md)
  as resolved by ADR 0009 LUA-OQ-3.
- Machine-readable surface table (R-SDK-1):
  `surface/bitty-plugin-api-v1.json`, generated into `lua/bitty.d.lua` (see
  `docs/lua-defs.md`); `tests/conformance.test.ts` asserts agreement with this
  table.
- Reference host evidence (read-only): `bitty` `1ea2f66`
  `crates/bitty-plugin-host/src/{event,capability,host,manifest}.rs`.

## Usage

```ts
import { MockHost } from "bitty-plugin-sdk";

const host = new MockHost({
  manifestSource, // a bitty-plugin.toml source, validated by the R-SDK-2 linter
  environment: { FIXTURE_KEY: "value" },
});

host.grant("platform.notify"); // explicit; absent means no authority
host.beginActivation(); // registration window opens

const handle = host.bitty.commands.register({
  id: "hello",
  title: "Hello",
  run: () => "hello",
});
host.bitty.events.subscribe("terminal.bell", (event) => {
  console.log(event.kind, event.sequence);
});

host.endActivation(); // delivers plugin.activated
host.publish("terminal.bell", {}); // { delivered, vetoed }
host.dispatchCommand("example.plugin:hello", {}); // "hello"
host.dispose(); // delivers plugin.disposed, invalidates generation handles
```

`host.bitty` mirrors the injected Lua table (`api_version`, `commands`,
`events`, `keymaps`, `settings`, `store`, `notify`, `env`, `ui`, `terminal`,
`services`, `tasks`, `timers`). Host-side controls stay on the host object:
lifecycle (`beginActivation`, `endActivation`, `suspend`, `dispose`), consent
(`grant`, `revoke`, `isGranted`), event injection (`publish`), command dispatch
(`dispatchCommand`), data injection (`setTerminalSnapshot`, `removeService`),
and virtual time (`drainTasks`, `advanceTimers`).

Timers run on a virtual clock: `advanceTimers(ms)` fires due one-shot timers in
due order. Tasks are drained cooperatively with `drainTasks()`. No test ever
waits on wall-clock time.

## Surface model

| Namespace  | Modeled behavior                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `commands` | Registration during activation; manifest reservation; duplicate rejection; schema-validated dispatch    |
| `events`   | Activation-only subscription; closed set + manifest declaration; envelope with sequence and payload     |
| `keymaps`  | Activation-only suggestion; config chord grammar subset; `when = "global"` only; same-generation target |
| `settings` | Plugin-owned dot paths only; a leading `plugins` segment is rejected                                    |
| `store`    | Key grammar, bounded JSON values, 256 KiB quota, delete via `nil`, persistence across generations       |
| `notify`   | `platform.notify` gate; bounded payload; captured host-side for assertions                              |
| `env`      | Absent unless declared; denied until granted; granted allowlist only; 4 KiB value bound                 |
| `ui`       | `ui.rich` gate; `ui.overlay` for the overlay slot; v1 node kinds only; generation-owned block handles   |
| `terminal` | `terminal.semantic-read` gate; `scope = "semantic"` only; 256 KiB snapshot bound; read-only copy        |
| `services` | Declared providers only; required `opts.version`; `E_SERVICE_RESOLUTION`; liveness-checked calls        |
| `tasks`    | Activation-only creation; 64 live-task cap; cooperative cancellation; generation-owned handles          |
| `timers`   | Activation-only creation; 32 live-timer cap; one-shot virtual timers; generation-owned handles          |

Capability gates follow the accepted mapping: `bitty.notify.show` requires
`platform.notify`, `bitty.ui.mount`/`bitty.ui.update` require `ui.rich`
(plus `ui.overlay` for the overlay slot), and `bitty.terminal.snapshot`
requires `terminal.semantic-read`. Commands, events, keymaps, settings, store,
services, tasks, and timers are ungated. Execution requires **both** manifest
declaration and an explicit grant: a grant for an undeclared capability is
ignored, and a declared-but-ungranted call fails closed with
`E_CAPABILITY_DENIED` (`runtime` class) before any side effect.

Settings keys are relative to `plugins.<owner>.<name>` per the accepted
[Plugin API v1 Lua Surface RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-api-v1-lua-surface-rfc.md);
the definitive host-side resolution model for those relative keys is still
pending. Rather than guess that model, the mock applies a conservative guard:
a key whose first segment is `plugins` is rejected
(`E_SETTINGS_KEY_INVALID`), because that first segment is the only relative
spelling that could be read as addressing the shared settings root instead of
the plugin's own namespace. A nested `plugins` component remains a legal key.
Settings values use the same JSON-compatible contract as store values and are
rejected with `E_STORE_VALUE_INVALID` for cycles, depth, node, or byte bound
violations.

Every recursive traversal of a value (store and settings values, UI
components, and the injected terminal snapshot) is cycle-aware and bounded. A
self-referential table fails with a typed diagnostic
(`E_STORE_VALUE_INVALID`, `E_UI_COMPONENT_INVALID`, or `E_DEF_INVALID` for the
snapshot) instead of overflowing the stack, and the store depth and node
bounds are checked by the same bounded walk, so a cycle cannot be reached
before a bound rejects it. An acyclic shared-reference (DAG) value is explored
once per node, and its JSON size is measured under a hard visit cap, so the
exponential serialization of a deep diamond graph is rejected by the existing
size bound instead of hanging.

## Lifecycle and generations

| State        | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `created`    | No generation; calls fail with `E_GENERATION_DISPOSED`              |
| `activating` | Registration window open (`init.lua` execution in the real host)    |
| `active`     | Registration closed; `plugin.activated` delivered at the transition |
| `suspended`  | Registration closed; `plugin.suspended` delivered                   |
| `disposed`   | Subscriptions/registrations/handles cleared; calls fail closed      |

- Registration calls (`commands.register`, `events.subscribe`,
  `keymaps.suggest`, `services.provide`, `tasks.spawn`, `timers.create`) are
  valid only while `activating`; later attempts fail with
  `E_REGISTRATION_CLOSED` (`validation`).
- `dispose()` delivers `plugin.disposed` before invalidation. Handles from a
  disposed generation are invalid: `ui.update` and the cancel calls return
  `false` rather than touching new-generation resources.
- The store is scoped by plugin ID, not generation. Values written in
  generation N are readable in generation N+1 after
  `dispose()` + `beginActivation()`; settings behave the same within one mock
  host instance.

## Events

The closed 17-name v1 set is modeled with its classes and required payload
fields; unknown names fail with `E_EVENT_UNKNOWN` and known-but-undeclared
names with `E_EVENT_UNDECLARED`. Envelopes are
`{ kind, sequence, payload }` with a host-assigned monotonic sequence and a
deep-frozen payload copy. Observation and lifecycle handler return values are
ignored; interception handlers veto with `false` and approve with anything
else. A handler that throws is recorded once in `host.handlerViolations` and
does not stop delivery to later handlers.

## Bounds

| Bound               | Value             | Source                             |
| ------------------- | ----------------- | ---------------------------------- |
| Event payload       | 8 KiB             | `EVENT_MAX_BYTES` (reference host) |
| Env value           | 4 KiB             | ADR 0006                           |
| Store value / quota | 8 KiB / 256 KiB   | ADR 0009 LUA-OQ-6                  |
| Store depth / nodes | 8 / 1024          | ADR 0009 LUA-OQ-6                  |
| Snapshot            | 256 KiB           | ADR 0009 LUA-OQ-4                  |
| Command schema      | 16 KiB / depth 16 | ADR 0009 LUA-OQ-3                  |
| Live tasks / timers | 64 / 32           | ADR 0007 (RC-4)                    |

## Diagnostics

The mock host throws `HostError` carrying
`{ class, code, message, path? }`. Codes fixed by accepted contracts are
exported as `ACCEPTED_HOST_CODES`:

| Code                     | Class        | Source              |
| ------------------------ | ------------ | ------------------- |
| `E_CAPABILITY_DENIED`    | `runtime`    | ADR 0009            |
| `E_ENV_KEY_INVALID`      | `validation` | ADR 0006            |
| `E_ENV_VALUE_TOO_LARGE`  | `validation` | ADR 0006            |
| `E_STORE_VALUE_INVALID`  | `validation` | ADR 0009            |
| `E_STORE_QUOTA`          | `budget`     | ADR 0009            |
| `E_UI_COMPONENT_INVALID` | `validation` | ADR 0009            |
| `E_SNAPSHOT_TOO_LARGE`   | `validation` | ADR 0009            |
| `E_SERVICE_RESOLUTION`   | `resolution` | ADR 0009            |
| `E_SERVICE_GONE`         | `runtime`    | ADR 0009            |
| `E_BUDGET_TASK`          | `budget`     | ADR 0007 / ADR 0009 |
| `E_BUDGET_TIMER`         | `budget`     | ADR 0007 / ADR 0009 |

Behaviors the accepted corpus requires but does not yet spell with a stable
code use `MOCK_HOST_CODES` (documented test-tool codes, never a replacement
for an accepted code): registration and lifecycle state (`E_REGISTRATION_CLOSED`,
`E_LIFECYCLE_STATE`, `E_GENERATION_DISPOSED`), event and command validations
(`E_EVENT_UNKNOWN`, `E_EVENT_UNDECLARED`, `E_EVENT_PAYLOAD_INVALID`,
`E_EVENT_PAYLOAD_TOO_LARGE`, `E_COMMAND_ID_INVALID`, `E_COMMAND_UNDECLARED`,
`E_COMMAND_DUPLICATE`, `E_SCHEMA_INVALID`, `E_ARGS_INVALID`, `E_RESULT_INVALID`),
keymaps and definitions (`E_KEYMAP_WHEN_UNSUPPORTED`, `E_KEYMAP_CHORD_INVALID`,
`E_KEYMAP_COMMAND_UNKNOWN`, `E_DEF_INVALID`), store and settings keys
(`E_STORE_KEY_INVALID`, `E_SETTINGS_KEY_INVALID`), snapshot scope
(`E_SNAPSHOT_SCOPE_UNSUPPORTED`), services (`E_SERVICE_UNDECLARED`; a missing
`opts` or `opts.version` fails the accepted required-argument validation with
`E_SERVICE_VERSION_INVALID`), and `E_HANDLER_VIOLATION` for recorded handler
faults.

## Conformance fixtures

Fixtures live under `conformance/`:

```text
conformance/
  manifests/   validated bitty-plugin.toml fixtures
  cases/       declarative JSON cases
```

A case names a manifest, optional explicit grants, an optional environment
snapshot, and an ordered step list:

```json
{
  "name": "deny-by-default capability denial and explicit grant",
  "manifest": "manifests/full.toml",
  "tags": ["deny-by-default", "capability"],
  "grants": [],
  "environment": { "FIXTURE_KEY_ONE": "value" },
  "steps": [
    { "op": "begin-activation" },
    {
      "op": "call",
      "surface": "notify.show",
      "args": { "title": "hello" },
      "expect": {
        "denial": { "code": "E_CAPABILITY_DENIED", "class": "runtime" }
      }
    },
    { "op": "grant", "capability": "platform.notify" },
    {
      "op": "call",
      "surface": "notify.show",
      "args": { "title": "hello" },
      "expect": { "result": true }
    }
  ]
}
```

### Step vocabulary

| Op                                    | Purpose                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `grant` / `revoke`                    | Explicit capability consent changes                              |
| `begin-activation` / `end-activation` | Lifecycle window control                                         |
| `suspend` / `dispose`                 | Lifecycle transitions and invalidation                           |
| `register`                            | Register a command from a fixture definition                     |
| `subscribe`                           | Subscribe to a declared event with an optional veto/throw policy |
| `publish`                             | Publish an event and assert the delivery result                  |
| `dispatch`                            | Dispatch a registered command and assert result or denial        |
| `call`                                | Invoke one modeled surface (`surface` + `args`)                  |
| `call-service`                        | Invoke a method on a captured resolved service                   |
| `expect-event`                        | Assert the events captured by one subscription                   |
| `expect-capture`                      | Assert a captured value (handles, counters)                      |
| `expect-bitty-env`                    | Assert `bitty.env` presence or absence                           |
| `advance-time` / `drain-tasks`        | Virtual clock and cooperative task execution                     |
| `set-terminal-snapshot`               | Inject host snapshot data                                        |
| `remove-service`                      | Simulate provider disappearance                                  |

`{"$ref": "<capture>"}` resolves a previously captured value (for example a
handle) inside `args` or `expect`. `expect` supports `{ "result": ... }` and
`{ "denial": { "code", "class", "path"? } }`.

The runner validates each fixture manifest with the accepted R-SDK-2 linter
before constructing the host, records one assertion per step, bounds case files
to 1 MiB and 512 steps, and applies a per-case timeout (default 5000 ms). No
network or process work is involved.

```sh
just conformance   # runs tests/conformance.test.ts
just check         # all repository gates, including the fixture suite
```

The suite covers deny-by-default and explicit grants (including grants for
undeclared capabilities), the `bitty.env` carve-out, the registration window
and generation invalidation, store persistence across reloads, round-trips for
every kind of the closed event set, interception veto, command schema
validation, table-form `[lazy].commands` reservations, store bounds,
UI/terminal gates, and service/task/timer behavior.

## Known gaps

- **R-SDK-1 drift coverage.** The modeled function paths, capability gates,
  event names/classes, and the raw-snapshot exclusion are checked against
  `surface/bitty-plugin-api-v1.json` in `tests/conformance.test.ts`. LuaLS
  semantics beyond those identifiers (type shapes) remain owned by R-SDK-1 and
  are not restated by the mock.
- **Manifest table forms.** ADR 0009 `[lazy].commands` and
  `[services.provided]` table entries are accepted by the linter and modeled
  with their static schemas; consumer-side schema validation and the
  static/dynamic schema-equivalence checks remain host-bridge work.
- **Strict schema subset.** The mock validates a strict JSON Schema subset and
  rejects schemas using `pattern`, `format`, `$ref`, or composition keywords
  at registration. This is deliberate fail-closed behavior (never more
  permissive), but a legal schema outside the subset is not testable until the
  subset is extended under a reviewed change.
- **Call-time denial.** ADR 0009 LUA-OQ-2 models denial when an ungranted
  function is called. The `bitty-plugin-host` activation path additionally
  requires grants before activation; reconciling the two is host-bridge work,
  not an SDK decision.
- **UI node fields.** v1 node validation is limited to the closed kind set,
  container shape, and depth. Full `SceneNode` field contracts remain with the
  Rich Presentation RFC and the host renderer.
- **Event pipeline budgets.** Coalescing, queue bounds, batching, and drop
  policy are host pipeline concerns not restated in a single-plugin mock.
- **Lua execution.** The mock host is a TypeScript test double. A Lua-facing
  adapter that lets plugin authors run `init.lua` against it is a separate
  tooling task, as is generation of fixtures from R-SDK-1 types.
