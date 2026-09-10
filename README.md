# Bitty Plugin SDK

This repository is the future home of developer-facing support for Bitty
plugins. It is currently unborn and pre-implementation: governance files exist,
but there is no initial commit or usable SDK.

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
- public types, functions, errors, capabilities, or lifecycle APIs;
- a plugin manifest or package schema;
- examples, fixtures, mocks, conformance tools, or generated artifacts;
- installation commands or a published package;
- host-version compatibility, deprecation, or support promises; or
- a release, release schedule, or publication channel.

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
