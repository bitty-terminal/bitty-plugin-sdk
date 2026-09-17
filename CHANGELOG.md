# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [Unreleased]

- Restrict MockHost `ui.mount` to the activation window in every UI slot,
  rejecting active/suspended late mounts with `E_REGISTRATION_CLOSED` while
  preserving independent live-block updates and capability/generation checks.
  Correct the lifecycle conformance fixture and add mount, callback, denial,
  and reload regression coverage (CTX-0043 / #85).

- Fix the documented `bitty-plugin-sdk` root import with direct TypeScript
  runtime and type exports for Bun consumers; keep internal subpaths private
  and the CLI entry unchanged. Add independent runtime and TypeScript consumer
  regression tests (CTX-0042 / #84).

- Repository-metadata refresh: `packageManager` pins `bun@1.4.2`, the
  `carryctx` devDependency moves to 0.11.5, a conservative `.gitattributes`
  baseline normalizes text files to LF, and CONTRIBUTING/SECURITY document the
  contributor-branch convention and the canonical security baseline
  (`CTX-0039`).
- Mark the `bitty-plugin-lint` entry point executable so dependency-installed
  `.bin` links run without a build step, and document the commit-pinned
  `github:` consumption path for generated plugin repositories (CTX-0038).
- Adopt the canonical `.editorconfig` baseline (`CTX-0023` slice); the
  repository-metadata baseline guide and ADR-0011 remain Proposed.
- Fix the full plugin example's `[lazy].claims` token from the legacy
  `workspaceline` to `tabline`, the only accepted exclusive UI slot, and pin it
  with a mock-host test that mounting the shipped example does not fail
  `E_UI_CLAIM_REQUIRED` (CTX-0037 / #61).
- Accept the ADR 0009 table form `{ id, args_schema?, result_schema? }` for
  `[lazy].commands` entries in the manifest linter and model, with bounded JSON
  Schema validation matching `bitty.commands.register` and a conformance case
  (CTX-0019 / R-SDK-2 extension).
- Add the Plugin API v1 mock host (deny-by-default capability gates, lifecycle
  and registration window, closed event set, bounded store/UI/terminal/service/
  task/timer surfaces) and the declarative conformance fixture suite, with
  tests and usage documentation (CTX-0016 / R-SDK-3).
- Accept the ADR 0006 `env:<KEY>` / `env:BITTY_*` capability family in the
  manifest linter, required by the ADR 0009 `bitty.env` carve-out.
- Add generated Plugin API v1 LuaLS declarations (`lua/bitty.d.lua`) with a
  machine-readable surface table, a deterministic drift check, LuaLS
  conformance fixtures (positive and negative), and usage documentation
  (CTX-0014 / R-SDK-1).
- Add the fail-closed `bitty-plugin.toml` schema validator and the
  `bitty-plugin-lint` CLI, with tests and usage documentation
  (CTX-0015 / R-SDK-2).
- Initial repository governance and toolchain scaffolding (proposed; pending
  first commit).
- Enforceable quality gates: pinned `just check` targets, lefthook Git hooks,
  and a read-only GitHub Actions CI workflow.
