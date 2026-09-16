/**
 * Shared structural version-range grammar for Plugin API v1 (P1-2).
 *
 * Both sides of the contract use this one parser: the manifest validator
 * (`src/manifest.ts` `versionReqProblem`, applied to `compat.*`,
 * `dependencies.*`, and `tools.git.version`) and the mock-host service
 * resolver (`src/mock-host.ts` `bitty.services.get`). Keeping the grammar in
 * its own module avoids a `manifest.ts` <-> `mock-host.ts` import cycle and
 * makes the linter's verdict and the resolver's verdict the same decision for
 * any input.
 *
 * Accepted grammar (the mock host's comparator model, not a general SemVer
 * range library):
 *
 *   range    = clause ("," clause)*
 *   clause   = [operator] [SP] version
 *   operator = "=" | "==" | ">=" | "<=" | ">" | "<" | "^" | "~"  (default "=")
 *   version  = MAJOR ["." MINOR ["." PATCH]]   (missing parts default to 0)
 *
 * Every clause is trimmed, so whitespace is allowed around operators and
 * commas but not inside an operator or a version, and a missing operator means
 * exact equality. Missing segments are shorthand for zero (`^1.0` is
 * `^1.0.0`; `>=2.30` is `>=2.30.0`). Prerelease and build segments (`-rc.1`,
 * `+build`) are not part of the comparator model and are rejected here; the
 * concrete `plugin.version` field is a separate SemVer 2 check in
 * `src/manifest.ts`. The byte bound is part of the grammar so the resolver
 * rejects an over-long range exactly like the linter does.
 *
 * Evaluation mirrors the reference host resolver's `expand_caret` /
 * `expand_tilde` (`bitty/crates/bitty-package` `requirement.rs`): `^1.2.3`
 * means `>=1.2.3 <2.0.0`, `^0.2.3` means `>=0.2.3 <0.3.0`, `^0.0.3` means
 * `=0.0.3`, and `~1.2.3` means `>=1.2.3 <1.3.0`. Structural acceptance stays
 * this module's linter contract and intentionally differs from the resolver's
 * stricter grammar only in the documented, ecosystem-compatible directions
 * (`docs/manifest.md` "Known gaps and open questions").
 */

import { MAX_VERSION_REQ_LEN } from "./schema.js";

/** One concrete version split into its compared components. */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Accepted comparator operators; `==` normalizes to `=`. */
export type VersionRangeOperator = "=" | ">=" | "<=" | ">" | "<" | "^" | "~";

/** One parsed comparator clause. */
export interface VersionRangeClause {
  readonly operator: VersionRangeOperator;
  readonly version: ParsedVersion;
}

/** Result of parsing one version range. */
export type VersionRangeParse =
  | { readonly ok: true; readonly clauses: readonly VersionRangeClause[] }
  | { readonly ok: false; readonly problem: string };

const COMPARATOR =
  /^(>=|<=|==|=|>|<|\^|~)?[ \t]*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const CONCRETE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** UTF-8 byte length, matching the reference host's `str::len()` bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function quote(raw: string): string {
  return raw.length > 80 ? `'${raw.slice(0, 77)}...'` : `'${raw}'`;
}

function buildVersion(
  major: string | undefined,
  minor: string | undefined,
  patch: string | undefined,
): ParsedVersion {
  return {
    major: Number(major ?? "0"),
    minor: Number(minor ?? "0"),
    patch: Number(patch ?? "0"),
  };
}

/**
 * Parse one version range into its comparator clauses.
 *
 * Returns a structural problem description instead of throwing so both the
 * manifest linter and the mock resolver can translate it into their own
 * diagnostic and stay in agreement.
 */
export function parseVersionRange(raw: string): VersionRangeParse {
  if (raw.length === 0) {
    return { ok: false, problem: "must not be empty" };
  }
  const bytes = byteLength(raw);
  if (bytes > MAX_VERSION_REQ_LEN) {
    return {
      ok: false,
      problem: `too long (${bytes} > ${MAX_VERSION_REQ_LEN})`,
    };
  }
  const clauses: VersionRangeClause[] = [];
  for (const entry of raw.split(",")) {
    const clause = entry.trim();
    const match = COMPARATOR.exec(clause);
    if (match === null) {
      return {
        ok: false,
        problem: `clause ${quote(clause)} is not a valid version comparator`,
      };
    }
    const rawOperator = match[1] ?? "=";
    clauses.push({
      operator:
        rawOperator === "==" ? "=" : (rawOperator as VersionRangeOperator),
      version: buildVersion(match[2], match[3], match[4]),
    });
  }
  return { ok: true, clauses };
}

/**
 * Validate one version range and return a reason when invalid.
 *
 * This is the single structural check behind `versionReqProblem`; a range is
 * accepted here exactly when the mock resolver can evaluate it.
 */
export function versionRangeProblem(raw: string): string | undefined {
  const parsed = parseVersionRange(raw);
  return parsed.ok ? undefined : parsed.problem;
}

/**
 * Parse one concrete `MAJOR.MINOR.PATCH` version.
 *
 * Concrete versions stay strict three-segment numeric to match the previous
 * resolver behavior; the manifest's `plugin.version` SemVer 2 check remains
 * separate.
 */
export function parseConcreteVersion(raw: string): ParsedVersion | undefined {
  const match = CONCRETE_VERSION.exec(raw);
  if (match === null) {
    return undefined;
  }
  return buildVersion(match[1], match[2], match[3]);
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

function clauseSatisfied(
  actual: ParsedVersion,
  clause: VersionRangeClause,
): boolean {
  const comparison = compareVersions(actual, clause.version);
  switch (clause.operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "^":
      // Host resolver `expand_caret`: `^0.0.z` pins exactly, `^0.x.y` caps at
      // the next minor, and major >= 1 caps at the next major. The previous
      // same-major-only comparison made `^0.1` match `0.9.9` (PX-0141).
      if (comparison < 0) return false;
      if (clause.version.major > 0) {
        return actual.major === clause.version.major;
      }
      if (clause.version.minor > 0) {
        return actual.major === 0 && actual.minor === clause.version.minor;
      }
      return comparison === 0;
    case "~":
      return (
        comparison >= 0 &&
        actual.major === clause.version.major &&
        actual.minor === clause.version.minor
      );
    default:
      return comparison === 0;
  }
}

/**
 * Evaluate a concrete version against a range.
 *
 * Returns `undefined` for an invalid concrete version or an invalid range, so
 * the mock resolver fails closed with a validation error instead of guessing.
 * A `false` result means the range parsed but does not match.
 */
export function versionSatisfies(
  version: string,
  range: string,
): boolean | undefined {
  const actual = parseConcreteVersion(version);
  if (actual === undefined) return undefined;
  const parsed = parseVersionRange(range);
  if (!parsed.ok) return undefined;
  for (const clause of parsed.clauses) {
    if (!clauseSatisfied(actual, clause)) return false;
  }
  return true;
}
