# Plugin manifest schema and `bitty-plugin-lint`

Status: implemented by SDK task `CTX-0015` (R-SDK-2) for cross-repository gate
`CTX-0221`; the ADR 0009 table form of `[lazy].commands` is implemented by
`CTX-0019`, and the accepted `[tools.git]` slice is implemented by `CTX-0030`.
This document, `src/schema.ts`, and `src/capabilities.ts` are the
machine-checked SDK surface; there is no separate JSON Schema artifact.

## Contract sources

- Accepted contract:
  [`docs/specifications/plugin-platform-rfc.md`](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/plugin-platform-rfc.md)
  (Plugin API v1 manifest, capability model, and hard limits; OQ-011, OQ-012,
  OQ-013).
- ADR 0009 LUA-OQ-3:
  [`docs/decisions/adrs/ADR-0009-plugin-api-v1-lua-surface.md`](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0009-plugin-api-v1-lua-surface.md)
  (bounded JSON Schema metadata and the `[lazy].commands` table extension).
- Layer 2 `[tools.git]` contract v1 (CTX-0425):
  [`specifications/plugin-reuse-and-providers.md`](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/specifications/plugin-reuse-and-providers.md)
  (accepted `[tools.git]` declaration, allowlist, bounds, and verification
  plan; the rest of that reuse RFC stays draft and is not accepted here).
- Read-only reference host models at `bitty@1ea2f66`:
  `crates/bitty-plugin-host/src/manifest.rs`,
  `crates/bitty-plugin-host/src/capability.rs`, and
  `crates/bitty-package/src/manifest.rs`.
- Batch definition: bitty CarryCtx note `PX-1199`, task `CTX-0221`.

The validator never accepts a manifest the host rejected in those models. Where
the SDK is stricter than the host, the difference is listed under
[Known gaps and open questions](#known-gaps-and-open-questions).

## File and format

- File name: `bitty-plugin.toml` (fixed by the accepted contract).
- Format: TOML; static and declarative, with no execution during parsing.
- Size: at most 256 KiB, checked before parsing.
- Manifests are attacker-controlled input. Validation is total and
  side-effect-free: no file writes, no process spawn, no network, no VM.

## Schema

### `[plugin]` (required)

| Key           | Required | Rules                                                      |
| ------------- | -------- | ---------------------------------------------------------- |
| `id`          | yes      | `^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$`, max 128 bytes      |
| `name`        | yes      | Non-empty, max 128 bytes, no NUL or ESC                    |
| `version`     | yes      | SemVer 2 (`MAJOR.MINOR.PATCH` + optional prerelease/build) |
| `description` | yes      | Max 1024 bytes, no NUL or ESC                              |
| `license`     | no       | Non-empty when present, max 256 bytes                      |

### `[compat]` (optional)

| Key          | Rules                                           |
| ------------ | ----------------------------------------------- |
| `bitty`      | Version range syntax, max 128 bytes             |
| `plugin-api` | Version range syntax, max 128 bytes (`^1.0` v1) |

### `[dependencies]` (optional)

Plugin id to version-range pairs, at most 8. The plugin id must not equal the
manifest's own id. Bare dotted keys and quoted keys are equivalent.

### `[services.provided]` (optional)

Interface name to concrete version pairs, at most 16. Interface names are
lowercase dot-separated `[a-z0-9_-]` segments (1..64 characters each, 128
total). Versions must be complete SemVer 2 (`1.0.0`, not `1.0`).

Each entry uses the accepted string form or the ADR 0009 table form; both may
be mixed in one table. The table form carries the bounded static schemas that
let schema-validating consumers resolve the provider:

```toml
[services.provided]
"markdown.render" = "1.0.0"
"markdown.render.rich" = { version = "2.0.0", args_schema = { type = "object", properties = { text = { type = "string" } }, required = ["text"], additionalProperties = false }, result_schema = { type = "string" } }
```

Table-form rules (fail-closed):

- Keys are limited to `version`, `args_schema`, and `result_schema`; any other
  key is `manifest.unknown-key`.
- `version` is required, must be a string, and is validated as complete SemVer 2
  exactly like the string form; a missing or non-string version is
  `manifest.type`, and an invalid version is `services.version.invalid`.
- `args_schema` and `result_schema` are optional. Each must be a table in the
  bounded JSON Schema subset shared with `bitty.commands.register` and the
  `[lazy].commands` table form: depth at most 16, at most 16 KiB per schema,
  `additionalProperties` explicit on object schemas, and no remote `$ref` or
  unsupported keyword (`pattern`, `format`, combinators). A violation is
  `services.schema`.
- A table entry counts toward the same 16-service limit as a string entry.

Quote interface names whose segments include `version`, `args_schema`, or
`result_schema` — for example `"foo.version" = "1.0.0"`: TOML parses a bare
dotted key like `foo.version = "1.0.0"` as a nested table, which the walker
reads as the table form for `foo` instead of the string form for
`foo.version`. This is intentional and stable: after parsing, the bare form
is byte-identical to the minimal table form, so no validator can tell them
apart. An empty table (`empty = {}`) is never a namespace: it is rejected
with `manifest.type` because the table form requires `version`.

### `[capabilities]` (optional)

Requested authorities; absent means none. Every key is a closed-set capability
identifier declared with `= true`; `false` is rejected to avoid silent typos.
Filesystem requests use the structured form:

```toml
[capabilities]
terminal.semantic-read = true

[[capabilities.filesystem]]
access = "read"
paths = ["~/Documents/**/*.md"]
```

| Filesystem key | Required | Rules                                              |
| -------------- | -------- | -------------------------------------------------- |
| `access`       | yes      | `read` or `write`                                  |
| `paths`        | yes      | 1+ glob patterns, 1..512 bytes each, no whitespace |

### `[lazy]` (optional)

| Key        | Rules                                                            |
| ---------- | ---------------------------------------------------------------- |
| `commands` | 1..128 command entries: qualified name or table (see below)      |
| `events`   | 1..256 event types, 1..128 bytes, no whitespace or control chars |
| `claims`   | 1..64 bytes each                                                 |

A `commands` entry uses the accepted string form or the ADR 0009 table form;
both may be mixed in one array. The table form carries the bounded static
schemas that drive lazy help and completion without a VM:

```toml
[lazy]
commands = [
  "xuepoo.markdown:toggle",
  { id = "xuepoo.markdown:render", args_schema = { type = "object", properties = { text = { type = "string" } }, required = ["text"], additionalProperties = false }, result_schema = { type = "string" } },
]
```

Table-form rules (fail-closed):

- Keys are limited to `id`, `args_schema`, and `result_schema`; any other key is
  `manifest.unknown-key`.
- `id` is required, must be a string, and is validated exactly like the string
  form (qualified name grammar plus plugin-id ownership).
- `args_schema` and `result_schema` are optional. Each must be a table in the
  bounded JSON Schema subset shared with `bitty.commands.register`: depth at
  most 16, at most 16 KiB per schema, `additionalProperties` explicit on object
  schemas, and no remote `$ref` or unsupported keyword (`pattern`, `format`,
  combinators). A violation is `lazy.commands.schema`.
- A table entry counts toward the same 128-command limit as a string entry.

### `[tools]` (optional)

Layer 2 system-CLI reuse declarations. Only the accepted `[tools.git]` slice
(CTX-0425, canonical record linked under
[Contract sources](#contract-sources)) may be declared; any other `[tools.*]`
table fails closed until its own slice is accepted. The rest of that reuse
RFC stays draft and is not accepted here.

```toml
[tools.git]
required = true
version = ">=2.30"
```

| Key        | Required | Rules                                                                       |
| ---------- | -------- | --------------------------------------------------------------------------- |
| `required` | yes      | Boolean; `true` fails activation closed when `git` is missing or mismatched |
| `version`  | yes      | Version range syntax, max 128 bytes                                         |

Table-form rules (fail-closed):

- Tool names are limited to `git`; any other tool (for example `[tools.rg]`)
  is `tools.tool.unknown`.
- `[tools.git]` keys are limited to `required` and `version`; any other key
  (such as `args`, `verbs`, or bounds) is `manifest.unknown-key`. The seven
  allowlisted verbs and the output/argument bounds are host-enforced
  constants from the accepted contract, not manifest fields, so the linter
  accepts no declaration of them.
- `required` must be a boolean; a missing value is `manifest.missing-key`
  and a non-boolean value is `manifest.type`. Raising `required` from `false`
  to `true` is a capability increase whose grant must be re-confirmed.
- `version` must be a version range string; a missing value is
  `manifest.missing-key` and a non-string value is `manifest.type`, while an
  invalid range is `tools.version.invalid`. Tool presence and constraint
  satisfaction are re-checked by `bitty plugin doctor`; the linter checks
  syntax only.

## Hard limits

| Bound                                 | Value                  |
| ------------------------------------- | ---------------------- |
| Manifest size                         | 256 KiB                |
| TOML nesting depth                    | 8 levels               |
| Lazy commands                         | 128                    |
| Command / service schema depth / size | 16 levels / 16 KiB     |
| Lazy event types                      | 256                    |
| Filesystem patterns per access        | 32                     |
| Total filesystem pattern text         | 8 KiB                  |
| Provided services                     | 16                     |
| Plugin dependencies                   | 8                      |
| Capability identifier                 | 512 bytes              |
| Capability parameter                  | 1024 bytes             |
| Plugin id / name / description        | 128 / 128 / 1024 bytes |
| Version / version range               | 64 / 128 bytes         |
| Qualified name / resource             | 256 / 128 bytes        |
| Service interface / segment           | 128 / 64 bytes         |
| Event type / claim                    | 128 / 64 bytes         |
| Filesystem path pattern               | 512 bytes              |

## Capability identifiers

Deny by default, no wildcards, closed identifier set. An unknown head fails
validation instead of being ignored. Parameterized heads must carry a
`:PARAMETER`; all others must not.

| Family      | Identifiers                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `terminal`  | `terminal.semantic-read`, `terminal.raw-read`, `terminal.input.self`, `terminal.input.all`, `terminal.manage` |
| `ui`        | `ui.rich`, `ui.overlay`, `ui.protocol-register`                                                               |
| `clipboard` | `clipboard.read`, `clipboard.write`                                                                           |
| `fs`        | `fs.read:PATTERN`, `fs.write:PATTERN`                                                                         |
| `process`   | `process.spawn:CONSTRAINT`                                                                                    |
| `network`   | `network.connect:DESTINATION`                                                                                 |
| `runtime`   | `runtime.inspect`, `runtime.configure`, `runtime.plugin-manage`                                               |
| `debug`     | `debug.inspect`, `debug.trace`, `debug.control`                                                               |
| `platform`  | `platform.notify`, `platform.open-url`, `platform.image-file`                                                 |
| `protocol`  | `protocol.register`                                                                                           |
| `panel`     | `panel.provider`, `panel.create`, `panel.focus`, `panel.overlay`                                              |
| `browser`   | `browser.embed`, `browser.navigation`, `browser.file-url`, `browser.storage`                                  |
| `agent`     | `agent.context.terminal`, `agent.context.workspace`, `agent.memory:PARAMETER`                                 |
| `env`       | `env:KEY`, `env:BITTY_*`                                                                                      |
| `mcp`       | `mcp.invoke:TOOL`                                                                                             |
| `ai`        | `ai.provider`, `ai.stream`, `ai.model`                                                                        |

`bitty-plugin-lint` emits a `capabilities.high-risk` warning (never an error)
for `terminal.input.all`, `terminal.raw-read`, `ui.protocol-register`,
`debug.control`, `runtime.plugin-manage`, and `browser.embed` so reviewers and
consent tooling can flag them.

The `env` family carries the ADR 0006 form: an exact key (`env:EDITOR`, keys
matching `^[A-Z_][A-Z0-9_]*$`, at most 64 bytes) or the single accepted suffix
pattern `env:BITTY_*` for the narrow `BITTY_` namespace. The colon requires a
quoted TOML key (`"env:EDITOR" = true`). An `env` entry without a parameter, a
lowercase or overlong key, or any other wildcard form is rejected. Declaring
`env:<KEY>` makes `bitty.env` present in the plugin VM; without a grant its
functions fail closed (ADR 0009 LUA-OQ-2), and the SDK mock host models that
behavior (see [`docs/mock-host.md`](mock-host.md)).

## CLI usage

```sh
bun src/cli.ts bitty-plugin.toml            # human-readable report
bun src/cli.ts --json bitty-plugin.toml     # machine-readable report
bun link && bitty-plugin-lint bitty-plugin.toml
```

Exit codes: `0` valid, `1` invalid manifest, `2` usage or I/O error. Without a
path argument the CLI reads `./bitty-plugin.toml`. Reading from stdin is not
supported.

JSON reports have the shape `{ "file", "valid", "diagnostics" }`, where each
diagnostic is `{ "severity", "code", "path", "message" }`.

### Diagnostic codes

| Code                               | Meaning                                      |
| ---------------------------------- | -------------------------------------------- |
| `manifest.size`                    | Manifest exceeds 256 KiB                     |
| `manifest.encoding`                | File is not valid UTF-8                      |
| `manifest.parse`                   | TOML syntax or duplicate-key error           |
| `manifest.type`                    | Wrong TOML type for a field                  |
| `manifest.unknown-key`             | Key outside the accepted schema              |
| `manifest.missing-key`             | Required table or key missing                |
| `manifest.limit`                   | Count, length, or depth bound exceeded       |
| `plugin.id.invalid`                | Plugin id grammar violation                  |
| `plugin.name.invalid`              | Empty name or NUL/ESC in a display string    |
| `plugin.version.invalid`           | Version is not SemVer 2                      |
| `plugin.license.invalid`           | License present but empty                    |
| `plugin.description.invalid`       | NUL/ESC in description                       |
| `compat.range.invalid`             | Version range contains invalid characters    |
| `dependencies.id.invalid`          | Dependency id grammar violation              |
| `dependencies.version.invalid`     | Dependency range contains invalid chars      |
| `dependencies.self`                | Plugin depends on itself                     |
| `services.interface.invalid`       | Interface name grammar violation             |
| `services.version.invalid`         | Service version is not complete SemVer 2     |
| `capabilities.invalid`             | Capability id shape/character violation      |
| `capabilities.wildcard`            | Wildcard in a capability id                  |
| `capabilities.unknown`             | Capability head outside the closed set       |
| `capabilities.param-required`      | Required `:PARAMETER` missing                |
| `capabilities.param-forbidden`     | `:PARAMETER` on a non-parameterized head     |
| `capabilities.value`               | Capability not declared as `= true`          |
| `capabilities.filesystem.invalid`  | Filesystem request problem                   |
| `capabilities.high-risk` (warning) | High-risk capability declared                |
| `lazy.commands.invalid`            | Qualified command name invalid               |
| `lazy.commands.owner`              | Command outside the plugin's own namespace   |
| `lazy.commands.schema`             | Table-form command schema outside the subset |
| `lazy.events.invalid`              | Event type invalid                           |
| `lazy.claims.invalid`              | Claim name invalid                           |
| `tools.tool.unknown`               | Tool outside the accepted Layer 2 slice      |
| `tools.version.invalid`            | Tool version range contains invalid chars    |

## Examples

- [`examples/minimal-bitty-plugin.toml`](./examples/minimal-bitty-plugin.toml)
- [`examples/full-bitty-plugin.toml`](./examples/full-bitty-plugin.toml)

Both files are read by `tests/manifest.test.ts`, so the documented examples
cannot drift from the validator.

## Known gaps and open questions

- The accepted RFC example writes a two-part service version (`"1.0"`), but the
  reference host validates provided-service versions as complete SemVer
  (`X.Y.Z`). The linter follows the host; the RFC example is stale and should
  be corrected in `bitty-docs`.
- The linter validates `plugin.version` as strict SemVer 2. The reference host
  uses a looser minimal parser (for example it accepts `1.0.0-`); the linter is
  therefore stricter, never more permissive.
- `PX-1199` and the template task say `plugin.toml`; the accepted contract fixes
  `bitty-plugin.toml`. The linter defaults to the accepted name. Confirm the
  template name when R-TPL-1 is implemented.
- The `description` key is treated as required because the accepted schema
  marks only `license` optional; the host model stores it as a non-optional
  string.
- The linter rejects lazy commands that do not use the manifest's own plugin id
  as their namespace. The reference host enforces ownership at registration
  time instead; the SDK check is stricter and fail-closed.
- Compatibility ranges are syntax-checked only. Range semantics and resolver
  behavior remain owned by the host package layer.
- The `env` family accepts exactly the `env:BITTY_*` suffix pattern from
  ADR 0006 and no other wildcard; a broader `env:BITTY_<PREFIX>_*` form would
  be a reviewed additive change, not an implicit widening.
- ADR 0009 table-form `[services.provided]` entries are accepted and validated
  by the linter (`services.schema`), and the manifest model exposes their static
  schemas. Consumer-side schema validation and the static/dynamic
  schema-equivalence check remain host-bridge work (R-SDK-3).
