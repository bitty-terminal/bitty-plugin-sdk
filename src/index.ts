/**
 * Public SDK surface for the accepted `bitty-plugin.toml` manifest contract
 * and the Plugin API v1 mock host (R-SDK-2, R-SDK-3).
 *
 * This module exports the fail-closed manifest validator, the schema constants
 * tooling can key off, and the mock-host/conformance facilities derived from
 * the accepted Plugin API v1 surface. It does not expose host APIs or Lua
 * helpers; those remain derived from the canonical `bitty-docs` contracts under
 * separate tasks.
 */

export {
  CAPABILITY_FAMILIES,
  CLOSED_CAPABILITY_HEADS,
  ENV_KEY_PATTERN,
  ENV_PATTERN,
  HIGH_RISK_HEADS,
  MAX_ENV_KEY_LEN,
  PARAM_REQUIRED_HEADS,
  validateCapabilityId,
} from "./capabilities.js";
export { runCli } from "./cli.js";
export {
  runConformanceCaseFile,
  runConformanceDirectory,
} from "./conformance.js";
export type {
  ConformanceAssertion,
  ConformanceCase,
  ConformanceCaseResult,
  ConformanceRunOptions,
  ConformanceStep,
} from "./conformance.js";
export { error, warning } from "./diagnostics.js";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostics.js";
export {
  ACCEPTED_HOST_CODES,
  HOST_CODES,
  HostError,
  MOCK_HOST_CODES,
} from "./host-diagnostics.js";
export type { DiagnosticClass, HostDiagnostic } from "./host-diagnostics.js";
export {
  CAPABILITY_GATED_SURFACE,
  COMMAND_ID_PATTERN,
  ENV_CAPABILITY_PREFIX,
  ENV_KEY_PATTERN as HOST_ENV_KEY_PATTERN,
  ENV_MAX_VALUE_BYTES,
  EVENT_KINDS,
  EVENT_KIND_SET,
  EVENT_MAX_BYTES,
  EVENT_PAYLOAD_FIELDS,
  eventKindSpec,
  EXCLUSIVE_CLAIM_SLOTS,
  INTERCEPTION_KINDS,
  LIFECYCLE_KINDS,
  MOCK_LIMITS,
  OBSERVATION_KINDS,
  PLUGIN_API_VERSION,
  SNAPSHOT_SCOPE_ONLY,
  STORE_KEY_PATTERN,
  UI_SLOTS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
  V1_SURFACE_FUNCTIONS,
} from "./host-surface.js";
export type { EventClass, EventKindSpec } from "./host-surface.js";
export { schemaProblem, valueProblem } from "./json-schema.js";
export type { JsonSchema, JsonValue } from "./json-schema.js";
export {
  lintManifestSource,
  pluginIdProblem,
  qualifiedNameProblem,
  serviceInterfaceProblem,
  versionProblem,
  versionReqProblem,
} from "./manifest.js";
export type { LintResult } from "./manifest.js";
export { loadManifestModel, ManifestModelError } from "./manifest-model.js";
export type { ManifestModel } from "./manifest-model.js";
export { MockHost } from "./mock-host.js";
export type {
  CommandDefinition,
  EventHandler,
  HostEvent,
  KeymapSuggestion,
  MockHostOptions,
  MockHostState,
  NotifyPayload,
  PublishResult,
  ResolvedService,
  ServiceGetOptions,
  ServiceMethod,
  SnapshotOptions,
} from "./mock-host.js";
export * from "./schema.js";
