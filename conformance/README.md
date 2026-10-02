# Conformance fixtures

Declarative Plugin API v1 conformance cases executed by the mock host.

```sh
just conformance   # from the repository root
```

- `manifests/` holds `bitty-plugin.toml` fixtures; the runner validates each
  one with the accepted R-SDK-2 linter before the case runs.
- `cases/` holds JSON cases: a manifest reference, optional explicit grants and
  environment snapshot, and an ordered step list.

The case format, step vocabulary, diagnostics, and coverage are documented in
[`docs/mock-host.md`](../docs/mock-host.md). Fixture grants are explicit by
design: an absent grant means no authority, and a grant for an undeclared
capability is ignored.

Cases for namespaces or functions the host has not wired yet (`env`, see bitty
PR #1303; `debug.control` inside the wired `debug` namespace; `services` was
re-wired by bitty PR #1391) carry the `pending-host`
tag and assert `E_NOT_IMPLEMENTED`
(`runtime`) instead of accepted-contract success, so the fixtures agree with
the host and the mock is never more permissive.
`tests/conformance.test.ts` enforces this for every `env.*` and every
argument-valid `debug.control` call step and forbids `E_NOT_IMPLEMENTED`
expectations on `services.*` and `workspace.*` steps.

Cases `16-workspace-gates.json` and `17-workspace-events.json` cover the
`bitty.workspace` domain and the `workspace.*` events (bitty PR #1584, ADR 0014) with `manifests/workspace.toml`; case `18-debug-namespace.json` covers
`bitty.debug` (bitty PR #1573) with `manifests/debug.toml`.
