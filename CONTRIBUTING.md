# Contributing

Thank you for considering a contribution to the Bitty Plugin SDK.

## Project status

This repository is documentation-first and pre-implementation. Nothing in it
yet constitutes implemented SDK, host API, or product behavior; governance and
scaffolding files describe proposed conventions, not shipped functionality.
Do not add product code until a separately authorized task has accepted the
API, security, packaging, and compatibility gates.

## Read first

- [AGENTS.md](AGENTS.md) — binding repository doctrine: authority, scope,
  CarryCtx workflow, SDK boundaries, and toolchain policy.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities privately.
- [CHANGELOG.md](CHANGELOG.md) — notable changes are recorded per release.

## Prerequisites

- `just` — command runner; quality gates run only through repository justfile
  targets so that formatter, linter, and tool versions stay pinned in one
  place. Run `just check` before proposing changes.
- `bun` / `bunx --bun` — JavaScript execution and package management. Never
  use `npm`, `npx`, or `yarn` in any Bitty repository.
- `markdownlint-cli2` — Markdown linting for documentation changes.

The canonical toolchain matrix lives in
`bitty-docs/docs/development/toolchain-policy.md`; treat it as authoritative
where this file is silent.

## Development loop

1. Pick up or create a GitHub Issue describing the change.
2. Bind the work to a CarryCtx task with explicit allowed paths (scopes).
3. Make the change; keep edits inside the declared scope.
4. Run quality gates on every changed file before review.
5. Open a pull request linking the Issue and CarryCtx task, stating impact,
   validation evidence, and any cross-repository ordering.

## Delivery lifecycle

Contributions follow the standard lifecycle:

```text
Issue -> Branch -> Commit -> Pull Request -> Review -> Merge
```

Review is independent from implementation. Changes merge only after required
findings and CI-equivalent checks pass. Documentation synchronization is part
of definition of done: an SDK surface is incomplete while canonical
`bitty-docs` contracts or plugin-author guidance remain stale.

## Committing

Use Conventional Commits:

```text
feat(docs): draft plugin manifest reference
fix(rules): correct scope overlap guidance
chore(governance): add security policy scaffolding
```

Commit messages are validated by `commitlint.config.ts` against Conventional
Commits rules. Run `just hooks-install` once per clone to enable the Git
hooks: `commit-msg` rejects non-conforming messages through
`just commit-check`, and `pre-commit` lints and format-checks staged Markdown
files through the justfile targets.
