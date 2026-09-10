/**
 * Public SDK surface for the accepted `bitty-plugin.toml` manifest contract
 * (Plugin API v1).
 *
 * This module exports the fail-closed manifest validator and the schema
 * constants tooling can key off. It does not expose host APIs, Lua helpers, or
 * capability enforcement; those remain derived from the canonical `bitty-docs`
 * contracts under separate tasks.
 */

export {
  CAPABILITY_FAMILIES,
  CLOSED_CAPABILITY_HEADS,
  HIGH_RISK_HEADS,
  PARAM_REQUIRED_HEADS,
  validateCapabilityId,
} from "./capabilities.js";
export { runCli } from "./cli.js";
export { error, warning } from "./diagnostics.js";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostics.js";
export {
  lintManifestSource,
  pluginIdProblem,
  qualifiedNameProblem,
  serviceInterfaceProblem,
  versionProblem,
  versionReqProblem,
} from "./manifest.js";
export type { LintResult } from "./manifest.js";
export * from "./schema.js";
