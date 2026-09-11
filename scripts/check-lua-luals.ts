/**
 * LuaLS conformance check for the generated `lua/bitty.d.lua` declarations.
 *
 * Requires `lua-language-server` on PATH (or `LUA_LANGUAGE_SERVER`). The check
 * is skipped with exit 0 when the binary is unavailable so CI stays deterministic;
 * `just lua-defs-check` is the deterministic gate in `just check`.
 *
 * Positive workspace: the generated definitions plus `lua/examples/minimal-init.lua`
 * must diagnose cleanly. Negative workspace: `tests/lua-defs/negative-fixture.lua`
 * must be rejected for sampled excluded identifiers and literals plus wrong-shape
 * `services.get` calls (missing `opts` and missing `opts.version`). The full
 * exclusion list is enforced textually by `tests/lua-defs.test.ts`.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { OUTPUT_PATH, REPO_ROOT } from "./generate-lua-defs.js";

export const EXAMPLE_PATH = join(REPO_ROOT, "lua/examples/minimal-init.lua");
export const NEGATIVE_FIXTURE_PATH = join(
  REPO_ROOT,
  "tests/lua-defs/negative-fixture.lua",
);

const CHECK_TIMEOUT_MS = 120_000;

export interface LuaLsDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface LuaLsCheckResult {
  readonly status: number | null;
  readonly diagnostics: readonly LuaLsDiagnostic[];
  readonly output: string;
}

export interface ConformanceResult {
  readonly skipped: boolean;
  readonly problems: readonly string[];
  readonly evidence: readonly string[];
}

export function findLuaLanguageServer(): string | undefined {
  const override = process.env.LUA_LANGUAGE_SERVER;
  if (override !== undefined && override !== "" && existsSync(override))
    return override;
  const entries = (process.env.PATH ?? "").split(delimiter);
  for (const entry of entries) {
    if (entry === "") continue;
    const candidate = join(entry, "lua-language-server");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function runLuaLsCheck(
  binary: string,
  workspace: string,
): LuaLsCheckResult {
  const logPath = join(workspace, "log");
  const proc = spawnSync(
    binary,
    [
      `--check=${workspace}`,
      "--checklevel=Warning",
      "--check_format=json",
      "--locale=en-us",
      `--logpath=${logPath}`,
    ],
    { timeout: CHECK_TIMEOUT_MS, encoding: "utf8" },
  );
  const diagnostics: LuaLsDiagnostic[] = [];
  const reportPath = join(logPath, "check.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
      string,
      Array<{ code?: string; message?: string }>
    >;
    for (const entries of Object.values(report)) {
      for (const entry of entries) {
        diagnostics.push({
          code: entry.code ?? "",
          message: entry.message ?? "",
        });
      }
    }
  }
  return {
    status: proc.status,
    diagnostics,
    output: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
  };
}

function hasDiagnostic(
  result: LuaLsCheckResult,
  code: string,
  messageNeedle: string,
): boolean {
  return result.diagnostics.some(
    (entry) => entry.code === code && entry.message.includes(messageNeedle),
  );
}

export function runConformance(): ConformanceResult {
  const binary = findLuaLanguageServer();
  if (binary === undefined) {
    return {
      skipped: true,
      problems: [],
      evidence: [
        "lua-language-server not found on PATH; LuaLS conformance skipped",
      ],
    };
  }

  const problems: string[] = [];
  const evidence: string[] = [];
  const temp = mkdtempSync(join(tmpdir(), "bitty-lua-defs-"));
  try {
    const positive = join(temp, "positive");
    const negative = join(temp, "negative");
    mkdirSync(positive, { recursive: true });
    mkdirSync(negative, { recursive: true });
    copyFileSync(OUTPUT_PATH, join(positive, "bitty.d.lua"));
    copyFileSync(EXAMPLE_PATH, join(positive, "minimal-init.lua"));
    copyFileSync(OUTPUT_PATH, join(negative, "bitty.d.lua"));
    copyFileSync(NEGATIVE_FIXTURE_PATH, join(negative, "negative-fixture.lua"));

    const positiveResult = runLuaLsCheck(binary, positive);
    evidence.push(
      `positive: exit=${positiveResult.status} diagnostics=${positiveResult.diagnostics.length}`,
    );
    if (positiveResult.status !== 0 || positiveResult.diagnostics.length > 0) {
      problems.push("positive workspace must diagnose cleanly");
      for (const entry of positiveResult.diagnostics) {
        problems.push(`  ${entry.code}: ${entry.message.split("\n")[0] ?? ""}`);
      }
    }

    const negativeResult = runLuaLsCheck(binary, negative);
    evidence.push(
      `negative: exit=${negativeResult.status} diagnostics=${negativeResult.diagnostics.length}`,
    );
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["undefined-field", "`api`"],
      ["undefined-field", "`register_panel`"],
      ["undefined-field", "`get_terminal_state`"],
      ["undefined-field", "`on_event`"],
      ["undefined-field", "`task`"],
      ["undefined-field", "`protocol`"],
      ["assign-type-mismatch", '"raw"'],
      ["missing-parameter", "requires 2 argument(s)"],
      [
        "missing-fields",
        "Missing required fields in type `BittyServiceGetOpts`",
      ],
    ];
    for (const [code, needle] of expected) {
      if (!hasDiagnostic(negativeResult, code, needle)) {
        problems.push(`negative workspace missing ${code} for ${needle}`);
      }
    }
    const missingFieldCount = negativeResult.diagnostics.filter(
      (entry) =>
        entry.code === "missing-fields" &&
        entry.message.includes("BittyServiceGetOpts"),
    ).length;
    if (missingFieldCount < 2) {
      problems.push(
        "negative workspace must reject both version-less services.get option tables",
      );
    }
    if (negativeResult.status === 0) {
      problems.push("negative workspace must report problems");
    }
    if (problems.length > 0) {
      problems.push("actual negative diagnostics:");
      for (const entry of negativeResult.diagnostics) {
        problems.push(`  ${entry.code}: ${entry.message.split("\n")[0] ?? ""}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { skipped: false, problems, evidence };
}

export function main(): number {
  const result = runConformance();
  for (const line of result.evidence) console.log(line);
  if (result.skipped) return 0;
  if (result.problems.length > 0) {
    console.error("LuaLS conformance failed:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("LuaLS conformance passed");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
