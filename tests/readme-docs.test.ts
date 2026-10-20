import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDocsCli } from "../src/docs-cli.js";
import {
  NO_SETTINGS_SENTENCE,
  checkPluginReadme,
  renderSettingsTable,
} from "../src/readme-docs.js";
import { loadManifestModel } from "../src/manifest-model.js";

const MANIFEST = `[plugin]
id = "example.hello"
name = "Hello"
version = "0.1.0"
description = "Example plugin."

[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"

[settings]
greeting = { type = "string", default = "Hello" }
count = { type = "int", default = 3 }
modules = { type = "string-array", default = ["a", "b"] }
enabled = { type = "bool", default = true }
`;

const SETTINGS_TABLE = `| Setting     | Type           | Default       | Description                          |
| ----------- | -------------- | ------------- | ------------------------------------ |
| \`greeting\`  | string         | "Hello"       | Greeting prefix.                     |
| \`count\`     | int            | 3             | Repetition count.                    |
| \`modules\`   | string-array   | ["a", "b"]    | Enabled modules.                     |
| \`enabled\`   | bool           | true          | Whether the plugin is active.        |`;

function readme(table = SETTINGS_TABLE): string {
  return `# Hello

Example plugin.

## Overview

What the plugin does.

## Install

How to install it.

## Commands

| Command           | Description   |
| ----------------- | ------------- |
| \`example.hello:hi\` | Say hello.  |

## Configuration

Settings are read from the plugin configuration file.

${table}

## Keybindings

No keybindings are registered.

## Troubleshooting

Check \`just check\`.
`;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bitty-plugin-docs-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Capture {
  readonly out: string[];
  readonly err: string[];
  readonly io: {
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
  };
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

function codes(result: ReturnType<typeof checkPluginReadme>): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("checkPluginReadme", () => {
  test("accepts the canonical shape and generated table", () => {
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: readme(),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("fails on a missing settings key", () => {
    const table = SETTINGS_TABLE.split("\n")
      .filter((line) => !line.includes("enabled"))
      .join("\n");
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: readme(table),
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.settings.missing");
  });

  test("fails on an extra settings key", () => {
    const table = `${SETTINGS_TABLE}\n| \`legacy\` | bool | false | Removed setting. |`;
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: readme(table),
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.settings.extra");
  });

  test("fails on a type that disagrees with the manifest", () => {
    const table = SETTINGS_TABLE.replace(
      "| int            | 3",
      "| string         | 3",
    );
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: readme(table),
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.settings.type");
  });

  test("fails when rows do not follow declaration order", () => {
    const rows = SETTINGS_TABLE.split("\n");
    const reordered = [
      rows[0],
      rows[1],
      rows[4],
      rows[2],
      rows[3],
      rows[5],
    ].join("\n");
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: readme(reordered),
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.settings.order");
  });

  test("fails when the required H2 order is broken", () => {
    const source = readme()
      .replace("## Install", "## Setup")
      .replace("## Commands", "## Install");
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: source,
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.section.order");
  });

  test("fails when a required H2 is missing", () => {
    const source = readme().replace(
      "## Keybindings\n\nNo keybindings are registered.\n",
      "",
    );
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: source,
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.section.missing");
    expect(codes(result)).not.toContain("readme.section.order");
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.path === "Keybindings",
      ),
    ).toBe(true);
  });

  test("does not close a four-backtick fence on a nested three-backtick line", () => {
    const source = readme().replace(
      "What the plugin does.",
      "````markdown\n```lua\nprint('x')\n```\n````",
    );
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: source,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("accepts the no-settings sentence when [settings] is absent", () => {
    const manifest = MANIFEST.replace(/\n\[settings\][\s\S]*$/, "\n");
    const source = readme(`This plugin declares no settings.`);
    const result = checkPluginReadme({
      manifestSource: manifest,
      readmeSource: source,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("fails when a no-settings README carries table rows", () => {
    const manifest = MANIFEST.replace(/\n\[settings\][\s\S]*$/, "\n");
    const result = checkPluginReadme({
      manifestSource: manifest,
      readmeSource: readme(SETTINGS_TABLE),
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("readme.settings.extra");
  });

  test("ignores headings and tables inside fenced code blocks", () => {
    const source = readme(
      `\`\`\`md\n## Install\n| Setting | Type | Default | Description |\n| --- | --- | --- | --- |\n\`\`\`\n\n${SETTINGS_TABLE}`,
    );
    const result = checkPluginReadme({
      manifestSource: MANIFEST,
      readmeSource: source,
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("renderSettingsTable", () => {
  test("renders keys, types, defaults, and order from the manifest", () => {
    const model = loadManifestModel(MANIFEST);
    const table = renderSettingsTable(model, { greeting: "Greeting prefix." });
    expect(table).toBe(
      [
        "| Setting | Type | Default | Description |",
        "| --- | --- | --- | --- |",
        '| `greeting` | string | "Hello" | Greeting prefix. |',
        "| `count` | int | 3 |  |",
        '| `modules` | string-array | ["a", "b"] |  |',
        "| `enabled` | bool | true |  |",
      ].join("\n"),
    );
  });

  test("escapes pipes and backslashes in table cells", () => {
    const manifest = MANIFEST.replace(
      'greeting = { type = "string", default = "Hello" }',
      'greeting = { type = "string", default = "a|b\\\\c" }',
    );
    const table = renderSettingsTable(loadManifestModel(manifest), {
      greeting: "left | right",
    });
    expect(table).toContain(
      '| `greeting` | string | "a\\|b\\\\c" | left \\| right |',
    );
  });

  test("renders the no-settings sentence for an empty declaration set", () => {
    const model = loadManifestModel(
      MANIFEST.replace(/\n\[settings\][\s\S]*$/, "\n"),
    );
    expect(renderSettingsTable(model)).toBe(NO_SETTINGS_SENTENCE);
  });
});

describe("runDocsCli", () => {
  function writePackage(manifest: string, readmeSource: string): string {
    const dir = tempDir();
    writeFileSync(join(dir, "bitty-plugin.toml"), manifest);
    writeFileSync(join(dir, "README.md"), readmeSource);
    return dir;
  }

  test("exits 0 for a valid package", () => {
    const dir = writePackage(MANIFEST, readme());
    const output = capture();
    expect(runDocsCli([dir], output.io)).toBe(0);
    expect(output.out.at(-1)).toContain("valid");
  });

  test("exits 1 and names the missing key", () => {
    const table = SETTINGS_TABLE.split("\n")
      .filter((line) => !line.includes("enabled"))
      .join("\n");
    const dir = writePackage(MANIFEST, readme(table));
    const output = capture();
    expect(runDocsCli([dir], output.io)).toBe(1);
    expect(output.out.join("\n")).toContain("readme.settings.missing");
    expect(output.out.join("\n")).toContain("enabled");
  });

  test("exits 1 and names the extra key", () => {
    const table = `${SETTINGS_TABLE}\n| \`legacy\` | bool | false | Removed setting. |`;
    const dir = writePackage(MANIFEST, readme(table));
    const output = capture();
    expect(runDocsCli([dir], output.io)).toBe(1);
    expect(output.out.join("\n")).toContain("readme.settings.extra");
    expect(output.out.join("\n")).toContain("legacy");
  });

  test("prints the generated table with --print-settings-table", () => {
    const dir = writePackage(MANIFEST, readme());
    const output = capture();
    expect(runDocsCli(["--print-settings-table", dir], output.io)).toBe(0);
    expect(output.out.join("\n")).toContain(
      '| `greeting` | string | "Hello" |',
    );
  });

  test("reports a missing README as a usage error", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bitty-plugin.toml"), MANIFEST);
    const output = capture();
    expect(runDocsCli([dir], output.io)).toBe(2);
    expect(output.err.join("\n")).toContain("cannot read README");
  });
});
