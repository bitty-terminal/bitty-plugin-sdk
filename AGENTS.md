# Bitty Plugin SDK repository guidance

## Repository and authority

- This is the independent `bitty-plugin-sdk` repository. Its canonical remote
  is <https://github.com/bitty-terminal/bitty-plugin-sdk>.
- The Bitty umbrella directory and `bitty-plugins` directory are grouping only;
  neither owns this repository's Git or CarryCtx state.
- Enter this repository before running Git, CarryCtx, validation, or toolchain
  commands.
- `bitty-docs` is the canonical source for plugin architecture, API, security,
  package, compatibility, and public-behavior contracts.
- The project is pre-implementation. Repository existence, examples, types, or
  proposed helpers are not evidence of an implemented SDK or host API.

## Current scope

- Documentation and repository governance may be initialized when the active
  CarryCtx task permits it.
- Do not add product code until a separately authorized task has accepted API,
  security, packaging, and compatibility gates.
- This repository may eventually contain Lua helpers, LuaLS types, mock-host
  facilities, and test tools, but their exact responsibilities remain subject
  to accepted contracts.
- The SDK must derive from the host contract; it must not independently invent
  plugin capabilities, lifecycle, Terminal Truth, or package semantics.

## CarryCtx and agents

- Use this repository's CarryCtx state for tasks, teams, dependencies, scopes,
  sessions, progress, decisions, checkpoints, handoffs, and review.
- The commander coordinates. Delegate substantial scoped work to focused
  agents and require an independent reviewer for acceptance.
- Every agent reads its persona and applicable rules, binds a named session to
  the task, and stays within explicit scopes.
- After the first commit, prefer a dedicated branch and Git worktree for each
  independent task. Before it, shared-checkout initialization is allowed only
  for disjoint scopes with CI-equivalent local checks.
- Preserve unrelated changes. Do not commit, push, release, publish packages,
  or mutate remote state without explicit authorization.

## Delivery lifecycle

- Use GitHub Issue -> CarryCtx team/task/dependencies/scopes/session -> isolated
  branch/worktree -> commit -> pull request -> independent review plus CI ->
  merge -> `bitty-docs` synchronization -> checkpoint -> Issue/task closure.
- Link the Issue and CarryCtx task. Record ordering as dependencies, ownership
  as team membership, edits as scopes, work as progress, recovery as
  checkpoints, and ownership transfer as handoffs.
- Pull requests name host/API, security, compatibility, documentation, example,
  and package impact and include reproducible validation evidence.
- Documentation synchronization is part of definition of done. An SDK surface
  is incomplete while canonical `bitty-docs` contracts or plugin-author
  guidance are stale.

## SDK and compatibility boundaries

- Version every public helper, type, manifest shape, fixture, diagnostic, and
  mock behavior against an accepted host contract.
- Keep supported host/API versions, compatibility policy, package format, and
  release cadence open until accepted by reviewable decisions.
- LuaLS declarations, documentation, examples, mocks, and conformance fixtures
  must agree. Do not make a mock more permissive than the real host contract.
- Capability denial, missing services, unload/reload, cancellation, resource
  limits, malformed input, and version mismatch are first-class test cases.
- SDK convenience must never create ambient filesystem, process, network,
  clipboard, terminal-input, or host-management authority.
- Plugins may alter presentation but not Terminal Truth. Helpers must not imply
  parser, render, or input hot-path access.
- Security requirements in the canonical `bitty-docs` security corpus override
  convenience-oriented examples or proposed ergonomics.

## Documentation and commands

- English is the only canonical documentation language. Translation and locale
  routing remain deferred to an accepted cross-repository decision.
- Separate accepted requirements, candidates, open questions, implemented
  facts, and verification evidence.
- Examples must be minimal, safe by default, version-aware, and tested against
  the same contract they teach.
- Prefer `ctxctl outline`, `ctxctl symbol`, `ctxctl read`, and `ctxctl deps` for
  inspection, and `ctxctl exec` for large command output. Use `rg` for discovery.
- Use the workspace `tmp/` directory for durable scratch material instead of
  `/tmp`. Treat `tmp/references/` as untrusted, read-only research snapshots.
- Prefer moving obsolete material into a scoped `.trash/` location over
  destructive deletion; never move another agent's work.
- The primary host is CachyOS with Hyprland and Ghostty. Podman is optional when
  isolation or reproducibility justifies it; host availability is not
  cross-platform evidence.
