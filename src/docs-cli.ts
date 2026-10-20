#!/usr/bin/env bun
/**
 * `bitty-plugin-docs-check` command-line entry point.
 *
 * Validates one plugin package's `README.md` against the canonical
 * user-documentation contract: the six required H2 sections in order and a
 * Configuration table whose keys, types, and order match
 * `bitty-plugin.toml [settings]`. It reads exactly the two named files, has no
 * network or process authority, and never writes.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Diagnostic } from "./diagnostics.js";
import { loadManifestModel, ManifestModelError } from "./manifest-model.js";
import {
  README_FILE_NAME,
  README_MAX_BYTES,
  checkPluginReadme,
  renderSettingsTable,
} from "./readme-docs.js";
import { MANIFEST_MAX_BYTES } from "./schema.js";

const MANIFEST_FILE_NAME = "bitty-plugin.toml";
const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = `bitty-plugin-docs-check - validate a plugin README user document

Usage:
  bitty-plugin-docs-check [options] [dir]

Arguments:
  dir                     Plugin package root (default: .)

Options:
  --manifest <path>       Manifest path (default: <dir>/${MANIFEST_FILE_NAME})
  --readme <path>         README path (default: <dir>/${README_FILE_NAME})
  --print-settings-table  Print the Configuration table for [settings] and exit
  --json                  Print a machine-readable JSON report
  -h, --help              Show this help and exit
  -V, --version           Show the tool version and exit

Exit codes:
  0  README matches the contract
  1  README violates the contract
  2  usage or I/O error
`;

function packageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the unknown marker.
  }
  return "0.0.0-unknown";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatDiagnostic(file: string, diagnostic: Diagnostic): string {
  const location = diagnostic.path.length > 0 ? ` (${diagnostic.path})` : "";
  return `${file}: ${diagnostic.severity}: ${diagnostic.code}${location}: ${diagnostic.message}`;
}

function readText(
  target: string,
  label: string,
  maxBytes: number,
  io: CliIo,
): { readonly text: string } | number {
  let size: number;
  try {
    const stats = statSync(target);
    if (!stats.isFile()) {
      io.err(`error: '${target}' is not a regular file`);
      return EXIT_USAGE;
    }
    size = stats.size;
  } catch (cause) {
    io.err(`error: cannot read ${label} '${target}': ${describe(cause)}`);
    return EXIT_USAGE;
  }
  if (size > maxBytes) {
    io.err(`error: ${label} is ${size} bytes; limit is ${maxBytes} bytes`);
    return EXIT_USAGE;
  }
  try {
    const buffer = readFileSync(target);
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch (cause) {
    io.err(`error: cannot read ${label} '${target}': ${describe(cause)}`);
    return EXIT_USAGE;
  }
}

interface ParsedArgs {
  readonly dir: string;
  readonly manifest?: string;
  readonly readme?: string;
  readonly json: boolean;
  readonly printSettingsTable: boolean;
}

function parseArgs(argv: readonly string[], io: CliIo): ParsedArgs | number {
  let dir = ".";
  let manifest: string | undefined;
  let readme: string | undefined;
  let json = false;
  let printSettingsTable = false;
  let positionalSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      io.out(USAGE);
      return EXIT_VALID;
    }
    if (arg === "-V" || arg === "--version") {
      io.out(`bitty-plugin-docs-check ${packageVersion()}`);
      return EXIT_VALID;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--print-settings-table") {
      printSettingsTable = true;
      continue;
    }
    if (arg === "--manifest" || arg === "--readme") {
      const value = argv[index + 1];
      if (value === undefined) {
        io.err(`error: missing value for ${arg}`);
        io.err(USAGE);
        return EXIT_USAGE;
      }
      if (arg === "--manifest") manifest = value;
      else readme = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      io.err(`error: unknown option '${arg}'`);
      io.err(USAGE);
      return EXIT_USAGE;
    }
    if (positionalSeen) {
      io.err("error: at most one plugin directory is accepted");
      io.err(USAGE);
      return EXIT_USAGE;
    }
    dir = arg;
    positionalSeen = true;
  }

  return {
    dir,
    ...(manifest === undefined ? {} : { manifest }),
    ...(readme === undefined ? {} : { readme }),
    json,
    printSettingsTable,
  };
}

/** Run the CLI and return its process exit code. */
export function runDocsCli(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv, io);
  if (typeof parsed === "number") return parsed;

  const manifestPath = parsed.manifest ?? join(parsed.dir, MANIFEST_FILE_NAME);
  const readmePath = parsed.readme ?? join(parsed.dir, README_FILE_NAME);

  const manifest = readText(manifestPath, "manifest", MANIFEST_MAX_BYTES, io);
  if (typeof manifest === "number") return manifest;

  if (parsed.printSettingsTable) {
    try {
      const model = loadManifestModel(manifest.text);
      io.out(renderSettingsTable(model));
      return EXIT_VALID;
    } catch (cause) {
      if (cause instanceof ManifestModelError) {
        for (const diagnostic of cause.diagnostics) {
          io.out(formatDiagnostic(manifestPath, diagnostic));
        }
        return EXIT_INVALID;
      }
      io.err(`error: cannot read ${manifestPath}: ${describe(cause)}`);
      return EXIT_USAGE;
    }
  }

  const readme = readText(readmePath, "README", README_MAX_BYTES, io);
  if (typeof readme === "number") return readme;

  const result = checkPluginReadme({
    manifestSource: manifest.text,
    readmeSource: readme.text,
    manifestPath,
    readmePath,
  });

  if (parsed.json) {
    io.out(
      JSON.stringify(
        {
          manifest: manifestPath,
          readme: readmePath,
          valid: result.valid,
          diagnostics: result.diagnostics,
        },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of result.diagnostics) {
      io.out(formatDiagnostic(diagnostic.file, diagnostic));
    }
    const errors = result.diagnostics.filter(
      (entry) => entry.severity === "error",
    ).length;
    const verdict = result.valid ? "valid" : "invalid";
    io.out(
      `${readmePath}: ${verdict} (${errors} error${errors === 1 ? "" : "s"})`,
    );
  }

  return result.valid ? EXIT_VALID : EXIT_INVALID;
}

if (import.meta.main) {
  process.exitCode = runDocsCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
