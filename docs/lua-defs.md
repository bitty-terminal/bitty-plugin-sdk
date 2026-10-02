# Plugin API v1 LuaLS definitions

Status: implemented by SDK task `CTX-0014` (R-SDK-1) for cross-repository gate
`CTX-0221`; corrected by SDK task `CTX-0017` (required `services.get` option
shape and validation-claim accuracy). The definitions in `lua/bitty.d.lua` are
generated from the machine-readable surface table
`surface/bitty-plugin-api-v1.json`; the drift check in
`scripts/generate-lua-defs.ts` runs as part of `just check`. No other LuaLS
artifact exists for Plugin API v1. The definitions are frozen on the host-parity
verdicts of bitty PR #1303 (SDK task `CTX-0053`) as re-wired by bitty PR #1391
(SDK issue #115): WIRED namespaces generate
full bindings while the DEFERRED `env` namespace and the DEFERRED
`debug.control` function generate typed `E_NOT_IMPLEMENTED` stubs (see
[Host parity and regen-sync](#host-parity-and-regen-sync)). SDK task
`CTX-0063` (issue #133) synced the `bitty.debug` and `bitty.workspace`
namespaces and the `workspace.*` events at bitty `main` `2cb49afe`.

## Contract sources

- Accepted contract:
  [ADR 0009](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0009-plugin-api-v1-lua-surface.md)
  (resolutions for LUA-OQ-1 through LUA-OQ-12) and the accepted
  [Plugin API v1 Lua Surface RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-api-v1-lua-surface-rfc.md)
  (module root `bitty`, one spelling per concept, the closed v1 event set, the
  L1/L2 split, and the exclusion list).
- Referenced accepted contracts: ADR 0006 (`bitty.env`), ADR 0007
  (tasks/timers caps), ADR 0014 (workspace as a Core mechanism with separate
  read/control gates; Lua spellings stay host candidates under OQ-056), the
  Plugin Platform RFC (manifest, capabilities,
  pipeline), the TerminalRegistry and View Lifecycle Contract (identity tuple,
  `TerminalClosed`/`TerminalExited`), the Rich Presentation RFC (`SceneNode`,
  zones), the CLI Contract RFC (JSON Schema limits), and the Configuration
  Model RFC (chord grammar).
- Host implementation evidence: the `bitty.debug` and `bitty.workspace`
  spellings, argument shapes, bounds, and error codes are derived from the
  bitty host source at `2cb49afe` (`crates/bitty-lua/src/host.rs`,
  `crates/bitty-runtime/src/plugin_runtime/{mod,services,debug}.rs`,
  `crates/bitty-terminal/src/terminal_app.rs`), not from an accepted
  spelling contract; they sit outside the ADR 0009 v1 guarantee.
- Pinned revisions live in `sources` in `surface/bitty-plugin-api-v1.json`;
  the generated header names each contract document by repository and path
  only, so the surface table is the sole revision record.

## Artifacts

| Path                               | Role                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `lua/bitty.d.lua`                  | Generated LuaLS declarations (module root `bitty`)                   |
| `surface/bitty-plugin-api-v1.json` | Machine-readable surface table: types, functions, events, exclusions |
| `scripts/generate-lua-defs.ts`     | Generator and deterministic drift check                              |
| `scripts/check-lua-luals.ts`       | LuaLS conformance check (positive and negative fixtures)             |
| `scripts/check-host-parity.ts`     | Host-parity agreement check (surface, model, defs, mock, fixtures)   |
| `lua/examples/minimal-init.lua`    | Conformance example checked by the LuaLS run                         |
| `tests/lua-defs.test.ts`           | Surface, generation, exclusion, and drift tests                      |

## Using the definitions

Point LuaLS at this repository's `lua/` directory, or vendor
`lua/bitty.d.lua` into a plugin repository:

```json
{
  "runtime": { "version": "Lua 5.4" },
  "workspace": { "library": ["path/to/bitty-plugin-sdk/lua"] }
}
```

`bitty` then resolves as a host-injected global with the accepted v1 surface:

```lua
local handle = bitty.commands.register({
  id = "hello",
  title = "Say hello",
  args_schema = { type = "object" },
  result_schema = { type = "string" },
  run = function(args)
    bitty.notify.show({ title = "Hello", urgency = "normal" })
    return "hello"
  end,
})

bitty.events.subscribe("terminal.title-changed", function(event)
  print(event.kind, event.sequence)
end)

local snapshot = bitty.terminal.snapshot({ scope = "semantic" })
print(snapshot.width, snapshot.height, #snapshot.rows)
```

The complete checked example is
[`lua/examples/minimal-init.lua`](../lua/examples/minimal-init.lua).

Semantics the annotations carry:

- `bitty` and its sub-tables are read-only; `bitty.api_version` is `1.0.0`.
  Registration calls are valid only while `init.lua` executes.
- `bitty.env` is absent unless the manifest declares an `env.read:<KEY>`
  capability, so the field is optional (`env?`); the other namespaces are
  always present and ungranted functions fail closed with typed denials.
- `bitty.services.get` requires `opts` and `opts.version`: the accepted
  signature is `bitty.services.get(iface, opts)` with
  `opts = { version = "...", optional? = boolean }`, and the accepted corpus
  defines no default version requirement. Only `opts.optional` is optional.
- The literal types keep accepted restrictions visible to authors:
  `scope = "semantic"` only, `when = "global"` only, the closed slot set, the
  closed event-name set, and the accepted snapshot attribute vocabulary.
- Handles are generation-owned integers; all handles from a disposed
  generation fail closed.
- `BittyEventHandler` returns `any`: observation and lifecycle return values
  are ignored, and interception handlers veto only with the literal `false`
  and approve with any other value (including `nil`), so a boolean-only result
  would reject valid callbacks statically. The `subscribe` doc comment keeps
  the veto/approve semantics.
- Annotations list the capability gate and the accepted error codes for each
  function where the accepted corpus names them.

## Coverage

The surface table covers L1 Control and the minimal L2 UI surface only:
14 namespaces, 30 functions, and the closed 22-name event set.

| Namespace   | Functions                                                       | Level | Capability                                                    |
| ----------- | --------------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `commands`  | `register`                                                      | L1    | none                                                          |
| `events`    | `subscribe`                                                     | L1    | none                                                          |
| `keymaps`   | `suggest`                                                       | L1    | none                                                          |
| `settings`  | `get`, `set`                                                    | L1    | none                                                          |
| `store`     | `get`, `set`                                                    | L1    | none (quota-bounded)                                          |
| `notify`    | `show`                                                          | L1    | `platform.notify`                                             |
| `env`       | `get`, `has`                                                    | L1    | `env.read:<KEY>` (namespace optional)                         |
| `services`  | `get`, `provide`                                                | L1    | none                                                          |
| `ui`        | `mount`, `update`                                               | L2    | `ui.rich`; `ui.overlay` for the overlay slot                  |
| `terminal`  | `snapshot`                                                      | L2    | `terminal.semantic-read`                                      |
| `tasks`     | `spawn`, `cancel`                                               | L1    | none (64-task cap)                                            |
| `timers`    | `create`, `cancel`                                              | L1    | none (32-timer cap, one-shot)                                 |
| `debug`     | `inspect`, `trace`, `trace_get`, `control`                      | L1    | `debug.inspect`; `debug.trace`; `debug.control` (deferred)    |
| `workspace` | `list`, `focus`, `new`, `next`, `close`, `rename`, `move_panel` | L1    | `workspace.read` for `list`; `workspace.control` for the rest |

The accepted RFC classifies the `services.get` consumer side as cross-cutting
within v1; the tasks and timers functions were resolved as v1 additions by
ADR 0009. They are carried here alongside L1 rather than as separate levels,
and no Level 3 or Level 4 element is present.

Namespaces the host has not wired yet (`env`; bitty #1303, still deferred
after the #1391 services re-wire) are
DEFERRED: the surface table records them in the `hostParity` namespace map,
their functions list exactly `E_NOT_IMPLEMENTED`, and the generator renders
each as a typed stub (`Host status: deferred ...`) instead of a full binding.
A single host entry point that always fails closed inside an otherwise wired
namespace is recorded as a per-function override in `hostParity.functions`
(today only `debug.control`, whose runtime implementation fails before
reading the grant or target) and renders the same stub annotation.
The spellings stay declared, so the freeze is never silent; the stub fails
closed on the host, so the SDK is never more permissive.

The `debug` and `workspace` namespaces are host-implemented candidates rather
than ADR 0009 v1 surface: `bitty.workspace.*` and the `workspace.*` events
follow ADR 0014 (separate `workspace.read`/`workspace.control` gates, read
never implies control) with spellings pending OQ-056, and `bitty.debug.*`
has no accepted spelling contract. Workspace mutations only enqueue a bounded
request and return whether it was queued; the reserved
`bitty.debug.inspect("panels")` target fails with `E_NOT_IMPLEMENTED` and is
documented in the function doc rather than the error list.

The `ui.overlay` gate is conditional: the surface table records it as a
structured `conditionalCapabilities` entry on `ui.mount`
(`ui.overlay` when the slot is `overlay`) and the generated definition renders
it as a separate `Conditional capabilities:` annotation, so the unconditional
`ui.rich` gate is never overstated. `ui.update` operates on an existing handle
and carries no slot gate. `tests/conformance.test.ts` checks both the
unconditional and conditional gates against the mock-host model instead of
dropping the `:overlay` entry.

| Event class  | Names                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifecycle    | `plugin.activated`, `plugin.suspended`, `plugin.disposed`, `handler.violation`                                                                                                                                                                                                             |
| Observation  | `terminal.opened`, `terminal.closed`, `terminal.title-changed`, `terminal.cwd-changed`, `terminal.bell`, `focus.changed`, `selection.changed`, `process.exited`, `config.reloaded`, `workspace.created`, `workspace.closed`, `workspace.renamed`, `workspace.focused`, `workspace.changed` |
| Interception | `intercept.command-dispatch`, `intercept.terminal-spawn`, `intercept.paste`, `intercept.open-url`                                                                                                                                                                                          |

## What is not in v1

The surface table records an explicit exclusion list that the tests enforce
against the generated file: no `bitty.api` alias, no flat
`register_command`/`on_event`/`get_terminal_state` spellings, no panel
providers, no `bitty.fs`/`process`/`network`/`clipboard`/`ipc`/`renderer`/
`protocol` entry points, no Level 3 presentation namespaces, no singular
`bitty.task`/`bitty.timer` spellings, and no `scope = "raw"` snapshot.
`tests/lua-defs.test.ts` checks the full list textually on every `just check`;
the LuaLS negative fixture samples six excluded spellings plus the excluded
`raw` scope literal and wrong-shape `services.get` calls to verify rejection at
author time.

## Blocked surface: history, search, and selection (W-139, CTX-0066)

SDK task `CTX-0066` (issue #138, plan key W-139) owns the plugin-facing
history/storage/search/selection public APIs delegated by three **draft**
contracts:

- `bitty-terminal-docs` `specifications/search-selection-contract.md` (W-135,
  `status: draft`).
- `bitty-plugins-docs` `extensibility/history-and-storage-policy.md` (W-137,
  `status: draft`).
- `bitty-plugins-docs` `specifications/search-copy-mode-policy.md` (W-138,
  `status: draft`).

These documents are recorded in the surface table `sources` with `status:
draft` for traceability, but **none authorizes implementation** and each
delegates the exact SDK spellings to W-139. They are therefore a source record,
not surface authority. The task is **blocked** and adds no accepted
function path:

- **No accepted capability authorizes the read.** The Plugin Platform RFC fixes
  the `terminal` capability family as a closed set (`terminal.semantic-read`,
  `terminal.raw-read`, `terminal.input.self`, `terminal.input.all`,
  `terminal.manage`), and the accepted Plugin API v1 Lua Surface RFC states v1
  has no scrollback text read path. The accepted `terminal.semantic-read`
  gates the bounded visible-viewport snapshot only. W-137/W-138 park the exact
  identifier to W-139 but require that a capability absent from the closed set
  be added only by a **successor RFC with its own security review**; W-139 does
  not hold that authority, so it does not widen the closed set and does not add
  `terminal.scrollback-read` or any history-read head.
- **No host entry point exists.** W-135's implementation-status section states
  there is no snapshot surface, no generation-stamped result handle, and no
  public navigation or clipboard host operation; the search/copy-mode package
  (`CTX-0003`) and the Core integration (`W-143`/`W-144`) are separate tasks.

The `bitty.history` surface path is recorded as an explicit exclusion in
`surface/bitty-plugin-api-v1.json` with the same blocker. Re-evaluate when an
accepted capability and a bitty host entry point exist (a successor RFC plus
`W-146`-style host wiring). The `debug`/`workspace` namespaces remain the only
host-candidate additions, unchanged by this task.

`selection` and the `terminal` closed-set membership are not touched: no
`terminal.*` head is added or renamed.

## Validation

```sh
just check              # includes lua-defs-check and host-parity-check
just lua-defs-write     # regenerate lua/bitty.d.lua after a reviewed surface change
just lua-defs-luals     # LuaLS conformance; skips with exit 0 when the binary is absent
just host-parity-check  # surface/model/defs/mock/fixture parity agreement
```

## Host parity and regen-sync

The surface table pins the bitty host revision it was frozen against
(`hostParity`: repository `bitty`, commit `2cb49afe` re-verified at bitty
`main` after PR 1607, PR 1584 as the last verdict move; verdict set
provenance #1303) and one verdict per namespace: every namespace is `wired`
except `env`, which is `deferred`, plus the per-function override
`debug.control: deferred`. `process.spawn` is v1-OUT and stays excluded.
`bitty.network` also stays excluded: bitty #1604 (DIR-030) removed the
embedded Lua network binding from Core, and network access now belongs to
the out-of-process `net` native component, whose Lua request surface is
deferred and not wired.

The SDK owns regen-sync for these artifacts. Run this trigger whenever a
bitty host change flips a namespace verdict or an accepted contract revision
moves:

1. Update `surface/bitty-plugin-api-v1.json`: the `hostParity` pin (commit,
   PR, per-namespace verdicts, per-function `functions` overrides) and, for a
   contract revision, the `sources` entries. A namespace or function flipping
   to `deferred` lists exactly `E_NOT_IMPLEMENTED` in every affected function
   `errors`; flipping to `wired` restores its accepted codes.
2. Mirror the verdicts in `src/host-surface.ts` (`HOST_PARITY_SOURCE`,
   `NAMESPACE_HOST_PARITY`, `FUNCTION_HOST_PARITY`); the mock host derives its
   deferred gates from `DEFERRED_NAMESPACES` and `DEFERRED_FUNCTIONS`, and
   `src/index.ts` re-exports the model.
3. Run `just lua-defs-write` to regenerate `lua/bitty.d.lua`.
4. Run `just check`: `just lua-defs-check` fails on drift and
   `just host-parity-check` fails when the surface table, wiring model,
   generated definitions, mock behavior, or fixtures disagree.

`api_version` stays `1.0.0` until a `bitty-docs` revision moves it; host-only
wiring changes never bump it.

`just lua-defs-luals` runs `lua-language-server --check` twice: the generated
definitions plus `lua/examples/minimal-init.lua` must diagnose cleanly, and
`tests/lua-defs/negative-fixture.lua` must be rejected for sampled excluded
identifiers, the excluded `raw` scope literal, and wrong-shape `services.get`
calls (missing `opts`, and `opts` without `version`). `bun test` also runs the
same conformance check when `lua-language-server` is on `PATH` (or
`LUA_LANGUAGE_SERVER` is set) and skips it otherwise.

`bitty.process.spawn` stays excluded: bitty #1303 rules it v1-OUT (a
consent-gated extra outside the v1 API guarantee), so no freeze vector asserts
it as v1 surface.

CI does not run LuaLS conformance. The Quality gates workflow installs no
`lua-language-server`, so `just lua-defs-luals` skips there with exit 0 and
only the deterministic `lua-defs-check` drift gate runs in CI. Run
`just lua-defs-luals` locally (verified with `lua-language-server` 3.19.1) for
the author-time diagnostic evidence.

## Compatibility

The module root, namespace names, function spellings, and event names are
stable within `1.x`; additions are minor versions and removals or narrowing
require a major version. The manifest `compat.plugin-api` range and the runtime
`bitty.api_version` must agree at activation.

## Known gaps

- `BittySceneNode` is typed `table`: the accepted corpus fixes the v1 node
  kinds (`Text`, `Row`, `Column`, `List`) and constraints but leaves the exact
  Lua table encoding to the accepted Rich Presentation RFC `SceneNode`
  contract. No field names are invented here.
- `terminal.closed.reason` is typed `string`: the accepted registry contract
  defines the field but not a closed reason vocabulary.
- Error-code lists name only codes the accepted corpus names; registration
  window and lifecycle violations keep their documented behavior without a
  fabricated code.
- The definitions describe the host bridge only. Manifest validation is owned
  by the `bitty-plugin-lint` tooling and `docs/manifest.md`.
