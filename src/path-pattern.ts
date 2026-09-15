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
 * Sensitive directory segments denied in filesystem patterns.
 *
 * The accepted contract resolves patterns against real paths, rejects
 * devices, sockets, `/proc`, `/sys`, and `/dev`, and requires regular files
 * under approved locations (threat model T-03; P0-AC-005). The reference host
 * does not yet publish the approved-location list or reject parent-directory
 * references, so the SDK lint applies the conservative static subset of that
 * policy: no traversal, no absolute form, and no well-known secret or
 * credential store under the home directory. Segments are matched as whole
 * normalized names, so `a..b` stays a legitimate path component.
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
]);

/** UTF-8 byte length, matching the reference host's `str::len()` bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate one filesystem glob pattern.
 *
 * After the accepted emptiness, UTF-8 byte, and control/whitespace checks,
 * the pattern is normalized on `/` and `\` and rejected when it is absolute
 * or contains a parent-directory segment. Absolute forms are rejected because
 * patterns are relative to the approved root the host resolves them under.
 * Byte length stays the single measurement for both the per-pattern and the
 * aggregate bound.
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
  const segments = raw.split(FS_PATH_SEPARATORS);
  if (segments.includes("..")) {
    return "must not contain a parent-directory reference ('..')";
  }
  for (const segment of segments) {
    if (SENSITIVE_PATH_SEGMENTS.has(segment)) {
      return `must not target the sensitive location '${segment}'`;
    }
  }
  return undefined;
}
