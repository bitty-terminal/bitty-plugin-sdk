# Quality gates for bitty-plugin-sdk.
# Tool version pins live here and mirror package.json devDependencies where
# applicable; keep both identical when bumping. All tool invocations go
# through bun/bunx.

markdownlint-cli2-version := "0.23.1"
prettier-version := "3.9.6"
commitlint-version := "21.2.2"
lefthook-version := "2.1.10"

default: check

check: lint fmt-check

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

# Publish a ctxpack snapshot to the bitty-plugin-sdk-workflow mirror (commander
# merge closeout only; never a git hook). Dry run exports + validates without push.
workflow-publish *args:
    bash scripts/publish-ctxpack.sh {{args}}

workflow-publish-dry *args:
    bash scripts/publish-ctxpack.sh --dry-run {{args}}

# Restore the local CarryCtx DB from the bitty-plugin-sdk-workflow mirror
# LATEST snapshot (fresh-clone recipe). Refuses to replace a non-empty local
# DB without --force, e.g. `just workflow-import --force`.
workflow-import *args:
    bash scripts/fetch-ctxpack.sh {{args}}

workflow-import-dry *args:
    bash scripts/fetch-ctxpack.sh --dry-run {{args}}
