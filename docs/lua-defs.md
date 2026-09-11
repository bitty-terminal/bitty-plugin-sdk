# Plugin API v1 LuaLS definitions

Status: implemented by SDK task `CTX-0014` (R-SDK-1) for cross-repository gate
`CTX-0221`; corrected by SDK task `CTX-0017` (required `services.get` option
shape and validation-claim accuracy). The definitions in `lua/bitty.d.lua` are
generated from the machine-readable surface table
`surface/bitty-plugin-api-v1.json`; the drift check in
`scripts/generate-lua-defs.ts` runs as part of `just check`. No other LuaLS
artifact exists for Plugin API v1.

## Contract sources

- Accepted contract:
  [ADR 0009](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0009-plugin-api-v1-lua-surface.md)
  (resolutions for LUA-OQ-1 through LUA-OQ-12) and the accepted
  [Plugin API v1 Lua Surface RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-api-v1-lua-surface-rfc.md)
  (module root `bitty`, one spelling per concept, the closed v1 event set, the
  L1/L2 split, and the exclusion list).
- Referenced accepted contracts: ADR 0006 (`bitty.env`), ADR 0007
  (tasks/timers caps), the Plugin Platform RFC (manifest, capabilities,
  pipeline), the TerminalRegistry and View Lifecycle Contract (identity tuple,
  `TerminalClosed`/`TerminalExited`), the Rich Presentation RFC (`SceneNode`,
  zones), the CLI Contract RFC (JSON Schema limits), and the Configuration
  Model RFC (chord grammar).
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
- `bitty.env` is absent unless the manifest declares an `env:<KEY>`
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
- Annotations list the capability gate and the accepted error codes for each
  function where the accepted corpus names them.

## Coverage

The surface table covers L1 Control and the minimal L2 UI surface only:
12 namespaces, 19 functions, and the closed 17-name event set.

| Namespace  | Functions          | Level | Capability                                   |
| ---------- | ------------------ | ----- | -------------------------------------------- |
| `commands` | `register`         | L1    | none                                         |
| `events`   | `subscribe`        | L1    | none                                         |
| `keymaps`  | `suggest`          | L1    | none                                         |
| `settings` | `get`, `set`       | L1    | none                                         |
| `store`    | `get`, `set`       | L1    | none (quota-bounded)                         |
| `notify`   | `show`             | L1    | `platform.notify`                            |
| `env`      | `get`, `has`       | L1    | `env:<KEY>` (namespace optional)             |
| `services` | `get`, `provide`   | L1    | none                                         |
| `ui`       | `mount`, `update`  | L2    | `ui.rich`; `ui.overlay` for the overlay slot |
| `terminal` | `snapshot`         | L2    | `terminal.semantic-read`                     |
| `tasks`    | `spawn`, `cancel`  | L1    | none (64-task cap)                           |
| `timers`   | `create`, `cancel` | L1    | none (32-timer cap, one-shot)                |

The accepted RFC classifies the `services.get` consumer side as cross-cutting
within v1; the tasks and timers functions were resolved as v1 additions by
ADR 0009. They are carried here alongside L1 rather than as separate levels,
and no Level 3 or Level 4 element is present.

| Event class  | Names                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle    | `plugin.activated`, `plugin.suspended`, `plugin.disposed`, `handler.violation`                                                                                                     |
| Observation  | `terminal.opened`, `terminal.closed`, `terminal.title-changed`, `terminal.cwd-changed`, `terminal.bell`, `focus.changed`, `selection.changed`, `process.exited`, `config.reloaded` |
| Interception | `intercept.command-dispatch`, `intercept.terminal-spawn`, `intercept.paste`, `intercept.open-url`                                                                                  |

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

## Validation

```sh
just check              # includes lua-defs-check: definitions match the surface table
just lua-defs-write     # regenerate lua/bitty.d.lua after a reviewed surface change
just lua-defs-luals     # LuaLS conformance; skips with exit 0 when the binary is absent
```

`just lua-defs-luals` runs `lua-language-server --check` twice: the generated
definitions plus `lua/examples/minimal-init.lua` must diagnose cleanly, and
`tests/lua-defs/negative-fixture.lua` must be rejected for sampled excluded
identifiers, the excluded `raw` scope literal, and wrong-shape `services.get`
calls (missing `opts`, and `opts` without `version`). `bun test` also runs the
same conformance check when `lua-language-server` is on `PATH` (or
`LUA_LANGUAGE_SERVER` is set) and skips it otherwise.

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
