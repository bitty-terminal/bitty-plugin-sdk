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
  ENV_PREFIX_WILDCARD_PATTERN,
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
  DEFERRED_FUNCTIONS,
  DEFERRED_NAMESPACES,
  EDITOR_ALLOWLIST,
  EDITOR_DENY_KINDS,
  EDITOR_OUTCOME_STATUSES,
  EDITOR_UNAVAILABLE_REASONS,
  ENV_CAPABILITY_PREFIX,
  ENV_KEY_PATTERN as HOST_ENV_KEY_PATTERN,
  ENV_MAX_VALUE_BYTES,
  EVENT_KINDS,
  EVENT_KIND_SET,
  EVENT_MAX_BYTES,
  EVENT_PAYLOAD_FIELDS,
  eventKindSpec,
  EXCLUSIVE_CLAIM_SLOTS,
  FUNCTION_HOST_PARITY,
  HOST_PARITY_SOURCE,
  INTERCEPTION_KINDS,
  LIFECYCLE_KINDS,
  MOCK_LIMITS,
  NAMESPACE_HOST_PARITY,
  namespaceHostParity,
  OBSERVATION_KINDS,
  OVERLAY_EVENT_TAGS,
  OVERLAY_OWNER_RELEASE_REASONS,
  OVERLAY_POLL_STATUSES,
  OVERLAY_RELEASE_REASONS,
  PLUGIN_API_VERSION,
  SNAPSHOT_SCOPE_ONLY,
  STORE_KEY_PATTERN,
  SUBMIT_DENY_KINDS,
  SUBMIT_OUTCOME_STATUSES,
  SUBMIT_UNAVAILABLE_REASONS,
  UI_HOSTED_SLOTS,
  UI_SLOTS,
  UI_UNAVAILABLE_SLOT_REASONS,
  UI_UNAVAILABLE_SLOTS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
  V1_SURFACE_FUNCTIONS,
  WORKSPACE_EVENT_PREFIX,
} from "./host-surface.js";
export type {
  EventClass,
  EventKindSpec,
  FunctionHostParity,
  HostParityStatus,
  NamespaceHostParity,
} from "./host-surface.js";
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
export type {
  LazyCommandSchema,
  ManifestModel,
  ServiceProvidedSchema,
  ToolsGitDeclaration,
} from "./manifest-model.js";
export { MockHost, MOCK_PLUGIN_API_VERSION } from "./mock-host.js";
export type {
  CommandDefinition,
  DebugInspectResult,
  DebugTraceDrain,
  DebugTraceOptions,
  DebugTraceRecord,
  EditorOutcome,
  EditorSeed,
  EditorStartOpts,
  EventHandler,
  HostEvent,
  KeymapSuggestion,
  MockHostOptions,
  MockHostState,
  NotifyPayload,
  OverlayAcquireSpec,
  OverlayInputEvent,
  OverlayPollResult,
  PublishResult,
  ResolvedService,
  ServiceGetOptions,
  ServiceMethod,
  SnapshotOptions,
  SubmitDelivery,
  SubmitOutcome,
  WorkspaceFocusTarget,
  WorkspaceInfo,
  WorkspaceRequest,
} from "./mock-host.js";
export * from "./schema.js";
