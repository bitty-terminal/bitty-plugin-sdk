# Bitty Plugin SDK

This repository provides developer-facing support for Bitty plugins: the
accepted-contract validator for `bitty-plugin.toml` with the
`bitty-plugin-lint` CLI, and the Plugin API v1 mock host with its conformance
fixtures. The Lua helper SDK and LuaLS declarations remain pre-implementation
under their own tasks.

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

## Workflow mirror restore

CarryCtx runtime state (`.git/carryctx/state.sqlite`) is never cloned. The
engineering workflow is mirrored to
[bitty-plugin-sdk-workflow](https://github.com/bitty-terminal/bitty-plugin-sdk-workflow)
as redacted ctxpack snapshots, with `LATEST` naming the newest snapshot. A
fresh clone can restore its local CarryCtx DB from that mirror:

```sh
just workflow-import-dry   # fetch + validate the LATEST snapshot; no DB writes
just workflow-import       # initialize CarryCtx state if needed, then import
```

The import validates snapshot shape, per-table row counts, and the v2 redacted
stamp before any write, refuses to replace a non-empty local DB without
`--force` (`just workflow-import --force`, or pass flags directly to
`scripts/fetch-ctxpack.sh`), and prints provenance (snapshot id + source
commit) plus restored counts. Mirror snapshots are redacted publication
artifacts: CarryCtx refuses them as merge sources, so restore always uses
replace mode, and a secret that leaked before rotation must still be rotated
at the source.

## Current status

This repository does not currently provide:

- a Lua SDK, helper library, or LuaLS declarations;
- public Lua functions or host APIs beyond the test-double mock host;
- installation commands or a published package;
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

Any future generated declarations, examples, fixtures, or packages require an
explicitly scoped task, an accepted source contract, deterministic validation,
and independent review. Nothing is generated, installed, published, or released
by this README initialization.
