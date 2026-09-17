import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")) as {
  bin?: Record<string, string>;
};

const BIN_NAME = "bitty-plugin-lint";
const CONSUMER_TIMEOUT_MS = 30_000;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TSC_ENTRY = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
);
const MANIFEST_SOURCE = readFileSync(
  new URL("../docs/examples/minimal-bitty-plugin.toml", import.meta.url),
  "utf8",
);
const CONSUMER_SOURCE = `
import { MockHost } from "bitty-plugin-sdk";
const host: MockHost = new MockHost({ manifestSource: ${JSON.stringify(MANIFEST_SOURCE)} });
host.beginActivation();
host.endActivation();
const version: string = host.bitty.api_version;
if (version !== "1.0.0") throw new Error("unexpected plugin API version");
host.dispose();
`;
const tempDirs: string[] = [];

function consumerDir(): string {
  const scratch = join(tmpdir(), "bitty");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "sdk-packaging-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(
    PACKAGE_ROOT,
    join(dir, "node_modules", "bitty-plugin-sdk"),
    "junction",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "consumer.ts"), CONSUMER_SOURCE);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["bun"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      files: ["consumer.ts"],
    }),
  );
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cliEntryPoint(): string {
  const target = packageJson.bin?.[BIN_NAME];
  if (target === undefined) {
    throw new Error(`package.json declares no '${BIN_NAME}' bin entry`);
  }
  return fileURLToPath(new URL(target, PACKAGE_JSON_URL));
}

describe("packaging for dependency consumers", () => {
  test("Bun consumers import and construct MockHost from the package root", () => {
    const result = Bun.spawnSync([process.execPath, "consumer.ts"], {
      cwd: consumerDir(),
      timeout: CONSUMER_TIMEOUT_MS,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("TypeScript consumers resolve and check MockHost from the package root", () => {
    const dir = consumerDir();
    const check = () =>
      Bun.spawnSync(
        [process.execPath, TSC_ENTRY, "--project", "tsconfig.json"],
        {
          cwd: dir,
          timeout: CONSUMER_TIMEOUT_MS,
        },
      );
    const valid = check();
    expect(valid.stdout.toString() + valid.stderr.toString()).toBe("");
    expect(valid.exitCode).toBe(0);

    writeFileSync(
      join(dir, "consumer.ts"),
      `${CONSUMER_SOURCE}\nconst invalid: number = host.bitty.api_version;\n`,
    );
    const invalid = check();
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout.toString()).toContain("TS2322");
  });

  test("declares the bitty-plugin-lint bin", () => {
    expect(typeof packageJson.bin?.[BIN_NAME]).toBe("string");
  });

  test("bin entry resolves to an existing entry point with a bun shebang", () => {
    const source = readFileSync(cliEntryPoint(), "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("#!/usr/bin/env bun");
  });

  test.skipIf(process.platform === "win32")(
    "bin entry is executable so installed .bin links run without a build step",
    () => {
      expect(statSync(cliEntryPoint()).mode & 0o111).toBeGreaterThan(0);
    },
  );
});
