# Contributing to bitty-plugin-sdk

This guide is for contributors to the `bitty-plugin-sdk` repository. The
repository is pre-implementation: everything here is governance scaffolding,
SDK tooling, generated LuaLS declarations, and candidate conventions, not
shipped product behavior. Do not add product code until a separately authorized
task has accepted the API, security, packaging, and compatibility gates.

## Repository ground rules

- Read [AGENTS.md](AGENTS.md) before making any change. It defines authority,
  scope boundaries, CarryCtx workflow, SDK and compatibility boundaries, and
  the toolchain policy that overrides convenience.
- Canonical plugin architecture, API, packaging, compatibility, and security
  contracts live in `bitty-docs` and `bitty-plugins-docs`. The SDK derives from
  the host contract; it must not invent plugin capabilities, lifecycle
  semantics, Terminal Truth, or package semantics independently.
- Never commit, push, publish packages, or mutate remote state without
  explicit authorization from the owning task.

## Prerequisites

Toolchain expectations (dependency versions are pinned in
[package.json](package.json) and locked in `bun.lock`; never invoke formatters
or linters by name):

- `just` — command runner owning all quality-gate invocations; the justfile
  pins the version of every gate tool it invokes.
- `bun` / `bun run <bin>` — JavaScript execution and package management. Never
  use `npm`, `npx`, or `yarn` in any Bitty repository.
- `markdownlint-cli2`, `prettier`, `commitlint`, `lefthook` — invoked through
  the justfile; `just install` materializes the locked package dependencies
  first.

The canonical toolchain matrix lives in
`bitty-docs/docs/development/toolchain-policy.md`; treat it as authoritative
where this file is silent.

## Development setup

1. Enter this repository before running Git, CarryCtx, or toolchain commands.
2. Install pinned development dependencies: `just install`.
3. Enable Git hooks (optional): `just hooks-install`.
4. Run all quality gates: `just check` (Markdown lint, Prettier format check,
   type-check, test suites, and Lua-definition drift check). CI runs the same
   aggregate target.
5. Record scoped work in CarryCtx (task, session, progress, checkpoint) and
   stop at review; independent review is required for acceptance.

## Delivery lifecycle

Changes follow Issue -> Branch -> Commit -> Pull Request -> Review -> Merge,
where independent review plus required CI must pass before merge. Commit
messages follow Conventional Commits and are validated by
[commitlint.config.ts](commitlint.config.ts).

Every pull request states its Issue and CarryCtx task links, impact areas
(host/API, security, compatibility, documentation, examples, packaging),
security and privacy impact, reproducible gate evidence, and
documentation-synchronization status. Labels (`feat`/`fix`/`docs`/`chore`,
`P0`/`P1`/`P2`, `area:*`) and milestone `v0.1.0` are kept in sync.

## Contributor branches

The project is managed with CarryCtx. Official branches follow the CarryCtx
task convention `ctx-XXXX/<type>-<slug>`, where `XXXX` is the owning task id,
`<type>` is one of `feat|fix|chore|docs`, and the slug is short kebab-case.
Commander housekeeping branches use `cmd/<slug>`.

External contributors must use a distinguishable prefix such as
`<github-handle>/<type>-<slug>` (for example `octocat/fix-lint-message`) so
their branches are never confused with maintainer task branches.

## Capabilities and privacy

The SDK describes and validates the host's deny-by-default capability model; it
must never widen it. Manifest validation, generated declarations, mocks, and
helpers stay least-privilege and must not introduce ambient filesystem,
process, network, clipboard, terminal-input, or host-management authority.
Never add secrets, install-time code execution, or permissive allow-all
defaults as a side effect of an unrelated change.

## Workflow snapshots

The engineering workflow snapshot lives in this repository on the branch
`refs/heads/carryctx-snapshots`. Merges run `just workflow-publish` (dry run:
`just workflow-publish-dry`) as part of the commander closeout; snapshots are
redacted publication artifacts and are never merged back. Fresh clones restore
with `just workflow-import` (`just workflow-import-dry`).

## Reporting

Report bugs and feature requests through the GitHub issue templates. Report
security issues privately per [SECURITY.md](SECURITY.md).
