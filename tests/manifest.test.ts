import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintManifestSource, type LintResult } from "../src/manifest.js";
import { EVENT_KINDS } from "../src/host-surface.js";
import { loadManifestModel } from "../src/manifest-model.js";

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

  test("table-form provided service is accepted with bounded schemas", () => {
    const result = lint(`
[services.provided]
"markdown.render" = { version = "2.0.0", args_schema = { type = "object", properties = { text = { type = "string" } }, required = ["text"], additionalProperties = false }, result_schema = { type = "string" } }
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("table-form provided service rejects unknown keys", () => {
    const result = lint(`
[services.provided]
"markdown.render" = { version = "1.0.0", schema = { type = "string" } }
`);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("table-form provided service requires a complete version", () => {
    const missing = lint(`
[services.provided]
"markdown.render" = { args_schema = { type = "string" } }
`);
    expect(codes(missing)).toContain("manifest.type");
    const bad = lint(`
[services.provided]
"markdown.render" = { version = "1.0" }
`);
    expect(codes(bad)).toContain("services.version.invalid");
  });

  test("table-form provided service rejects an invalid bounded schema", () => {
    const result = lint(`
[services.provided]
"markdown.render" = { version = "1.0.0", args_schema = { type = "object", properties = { text = { type = "string" } } } }
`);
    expect(codes(result)).toContain("services.schema");
  });

  test("table entries count toward the sixteen-service limit", () => {
    const rows = Array.from(
      { length: 17 },
      (_value, index) => `"iface.svc${index}" = { version = "1.0.0" }`,
    ).join("\n");
    const result = lint(`\n[services.provided]\n${rows}\n`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("quoted form-key-colliding segments stay the string form", () => {
    const source = `${PLUGIN}
[services.provided]
"foo.version" = "1.0.0"
"foo.args_schema" = "1.0.0"
"foo.result_schema" = "1.0.0"
`;
    const linted = lintManifestSource(source);
    expect(linted.diagnostics).toEqual([]);
    const model = loadManifestModel(source);
    expect(model.providedServices.get("foo.version")).toBe("1.0.0");
    expect(model.providedServices.get("foo.args_schema")).toBe("1.0.0");
    expect(model.providedServices.get("foo.result_schema")).toBe("1.0.0");
  });

  test("bare dotted form-key segments read as the table form (documented)", () => {
    const model = loadManifestModel(`${PLUGIN}
[services.provided]
foo.version = "1.0.0"
`);
    expect(model.providedServices.get("foo")).toBe("1.0.0");
    expect(model.providedServices.has("foo.version")).toBe(false);
  });

  test("bare dotted args_schema without version is rejected", () => {
    const result = lint(`
[services.provided]
foo.args_schema = { type = "string" }
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
  });

  test("bare dotted result_schema without version is rejected", () => {
    const result = lint(`
[services.provided]
foo.result_schema = { type = "string" }
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
  });

  test("mixed string and table entries share one namespace and round-trip", () => {
    const source = `${PLUGIN}
[services.provided.ns]
"a" = "1.0.0"
"b" = { version = "2.0.0" }
`;
    const linted = lintManifestSource(source);
    expect(linted.diagnostics).toEqual([]);
    const model = loadManifestModel(source);
    expect(model.providedServices.get("ns.a")).toBe("1.0.0");
    expect(model.providedServices.get("ns.b")).toBe("2.0.0");
  });

  test("empty table entry is rejected with a typed diagnostic", () => {
    const result = lint(`
[services.provided]
empty = {}
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
  });

  test("mixed string and table entries share the sixteen-service cap", () => {
    const stringRows = Array.from(
      { length: 8 },
      (_value, index) => `"str.svc${index}" = "1.0.0"`,
    );
    const tableRows = Array.from(
      { length: 8 },
      (_value, index) => `"tbl.svc${index}" = { version = "1.0.0" }`,
    );
    const full = [...stringRows, ...tableRows].join("\n");
    const accepted = lint(`\n[services.provided]\n${full}\n`);
    expect(accepted.diagnostics).toEqual([]);
    const rejected = lint(
      `\n[services.provided]\n${full}\n"extra.svc" = "1.0.0"\n`,
    );
    expect(codes(rejected)).toContain("manifest.limit");
  });
});

describe("manifest model provided services", () => {
  test("exposes versions and table-form schemas", () => {
    const model = loadManifestModel(
      `${PLUGIN}
[services.provided]
"markdown.render" = "1.0.0"
"markdown.render.rich" = { version = "2.0.0", args_schema = { type = "object", properties = { text = { type = "string" } }, required = ["text"], additionalProperties = false } }
`,
    );
    expect(model.providedServices.get("markdown.render")).toBe("1.0.0");
    expect(model.providedServices.get("markdown.render.rich")).toBe("2.0.0");
    expect(model.providedServiceSchemas.get("markdown.render.rich")).toEqual({
      argsSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    });
    expect(model.providedServiceSchemas.get("markdown.render")).toBeUndefined();
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

  test("env capability accepts an exact key and the BITTY_* pattern", () => {
    const result = lint(`
[capabilities]
"env:EDITOR" = true
"env:BITTY_*" = true
`);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("env capability requires a key parameter", () => {
    const result = lint(`
[capabilities]
env = true
`);
    expect(codes(result)).toContain("capabilities.param-required");
  });

  test("env capability rejects non-uppercase and overlong keys", () => {
    const lowercase = lint(`
[capabilities]
"env:editor" = true
`);
    expect(codes(lowercase)).toContain("capabilities.invalid");
    const overlong = lint(`
[capabilities]
"env:${"A".repeat(65)}" = true
`);
    expect(codes(overlong)).toContain("capabilities.invalid");
  });

  test("env capability accepts only the BITTY_* suffix wildcard", () => {
    const result = lint(`
[capabilities]
"env:FOO_*" = true
`);
    expect(codes(result)).toContain("capabilities.invalid");
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
      (_value, index) => `"dir/file${index}"`,
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
      (_value, index) => `"dir/file${index}"`,
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
    const pattern = "a".repeat(500);
    const paths = Array.from({ length: 17 }, () => `"${pattern}"`).join(", ");
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${paths}]
`);
    expect(codes(result)).toContain("manifest.limit");
  });

  test("parent-directory references are rejected as path segments", () => {
    for (const pattern of [
      "../secrets/**",
      "a/../b",
      "~/.local/../../etc/passwd",
      String.raw`..\windows`,
    ]) {
      const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${JSON.stringify(pattern)}]
`);
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain("capabilities.filesystem.invalid");
    }
  });

  test("legitimate names containing a double dot are accepted", () => {
    const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = ["~/a..b/**", "notes/file..txt"]
`);
    expect(result.diagnostics).toEqual([]);
  });

  test("absolute path patterns are rejected", () => {
    for (const pattern of [
      "/etc/passwd",
      "C:/Windows/**",
      String.raw`\\server\share`,
      String.raw`C:\Users\**`,
    ]) {
      const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${JSON.stringify(pattern)}]
`);
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain("capabilities.filesystem.invalid");
    }
  });

  test("sensitive filesystem locations are rejected", () => {
    for (const pattern of [
      "~/.ssh/**",
      "~/.ssh/id_ed25519",
      "**/.gnupg/**",
      "home/.aws/credentials",
    ]) {
      const result = lint(`
[[capabilities.filesystem]]
access = "read"
paths = [${JSON.stringify(pattern)}]
`);
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain("capabilities.filesystem.invalid");
    }
  });

  test("flat fs capability applies the same path rules as the table form", () => {
    for (const capability of [
      "fs.read:../secrets/**",
      "fs.write:a/../b",
      "fs.read:/etc/passwd",
      "fs.read:C:/Windows/**",
      "fs.write:~/.ssh/**",
    ]) {
      const result = lint(`
[capabilities]
${JSON.stringify(capability)} = true
`);
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain("capabilities.filesystem.invalid");
    }
  });

  test("flat fs capability accepts relative and dotted names", () => {
    const result = lint(`
[capabilities]
"fs.read:~/Documents/**/*.md" = true
"fs.write:notes/file..txt" = true
`);
    expect(result.diagnostics).toEqual([]);
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

  test("event kind outside the closed v1 set is rejected", () => {
    const result = lint(`
[lazy]
events = ["terminal.title-changed", "terminal.titl-changed"]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("lazy.events.unknown");
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "lazy.events.unknown",
    );
    expect(diagnostic?.path).toBe("lazy.events[1]");
    expect(diagnostic?.message).toContain("terminal.titl-changed");
  });

  test("every closed v1 event kind is accepted", () => {
    const events = EVENT_KINDS.map((entry) => JSON.stringify(entry.kind)).join(
      ", ",
    );
    const result = lint(`\n[lazy]\nevents = [${events}]\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
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

  test("table-form command with bounded schemas is accepted", () => {
    const result = lint(`
[lazy]
commands = [
  { id = "xuepoo.example:toggle", args_schema = { type = "object", properties = { value = { type = "string" } }, required = ["value"], additionalProperties = false }, result_schema = { type = "string" } },
]
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("string and table command forms may be mixed", () => {
    const result = lint(`
[lazy]
commands = [
  "xuepoo.example:plain",
  { id = "xuepoo.example:toggle", args_schema = { type = "string" } },
]
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("table-form command with an unknown key is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "xuepoo.example:toggle", title = "Toggle" }]
`);
    expect(codes(result)).toContain("manifest.unknown-key");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.unknown-key")
        ?.path,
    ).toBe("lazy.commands[0].title");
  });

  test("table-form command without an id is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ args_schema = { type = "string" } }]
`);
    expect(codes(result)).toContain("manifest.type");
    expect(result.diagnostics[0]?.path).toBe("lazy.commands[0].id");
  });

  test("table-form command with a non-string id is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = 1 }]
`);
    expect(codes(result)).toContain("manifest.type");
    expect(result.diagnostics[0]?.path).toBe("lazy.commands[0].id");
  });

  test("table-form malformed command id is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "toggle" }]
`);
    expect(codes(result)).toContain("lazy.commands.invalid");
    expect(result.diagnostics[0]?.path).toBe("lazy.commands[0].id");
  });

  test("table-form command outside the plugin namespace is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "other.plugin:toggle" }]
`);
    expect(codes(result)).toContain("lazy.commands.owner");
    expect(result.diagnostics[0]?.path).toBe("lazy.commands[0].id");
  });

  test("table-form schema with an unsupported keyword is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "xuepoo.example:toggle", args_schema = { type = "string", pattern = "^a+$" } }]
`);
    expect(codes(result)).toContain("lazy.commands.schema");
    expect(
      result.diagnostics.find((entry) => entry.code === "lazy.commands.schema")
        ?.path,
    ).toBe("lazy.commands[0].args_schema");
  });

  test("table-form object schema without explicit additionalProperties is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "xuepoo.example:toggle", result_schema = { type = "object", properties = { value = { type = "string" } } } }]
`);
    expect(codes(result)).toContain("lazy.commands.schema");
  });

  test("table-form schema with a non-table value is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "xuepoo.example:toggle", args_schema = "object" }]
`);
    expect(codes(result)).toContain("lazy.commands.schema");
  });

  test("table-form schema over 16 KiB is rejected", () => {
    const result = lint(`
[lazy]
commands = [{ id = "xuepoo.example:toggle", args_schema = { type = "string", description = "${"x".repeat(17 * 1024)}" } }]
`);
    expect(codes(result)).toContain("lazy.commands.schema");
  });

  test("table-form commands count toward the 128-command limit", () => {
    const commands = Array.from(
      { length: 129 },
      (_value, index) => `{ id = "xuepoo.example:cmd${index}" }`,
    ).join(", ");
    const result = lint(`\n[lazy]\ncommands = [${commands}]\n`);
    expect(codes(result)).toContain("manifest.limit");
  });
});

describe("tools", () => {
  test("accepted [tools.git] declaration passes", () => {
    const result = lint(`
[tools.git]
required = true
version = ">=2.30"
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("optional [tools.git] declaration passes", () => {
    const result = lint(`
[tools.git]
required = false
version = ">=2.30"
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("extracted git-panel manifest shape passes", () => {
    const result = lintManifestSource(`
[plugin]
id = "bitty-terminal.git-panel"
name = "Git Panel"
version = "0.1.0"
description = "Tiled Panel git branch/status/diff/log via process.spawn:git."

[compat]
bitty = ">=0.1,<1.0"
plugin-api = "^1.0"

[capabilities]
panel.provider = true
panel.create = true
terminal.semantic-read = true
"process.spawn:git" = true

[[capabilities.filesystem]]
access = "read"
paths = ["~/projects/**"]

[tools.git]
required = true
version = ">=2.30"

[lazy]
commands = [
  "bitty-terminal.git-panel:open",
  "bitty-terminal.git-panel:status",
  "bitty-terminal.git-panel:diff",
  "bitty-terminal.git-panel:log",
  "bitty-terminal.git-panel:branch",
]
events = [
  "terminal.cwd-changed",
  "terminal.title-changed",
  "focus.changed",
]
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("unknown tool is rejected", () => {
    const result = lint(`
[tools.rg]
required = true
version = ">=13"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("tools.tool.unknown");
    expect(
      result.diagnostics.find((entry) => entry.code === "tools.tool.unknown")
        ?.path,
    ).toBe("tools.rg");
  });

  test("non-table [tools] is rejected", () => {
    const result = lintManifestSource(`tools = "git"\n${PLUGIN}`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.type")?.path,
    ).toBe("tools");
  });

  test("empty [tools] without the accepted slice is rejected", () => {
    const result = lint(`[tools]\n`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.missing-key");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.missing-key")
        ?.path,
    ).toBe("tools.git");
  });

  test("non-table [tools.git] is rejected", () => {
    const result = lint(`
[tools]
git = ">=2.30"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
  });

  test("unknown [tools.git] key is rejected", () => {
    const result = lint(`
[tools.git]
required = true
version = ">=2.30"
args = ["--no-config"]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.unknown-key");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.unknown-key")
        ?.path,
    ).toBe("tools.git.args");
  });

  test("verb and bound declarations are rejected as unknown keys", () => {
    const result = lint(`
[tools.git]
required = true
version = ">=2.30"
verbs = ["status", "diff"]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.unknown-key");
  });

  test("missing required is rejected", () => {
    const result = lint(`
[tools.git]
version = ">=2.30"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.missing-key");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.missing-key")
        ?.path,
    ).toBe("tools.git.required");
  });

  test("non-boolean required is rejected", () => {
    const result = lint(`
[tools.git]
required = "yes"
version = ">=2.30"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.type")?.path,
    ).toBe("tools.git.required");
  });

  test("missing version is rejected", () => {
    const result = lint(`
[tools.git]
required = true
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.missing-key");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.missing-key")
        ?.path,
    ).toBe("tools.git.version");
  });

  test("non-string version is rejected", () => {
    const result = lint(`
[tools.git]
required = true
version = 42
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("manifest.type");
    expect(
      result.diagnostics.find((entry) => entry.code === "manifest.type")?.path,
    ).toBe("tools.git.version");
  });

  test("invalid version range is rejected", () => {
    const result = lint(`
[tools.git]
required = true
version = ">=2.30!"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("tools.version.invalid");
    expect(
      result.diagnostics.find((entry) => entry.code === "tools.version.invalid")
        ?.path,
    ).toBe("tools.git.version");
  });

  test("tool diagnostics accumulate instead of failing fast", () => {
    const result = lint(`
[tools.rg]
required = true
version = ">=13"

[tools.git]
required = true
version = ">=2.30!"
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("tools.tool.unknown");
    expect(codes(result)).toContain("tools.version.invalid");
  });
});

describe("manifest model lazy commands", () => {
  test("table-form commands contribute ids and static schemas", () => {
    const model = loadManifestModel(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
description = "Example plugin."

[lazy]
commands = [
  "xuepoo.example:plain",
  { id = "xuepoo.example:toggle", args_schema = { type = "string" }, result_schema = { type = "boolean" } },
]
`);
    expect(model.commands).toEqual([
      "xuepoo.example:plain",
      "xuepoo.example:toggle",
    ]);
    expect(model.commandSchemas.get("xuepoo.example:toggle")).toEqual({
      argsSchema: { type: "string" },
      resultSchema: { type: "boolean" },
    });
    expect(model.commandSchemas.has("xuepoo.example:plain")).toBe(false);
  });

  test("string-only commands keep the empty schema map", () => {
    const model = loadManifestModel(`
[plugin]
id = "xuepoo.example"
name = "Example"
version = "0.1.0"
description = "Example plugin."

[lazy]
commands = ["xuepoo.example:toggle"]
`);
    expect(model.commands).toEqual(["xuepoo.example:toggle"]);
    expect(model.commandSchemas.size).toBe(0);
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

  test("lazy event type within 128 UTF-8 bytes passes the bound but is still closed-set checked", () => {
    const result = lint(`
[lazy]
events = [${JSON.stringify("é".repeat(64))}]
`);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("lazy.events.unknown");
    expect(codes(result)).not.toContain("lazy.events.invalid");
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
