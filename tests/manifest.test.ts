import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintManifestSource, type LintResult } from "../src/manifest.js";

const PLUGIN = `
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
description = "Example plugin."
`;

function lint(body: string): LintResult {
  return lintManifestSource(PLUGIN + body);
}

function codes(result: LintResult): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

function example(name: string): string {
  return readFileSync(
    new URL(`../docs/examples/${name}`, import.meta.url),
    "utf8",
  );
}

describe("valid manifests", () => {
  test("minimal required fields pass", () => {
    const result = lint("");
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("documented minimal example passes", () => {
    const result = lintManifestSource(example("minimal-bitty-plugin.toml"));
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("documented full example passes without warnings", () => {
    const result = lintManifestSource(example("full-bitty-plugin.toml"));
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("free-form version range syntax is accepted", () => {
    const result = lint(`
[compat]
bitty = ">=0.5,<1.0"
plugin-api = "^1.0"
`);
    expect(result.valid).toBe(true);
  });

  test("bare dotted keys flatten like quoted keys", () => {
    const result = lint(`
[dependencies]
xuepoo.gitcore = ">=2.0"

[services.provided]
markdown.render = "1.0.0"

[capabilities]
terminal.semantic-read = true
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("parameterized filesystem capability is accepted in flat form", () => {
    const result = lint(`
[capabilities]
"fs.read:~/Documents/**/*.md" = true
`);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("schema shape", () => {
  test("missing [plugin] table is rejected", () => {
    const result = lintManifestSource("version = 1\n");
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.missing-key");
  });

  test("missing description is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
`);
    expect(codes(result)).toContain("manifest.missing-key");
  });

  test("unknown root key is rejected", () => {
    const result = lint("\n[unknown]\nvalue = true\n");
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("unknown [plugin] key is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
description = "Example plugin."
homepage = "https://example.invalid"
`);
    expect(codes(result)).toContain("manifest.unknown-key");
    expect(result.valid).toBe(false);
  });

  test("wrong TOML type is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = 42
version = "0.1.0"
description = "Example plugin."
`);
    expect(codes(result)).toContain("manifest.type");
  });

  test("duplicate keys are rejected by the TOML parser", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
id = "xuepoo.other"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.parse");
  });

  test("invalid TOML syntax is rejected", () => {
    const result = lintManifestSource("[plugin\nid = 1\n");
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.parse");
  });

  test("excessive nesting depth is rejected", () => {
    const result = lint("a.b.c.d.e.f.g.h.i.j.k = true\n");
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("oversized manifests are rejected before parsing", () => {
    const result = lintManifestSource(`# ${"a".repeat(300_000)}\n`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual(["manifest.size"]);
  });
});

describe("plugin identity", () => {
  test.each([
    ["uppercase", "Xuepoo.example"],
    ["no dot", "xuepoo"],
    ["two dots", "xuepoo.extra.name"],
    ["leading digit", "1uepoo.example"],
    ["empty segment", "xuepoo."],
  ])("invalid plugin id (%s) is rejected", (_label, id) => {
    const result = lintManifestSource(`
[plugin]
id = "${id}"
name = "Example"
version = "0.1.0"
description = "Example plugin."
`);
    expect(codes(result)).toContain("plugin.id.invalid");
  });

  test.each([
    ["1.0", "must be X.Y.Z"],
    ["01.0.0", "leading zero"],
    ["1.0.0-", "empty prerelease"],
    ["1.0.0-a_b", "underscore outside SemVer"],
  ])("invalid version (%s) is rejected", (version) => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "${version}"
description = "Example plugin."
`);
    expect(codes(result)).toContain("plugin.version.invalid");
  });

  test("full SemVer 2 versions pass", () => {
    for (const version of ["0.1.0", "1.0.0-alpha.1", "1.0.0+build.5"]) {
      const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "${version}"
description = "Example plugin."
`);
      expect(result.diagnostics).toEqual([]);
    }
  });

  test("empty plugin name is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "   "
version = "0.1.0"
description = "Example plugin."
`);
    expect(codes(result)).toContain("plugin.name.invalid");
  });

  test("ESC in display strings is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "bad\\u001bname"
version = "0.1.0"
description = "Example plugin."
`);
    expect(codes(result)).toContain("plugin.name.invalid");
  });

  test("empty license is rejected", () => {
    const result = lintManifestSource(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
description = "Example plugin."
license = ""
`);
    expect(codes(result)).toContain("plugin.license.invalid");
  });
});

describe("compat", () => {
  test("unknown compat key is rejected", () => {
    const result = lint(`
[compat]
plugin_api = "^1.0"
`);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("invalid range characters are rejected", () => {
    const result = lint(`
[compat]
bitty = "1.0!"
`);
    expect(codes(result)).toContain("compat.range.invalid");
  });
});

describe("dependencies", () => {
  test("self dependency is rejected", () => {
    const result = lint(`
[dependencies]
"xuepoo.example" = ">=1.0"
`);
    expect(codes(result)).toContain("dependencies.self");
  });

  test("invalid dependency id is rejected", () => {
    const result = lint(`
[dependencies]
"Xuepoo.Other" = ">=1.0"
`);
    expect(codes(result)).toContain("dependencies.id.invalid");
  });

  test("invalid dependency range is rejected", () => {
    const result = lint(`
[dependencies]
"xuepoo.other" = "1.0!"
`);
    expect(codes(result)).toContain("dependencies.version.invalid");
  });

  test("more than eight dependencies is rejected", () => {
    const rows = Array.from(
      { length: 9 },
      (_value, index) => `"xuepoo.dep${index}" = ">=1.0"`,
    ).join("\n");
    const result = lint(`\n[dependencies]\n${rows}\n`);
    expect(codes(result)).toContain("manifest.limit");
  });
});

describe("services", () => {
  test("unknown services key is rejected", () => {
    const result = lint(`
[services.other]
"x.y" = "1.0.0"
`);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("uppercase interface name is rejected", () => {
    const result = lint(`
[services.provided]
"Markdown.Render" = "1.0.0"
`);
    expect(codes(result)).toContain("services.interface.invalid");
  });

  test("two-part service version is rejected (host requires X.Y.Z)", () => {
    const result = lint(`
[services.provided]
"markdown.render" = "1.0"
`);
    expect(codes(result)).toContain("services.version.invalid");
  });

  test("more than sixteen provided services is rejected", () => {
    const rows = Array.from(
      { length: 17 },
      (_value, index) => `"iface.svc${index}" = "1.0.0"`,
    ).join("\n");
    const result = lint(`\n[services.provided]\n${rows}\n`);
    expect(codes(result)).toContain("manifest.limit");
  });
});

describe("capabilities", () => {
  test("unknown capability head is rejected", () => {
    const result = lint(`
[capabilities]
terminal.everything = true
`);
    expect(codes(result)).toContain("capabilities.unknown");
  });

  test("wildcard capability is rejected", () => {
    const result = lint(`
[capabilities]
"terminal.*" = true
`);
    expect(codes(result)).toContain("capabilities.wildcard");
  });

  test("false capability value is rejected", () => {
    const result = lint(`
[capabilities]
terminal.semantic-read = false
`);
    expect(codes(result)).toContain("capabilities.value");
  });

  test("parameter is required where the closed set demands one", () => {
    const result = lint(`
[capabilities]
fs.read = true
`);
    expect(codes(result)).toContain("capabilities.param-required");
  });

  test("parameter is forbidden where the closed set rejects one", () => {
    const result = lint(`
[capabilities]
"terminal.semantic-read:everything" = true
`);
    expect(codes(result)).toContain("capabilities.param-forbidden");
  });

  test("high-risk capability is valid but warned", () => {
    const result = lint(`
[capabilities]
terminal.raw-read = true
`);
    expect(result.valid).toBe(true);
    expect(codes(result)).toContain("capabilities.high-risk");
    const entry = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "capabilities.high-risk",
    );
    expect(entry?.severity).toBe("warning");
  });

  test("invalid filesystem access kind is rejected", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "execute"
paths = ["~/**"]
`);
    expect(codes(result)).toContain("capabilities.filesystem.invalid");
  });

  test("unknown filesystem entry key is rejected", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = ["~/**"]
mode = "fast"
`);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("non-string filesystem paths are rejected", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [1, 2]
`);
    expect(codes(result)).toContain("manifest.type");
  });

  test("empty filesystem paths are rejected", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = []
`);
    expect(codes(result)).toContain("capabilities.filesystem.invalid");
  });

  test("more than 32 patterns per access kind is rejected", () => {
    const paths = Array.from(
      { length: 33 },
      (_value, index) => `"/dir/file${index}"`,
    ).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("per-access aggregation across entries is enforced", () => {
    const paths = Array.from(
      { length: 17 },
      (_value, index) => `"/dir/file${index}"`,
    ).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]

[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("total pattern text over 8 KiB is rejected", () => {
    const pattern = `/${"a".repeat(499)}`;
    const paths = Array.from({ length: 17 }, () => `"${pattern}"`).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(codes(result)).toContain("manifest.limit");
  });
});

describe("lazy triggers", () => {
  test("unknown lazy key is rejected", () => {
    const result = lint(`
[lazy]
triggers = ["x"]
`);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("command outside the plugin namespace is rejected", () => {
    const result = lint(`
[lazy]
commands = ["other.plugin:toggle"]
`);
    expect(codes(result)).toContain("lazy.commands.owner");
  });

  test("malformed command is rejected", () => {
    const result = lint(`
[lazy]
commands = ["toggle"]
`);
    expect(codes(result)).toContain("lazy.commands.invalid");
  });

  test("more than 128 commands is rejected", () => {
    const commands = Array.from(
      { length: 129 },
      (_value, index) => `"xuepoo.example:cmd${index}"`,
    ).join(", ");
    const result = lint(`\n[lazy]\ncommands = [${commands}]\n`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("event type with whitespace is rejected", () => {
    const result = lint(`
[lazy]
events = ["terminal.cwd changed"]
`);
    expect(codes(result)).toContain("lazy.events.invalid");
  });

  test("more than 256 event types is rejected", () => {
    const events = Array.from(
      { length: 257 },
      (_value, index) => `"event.${index}"`,
    ).join(", ");
    const result = lint(`\n[lazy]\nevents = [${events}]\n`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("oversized claim is rejected", () => {
    const result = lint(`
[lazy]
claims = ["${"c".repeat(65)}"]
`);
    expect(codes(result)).toContain("lazy.claims.invalid");
  });

  test("non-string command entries are rejected", () => {
    const result = lint(`
[lazy]
commands = [1]
`);
    expect(codes(result)).toContain("manifest.type");
  });
});

describe("UTF-8 byte bounds", () => {
  function pluginManifest(fields: {
    readonly name?: string;
    readonly description?: string;
    readonly license?: string;
  }): string {
    const name = JSON.stringify(fields.name ?? "Example");
    const description = JSON.stringify(fields.description ?? "Example plugin.");
    const license =
      fields.license === undefined
        ? ""
        : `license = ${JSON.stringify(fields.license)}\n`;
    return `
[plugin]
id = "xuepoo.example"
name = ${name}
version = "0.1.0"
description = ${description}
${license}`;
  }

  test("name over 128 UTF-8 bytes is rejected", () => {
    const result = lintManifestSource(
      pluginManifest({ name: "é".repeat(128) }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("name at exactly 128 UTF-8 bytes is accepted", () => {
    const result = lintManifestSource(pluginManifest({ name: "é".repeat(64) }));
    expect(result.diagnostics).toEqual([]);
  });

  test("description over 1024 UTF-8 bytes is rejected", () => {
    const result = lintManifestSource(
      pluginManifest({ description: "é".repeat(1024) }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("description at exactly 1024 UTF-8 bytes is accepted", () => {
    const result = lintManifestSource(
      pluginManifest({ description: "é".repeat(512) }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("license over 256 UTF-8 bytes is rejected", () => {
    const result = lintManifestSource(
      pluginManifest({ license: "é".repeat(256) }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("license at exactly 256 UTF-8 bytes is accepted", () => {
    const result = lintManifestSource(
      pluginManifest({ license: "é".repeat(128) }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("filesystem path over 512 UTF-8 bytes is rejected", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${JSON.stringify("é".repeat(512))}]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("capabilities.filesystem.invalid");
  });

  test("filesystem path at exactly 512 UTF-8 bytes is accepted", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${JSON.stringify("é".repeat(256))}]
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("total pattern text over 8 KiB of UTF-8 bytes is rejected", () => {
    const paths = Array.from({ length: 17 }, () =>
      JSON.stringify("é".repeat(256)),
    ).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("total pattern text at exactly 8 KiB of UTF-8 bytes is accepted", () => {
    const paths = Array.from({ length: 16 }, () =>
      JSON.stringify("é".repeat(256)),
    ).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("lazy event type over 128 UTF-8 bytes is rejected", () => {
    const result = lint(`
[lazy]
events = [${JSON.stringify("é".repeat(128))}]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("lazy.events.invalid");
  });

  test("lazy event type at exactly 128 UTF-8 bytes is accepted", () => {
    const result = lint(`
[lazy]
events = [${JSON.stringify("é".repeat(64))}]
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("lazy claim over 64 UTF-8 bytes is rejected", () => {
    const result = lint(`
[lazy]
claims = [${JSON.stringify("é".repeat(64))}]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("lazy.claims.invalid");
  });

  test("lazy claim at exactly 64 UTF-8 bytes is accepted", () => {
    const result = lint(`
[lazy]
claims = [${JSON.stringify("é".repeat(32))}]
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("capability id over 512 UTF-8 bytes is rejected", () => {
    const capability = `fs.read:${"漢".repeat(504)}`;
    const result = lint(`
[capabilities]
${JSON.stringify(capability)} = true
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("capabilities.invalid");
  });

  test("capability id at exactly 512 UTF-8 bytes is accepted", () => {
    const capability = `fs.read:${"漢".repeat(168)}`;
    const result = lint(`
[capabilities]
${JSON.stringify(capability)} = true
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("capability parameter over 1024 UTF-8 bytes is rejected", () => {
    const capability = `fs.read:${"漢".repeat(342)}`;
    const result = lint(`
[capabilities]
${JSON.stringify(capability)} = true
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("capabilities.invalid");
  });
});
