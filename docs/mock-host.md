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
- Host parity evidence (read-only): `bitty` #1303 (`c01f538`, CTX-0707) wires
  `keymaps.suggest` and `tasks.spawn`/`cancel` as bridge captures and defers
  `services.get`/`provide` and `env.get`/`has` with typed `E_NOT_IMPLEMENTED`
  (`runtime` class), and rules `process.spawn` v1-OUT. The SDK freeze in
  `surface/bitty-plugin-api-v1.json` (`hostParity`), `src/host-surface.ts`
  (`NAMESPACE_HOST_PARITY`), and `just host-parity-check` pins these verdicts
  (see [Host parity freeze](#host-parity-freeze)).

## Usage

Consume the SDK as a commit-pinned Git dependency or a local checkout, as
shown in the [README](../README.md#consuming-the-linter-from-a-plugin-repository).
The supported library import is the package root, `bitty-plugin-sdk`: its
runtime and type exports both resolve directly to `src/index.ts`. No package
subpaths are exported; do not import internal `src/*` paths. This is a
Bun/TypeScript library with no build step, not a registry publication or a
Node.js compatibility promise. The `bitty-plugin-lint` executable remains a
separate CLI entry.

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

Namespaces the host has not wired yet (`services`, `env`; see
[Host parity freeze](#host-parity-freeze)) stay present on `host.bitty` but
every call fails closed with `E_NOT_IMPLEMENTED` (`runtime` class) before
activation, capability, or argument checks run. Keymaps and tasks are WIRED
and behave fully.

## Static schema enforcement

The service paragraphs below describe the accepted-contract implementation,
which stays in the mock behind the deferral gate so a future host-wiring task
can re-enable it; every `services.*` call currently fails with
`E_NOT_IMPLEMENTED` before schema checks run (bitty #1303, see
[Host parity freeze](#host-parity-freeze)). The command-schema paragraphs are
WIRED and behave as written.

The mock enforces ADR 0009 LUA-OQ-3 and LUA-OQ-8 within its existing bounded
JSON Schema subset. Table-form `[lazy].commands` metadata must match both
runtime schemas at registration, including omissions. Canonical comparison
ignores object-key order and the order of `required`, `enum`, and union `type`
sets; arrays inside literal values such as `default` remain ordered. A mismatch
fails registration with `E_SCHEMA_INVALID` (`validation`) before the command is
installed. String-form reservations still allow runtime-only schemas. The
registered definition is copied so later caller mutation cannot change it.

For table-form `[services.provided]`, every method validates supplied arguments
against `args_schema` before entering the callback (`E_ARGS_INVALID`) and its
result against `result_schema` before returning (`E_RESULT_INVALID`). Both are
mock-owned `validation` codes. Omitted schemas impose no additional constraint.
Provider liveness is checked before argument validation and after execution;
provider disappearance still wins with `E_SERVICE_GONE`.

To model a schema-validating consumer, construct the host with
`schemaValidatingServices: ["example.interface"]`. This is **host-harness
configuration**, not a new Lua `services.get` option or manifest field. For each
listed interface, a string-form provider cannot resolve: required lookups fail
with `E_SERVICE_RESOLUTION`, optional lookups return `undefined` (Lua `nil`).
Table-form entries remain distinguishable even when optional schemas are absent.
Without this configuration, legacy string-form resolution remains available;
provided table schemas are enforced regardless of this selection.

These bounded in-memory checks close the acknowledged SDK coverage gap (#88),
not a production host defect. They do not establish cross-VM or full resolver
conformance. Regression evidence lives in the `static schema enforcement` group
in `tests/mock-host.test.ts`.

## Surface model

| Namespace  | Modeled behavior                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands` | Registration during activation; manifest reservation; duplicate rejection; schema-validated dispatch                                                       |
| `events`   | Activation-only subscription; closed set + manifest declaration; envelope with sequence and payload                                                        |
| `keymaps`  | Activation-only suggestion; shipped config chord grammar (trimmed, case-insensitive, modifier/key aliases); `when = "global"` only; same-generation target |
| `settings` | Plugin-owned dot paths only; a leading `plugins` segment is rejected                                                                                       |
| `store`    | Key grammar, bounded JSON values, 256 KiB quota, delete via `nil`, persistence across generations                                                          |
| `notify`   | `platform.notify` gate; bounded payload; captured host-side for assertions                                                                                 |
| `env`      | DEFERRED (bitty #1303): present when declared, absent otherwise; every call fails `E_NOT_IMPLEMENTED`; the allowlist returns when the namespace wires      |
| `ui`       | `ui.rich` gate; `ui.overlay` for the overlay slot; exclusive `tabline` needs a `[lazy].claims` entry; v1 node kinds only; generation-owned block handles   |
| `terminal` | `terminal.semantic-read` gate; `scope` defaults to `"semantic"`; 256 KiB snapshot bound; read-only copy                                                    |
| `services` | DEFERRED (bitty #1303): present; `provide`/`get` fail `E_NOT_IMPLEMENTED`; declarations stay valid manifest metadata; full behavior returns when wired     |
| `tasks`    | Activation-only creation; 64 live-task cap; cooperative cancellation; generation-owned handles                                                             |
| `timers`   | Activation-only creation; 32 live-timer cap; one-shot virtual timers; generation-owned handles                                                             |

Capability gates follow the accepted mapping: `bitty.notify.show` requires
`platform.notify`, `bitty.ui.mount`/`bitty.ui.update` require `ui.rich`
(plus `ui.overlay` for the overlay slot), and `bitty.terminal.snapshot`
requires `terminal.semantic-read`. Commands, events, keymaps, settings, store,
services, tasks, and timers are ungated. Execution requires **both** manifest
declaration and an explicit grant: a grant for an undeclared capability is
ignored, and a declared-but-ungranted call fails closed with
`E_CAPABILITY_DENIED` (`runtime` class) before any side effect.

Service version requirements use the shared structural grammar in
`src/version-range.ts` (P1-2): comma-separated conjunctions of an optional
comparator (`=`/`==`/`>=`/`<=`/`>`/`<`/`^`/`~`, default `=`) and a version with
optional shorthand segments (`^1.0` means `^1.0.0`). Evaluation follows the
reference host resolver's comparator expansion, including the caret zero-major
tightening: `^1.2.3` is `>=1.2.3 <2.0.0`, `^0.2.3` is `>=0.2.3 <0.3.0`,
`^0.0.3` pins `=0.0.3`, and `^0.1` does not match `0.9.9` (PX-0141). The
manifest linter uses the same parser for `compat.*`, `dependencies.*`, and
`tools.git.version`, so a range that passes `bitty-plugin-lint` is never
rejected at resolution as malformed, and a range the linter rejects always
fails closed with `E_SERVICE_VERSION_INVALID` here
(`tests/version-range.test.ts`). Structural acceptance intentionally differs
from the resolver's closed grammar; see
[Contract choices and divergences](#contract-choices-and-divergences).

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
size bound instead of hanging. UI depth is enforced from each subtree's
memoized height (`depth + height - 1 <= UI_MAX_DEPTH`), so an aliased subtree
reused both above and below the limit in one component gets the deep-only
verdict regardless of traversal order or where it was first validated.

## Host parity freeze

`surface/bitty-plugin-api-v1.json` (`hostParity`), `src/host-surface.ts`
(`NAMESPACE_HOST_PARITY`), the generated `lua/bitty.d.lua` annotations, the
mock host, and the conformance fixtures are frozen on the bitty #1303
(CTX-0707) verdicts: `keymaps` and `tasks` are WIRED; `services` and `env` are
DEFERRED; `process.spawn` is v1-OUT and stays in the surface-table
`exclusions`. WIRED namespaces generate full bindings; DEFERRED namespaces
stay present but generate typed `E_NOT_IMPLEMENTED` stubs, so the freeze is
never silent and never more permissive than the host.

- The deferred gate runs before activation, capability, and argument checks:
  grants, declarations, key shapes, versions, and `optional` change nothing,
  and lifecycle state changes nothing.
- The `bitty.env` absent-unless-declared carve-out stays in the mock per the
  accepted ADR 0006 contract. The current host bridge always presents the
  deferred tables (it knows no manifest); the mock carve-out is stricter and
  therefore fail-closed, never more permissive.
- The accepted full-contract `services`/`env` implementation stays in the mock
  behind the gate so a future host-wiring task can re-enable it by flipping
  the namespace to `wired`; until then fixtures assert `E_NOT_IMPLEMENTED`.
- Regen-sync (SDK-owned): when a bitty host change flips a namespace or an
  accepted contract revision moves, update the surface-table `hostParity` pin
  (and `sources` revisions), run `just lua-defs-write`, and run `just check`
  (`just lua-defs-check` for drift, `just host-parity-check` for agreement).
  `api_version` stays `1.0.0` until a `bitty-docs` revision moves it. See
  `docs/lua-defs.md` for the full procedure.

## Lifecycle and generations

| State        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `created`    | No generation; calls fail with `E_GENERATION_DISPOSED`                        |
| `activating` | Registration window open (`init.lua` execution in the real host)              |
| `active`     | Registration closed; `plugin.activated` delivered at the transition           |
| `suspended`  | Registration closed; `plugin.suspended` delivered; ordinary dispatch detached |
| `disposed`   | Subscriptions/registrations/handles cleared; calls fail closed                |

- Registration calls (`commands.register`, `events.subscribe`,
  `keymaps.suggest`, `ui.mount`, `tasks.spawn`,
  `timers.create`) are valid only while `activating`; later attempts fail with
  `E_REGISTRATION_CLOSED` (`validation`). `services.provide` is DEFERRED (see
  [Host parity freeze](#host-parity-freeze)): it fails with
  `E_NOT_IMPLEMENTED` in every lifecycle state, before the window check runs.
- New UI mounts in every slot must occur between `beginActivation()` and
  `endActivation()`, matching the accepted
  [activation entry point contract](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/specifications/plugin-api-v1-lua-surface-rfc.md#activation-entry-point-lua-oq-12).
  Mounts from active or suspended generations, including lifecycle callbacks,
  fail with `E_REGISTRATION_CLOSED`; calls before activation or after disposal
  fail with `E_GENERATION_DISPOSED`. This registration guard runs before
  capability and component validation. During activation, mounts still require
  declared and granted `ui.rich`, plus `ui.overlay` for the overlay slot, and
  an exclusive slot claim where applicable.
- `ui.update` is not a new registration: a live block mounted during activation
  can still be updated after `endActivation()`. Its existing capability,
  component-validation, and generation checks remain independent; revoking
  `ui.rich` denies updates, and stale handles return `false` in a new,
  explicitly authorized generation. Tests cover every mount slot, lifecycle
  callbacks, capability denial/revocation, and disposal/reload; conformance
  case `05-lifecycle-registration.json` separately exercises active/suspended
  late-mount denial and an active live-block update.
- Tasks and timers are generation-owned and created only during the activation
  window (ADR 0009 LUA-OQ-12). After `endActivation()`, `tasks.spawn` and
  `timers.create` fail with `E_REGISTRATION_CLOSED`; a new generation's
  `drainTasks()` / `advanceTimers()` never runs a disposed generation's
  callbacks, and its handles fail closed.
- `advanceTimers()` revalidates every queued due record immediately before its
  callback runs: a record cancelled, already fired, removed (disposal), or
  owned by a non-current generation is skipped, and delivery stops when the
  batch itself suspended or disposed the host. A callback can therefore cancel
  a later due timer in the same batch and the cancelled callback never fires,
  while unrelated eligible timers still deliver in due-time order. The
  cancellation return value and observed delivery agree.
- Grants: `suspend()` retains grants (same generation, matching the accepted
  runtime lifecycle). `dispose()` clears the grant set as a deliberate
  fail-closed harness simplification; the accepted grant record is persistent
  and manifest-hash-addressed, so a real reload normally carries grants forward
  and re-prompts only on a manifest-hash change with added capabilities or
  after revocation (see
  [Contract choices and divergences](#contract-choices-and-divergences)).
  Until the harness re-grants, a declared-but-ungranted call fails closed with
  `E_CAPABILITY_DENIED`.
- `suspend()` detaches ordinary dispatch for the suspended generation while
  retaining registrations, grants, tasks, timers, and store data: commands fail
  with `E_LIFECYCLE_STATE` without running; observation and interception
  deliveries are detached (zero delivered, never vetoes); queued tasks and
  timers stay retained (still cancellable) but never fire; `services.*` calls
  fail with `E_NOT_IMPLEMENTED` in every state (the namespace is DEFERRED, so
  no provider ever resolves). Only the host-internal lifecycle deliveries
  (`plugin.activated`, `plugin.suspended`, `plugin.disposed`,
  `handler.violation`) remain — lifecycle callbacks can still run cleanup and
  read the store and grants, but their ordinary dispatch attempts also fail
  closed. Resume is out of scope for Plugin API v1; the mock never reopens
  dispatch inside one generation, and disposal keeps detached tasks and timers
  invalid in every later generation. Snapshotted timer and event batches also
  stop delivering disposed-generation callbacks when suspension cleanup calls
  `dispose()`, even if cleanup then activates a new generation.
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
names with `E_EVENT_UNDECLARED`. The manifest linter validates `[lazy].events`
against the same closed set (`lazy.events.unknown`), read from `EVENT_KINDS` in
`src/host-surface.ts`, so an unknown kind cannot reach this runtime check.
Kinds with declared fields tolerate unknown optional fields for forward
compatibility (ADR 0009 LUA-OQ-10); kinds that declare no payload fields
(`plugin.activated`, `plugin.suspended`, `plugin.disposed`,
`handler.violation`, `terminal.bell`, `config.reloaded`) reject any key with
`E_EVENT_PAYLOAD_INVALID`. Envelopes are
`{ kind, sequence, payload }` with a host-assigned monotonic sequence and a
deep-frozen payload copy. Observation and lifecycle handler return values are
ignored; interception handlers veto with `false` and approve with anything
else. A handler that throws is recorded once in `host.handlerViolations` and
does not stop delivery to later handlers. While suspended, only lifecycle
deliveries run; observation and interception deliveries are detached
entirely (see [Lifecycle and generations](#lifecycle-and-generations)).

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

| Code                     | Class        | Source                                  |
| ------------------------ | ------------ | --------------------------------------- |
| `E_CAPABILITY_DENIED`    | `runtime`    | ADR 0009                                |
| `E_ENV_KEY_INVALID`      | `validation` | ADR 0006                                |
| `E_ENV_VALUE_TOO_LARGE`  | `validation` | ADR 0006                                |
| `E_STORE_VALUE_INVALID`  | `validation` | ADR 0009                                |
| `E_STORE_QUOTA`          | `budget`     | ADR 0009                                |
| `E_UI_COMPONENT_INVALID` | `validation` | ADR 0009                                |
| `E_SNAPSHOT_TOO_LARGE`   | `validation` | ADR 0009                                |
| `E_SERVICE_RESOLUTION`   | `resolution` | ADR 0009                                |
| `E_SERVICE_GONE`         | `runtime`    | ADR 0009                                |
| `E_BUDGET_TASK`          | `budget`     | ADR 0007 / ADR 0009                     |
| `E_NOT_IMPLEMENTED`      | `runtime`    | bitty #1303 (mock-owned until accepted) |
| `E_BUDGET_TIMER`         | `budget`     | ADR 0007 / ADR 0009                     |

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
(`E_SNAPSHOT_SCOPE_UNSUPPORTED`), UI exclusivity (`E_UI_CLAIM_REQUIRED`),
services (`E_SERVICE_UNDECLARED`; a missing
`opts` or `opts.version` fails the accepted required-argument validation with
`E_SERVICE_VERSION_INVALID`), `E_HANDLER_VIOLATION` for recorded handler
faults, and `E_NOT_IMPLEMENTED` for the deferred host namespaces (see
[Host parity freeze](#host-parity-freeze)).

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

Cases covering deferred namespaces carry the `pending-host` tag and assert
`E_NOT_IMPLEMENTED` (`runtime`) for every `services.*`/`env.*` call instead of
accepted-contract success (see [Host parity freeze](#host-parity-freeze));
`tests/conformance.test.ts` enforces this agreement.

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
to 1 MiB and 512 steps, and applies a per-case timeout (default 5000 ms). The
execution budget covers manifest linting, host initialization, and all step
evaluations. Monotonic elapsed time (`performance.now()`) is verified between
steps in addition to the asynchronous `withTimeout` race timer, ensuring both
synchronous step sequences and asynchronous operations strictly observe the
timeout. When a case exceeds its budget, the runner marks the case as failed with
an exceeded-timeout error and cleans up any active or suspended host state
(`dispose()`). No network or process work is involved.

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

## Contract choices and divergences

Where the accepted corpus is silent, the mock chooses the fail-closed reading
and records it here; where a mock harness simplification diverges from an
accepted contract, the divergence and its fail-closed direction are stated
explicitly.

- **Terminal snapshot scope.** ADR 0009 LUA-OQ-4 and the Lua Surface RFC write
  `opts = { scope = "semantic", terminal_id? = integer }`; `"semantic"` is the
  only accepted v1 scope, so an omitted `scope` is unambiguously semantic and
  the mock defaults it instead of failing a valid call. `scope = "raw"` and any
  other explicit value still fail with `E_SNAPSHOT_SCOPE_UNSUPPORTED`. The
  R-SDK-1 surface table marks `scope` optional and `lua/bitty.d.lua` renders
  `---@field scope? "semantic"`, matching this default.
- **UI exclusivity claims.** The surface table says `tabline` is an exclusive
  claim while status components compose. The mock therefore requires a
  `lazy.claims` entry named exactly `tabline` before mounting to `tabline`
  (`E_UI_CLAIM_REQUIRED`); other slots, including `statusline` and `overlay`,
  need no claim. The accepted corpus does not yet define a claim grammar beyond
  the slot name.
- **Cross-generation grants (deliberate harness simplification; diverges from
  the accepted persistent grant record).** The accepted grant lifecycle
  (`bitty-plugins-docs`
  [`plugin-platform-rfc.md`](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/specifications/plugin-platform-rfc.md)
  "Grant lifecycle": Persistence / Update / Re-grant) records grants as a
  user-owned, manifest-hash-addressed record that survives suspension and
  reload; the real host re-prompts only when the manifest hash changes with
  added capabilities, or after revocation. `plugin-host-runtime-rfc.md` A.5
  confirms "`Suspended` retains grants". The mock does not model that record:
  to keep a self-contained test double it fails closed on the stricter side,
  clearing the grant set on `dispose()` so a reload starts from
  deny-by-default and the harness re-grants explicitly, while `suspend()` keeps
  grants because it stays in the same generation. This is deliberately more
  restrictive than the contract, never more permissive.
- **Empty event payloads.** Kinds that declare no payload fields accept no
  keys; kinds with declared fields keep the accepted forward-compatible
  unknown-optional-field rule (ADR 0009 LUA-OQ-10). The asymmetry is deliberate
  because the accepted corpus never assigns semantics to extra keys on a
  payload-less event.
- **Key chords.** Parsing mirrors the shipped `bitty-config` `Chord::parse`
  (trimmed, case-insensitive, modifier aliases `ctrl`/`control`,
  `alt`/`opt`/`option`, `super`/`meta`/`cmd`/`command`/`win`/`windows`,
  named-key aliases plus `f1..f35`, single-character keys requiring a modifier,
  and the 64-byte bound).
- **High-risk capabilities.** The lint-side escalation set is documented in
  [`docs/manifest.md`](manifest.md); the mock does not re-derive it.
- **Version-range structural grammar.** The mock and the linter share one
  parser whose accepted structure is wider than the reference resolver's in
  compatible ways (comparator-list shorthand, `==` as `=`, caret/tilde
  combined with a comma, leading-zero components, more than 16 comparator
  clauses, and numeric components above `u32::MAX`) and narrower in one
  fail-closed way (prerelease/build range segments are rejected). These
  structural differences are kept for corpus compatibility pending the
  `bitty-plugins` `DEC-0008` decision; matching semantics for every accepted
  range follow the resolver, including caret zero-major tightening. The full
  list and directions live in [`docs/manifest.md`](manifest.md) "Known gaps
  and open questions".

## Known gaps

- **R-SDK-1 drift coverage.** The modeled function paths, capability gates,
  event names/classes, and the raw-snapshot exclusion are checked against
  `surface/bitty-plugin-api-v1.json` in `tests/conformance.test.ts`. LuaLS
  semantics beyond those identifiers (type shapes) remain owned by R-SDK-1 and
  are not restated by the mock.
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
- **Lua execution.** The mock host is a TypeScript test double. The bundled
  minimal example (`lua/examples/minimal-init.lua`) is exercised end to end by
  `tests/example.test.ts`: a Lua recorder
  (`tests/lua/minimal-example-recorder.lua`) captures the example's call
  sequence, and the test replays it through the mock host, which validates every
  definition and component shape. A `lua` interpreter on `PATH` (override with
  `LUA`) is required for that step; without one the test skips explicitly
  instead of passing silently, and the deterministic companion-manifest check
  still runs. A general Lua-facing adapter and generation of fixtures from
  R-SDK-1 types remain separate tooling work.
