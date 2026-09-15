/**
 * Typed diagnostics for the Plugin API v1 mock host (R-SDK-3).
 *
 * The diagnostic shape follows the accepted Lua Runtime RFC diagnostics
 * classes (`syntax`, `resolution`, `validation`, `runtime`, `budget`) and the
 * stable codes fixed by accepted decisions. Codes are split into two sets:
 * codes an accepted `bitty-docs` contract fixes verbatim, and mock-owned codes
 * this SDK documents for contract behaviors whose code is not yet fixed.
 * Mock-owned codes never replace or rename an accepted code.
 */

/** Diagnostic classes accepted by the Lua Runtime RFC. */
export type DiagnosticClass =
  "syntax" | "resolution" | "validation" | "runtime" | "budget";

/** One typed, bounded host diagnostic. */
export interface HostDiagnostic {
  readonly class: DiagnosticClass;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** Stable codes used by the mock host. */
export const HOST_CODES = {
  CAPABILITY_DENIED: "E_CAPABILITY_DENIED",
  ENV_KEY_INVALID: "E_ENV_KEY_INVALID",
  ENV_VALUE_TOO_LARGE: "E_ENV_VALUE_TOO_LARGE",
  STORE_KEY_INVALID: "E_STORE_KEY_INVALID",
  STORE_VALUE_INVALID: "E_STORE_VALUE_INVALID",
  STORE_QUOTA: "E_STORE_QUOTA",
  SETTINGS_KEY_INVALID: "E_SETTINGS_KEY_INVALID",
  UI_COMPONENT_INVALID: "E_UI_COMPONENT_INVALID",
  UI_CLAIM_REQUIRED: "E_UI_CLAIM_REQUIRED",
  SNAPSHOT_TOO_LARGE: "E_SNAPSHOT_TOO_LARGE",
  SNAPSHOT_SCOPE_UNSUPPORTED: "E_SNAPSHOT_SCOPE_UNSUPPORTED",
  SERVICE_RESOLUTION: "E_SERVICE_RESOLUTION",
  SERVICE_GONE: "E_SERVICE_GONE",
  SERVICE_UNDECLARED: "E_SERVICE_UNDECLARED",
  SERVICE_VERSION_INVALID: "E_SERVICE_VERSION_INVALID",
  BUDGET_TASK: "E_BUDGET_TASK",
  BUDGET_TIMER: "E_BUDGET_TIMER",
  REGISTRATION_CLOSED: "E_REGISTRATION_CLOSED",
  EVENT_UNKNOWN: "E_EVENT_UNKNOWN",
  EVENT_UNDECLARED: "E_EVENT_UNDECLARED",
  EVENT_PAYLOAD_INVALID: "E_EVENT_PAYLOAD_INVALID",
  EVENT_PAYLOAD_TOO_LARGE: "E_EVENT_PAYLOAD_TOO_LARGE",
  COMMAND_UNDECLARED: "E_COMMAND_UNDECLARED",
  COMMAND_DUPLICATE: "E_COMMAND_DUPLICATE",
  COMMAND_ID_INVALID: "E_COMMAND_ID_INVALID",
  SCHEMA_INVALID: "E_SCHEMA_INVALID",
  ARGS_INVALID: "E_ARGS_INVALID",
  RESULT_INVALID: "E_RESULT_INVALID",
  KEYMAP_WHEN_UNSUPPORTED: "E_KEYMAP_WHEN_UNSUPPORTED",
  KEYMAP_CHORD_INVALID: "E_KEYMAP_CHORD_INVALID",
  KEYMAP_COMMAND_UNKNOWN: "E_KEYMAP_COMMAND_UNKNOWN",
  GENERATION_DISPOSED: "E_GENERATION_DISPOSED",
  LIFECYCLE_STATE: "E_LIFECYCLE_STATE",
  HANDLER_VIOLATION: "E_HANDLER_VIOLATION",
  DEF_INVALID: "E_DEF_INVALID",
} as const;

export type HostCode = (typeof HOST_CODES)[keyof typeof HOST_CODES];

/**
 * Codes fixed verbatim by accepted `bitty-docs` contracts.
 *
 * Sources: ADR 0006 (`E_ENV_KEY_INVALID`, `E_ENV_VALUE_TOO_LARGE`), ADR 0009 /
 * Plugin API v1 RFC (`E_CAPABILITY_DENIED`, `E_STORE_VALUE_INVALID`,
 * `E_STORE_QUOTA`, `E_UI_COMPONENT_INVALID`, `E_SNAPSHOT_TOO_LARGE`,
 * `E_SERVICE_RESOLUTION`, `E_SERVICE_GONE`, `E_BUDGET_TASK`,
 * `E_BUDGET_TIMER`).
 */
export const ACCEPTED_HOST_CODES: ReadonlySet<string> = new Set<string>([
  HOST_CODES.CAPABILITY_DENIED,
  HOST_CODES.ENV_KEY_INVALID,
  HOST_CODES.ENV_VALUE_TOO_LARGE,
  HOST_CODES.STORE_VALUE_INVALID,
  HOST_CODES.STORE_QUOTA,
  HOST_CODES.UI_COMPONENT_INVALID,
  HOST_CODES.SNAPSHOT_TOO_LARGE,
  HOST_CODES.SERVICE_RESOLUTION,
  HOST_CODES.SERVICE_GONE,
  HOST_CODES.BUDGET_TASK,
  HOST_CODES.BUDGET_TIMER,
]);

/**
 * Mock-owned codes for behaviors the accepted corpus requires but does not yet
 * spell with a stable code (registration, keymap, lifecycle, and bounded-input
 * diagnostics). Documented in `docs/mock-host.md`.
 */
export const MOCK_HOST_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(HOST_CODES).filter((code) => !ACCEPTED_HOST_CODES.has(code)),
);

/** Error carrying one typed host diagnostic; the only failure mode of calls. */
export class HostError extends Error {
  readonly diagnostic: HostDiagnostic;

  constructor(diagnostic: HostDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "HostError";
    this.diagnostic = diagnostic;
  }
}

/** Build and throw one typed host diagnostic. */
export function fail(
  diagnosticClass: DiagnosticClass,
  code: string,
  message: string,
  path?: string,
): never {
  throw new HostError({
    class: diagnosticClass,
    code,
    message,
    ...(path === undefined ? {} : { path }),
  });
}
