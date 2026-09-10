# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [Unreleased]

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
