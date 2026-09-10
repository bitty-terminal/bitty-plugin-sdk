#!/usr/bin/env bun
/**
 * `bitty-plugin-lint` command-line entry point.
 *
 * Validates exactly one manifest file, prints human-readable or JSON
 * diagnostics, and exits non-zero when the manifest is invalid. The CLI reads
 * one user-specified file and has no network, process-spawning, or ambient
 * filesystem authority beyond that read.
 */

import { readFileSync, statSync } from "node:fs";

import { error } from "./diagnostics.js";
import { lintManifestSource, type LintResult } from "./manifest.js";
import { MANIFEST_FILE_NAME, MANIFEST_MAX_BYTES } from "./schema.js";

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = `bitty-plugin-lint - validate a bitty-plugin.toml manifest (Plugin API v1)

Usage:
  bitty-plugin-lint [options] [path]

Arguments:
  path            Manifest path (default: ./${MANIFEST_FILE_NAME})

Options:
  --json          Print a machine-readable JSON report
  -h, --help      Show this help and exit
  -V, --version   Show the tool version and exit

Exit codes:
  0  manifest is valid
  1  manifest is invalid
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

function formatDiagnostic(
  file: string,
  severity: string,
  code: string,
  path: string,
  message: string,
): string {
  const location = path.length > 0 ? ` (${path})` : "";
  return `${file}: ${severity}: ${code}${location}: ${message}`;
}

function readManifest(target: string, io: CliIo): LintResult | number {
  let size: number;
  try {
    const stats = statSync(target);
    if (!stats.isFile()) {
      io.err(`error: '${target}' is not a regular file`);
      return EXIT_USAGE;
    }
    size = stats.size;
  } catch (cause) {
    io.err(`error: cannot read '${target}': ${describe(cause)}`);
    return EXIT_USAGE;
  }

  if (size > MANIFEST_MAX_BYTES) {
    return {
      valid: false,
      diagnostics: [
        error(
          "manifest.size",
          "",
          `manifest is ${size} bytes; limit is ${MANIFEST_MAX_BYTES} bytes`,
        ),
      ],
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(target);
  } catch (cause) {
    io.err(`error: cannot read '${target}': ${describe(cause)}`);
    return EXIT_USAGE;
  }
  if (buffer.byteLength > MANIFEST_MAX_BYTES) {
    return {
      valid: false,
      diagnostics: [
        error(
          "manifest.size",
          "",
          `manifest is ${buffer.byteLength} bytes; limit is ${MANIFEST_MAX_BYTES} bytes`,
        ),
      ],
    };
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return {
      valid: false,
      diagnostics: [
        error("manifest.encoding", "", "manifest must be valid UTF-8"),
      ],
    };
  }
  return lintManifestSource(source);
}

/** Run the CLI and return its process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  let json = false;
  let target: string | undefined;
  let positionalOnly = false;

  for (const arg of argv) {
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && (arg === "-h" || arg === "--help")) {
      io.out(USAGE);
      return EXIT_VALID;
    }
    if (!positionalOnly && (arg === "-V" || arg === "--version")) {
      io.out(`bitty-plugin-lint ${packageVersion()}`);
      return EXIT_VALID;
    }
    if (!positionalOnly && arg === "--json") {
      json = true;
      continue;
    }
    if (!positionalOnly && arg.startsWith("-") && arg !== "-") {
      io.err(`error: unknown option '${arg}'`);
      io.err(USAGE);
      return EXIT_USAGE;
    }
    if (arg === "-") {
      io.err(
        "error: reading from stdin is not supported; pass a manifest path",
      );
      return EXIT_USAGE;
    }
    if (target !== undefined) {
      io.err("error: at most one manifest path is accepted");
      io.err(USAGE);
      return EXIT_USAGE;
    }
    target = arg;
  }

  const file = target ?? MANIFEST_FILE_NAME;
  const result = readManifest(file, io);
  if (typeof result === "number") {
    return result;
  }

  if (json) {
    io.out(
      JSON.stringify(
        { file, valid: result.valid, diagnostics: result.diagnostics },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of result.diagnostics) {
      io.out(
        formatDiagnostic(
          file,
          diagnostic.severity,
          diagnostic.code,
          diagnostic.path,
          diagnostic.message,
        ),
      );
    }
    const errors = result.diagnostics.filter(
      (entry) => entry.severity === "error",
    ).length;
    const warnings = result.diagnostics.length - errors;
    const verdict = result.valid ? "valid" : "invalid";
    io.out(
      `${file}: ${verdict} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`,
    );
  }

  return result.valid ? EXIT_VALID : EXIT_INVALID;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
