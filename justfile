# Quality gates for bitty-plugin-sdk.
# Tool version pins live here and mirror package.json devDependencies where
# applicable; keep both identical when bumping. All tool invocations go
# through bun/bunx.

markdownlint-cli2-version := "0.23.1"
prettier-version := "3.9.6"
commitlint-version := "21.2.2"
lefthook-version := "2.1.10"

default: check

check: lint fmt-check type-check test lua-defs-check host-parity-check

# Install pinned dependencies from the lockfile before running code gates.
install:
    bun install --frozen-lockfile

# Type-check sources and tests against the strict tsconfig (no emit).
type-check: install
    bunx --bun tsc -p tsconfig.json --noEmit

# Run the manifest validator, Lua definition, and CLI test suites (no network).
test: install
    bun test

# Run the mock-host conformance fixtures and print per-case evidence.
conformance: install
    bun test tests/conformance.test.ts

# Fail when lua/bitty.d.lua drifts from surface/bitty-plugin-api-v1.json.
lua-defs-check:
    bun scripts/generate-lua-defs.ts --check

# Fail when the surface table, wiring model, definitions, or mock disagree
# about host parity (CTX-0053 regen-sync trigger).
host-parity-check: install
    bun scripts/check-host-parity.ts

# Regenerate lua/bitty.d.lua from the surface table.
lua-defs-write:
    bun scripts/generate-lua-defs.ts --write

# LuaLS conformance check (skips with exit 0 when lua-language-server is absent).
lua-defs-luals:
    bun scripts/check-lua-luals.ts

lint:
    bunx --bun markdownlint-cli2@{{markdownlint-cli2-version}}

fmt-check:
    bunx --bun prettier@{{prettier-version}} --check . --ignore-unknown

fmt:
    bunx --bun prettier@{{prettier-version}} --write . --ignore-unknown

lint-files *files:
    bunx --bun markdownlint-cli2@{{markdownlint-cli2-version}} {{files}}

fmt-check-files *files:
    bunx --bun prettier@{{prettier-version}} --check --ignore-unknown {{files}}

# Validate a commit message file with commitlint (conventional commits).
commit-check message=".git/COMMIT_EDITMSG":
    test -d node_modules/@commitlint/config-conventional || bun install --frozen-lockfile
    bunx --bun commitlint@{{commitlint-version}} --edit "{{message}}"

hooks-install:
    bunx --bun lefthook@{{lefthook-version}} install

# Publish a redacted CarryCtx snapshot inside this repo (commander merge
# closeout only; never a git hook). `carryctx export --publication` redacts the
# bundle, stamps manifest.redacted, and commits one snapshot to the fixed ref
# `refs/heads/carryctx-snapshots`; the target pushes that branch only when the
# local ref advanced (native carryctx commits one snapshot per export, so a
# re-run publishes again rather than no-opping). Canonical closeout runs from
# the primary checkout on branch main
# (`cd "$BITTY_WORKSPACE/bitty-plugins/bitty-plugin-sdk" && just
# workflow-publish`); a detached or feature worktree records that branch as the
# snapshot source. Dry run validates the export and writes neither the ref nor
# the remote.
workflow-publish *args:
    bash scripts/workflow-publish.sh {{args}}

workflow-publish-dry *args:
    bash scripts/workflow-publish.sh --dry-run {{args}}

# Restore the local CarryCtx DB from the in-repo snapshot branch
# `refs/heads/carryctx-snapshots` (fresh-clone recipe). Refuses to replace a
# non-empty local DB without --force, e.g. `just workflow-import --force`.
workflow-import *args:
    bash scripts/workflow-import.sh {{args}}

workflow-import-dry *args:
    bash scripts/workflow-import.sh --dry-run {{args}}
