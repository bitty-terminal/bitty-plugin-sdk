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

Cases for namespaces the host has not wired yet (`services`/`env`, see bitty
PR #1303) carry the `pending-host` tag and assert `E_NOT_IMPLEMENTED`
(`runtime`) instead of accepted-contract success, so the fixtures agree with
the host and the mock is never more permissive.
`tests/conformance.test.ts` enforces this for every `services.*`/`env.*`
call step.
