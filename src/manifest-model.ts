/**
 * Manifest model extraction for the mock host (R-SDK-3).
 *
 * The mock host consumes only manifests that pass the accepted R-SDK-2
 * validator (`lintManifestSource`, task CTX-0015). This module runs that
 * validator first and, only when it reports no error diagnostics, reads the
 * closed declaration set the host needs: plugin identity, declared
 * capabilities, reserved lazy commands and events, claims, and provided
 * services. A manifest the host would reject is never converted into a host.
 */

import { parse } from "smol-toml";

import { error, type Diagnostic } from "./diagnostics.js";
import type { JsonSchema, JsonValue } from "./json-schema.js";
import { lintManifestSource } from "./manifest.js";
import {
  ALLOWED_SETTING_TYPES,
  MANIFEST_MAX_DEPTH,
  collectProvidedServices,
  type ProvidedServiceEntry,
} from "./schema.js";

/** Bounded static schema metadata declared by one table-form lazy command. */
export interface LazyCommandSchema {
  readonly argsSchema?: JsonSchema;
  readonly resultSchema?: JsonSchema;
}

/** Bounded static schema metadata declared by one table-form provided service. */
export interface ServiceProvidedSchema {
  readonly argsSchema?: JsonSchema;
  readonly resultSchema?: JsonSchema;
}

/** Accepted Layer-2 `[tools.git]` declaration read from the manifest. */
export interface ToolsGitDeclaration {
  /** Value of `[tools.git].required`; only `true` gates activation. */
  readonly required: boolean;
  /** Value of `[tools.git].version` (shared structural range grammar). */
  readonly version: string;
}

/** One declared settings key: value type plus shipped default (CTX-1195). */
export interface SettingDeclaration {
  /** Declared value type (`bool` / `int` / `string` / `string-array`). */
  readonly kind: string;
  /** Shipped built-in default, always of exactly `kind`. */
  readonly default: JsonValue;
}

/** Closed declaration set read from an accepted manifest. */
export interface ManifestModel {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly pluginApiRange?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly commandSchemas: ReadonlyMap<string, LazyCommandSchema>;
  readonly events: readonly string[];
  readonly claims: readonly string[];
  readonly providedServices: ReadonlyMap<string, string>;
  readonly providedServiceSchemas: ReadonlyMap<string, ServiceProvidedSchema>;
  /** Required broker interfaces (`[services.required]`, interface to range). */
  readonly requiredServices: ReadonlyMap<string, string>;
  /** Declared settings keys (`[settings]`, key to type plus default). */
  readonly settings: ReadonlyMap<string, SettingDeclaration>;
  /**
   * Whether the manifest contained a `[settings]` table at all (even an
   * empty one). An explicit table opts into the host declared-keys gate —
   * an empty one therefore denies every key — while an absent table keeps
   * the legacy open read.
   */
  readonly hasSettingsTable: boolean;
  readonly toolsGit?: ToolsGitDeclaration;
}

/** One manifest that failed the accepted validator. */
export class ManifestModelError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(
      `manifest rejected: ${diagnostics
        .filter((entry) => entry.severity === "error")
        .map((entry) => entry.code)
        .join(", ")}`,
    );
    this.name = "ManifestModelError";
    this.diagnostics = diagnostics;
  }
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenCapabilities(
  table: Table,
  prefix: string,
  output: string[],
): void {
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isTable(value)) {
      flattenCapabilities(value, path, output);
      continue;
    }
    if (value === true) output.push(path);
  }
}

function readCapabilities(capabilities: Table): string[] {
  const declared: string[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === "filesystem") {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (!isTable(entry)) continue;
          const access = entry.access;
          const paths = entry.paths;
          if (
            (access === "read" || access === "write") &&
            Array.isArray(paths)
          ) {
            for (const path of paths) {
              if (typeof path === "string") {
                declared.push(`fs.${access}:${path}`);
              }
            }
          }
        }
      }
      continue;
    }
    if (isTable(value)) {
      flattenCapabilities(value, key, declared);
    } else if (value === true) {
      declared.push(key);
    }
  }
  return declared;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Read `[lazy].commands` from both accepted forms: the string form and the
 * ADR 0009 table form `{ id, args_schema?, result_schema? }`. Ids keep
 * declaration order; static schemas are exposed per qualified command id so
 * lazy help/completion can derive without a VM.
 */
function readLazyCommands(value: unknown): {
  commands: string[];
  schemas: Map<string, LazyCommandSchema>;
} {
  const commands: string[] = [];
  const schemas = new Map<string, LazyCommandSchema>();
  if (!Array.isArray(value)) return { commands, schemas };
  for (const entry of value) {
    if (typeof entry === "string") {
      commands.push(entry);
      continue;
    }
    if (!isTable(entry) || typeof entry.id !== "string") continue;
    commands.push(entry.id);
    const declared: { argsSchema?: JsonSchema; resultSchema?: JsonSchema } = {};
    if (isTable(entry.args_schema)) declared.argsSchema = entry.args_schema;
    if (isTable(entry.result_schema)) {
      declared.resultSchema = entry.result_schema;
    }
    schemas.set(entry.id, declared);
  }
  return { commands, schemas };
}

/**
 * Read `[services.provided]` from both accepted forms: the string form and the
 * ADR 0009 table form `{ version, args_schema?, result_schema? }`. Versions and
 * static schemas are exposed per interface so schema-validating consumers can
 * resolve table-form providers without a VM.
 */
function readProvidedServices(services: unknown): {
  versions: Map<string, string>;
  schemas: Map<string, ServiceProvidedSchema>;
} {
  const versions = new Map<string, string>();
  const schemas = new Map<string, ServiceProvidedSchema>();
  if (!isTable(services)) return { versions, schemas };
  const table = services.provided;
  if (!isTable(table)) return { versions, schemas };
  const entries: ProvidedServiceEntry[] = [];
  collectProvidedServices(table, "", entries);
  for (const entry of entries) {
    if (typeof entry.value === "string") {
      versions.set(entry.path, entry.value);
      continue;
    }
    if (!isTable(entry.value)) continue;
    const version = entry.value.version;
    if (typeof version === "string") versions.set(entry.path, version);
    const declared: { argsSchema?: JsonSchema; resultSchema?: JsonSchema } = {};
    if (isTable(entry.value.args_schema)) {
      declared.argsSchema = entry.value.args_schema;
    }
    if (isTable(entry.value.result_schema)) {
      declared.resultSchema = entry.value.result_schema;
    }
    schemas.set(entry.path, declared);
  }
  return { versions, schemas };
}

/**
 * Read `[services.required]` from both accepted forms: the string form
 * (`"iface" = "range"`) and the table form (`"iface" = { version = "range"
 * }`). Ranges are exposed per interface so consumers can negotiate broker
 * providers; the accepted linter already rejects provider-side schemas here.
 */
function readRequiredServices(services: unknown): Map<string, string> {
  const versions = new Map<string, string>();
  if (!isTable(services)) return versions;
  const table = services.required;
  if (!isTable(table)) return versions;
  // Shared walker with provided services (same dotted-key reconstruction and
  // the same `version`-form-key quoting caveat); the linter has already
  // rejected every non-`version` table key by the time this runs.
  const entries: ProvidedServiceEntry[] = [];
  collectProvidedServices(table, "", entries);
  for (const entry of entries) {
    if (typeof entry.value === "string") {
      versions.set(entry.path, entry.value);
      continue;
    }
    if (!isTable(entry.value)) continue;
    const version = entry.value.version;
    if (typeof version === "string") versions.set(entry.path, version);
  }
  return versions;
}

/**
 * Read the `[settings]` declarations. The accepted linter already enforces
 * the closed shape (`key = { type, default }` with an agreeing default), so
 * only well-formed declarations are exposed for the mock host's
 * declared-keys gate.
 */
function readSettings(value: unknown): Map<string, SettingDeclaration> {
  const declared = new Map<string, SettingDeclaration>();
  if (!isTable(value)) return declared;
  for (const [key, entry] of Object.entries(value)) {
    if (!isTable(entry)) continue;
    const kind = entry.type;
    if (typeof kind !== "string" || !ALLOWED_SETTING_TYPES.has(kind)) {
      continue;
    }
    if (!("default" in entry)) continue;
    declared.set(key, { kind, default: entry.default as JsonValue });
  }
  return declared;
}

/**
 * Read the accepted Layer-2 `[tools.git]` declaration. The accepted R-SDK-2
 * linter already enforces the closed shape (`required: boolean`,
 * `version: range string`); only a well-formed declaration is exposed so the
 * mock host can gate activation on it.
 */
function readToolsGit(value: unknown): ToolsGitDeclaration | undefined {
  if (!isTable(value)) return undefined;
  const git = value.git;
  if (!isTable(git)) return undefined;
  if (typeof git.required !== "boolean") return undefined;
  if (typeof git.version !== "string") return undefined;
  return { required: git.required, version: git.version };
}

/**
 * Validate and convert one `bitty-plugin.toml` source into a manifest model.
 *
 * Throws {@link ManifestModelError} when the accepted validator reports any
 * error.
 */
export function loadManifestModel(source: string): ManifestModel {
  const lint = lintManifestSource(source);
  if (!lint.valid) throw new ManifestModelError(lint.diagnostics);

  const parsed = parse(source, { maxDepth: MANIFEST_MAX_DEPTH });
  if (!isTable(parsed)) {
    throw new ManifestModelError([
      error("manifest.type", "", "expected a TOML table"),
    ]);
  }
  const plugin = isTable(parsed.plugin) ? parsed.plugin : {};
  const compat = isTable(parsed.compat) ? parsed.compat : {};
  const lazy = isTable(parsed.lazy) ? parsed.lazy : {};
  const capabilities = isTable(parsed.capabilities) ? parsed.capabilities : {};

  const pluginId = typeof plugin.id === "string" ? plugin.id : "";
  const name = typeof plugin.name === "string" ? plugin.name : "";
  const version = typeof plugin.version === "string" ? plugin.version : "";
  const pluginApiRange =
    typeof compat["plugin-api"] === "string" ? compat["plugin-api"] : undefined;
  const lazyCommands = readLazyCommands(lazy.commands);
  const providedServices = readProvidedServices(parsed.services);
  const requiredServices = readRequiredServices(parsed.services);
  const settings = readSettings(parsed.settings);
  const hasSettingsTable = isTable(parsed.settings);
  const toolsGit = readToolsGit(parsed.tools);

  return {
    pluginId,
    name,
    version,
    ...(pluginApiRange === undefined ? {} : { pluginApiRange }),
    capabilities: readCapabilities(capabilities),
    commands: lazyCommands.commands,
    commandSchemas: lazyCommands.schemas,
    events: readStringArray(lazy.events),
    claims: readStringArray(lazy.claims),
    providedServices: providedServices.versions,
    providedServiceSchemas: providedServices.schemas,
    requiredServices,
    settings,
    hasSettingsTable,
    ...(toolsGit === undefined ? {} : { toolsGit }),
  };
}
