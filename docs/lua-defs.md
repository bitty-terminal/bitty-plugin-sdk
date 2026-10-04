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
namespaces and the `workspace.*` events at bitty `main` `2cb49afe`. SDK task
`CTX-0067` (plan W-43) re-pins the freeze to bitty `main` `fb44a867`
(PR #1641) with no v1 verdict move: the W-28 overlay mechanism and the W-29
targeting bindings stay pending per W-120 at that pin, deferred and not
wired (see [Pending surface](#pending-surface-targeting-w-29-ctx-0067)).
SDK task `CTX-0065` (plan W-120) then wires the accepted W-01 overlay
surface (see
[Accepted overlay surface](#accepted-overlay-surface-w-01-ctx-0065)).
SDK task `CTX-0068` (issue #142, plan W-103 S-2) wires the accepted W-82
composer operations `bitty.terminal.submit` and `bitty.process.editor.start`
with the additive v2 capabilities `terminal.input.submit` and
`process.editor` (see
[Accepted submit/editor surface](#accepted-submiteditor-surface-w-82-ctx-0068));
`api_version` stays `1.0.0` (additive only) and the host pin stays `fb44a867`
(#1641). SDK task `CTX-0066` (plan W-139) wires the accepted RFC-0004
history-read family `bitty.history.*.query` plus `bitty.selection.copy` with
the additive v2 capabilities `history.transcript.read`,
`history.commands.read`, and `history.kv.read` (see
[Accepted history/search/selection surface](#accepted-historysearchselection-surface-w-139-ctx-0066));
`api_version` stays `1.0.0` (additive only, precedent #141).

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
  spelling contract; they sit outside the ADR 0009 v1 guarantee. The
  W-29 targeting host evidence at `fb44a867`
  (`crates/bitty-lua/src/host.rs`,
  `crates/bitty-runtime/src/plugin_runtime/{mod,services,overlay}.rs`)
  is recorded as explicit exclusions only (see
  [Pending surface](#pending-surface-targeting-w-29-ctx-0067)). The W-28
  overlay mechanism is now covered by the accepted W-01 surface (see
  [Accepted overlay surface](#accepted-overlay-surface-w-01-ctx-0065)).
  The W-82 submit/editor spellings, outcome shapes, bounds, and error codes
  are derived from the accepted W-82 contract plus the bitty host source at
  `1df0459e` (`crates/bitty-rich/src/host.rs`,
  `crates/bitty-runtime/src/runtime/submit_host.rs`,
  `crates/bitty-terminal/src/editor_host.rs`) and the overlay mechanism at
  `2f49934d` as mechanism evidence, not as the spelling authority (Core has
  no Lua wiring for submit/editor yet; see
  [Accepted submit/editor surface](#accepted-submiteditor-surface-w-82-ctx-0068)).
  The W-139 history/search/selection spellings, grant shapes, denial
  taxonomy, and budget shapes are derived from the accepted RFC-0004
  history-read surface, the accepted W-135 search-selection contract, and
  the accepted W-131/W-137 storage boundary/policy plus the open Core host
  PR bitty#1673 (`c01a9772`, CTX-0955) and merged Core W-143 `0d50b436`
  (CTX-0936, #1640) as mechanism evidence, not as the spelling authority
  (Core has no Lua wiring for history yet; Lua spellings are minted by this
  SDK task under the NEW root, see
  [Accepted history/search/selection surface](#accepted-historysearchselection-surface-w-139-ctx-0066)).
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

The surface table covers L1 Control and the minimal L2 UI surface plus the
accepted W-01 overlay surface, the accepted W-82 composer operations, and the
accepted W-139 history-read family: 17 namespaces, 40 functions, and the
closed 23-name event set.

| Namespace            | Functions                                                       | Level | Capability                                                    |
| -------------------- | --------------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `commands`           | `register`                                                      | L1    | none                                                          |
| `events`             | `subscribe`                                                     | L1    | none                                                          |
| `keymaps`            | `suggest`                                                       | L1    | none                                                          |
| `settings`           | `get`, `set`                                                    | L1    | none                                                          |
| `store`              | `get`, `set`                                                    | L1    | none (quota-bounded)                                          |
| `notify`             | `show`                                                          | L1    | `platform.notify`                                             |
| `env`                | `get`, `has`                                                    | L1    | `env.read:<KEY>` (namespace optional)                         |
| `services`           | `get`, `provide`                                                | L1    | none                                                          |
| `ui`                 | `mount`, `update`                                               | L2    | `ui.rich`; `ui.overlay` for the overlay slot                  |
| `ui.overlay`         | `acquire`, `update`, `poll`, `release`                          | L2    | `ui.overlay.focus` (single coupled grant, W-01)               |
| `terminal`           | `snapshot`, `submit`                                            | L2    | `terminal.semantic-read`; `terminal.input.submit` (W-82)      |
| `tasks`              | `spawn`, `cancel`                                               | L1    | none (64-task cap)                                            |
| `timers`             | `create`, `cancel`                                              | L1    | none (32-timer cap, one-shot)                                 |
| `debug`              | `inspect`, `trace`, `trace_get`, `control`                      | L1    | `debug.inspect`; `debug.trace`; `debug.control` (deferred)    |
| `workspace`          | `list`, `focus`, `new`, `next`, `close`, `rename`, `move_panel` | L1    | `workspace.read` for `list`; `workspace.control` for the rest |
| `process.editor`     | `start`                                                         | L2    | `process.editor` (single grant, W-82)                         |
| `history.transcript` | `query`                                                         | L2    | `history.transcript.read` (per-source scoped grant, W-139)    |
| `history.commands`   | `query`                                                         | L2    | `history.commands.read` (per-source scoped grant, W-139)      |
| `history.kv`         | `query`                                                         | L2    | `history.kv.read` (own namespace only, W-139)                 |
| `selection`          | `copy`                                                          | L2    | `clipboard.write` (existing grant, no new capability, W-143)  |

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
providers, no `bitty.fs`/`network`/`clipboard`/`ipc`/`renderer`/
`protocol` entry points, no unconstrained `bitty.process.spawn` (only the
allowlisted `bitty.process.editor.start` is wired; see
[Accepted submit/editor surface](#accepted-submiteditor-surface-w-82-ctx-0068)),
no Level 3 presentation namespaces, no singular
`bitty.task`/`bitty.timer` spellings, no `scope = "raw"` snapshot, no
`bitty.terminal.history` (NEW history root, never `terminal.*`), no live
`bitty.search` binding or `bitty.selection.get` handles (Core-owned deferred
pending W-01 + W-138; only `selection.copy` is wired), no
`bitty.history.session` snapshots (Core-only), no `bitty.history.export`
bundled path (separate grants only), and no provisional
`bitty.ui.targets`/`bitty.ui.labels` sub-tables (the `bitty.ui.overlay`
focusable surface is now accepted via W-01; see
[Accepted overlay surface](#accepted-overlay-surface-w-01-ctx-0065) and
[Pending surface](#pending-surface-targeting-w-29-ctx-0067)).
`tests/lua-defs.test.ts` checks the full list textually on every `just check`;
the LuaLS negative fixture samples eleven excluded spellings plus the excluded
`raw` scope literal and wrong-shape `services.get` calls to verify rejection at
author time.

## Accepted history/search/selection surface (W-139, CTX-0066)

SDK task `CTX-0066` (plan W-139) mints the exact capability identifiers and
Lua spellings the accepted RFC-0004 parked to W-139: the NEW read-only
`history` family beside `terminal.*` (never an extension of it) with
`bitty.history.transcript.query`, `bitty.history.commands.query`, and
`bitty.history.kv.query` under the additive v2 capabilities
`history.transcript.read`, `history.commands.read`, and `history.kv.read`,
plus `bitty.selection.copy` under the existing `clipboard.write` (no new
capability per Core W-143). `api_version` stays `1.0.0` (additive only,
precedent #141) and the host pin stays `fb44a867` (#1641).

Derivation (strict, derived never invented): the family shape, source table,
grant/scope/migration rules, snapshot bounds, secrecy treatment, and
8-category denial taxonomy come from accepted RFC-0004 plus the threat-model
matrix cells and P0-AC-035/030/024/013 scope notes; storage/KV ceilings reuse
accepted W-131/W-137 (published `bitty.store` ceilings unchanged);
search/selection mechanism derives from the accepted W-135 contract plus
merged Core W-143 `0d50b436` (CTX-0936, #1640) with live per-view binding,
viewport navigation, and selection lifecycles staying Core-owned deferred
pending W-01 + W-138 (draft policy, requirements only). Open Core host PR
bitty#1673 (CTX-0955, `c01a9772`) aligns on the `history.*.read` heads and
the gate shape (RFC wins on conflict; no delta found).

Family invariants obeyed: NEW root (never `bitty.terminal.*`),
per-plugin per-source scoped grants with explicit scope params plus no
wildcard plus intersect-or-deny, 8-category typed denials oracle-tight,
VM-only delivery plus separate export grants plus argv-first, Core-attached
untrusted label, TerminalOutput-only trust (L0-L3 admit, L4 deny),
rate/aggregate budget SHAPE normative with mock placeholders (never wire
truth). Projections (documented here and in code, like CTX-0068): Lua
`query` opts shape with `op` list/tail/search collapses Core `QueryOp`
(mint, not Core spelling); history budget numbers are harness placeholders
mirroring bitty#1673 test caps; grant-scope narrowing is Core-owned (W-146,
mock returns only in-scope rows); L3 per-request and L4 per-invocation
grants are parked (mock denies L3/L4 fail-closed); redaction format is
parked to W-137 (mock seeds already-redacted bodies); live search binding,
navigation, and selection lifecycles are deferred with explicit exclusions
(`bitty.search`, `bitty.selection.get`, `bitty.history.session`,
`bitty.history.export`, `bitty.terminal.history`).

## Accepted overlay surface (W-01, CTX-0065)

SDK task `CTX-0065` (plan W-120) wires the accepted W-01
overlay-input-capture contract
(`bitty-docs` `docs/development/overlay-input-capture-contract.md`,
`status: accepted`): the single coupled grant `ui.overlay.focus` (no
`input.capture` head, no wildcard), the `bitty.ui.overlay.acquire`/`update`/
`poll`/`release` spellings plus the observation-only `overlay.released` bus
event, the `{status, seq, events[], overflowed, reason?}` poll envelope with
`key|text|pointer|paste` tags (field encodings parked), the 256-queue /
4096-payload / 4096-call / 30s-idle bounds with v1 scene budgets per update,
the typed `E_UI_ALREADY_CAPTURED` / `E_UI_NOT_OWNER` codes (reused
`E_UI_UNAVAILABLE`, `E_CAPABILITY_DENIED`, and `E_VALUE_*`), Core single-owner
arbitration, safe-mode `E_UI_UNAVAILABLE`, and additive versioning. The four
functions live under the already-wired `ui` namespace, so no namespace
verdict moves; the mock host enforces deny-by-default, the bounded queue with
drop-oldest plus sticky `overflowed`, the byte ceilings, the idle expiry on
the virtual clock, single ownership with idempotent release, and safe mode.
Conformance cases `19-overlay-focus.json`, `20-overlay-safe-mode.json`, and
`21-overlay-timeout-focus.json` cover the lifecycle. Field encodings, richer
node types, submit-to-PTY, and mechanism internals stay parked with their
owners per the contract.

## Accepted submit/editor surface (W-82, CTX-0068)

SDK task `CTX-0068` (plan W-103 S-2) wires the accepted W-82 Composer
architecture (`bitty-terminal-docs`
`specifications/composer-architecture.md`, `status: accepted`): the additive
v2 capabilities `terminal.input.submit` and `process.editor` (closed terminal
and process families; no wildcard, no family grant), the
`bitty.terminal.submit(text)` spelling returning the typed
`{status, bytes?, deny?, wanted?, used?, cap?, reason?}` outcome, and the
`bitty.process.editor.start(opts?)` spelling returning the typed
`{status, content?, deny?, detail?, code?, reason?}` outcome. The status tags
mirror the Core typed outcomes at bitty `1df0459e` (CTX-0929):
`TerminalSubmitOutcome` (`accepted`/`denied`/`unavailable`),
`SubmitDeny` (`too-large`/`lease-denied`/`budget-exceeded`),
`TerminalSubmitUnavailable` (`no-focused-view`/`buffered-only`),
`EditorOutcome` (`edited`/`cancelled`/`denied`/`timeout`/`spawn-failed`/
`non-zero`/`unavailable`, minus the hosted-only `Signal` variant, which has
no Lua spelling), and `EditorDeny` (`no-editor`/`not-allowed`). The
`start(opts)` table shape (`draft`, `timeout_ms`, unknown fields ignored)
projects the round-trip inputs: the temp path itself never leaves Core, so
the plugin contributes draft content and a bounded wait request only. Bounds
are the reviewed values: 64 KiB edit-buffer and temp cap, 13-byte
bracketed-paste framing overhead, 120 s default / 300 s ceiling editor wait,
and the exact `nvim`/`vim`/`vi` bare-name allowlist with first-non-empty-wins
and no fallback. `terminal.submit` lives under the already-wired `terminal`
namespace (no verdict move); `process.editor.start` records the new wired
`process` namespace verdict while unconstrained `process.spawn` stays v1-OUT.
`api_version` stays `1.0.0` (additive only) and the host pin stays `fb44a867`
(#1641). The mock host enforces deny-by-default, the framing and charge
rules (framed bytes charged only on live delivery; denials and buffered-only
frames leave the window untouched), the lease gate, the allowlist before any
temp state, Core-owned temp creation with removal on every path, and the
harness-seeded child vocabulary (wall-clock waiting, tree kill, and
crash-restart sweep stay Core-owned). Conformance cases `22-submit-terminal`,
`23-process-editor`, `24-editor-allowlist`, `25-compat-mismatch`, and the
`26`/`27` first-party/third-party parity-denial pair cover the surface; the
parity legs run byte-identical steps under the two principals.

## Pending surface: targeting (W-29, CTX-0067)

SDK task `CTX-0067` (plan W-43) re-pins the freeze to bitty `main` `fb44a867`
(PR #1641, verified as the remote tip) with no v1 verdict move. Two host
surface changes landed since `2cb49afe` (the remaining commits in range touch
no Lua v1 verdict):

- W-28 (bitty #1633, CTX-0941): the focusable overlay and transient
  input-capture host mechanism with provisional spellings
  `bitty.ui.overlay.acquire`/`release`/`poll`, gated by the existing
  closed-set `ui.overlay` grant with no new capability identifier and two
  typed errors (`E_UI_ALREADY_CAPTURED`, `E_UI_NOT_OWNER`). The PR is the
  mechanism only; routing real key, IME, and pointer events, per-tick expiry,
  focus-switch and cancel revoke, and overlay rendering are the tracked
  follow-up CTX-0943 and have not landed. The spellings are now superseded by
  the accepted W-01 `bitty.ui.overlay.*` surface above (CTX-0065).
- W-29 (bitty #1641, CTX-0942, re-scoped minimal per DEC-0085): thin Lua
  bindings over the existing beacon mechanism types only
  (`bitty.ui.targets.snapshot`/`register`/`unregister`/`session_start`/
  `session_cancel`/`dispatch` and `bitty.ui.labels.set_policy`/`assign`),
  with no new struct, enum, namespace, or capability and no target or
  annotation Event-Bus exposure.

The thin targeting bindings stay provisional host candidates pending per
W-120: deferred and not wired into v1. The SDK records them honestly as
explicit exclusions (`bitty.ui.targets`, `bitty.ui.labels`) with no new
function path, no new capability identifier, and no mock method. All 14 v1
namespace verdicts and the `debug.control` function override keep their
previous values; the pin PR stays 1641 while the last v1 verdict move
remains PR 1584. Re-evaluate when an accepted contract authorizes the
spellings.

## Validation

```sh
just check              # includes lua-defs-check and host-parity-check
just lua-defs-write     # regenerate lua/bitty.d.lua after a reviewed surface change
just lua-defs-luals     # LuaLS conformance; skips with exit 0 when the binary is absent
just host-parity-check  # surface/model/defs/mock/fixture parity agreement
```

## Host parity and regen-sync

The surface table pins the bitty host revision it was frozen against
(`hostParity`: repository `bitty`, commit `fb44a867` re-verified at bitty
`main` tip (PR #1641, CTX-0067, W-43); last v1 verdict move PR 1584, verdict
set provenance #1303) and one verdict per namespace: every namespace is
`wired`
except `env`, which is `deferred`, plus the per-function override
`debug.control: deferred`. `process.spawn` is v1-OUT and stays excluded.
`bitty.network` also stays excluded: bitty #1604 (DIR-030) removed the
embedded Lua network binding from Core, and network access now belongs to
the out-of-process `net` native component, whose Lua request surface is
deferred and not wired. The W-29 `bitty.ui.targets` and `bitty.ui.labels`
sub-tables stay excluded as pending per W-120 (see
[Pending surface](#pending-surface-targeting-w-29-ctx-0067)); the W-28
overlay mechanism is now the accepted W-01 surface (see
[Accepted overlay surface](#accepted-overlay-surface-w-01-ctx-0065)). No v1
verdict moved at `fb44a867`.

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
