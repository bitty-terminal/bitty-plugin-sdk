/**
 * Shared filesystem path-pattern rule for Plugin API v1 (P1-1).
 *
 * Both declaration forms apply this one validator: the structured
 * `[[capabilities.filesystem]]` table (`src/manifest.ts` `validateFilesystem`)
 * and the flat `fs.read:PATTERN` / `fs.write:PATTERN` capability parameter
 * (`src/capabilities.ts` `validateCapabilityId`). Keeping the rule in its own
 * module gives a single source without a `manifest.ts` <-> `capabilities.ts`
 * import cycle.
 */

import { MAX_FS_PATH_LEN } from "./schema.js";

const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;

/** Path separators normalized before filesystem-pattern segment checks. */
const FS_PATH_SEPARATORS = /[\\/]+/;

/**
 * Sensitive directory segments denied in filesystem patterns (case-insensitive).
 *
 * The accepted contract resolves patterns against real paths, rejects
 * devices, sockets, `/proc`, `/sys`, and `/dev`, and requires regular files
 * under approved locations (threat model T-03; P0-AC-005). This aligns with
 * the host's normalization and deny policy including case-insensitive checks,
 * GitHub CLI/gcloud credential paths, and Windows device names.
 */
const SENSITIVE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".netrc",
  ".config/gh", // GitHub CLI credentials
  ".config/gcloud", // Google Cloud credentials
]);

/** Windows device names rejected per host policy (case-insensitive). */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** UTF-8 byte length, matching the reference host's `str::len()` bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate one filesystem glob pattern.
 *
 * Aligns with the host's normalization and deny policy:
 * - Rejects control/whitespace, absolute paths, traversal (..)
 * - Rejects sensitive credential directories (case-insensitive)
 * - Rejects Windows device names (case-insensitive)
 * - Normalizes multiple/mixed separators and dot segments
 */
export function pathPatternProblem(raw: string): string | undefined {
  if (raw.length === 0) {
    return "must not be empty";
  }
  if (byteLength(raw) > MAX_FS_PATH_LEN) {
    return `too long (${byteLength(raw)} > ${MAX_FS_PATH_LEN})`;
  }
  if (CONTROL_OR_WHITESPACE.test(raw)) {
    return "must not contain control characters or whitespace";
  }
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) {
    return "must be relative (absolute path patterns are not permitted)";
  }

  // Normalize separators and remove empty/single-dot segments
  const segments = raw
    .split(FS_PATH_SEPARATORS)
    .filter((s) => s.length > 0 && s !== ".");

  // Check for parent-directory traversal
  if (segments.includes("..")) {
    return "must not contain a parent-directory reference ('..')";
  }

  // Check sensitive paths (case-insensitive) and Windows device names
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;

    const lowerSegment = segment.toLowerCase();

    // Check Windows device names (may have extension like CON.txt)
    const baseSegment = lowerSegment.split(".")[0]?.toUpperCase();
    if (baseSegment && WINDOWS_DEVICE_NAMES.has(baseSegment)) {
      return `must not use Windows device name '${segment}'`;
    }

    // Check single-segment sensitive paths
    if (SENSITIVE_PATH_SEGMENTS.has(lowerSegment)) {
      return `must not target the sensitive location '${segment}'`;
    }

    // Check two-segment sensitive paths like .config/gh
    if (i < segments.length - 1) {
      const nextSegment = segments[i + 1];
      if (nextSegment) {
        const twoSegment = `${lowerSegment}/${nextSegment.toLowerCase()}`;
        if (SENSITIVE_PATH_SEGMENTS.has(twoSegment)) {
          return `must not target the sensitive location '${segment}/${nextSegment}'`;
        }
      }
    }
  }

  return undefined;
}
