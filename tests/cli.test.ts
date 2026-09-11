import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";

const MINIMAL_EXAMPLE = fileURLToPath(
  new URL("../docs/examples/minimal-bitty-plugin.toml", import.meta.url),
);
const INVALID_EXAMPLE = fileURLToPath(
  new URL("./fixtures/invalid/unknown-key.toml", import.meta.url),
);
const TABLE_COMMANDS_FIXTURE = fileURLToPath(
  new URL("./fixtures/valid/lazy-commands-table.toml", import.meta.url),
);
const CLI_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bitty-plugin-lint-test-"));
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

describe("runCli", () => {
  test("valid manifest exits 0", () => {
    const stream = capture();
    const code = runCli([MINIMAL_EXAMPLE], stream.io);
    expect(code).toBe(0);
    expect(stream.out.join("\n")).toContain("valid");
    expect(stream.err).toEqual([]);
  });

  test("invalid manifest exits 1 with a diagnostic", () => {
    const stream = capture();
    const code = runCli([INVALID_EXAMPLE], stream.io);
    expect(code).toBe(1);
    expect(stream.out.join("\n")).toContain("manifest.unknown-key");
  });

  test("table-form lazy commands exit 0", () => {
    const stream = capture();
    const code = runCli([TABLE_COMMANDS_FIXTURE], stream.io);
    expect(code).toBe(0);
    expect(stream.out.join("\n")).toContain("valid");
    expect(stream.err).toEqual([]);
  });

  test("--json prints a machine-readable report", () => {
    const stream = capture();
    const code = runCli(["--json", INVALID_EXAMPLE], stream.io);
    expect(code).toBe(1);
    const report = JSON.parse(stream.out[0] ?? "{}") as {
      file: string;
      valid: boolean;
      diagnostics: { code: string; severity: string }[];
    };
    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some((entry) => entry.code === "manifest.unknown-key"),
    ).toBe(true);
  });

  test("missing file exits 2", () => {
    const stream = capture();
    const code = runCli([join(tempDir(), "absent.toml")], stream.io);
    expect(code).toBe(2);
    expect(stream.err.join("\n")).toContain("cannot read");
  });

  test("unknown option exits 2", () => {
    const stream = capture();
    const code = runCli(["--frobnicate"], stream.io);
    expect(code).toBe(2);
    expect(stream.err.join("\n")).toContain("unknown option");
  });

  test("two positional paths exit 2", () => {
    const stream = capture();
    const code = runCli([MINIMAL_EXAMPLE, MINIMAL_EXAMPLE], stream.io);
    expect(code).toBe(2);
    expect(stream.err.join("\n")).toContain("at most one");
  });

  test("stdin path exits 2", () => {
    const stream = capture();
    const code = runCli(["-"], stream.io);
    expect(code).toBe(2);
    expect(stream.err.join("\n")).toContain("stdin");
  });

  test("--help exits 0", () => {
    const stream = capture();
    const code = runCli(["--help"], stream.io);
    expect(code).toBe(0);
    expect(stream.out.join("\n")).toContain("Usage:");
  });

  test("--version exits 0", () => {
    const stream = capture();
    const code = runCli(["--version"], stream.io);
    expect(code).toBe(0);
    expect(stream.out.join("\n")).toContain("bitty-plugin-lint");
  });

  test("invalid UTF-8 exits 1 with an encoding diagnostic", () => {
    const dir = tempDir();
    const file = join(dir, "bitty-plugin.toml");
    writeFileSync(file, Buffer.from([0x5b, 0xff, 0xfe, 0x5d]));
    const stream = capture();
    const code = runCli([file], stream.io);
    expect(code).toBe(1);
    expect(stream.out.join("\n")).toContain("manifest.encoding");
  });

  test("oversized file exits 1 with a size diagnostic", () => {
    const dir = tempDir();
    const file = join(dir, "bitty-plugin.toml");
    writeFileSync(file, `# ${"a".repeat(300_000)}\n`);
    const stream = capture();
    const code = runCli([file], stream.io);
    expect(code).toBe(1);
    expect(stream.out.join("\n")).toContain("manifest.size");
  });

  test("directory path exits 2", () => {
    const stream = capture();
    const code = runCli([tempDir()], stream.io);
    expect(code).toBe(2);
    expect(stream.err.join("\n")).toContain("not a regular file");
  });

  test("valid manifest matches the file bytes exactly", () => {
    const stream = capture();
    const code = runCli([MINIMAL_EXAMPLE], stream.io);
    expect(code).toBe(0);
    expect(readFileSync(MINIMAL_EXAMPLE, "utf8")).toContain(
      "bitty-plugin.toml",
    );
  });
});

describe("bitty-plugin-lint process", () => {
  test("runs as a real process with bounded timeout", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "--json", INVALID_EXAMPLE],
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    });
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout) as { valid: boolean };
    expect(report.valid).toBe(false);
  }, 20_000);
});
