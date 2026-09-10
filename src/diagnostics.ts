/**
 * Structured lint diagnostics.
 *
 * Codes are stable, machine-readable symbols so editors, CI, and future SDK
 * tooling can key off them. `path` is a dotted location inside the manifest
 * (array entries use `[index]`), or an empty string for whole-file findings.
 */

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Build an error diagnostic. */
export function error(code: string, path: string, message: string): Diagnostic {
  return { severity: "error", code, path, message };
}

/** Build a warning diagnostic (never fails validation). */
export function warning(
  code: string,
  path: string,
  message: string,
): Diagnostic {
  return { severity: "warning", code, path, message };
}
