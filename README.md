# Bitty Plugin SDK

This repository provides developer-facing support for Bitty plugins: the
accepted-contract validator for `bitty-plugin.toml` with the
`bitty-plugin-lint` CLI, generated Plugin API v1 LuaLS declarations, and the
Plugin API v1 mock host with its conformance fixtures. The Lua helper SDK
remains pre-implementation under its own task.

## See the project workflow (CarryCtx)

CarryCtx is the local-first tool that records this project's tasks, decisions,
and checkpoints. Install it globally for local development (recommended):

```sh
cargo install carryctx      # Rust toolchain, or: npm i -g carryctx
```

CarryCtx engineering state (tasks, sessions, checkpoints) is not cloned. A
fresh clone restores it from the in-repo `refs/heads/carryctx-snapshots`
branch:

```sh
just workflow-import-dry   # fetch + validate the snapshot; no DB writes
just workflow-import       # initialize CarryCtx state if needed, then import
```

Then `carryctx stats` reports the restored tasks, sessions, and checkpoints.
Provenance, redaction, and `--force` behavior are covered under the
repository snapshot documentation below.

## Ownership boundary

This repository will own SDK-specific implementation evidence and contributor
guidance after separately reviewed tasks authorize them. It does not own the
Bitty host, plugin runtime, capability model, lifecycle, package format, or
Terminal Truth.

Canonical product and plugin contracts belong to the
[bitty-docs repository](https://github.com/bitty-terminal/bitty-docs). The
[plugin-system specification](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/extensibility/plugin-system.md)
and the
[security overview](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/security/overview.md)
govern future SDK work. An SDK surface must derive from an accepted and verified
host contract; it cannot create host behavior by documenting it first.

## Manifest schema and linter

The SDK validates `bitty-plugin.toml` against the accepted Plugin API v1
manifest and capability contract in `bitty-docs`. Validation is fail-closed:
unknown keys are rejected at every schema level, capability identifiers are
checked against the closed v1 set, and every count and length bound is
enforced before a manifest is accepted.

```sh
just test                                   # schema, limit, and CLI tests
bun src/cli.ts bitty-plugin.toml            # human-readable report
bun src/cli.ts --json bitty-plugin.toml     # machine-readable report
```

The schema, diagnostic codes, capability table, and known contract gaps are
documented in [`docs/manifest.md`](docs/manifest.md), with validated examples
under [`docs/examples/`](docs/examples/).

### Consuming the linter from a plugin repository

Generated plugin repositories run the authoritative linter instead of a local
re-implementation. `bitty-plugin-lint` is plain TypeScript with a
`#!/usr/bin/env bun` shebang, so the dependency needs no build step and no
registry publication; Bun must be on `PATH`:

```sh
bun add --dev "github:bitty-terminal/bitty-plugin-sdk#<40-char-commit-sha>"
bun run bitty-plugin-lint bitty-plugin.toml
```

Pin the full commit SHA: branch and tag refs move, so the validation contract
is stable only per commit. The `github:` specifier
resolves only after the pinned commit is pushed to the canonical remote. For
local development against an unpublished checkout, use a local dependency
instead (`bun add --dev "file:/path/to/bitty-plugin-sdk"` or `bun link`). The
SDK is not published to a registry (`private: true`), so registry-based
`bunx`/`npx` installs do not resolve.

## Plugin API v1 LuaLS definitions

`lua/bitty.d.lua` is generated from the accepted Plugin API v1 surface in
`surface/bitty-plugin-api-v1.json` and checked for drift by `just check`
(`just lua-defs-check`). The declarations cover L1 Control and the minimal L2
UI surface only plus the closed v1 event set. Every surface exclusion is
enforced textually against the generated file by `tests/lua-defs.test.ts`; the
LuaLS negative fixture samples excluded names, the excluded `raw` scope
literal, and wrong-shape `services.get` calls. LuaLS conformance runs locally
only: CI has no `lua-language-server`, so that check skips there.

See [`docs/lua-defs.md`](docs/lua-defs.md) for LuaLS setup, coverage,
exclusions, and validation commands, and
[`lua/examples/minimal-init.lua`](lua/examples/minimal-init.lua) for a runnable
example.

## Mock host and conformance fixtures

The Plugin API v1 mock host models the accepted `bitty` host bridge for
conformance testing: deny-by-default capability gates with the typed
`E_CAPABILITY_DENIED` denial, the activation-only registration window,
generation-owned handles, the closed v1 event set, bounded command/store/UI/
snapshot data, services, and tasks/timers on a virtual clock. It performs no
I/O, spawns no process, and opens no network.

```sh
just conformance                    # run the declarative fixture suite
bun test tests/mock-host.test.ts    # unit-level behavior suite
just check                          # all quality gates
```

Fixtures live under [`conformance/`](conformance/); the host contract mapping,
fixture format, and diagnostic codes are documented in
[`docs/mock-host.md`](docs/mock-host.md).

## Workflow snapshot restore

CarryCtx runtime state (`.git/carryctx/state.sqlite`) is never cloned. The
redacted engineering snapshot lives in this repository on the branch
`refs/heads/carryctx-snapshots`, one commit per publication. The commander's
merge closeout publishes it with `just workflow-publish`; a fresh clone
restores its local CarryCtx DB from that branch:

```sh
just workflow-import-dry   # fetch + validate the snapshot; no DB writes
just workflow-import       # initialize CarryCtx state if needed, then import
```

The import fetches `refs/heads/carryctx-snapshots`, refuses to replace a
non-empty local DB without `--force` (`just workflow-import --force`), and
prints provenance (snapshot commit + source). Snapshots are redacted
publication artifacts produced by `carryctx export --publication`: CarryCtx
refuses them as merge sources, so restore always uses replace mode, and a
secret that leaked before rotation must still be rotated at the source.

## Current status

This repository does not currently provide:

- a Lua helper SDK or library;
- public Lua functions or host APIs beyond the generated declarations and the
  test-double mock host;
- a published package or registry release (the linter is consumed as a
  commit-pinned Git dependency);
- host-version compatibility, deprecation, or support promises; or
- a release, release schedule, or publication channel.

The `bitty-plugin-lint` CLI and the manifest validator are local developer
tooling. They do not install, execute, or activate plugins.

Repository existence and planned boundaries are not implementation or release
evidence.

## Security and generation boundary

Future convenience APIs must remain least-privilege and must not grant ambient
filesystem, process, network, clipboard, terminal-input, or host-management
authority. Canonical security requirements override proposed ergonomics.

The generated declarations and mock-host conformance fixtures were produced
under explicitly scoped tasks with accepted source contracts, deterministic
validation, and independent review. Any further generated declarations,
examples, fixtures, or packages require the same gates. Nothing is installed,
published, or released by this README.
