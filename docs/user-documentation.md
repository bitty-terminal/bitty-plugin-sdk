# Plugin README user documentation

Status: implemented by `bitty-plugin-docs-check` (this SDK). The convention is
normative for every plugin repository; this page defines the contract the
checker enforces and the rendering rule for the Configuration table.

## Canonical file rule

Each plugin repository's root `README.md` is the single canonical user
document. Do not add a `docs/` directory for user-facing content: user
documentation lives in the README, and design or architecture notes that need
more space belong in the owning documentation corpus
([bitty-plugins-docs](https://github.com/bitty-terminal/bitty-plugins-docs)),
not in a second user-doc tree.

The README is canonical because it is the file GitHub renders at the repository
root and the file a future website ingest reads first. One canonical source
keeps the rendered page, the API surface, and the settings table from drifting
into competing copies.

## Required section order

These six H2 sections lead the README, in this order:

1. `## Overview`
2. `## Install`
3. `## Commands`
4. `## Configuration`
5. `## Keybindings`
6. `## Troubleshooting`

Developer and architecture sections (`## Layout`, `## Development`,
`## Capabilities`, `## API contract`, `## Security`, and similar) follow the
six required sections. Content before the first H2 (the H1 title and a short
lede) is free-form.

The checker rejects a missing section, a section at the wrong position, and a
duplicated required section. Heading text must match exactly (case included);
headings and tables inside fenced code blocks are ignored.

## Configuration table

The `## Configuration` section carries one table row per key declared in
`bitty-plugin.toml` `[settings]`:

```toml
[settings]
greeting = { type = "string", default = "Hello" }
name_max_chars = { type = "int", default = 32 }
show = { type = "bool", default = true }
modules = { type = "string-array", default = ["workspaces", "clock"] }
```

The table has exactly these columns:

```markdown
| Setting          | Type         | Default                 | Description                   |
| ---------------- | ------------ | ----------------------- | ----------------------------- |
| `greeting`       | string       | "Hello"                 | Greeting prefix.              |
| `name_max_chars` | int          | 32                      | Maximum label width.          |
| `show`           | bool         | true                    | Whether the block is visible. |
| `modules`        | string-array | ["workspaces", "clock"] | Enabled modules.              |
```

Rules:

- The key set, the `Type` cell, and the row order are checked against the
  manifest declaration order. A key missing from the table fails
  (`readme.settings.missing`); a key the manifest does not declare fails
  (`readme.settings.extra`). Both failures are hard errors.
- A declared type that disagrees with the `Type` cell fails
  (`readme.settings.type`).
- `Default` and `Description` must be non-empty. Descriptions are
  author-written prose: the accepted `[settings]` shape carries only `type` and
  `default`, so the checker cannot derive them.
- When the manifest declares no settings, write the exact sentence
  `This plugin declares no settings.` or keep the empty table header. Rows in
  that state fail (`readme.settings.extra`).

Generate the checked columns instead of hand-writing them:

```sh
bun src/docs-cli.ts --print-settings-table path/to/plugin
# or, from a plugin repository pinned to this SDK:
bunx --bun --package github:bitty-terminal/bitty-plugin-sdk#<commit-sha> \
  bitty-plugin-docs-check --print-settings-table .
```

`renderSettingsTable(model, descriptions)` exports the same rendering for
build scripts. The rendered `Default` cell uses TOML-shaped literals: `true`,
`32`, `"Hello"`, and `["a", "b"]`.

## Running the check

```sh
# From an SDK checkout:
bun src/docs-cli.ts path/to/plugin

# From a plugin repository that pins this SDK by commit:
bunx --bun --package github:bitty-terminal/bitty-plugin-sdk#<commit-sha> \
  bitty-plugin-docs-check .
```

`bitty-plugin-docs-check` reads `<dir>/bitty-plugin.toml` and
`<dir>/README.md` (override with `--manifest` and `--readme`), prints
human-readable diagnostics or `--json`, and exits `0` when the README matches
the contract, `1` on a contract violation, and `2` on a usage or I/O error.
The manifest is validated first with `bitty-plugin-lint`; an invalid manifest is
reported as-is rather than judged against a README contract it cannot satisfy.

Wire it into the plugin repository's aggregate gate so a README cannot drift
silently:

```make
# justfile
docs:
    bunx --bun --package github:bitty-terminal/bitty-plugin-sdk#{{ sdk_ref }} bitty-plugin-docs-check .

check: manifest lua lua-control docs
```

## Diagnostic codes

| Code                          | Meaning                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `readme.section.missing`      | A required H2 section is absent.                              |
| `readme.section.order`        | The six required H2 sections are not in canonical order.      |
| `readme.section.duplicate`    | A required H2 section appears more than once.                 |
| `readme.settings.table`       | The Configuration section has no canonical settings table.    |
| `readme.settings.missing`     | A declared `[settings]` key has no table row.                 |
| `readme.settings.extra`       | A table row names a key the manifest does not declare.        |
| `readme.settings.duplicate`   | A key appears in more than one row.                           |
| `readme.settings.order`       | Rows do not follow the manifest declaration order.            |
| `readme.settings.type`        | The `Type` cell disagrees with the declared type.             |
| `readme.settings.columns`     | A row does not have the four required columns.                |
| `readme.settings.none`        | No settings are declared and the required sentence is absent. |
| `readme.settings.default`     | The `Default` cell is empty.                                  |
| `readme.settings.description` | The `Description` cell is empty.                              |
| `readme.settings.key`         | A row has an empty `Setting` cell.                            |
| `readme.size`                 | The README exceeds the 1 MiB read limit.                      |

## Template snippet

Copy this skeleton into a new plugin repository and replace the placeholders.
Keep the six H2 headings byte-identical and generate the Configuration table
from `[settings]`.

```markdown
# <plugin name>

<one-line description>

## Overview

What the plugin does, in one or two paragraphs.

## Install

How to install and enable it, including any host compatibility requirement.

## Commands

| Command                 | Description            |
| ----------------------- | ---------------------- |
| `<plugin-id>:<command>` | What the command does. |

## Configuration

Declared settings live in `plugins.<plugin-id>.*` in the host configuration
file. The table below is generated from `bitty-plugin.toml` `[settings]`.

| Setting | Type     | Default     | Description               |
| ------- | -------- | ----------- | ------------------------- |
| `<key>` | `<type>` | `<default>` | What the setting changes. |

## Keybindings

Registered keybindings, or the exact sentence that none are registered.

## Troubleshooting

Symptoms and fixes for the common failure modes.

## Development

Contributor-only instructions follow the six sections above.
```

## Boundary

The check is static and offline. It does not prove that the documented
commands, defaults, or behavior match the host at runtime; those claims still
need the owning repository's tests and release evidence.
