/**
 * Fail-closed validator for `bitty-plugin.toml` (Plugin API v1).
 *
 * The manifest is parsed from raw bytes with no I/O, no VM, and no network.
 * Unknown keys are rejected at every schema level, capability identifiers are
 * checked against the closed v1 set, and every count and length bound from
 * the accepted contract is enforced before a manifest can be considered
 * valid.
 */

import { parse, TomlError } from "smol-toml";

import { validateCapabilityId } from "./capabilities.js";
import { error, type Diagnostic } from "./diagnostics.js";
import { EVENT_KIND_SET } from "./host-surface.js";
import { schemaProblem } from "./json-schema.js";
import { pathPatternProblem } from "./path-pattern.js";
import { versionRangeProblem } from "./version-range.js";
import {
  ALLOWED_COMPAT_KEYS,
  ALLOWED_FILESYSTEM_KEYS,
  ALLOWED_LAZY_COMMAND_KEYS,
  ALLOWED_LAZY_KEYS,
  ALLOWED_PLUGIN_KEYS,
  ALLOWED_ROOT_KEYS,
  ALLOWED_SERVICES_KEYS,
  ALLOWED_SERVICES_PROVIDED_KEYS,
  ALLOWED_TOOLS_GIT_KEYS,
  ALLOWED_TOOLS_KEYS,
  MANIFEST_MAX_BYTES,
  MANIFEST_MAX_DEPTH,
  MAX_CLAIM_LEN,
  MAX_COMMANDS,
  MAX_DEPENDENCIES,
  MAX_DESCRIPTION_LEN,
  MAX_EVENT_TYPES,
  MAX_EVENT_TYPE_LEN,
  MAX_FS_PATTERNS_PER_ACCESS,
  MAX_LICENSE_LEN,
  MAX_NAME_LEN,
  MAX_PATTERN_TEXT_BYTES,
  MAX_PLUGIN_ID_LEN,
  MAX_PLUGIN_ID_SEGMENT_LEN,
  MAX_PROVIDED_SERVICES,
  MAX_QUALIFIED_NAME_LEN,
  MAX_QUALIFIED_RESOURCE_LEN,
  MAX_SERVICE_IFACE_LEN,
  MAX_SERVICE_IFACE_SEGMENT_LEN,
  MAX_VERSION_LEN,
  REQUIRED_PLUGIN_KEYS,
  collectProvidedServices,
  type ProvidedServiceEntry,
} from "./schema.js";

/** Outcome of linting one manifest source. */
export interface LintResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

type TomlTable = Record<string, unknown>;

const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;
const PLUGIN_ID_SEGMENT = /^[a-z][a-z0-9_-]*$/;
const SERVICE_IFACE_SEGMENT = /^[a-z][a-z0-9_-]*$/;
const SEMVER_2 =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** UTF-8 byte length, matching the reference host's `str::len()` bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function exceedsMaxDepth(value: unknown, depth: number): boolean {
  if (depth > MANIFEST_MAX_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => exceedsMaxDepth(item, depth + 1));
  }
  if (isTable(value)) {
    return Object.values(value).some((item) =>
      exceedsMaxDepth(item, depth + 1),
    );
  }
  return false;
}

function quote(raw: string): string {
  return raw.length > 80 ? `'${raw.slice(0, 77)}...'` : `'${raw}'`;
}

interface FlatEntry {
  readonly path: string;
  readonly value: unknown;
}

function flatten(table: TomlTable, prefix: string): FlatEntry[] {
  const entries: FlatEntry[] = [];
  for (const [key, value] of Object.entries(table)) {
    const path = `${prefix}.${key}`;
    if (isTable(value)) {
      entries.push(...flatten(value, path));
    } else {
      entries.push({ path, value });
    }
  }
  return entries;
}

function checkUnknownKeys(
  table: TomlTable,
  allowed: ReadonlySet<string>,
  prefix: string,
  diagnostics: Diagnostic[],
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.has(key)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      diagnostics.push(
        error(
          "manifest.unknown-key",
          path,
          `unknown key '${key}' is not part of the accepted schema`,
        ),
      );
    }
  }
}

function checkTable(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): TomlTable | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isTable(value)) {
    diagnostics.push(error("manifest.type", path, "expected a table"));
    return undefined;
  }
  return value;
}

/** Validate a plugin id and return a reason when invalid. */
export function pluginIdProblem(raw: string): string | undefined {
  if (raw.length === 0) {
    return "must not be empty";
  }
  if (raw.length > MAX_PLUGIN_ID_LEN) {
    return `too long (${raw.length} > ${MAX_PLUGIN_ID_LEN})`;
  }
  if (CONTROL_OR_WHITESPACE.test(raw)) {
    return "must not contain whitespace or control characters";
  }
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return "must be exactly owner.name (one dot)";
  }
  for (const segment of parts) {
    if (segment.length === 0) {
      return "segments must not be empty";
    }
    if (segment.length > MAX_PLUGIN_ID_SEGMENT_LEN) {
      return `segment too long (${segment.length} > ${MAX_PLUGIN_ID_SEGMENT_LEN})`;
    }
    if (!PLUGIN_ID_SEGMENT.test(segment)) {
      return "segments must be lowercase [a-z0-9_-] starting with a letter";
    }
  }
  return undefined;
}

/** Validate a concrete SemVer 2 version and return a reason when invalid. */
export function versionProblem(raw: string): string | undefined {
  if (raw.length === 0) {
    return "must not be empty";
  }
  if (raw.length > MAX_VERSION_LEN) {
    return `too long (${raw.length} > ${MAX_VERSION_LEN})`;
  }
  if (!SEMVER_2.test(raw)) {
    return "must be SemVer 2 (MAJOR.MINOR.PATCH with optional -prerelease/+build)";
  }
  return undefined;
}

/** Validate a version requirement and return a reason when invalid. */
export function versionReqProblem(raw: string): string | undefined {
  return versionRangeProblem(raw);
}

/** Validate a qualified name (`plugin-id:resource`) and return a reason. */
export function qualifiedNameProblem(raw: string): string | undefined {
  if (raw.length === 0) {
    return "must not be empty";
  }
  if (raw.length > MAX_QUALIFIED_NAME_LEN) {
    return `too long (${raw.length} > ${MAX_QUALIFIED_NAME_LEN})`;
  }
  const colon = raw.indexOf(":");
  if (colon === -1) {
    return "must be plugin-id:resource";
  }
  const pluginPart = raw.slice(0, colon);
  const resource = raw.slice(colon + 1);
  const idProblem = pluginIdProblem(pluginPart);
  if (idProblem !== undefined) {
    return `invalid plugin id: ${idProblem}`;
  }
  if (resource.length === 0) {
    return "resource must not be empty";
  }
  if (resource.length > MAX_QUALIFIED_RESOURCE_LEN) {
    return `resource too long (${resource.length} > ${MAX_QUALIFIED_RESOURCE_LEN})`;
  }
  if (!/^[a-z][a-z0-9._-]*$/.test(resource)) {
    return "resource must be lowercase [a-z0-9._-] starting with a letter";
  }
  return undefined;
}

/** Validate a service interface name and return a reason when invalid. */
export function serviceInterfaceProblem(raw: string): string | undefined {
  if (raw.length === 0) {
    return "must not be empty";
  }
  if (raw.length > MAX_SERVICE_IFACE_LEN) {
    return `too long (${raw.length} > ${MAX_SERVICE_IFACE_LEN})`;
  }
  const segments = raw.split(".");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > MAX_SERVICE_IFACE_SEGMENT_LEN
    ) {
      return `segments must be 1..${MAX_SERVICE_IFACE_SEGMENT_LEN} characters`;
    }
    if (!SERVICE_IFACE_SEGMENT.test(segment)) {
      return "segments must be lowercase [a-z0-9_-] starting with a letter";
    }
  }
  return undefined;
}

function validatePluginSection(
  value: unknown,
  diagnostics: Diagnostic[],
): string | undefined {
  if (value === undefined) {
    diagnostics.push(
      error(
        "manifest.missing-key",
        "plugin",
        "required [plugin] table is missing",
      ),
    );
    return undefined;
  }
  const table = checkTable(value, "plugin", diagnostics);
  if (table === undefined) {
    return undefined;
  }
  checkUnknownKeys(table, ALLOWED_PLUGIN_KEYS, "plugin", diagnostics);

  for (const key of REQUIRED_PLUGIN_KEYS) {
    if (table[key] === undefined) {
      diagnostics.push(
        error(
          "manifest.missing-key",
          `plugin.${key}`,
          "required key is missing",
        ),
      );
    }
  }

  let validId: string | undefined;
  const id = table.id;
  if (id !== undefined) {
    if (typeof id !== "string") {
      diagnostics.push(
        error("manifest.type", "plugin.id", "expected a string"),
      );
    } else {
      const problem = pluginIdProblem(id);
      if (problem !== undefined) {
        diagnostics.push(
          error(
            "plugin.id.invalid",
            "plugin.id",
            `plugin id ${quote(id)} is invalid: ${problem}`,
          ),
        );
      } else {
        validId = id;
      }
    }
  }

  const name = table.name;
  if (name !== undefined) {
    if (typeof name !== "string") {
      diagnostics.push(
        error("manifest.type", "plugin.name", "expected a string"),
      );
    } else if (name.trim().length === 0) {
      diagnostics.push(
        error("plugin.name.invalid", "plugin.name", "must not be empty"),
      );
    } else if (byteLength(name) > MAX_NAME_LEN) {
      diagnostics.push(
        error(
          "manifest.limit",
          "plugin.name",
          `name too long (${byteLength(name)} > ${MAX_NAME_LEN})`,
        ),
      );
    } else if (/[\u0000\u001b]/.test(name)) {
      diagnostics.push(
        error(
          "plugin.name.invalid",
          "plugin.name",
          "must not contain NUL or ESC",
        ),
      );
    }
  }

  const version = table.version;
  if (version !== undefined) {
    if (typeof version !== "string") {
      diagnostics.push(
        error("manifest.type", "plugin.version", "expected a string"),
      );
    } else {
      const problem = versionProblem(version);
      if (problem !== undefined) {
        diagnostics.push(
          error("plugin.version.invalid", "plugin.version", problem),
        );
      }
    }
  }

  const description = table.description;
  if (description !== undefined) {
    if (typeof description !== "string") {
      diagnostics.push(
        error("manifest.type", "plugin.description", "expected a string"),
      );
    } else if (byteLength(description) > MAX_DESCRIPTION_LEN) {
      diagnostics.push(
        error(
          "manifest.limit",
          "plugin.description",
          `description too long (${byteLength(description)} > ${MAX_DESCRIPTION_LEN})`,
        ),
      );
    } else if (/[\u0000\u001b]/.test(description)) {
      diagnostics.push(
        error(
          "plugin.description.invalid",
          "plugin.description",
          "must not contain NUL or ESC",
        ),
      );
    }
  }

  const license = table.license;
  if (license !== undefined) {
    if (typeof license !== "string") {
      diagnostics.push(
        error("manifest.type", "plugin.license", "expected a string"),
      );
    } else if (license.trim().length === 0) {
      diagnostics.push(
        error(
          "plugin.license.invalid",
          "plugin.license",
          "must not be empty when present",
        ),
      );
    } else if (byteLength(license) > MAX_LICENSE_LEN) {
      diagnostics.push(
        error(
          "manifest.limit",
          "plugin.license",
          `license too long (${byteLength(license)} > ${MAX_LICENSE_LEN})`,
        ),
      );
    }
  }

  return validId;
}

function validateCompat(value: unknown, diagnostics: Diagnostic[]): void {
  const table = checkTable(value, "compat", diagnostics);
  if (table === undefined) {
    return;
  }
  checkUnknownKeys(table, ALLOWED_COMPAT_KEYS, "compat", diagnostics);
  for (const key of ["bitty", "plugin-api"]) {
    const range = table[key];
    if (range === undefined) {
      continue;
    }
    if (typeof range !== "string") {
      diagnostics.push(
        error("manifest.type", `compat.${key}`, "expected a string"),
      );
    } else {
      const problem = versionReqProblem(range);
      if (problem !== undefined) {
        diagnostics.push(
          error("compat.range.invalid", `compat.${key}`, problem),
        );
      }
    }
  }
}

function validateDependencies(
  value: unknown,
  pluginId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const table = checkTable(value, "dependencies", diagnostics);
  if (table === undefined) {
    return;
  }
  const entries = flatten(table, "dependencies");
  if (entries.length > MAX_DEPENDENCIES) {
    diagnostics.push(
      error(
        "manifest.limit",
        "dependencies",
        `too many dependencies (${entries.length} > ${MAX_DEPENDENCIES})`,
      ),
    );
  }
  for (const entry of entries) {
    const id = entry.path.slice("dependencies.".length);
    const problem = pluginIdProblem(id);
    if (problem !== undefined) {
      diagnostics.push(
        error(
          "dependencies.id.invalid",
          entry.path,
          `dependency id ${quote(id)} is invalid: ${problem}`,
        ),
      );
      continue;
    }
    if (pluginId !== undefined && id === pluginId) {
      diagnostics.push(
        error(
          "dependencies.self",
          entry.path,
          "a plugin must not depend on itself",
        ),
      );
    }
    if (typeof entry.value !== "string") {
      diagnostics.push(
        error("manifest.type", entry.path, "expected a version range string"),
      );
    } else {
      const rangeProblem = versionReqProblem(entry.value);
      if (rangeProblem !== undefined) {
        diagnostics.push(
          error("dependencies.version.invalid", entry.path, rangeProblem),
        );
      }
    }
  }
}

/**
 * Validate one `[services.provided]` entry: the accepted string form or the
 * ADR 0009 table form `{ version, args_schema?, result_schema? }` with bounded
 * JSON Schema metadata. Unknown table keys and schema fragments outside the
 * supported subset stay rejected.
 */
function validateProvidedServiceEntry(
  path: string,
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  if (typeof value === "string") {
    const version = versionProblem(value);
    if (version !== undefined) {
      diagnostics.push(error("services.version.invalid", path, version));
    }
    return;
  }
  if (!isTable(value)) {
    diagnostics.push(
      error(
        "manifest.type",
        path,
        "expected a version string or a table with version/args_schema/result_schema",
      ),
    );
    return;
  }
  checkUnknownKeys(value, ALLOWED_SERVICES_PROVIDED_KEYS, path, diagnostics);
  const version = value.version;
  if (version === undefined) {
    diagnostics.push(
      error(
        "manifest.type",
        `${path}.version`,
        "expected a version string (required by the table form)",
      ),
    );
  } else if (typeof version !== "string") {
    diagnostics.push(
      error("manifest.type", `${path}.version`, "expected a version string"),
    );
  } else {
    const problem = versionProblem(version);
    if (problem !== undefined) {
      diagnostics.push(
        error("services.version.invalid", `${path}.version`, problem),
      );
    }
  }
  for (const field of ["args_schema", "result_schema"] as const) {
    const schema = value[field];
    if (schema === undefined) continue;
    const problem = schemaProblem(schema, field);
    if (problem !== undefined) {
      diagnostics.push(error("services.schema", `${path}.${field}`, problem));
    }
  }
}

function validateServices(value: unknown, diagnostics: Diagnostic[]): void {
  const table = checkTable(value, "services", diagnostics);
  if (table === undefined) {
    return;
  }
  checkUnknownKeys(table, ALLOWED_SERVICES_KEYS, "services", diagnostics);
  const provided = checkTable(table.provided, "services.provided", diagnostics);
  if (provided === undefined) {
    return;
  }
  const entries: ProvidedServiceEntry[] = [];
  collectProvidedServices(provided, "services.provided", entries);
  if (entries.length > MAX_PROVIDED_SERVICES) {
    diagnostics.push(
      error(
        "manifest.limit",
        "services.provided",
        `too many provided services (${entries.length} > ${MAX_PROVIDED_SERVICES})`,
      ),
    );
  }
  for (const entry of entries) {
    const iface = entry.path.slice("services.provided.".length);
    const problem = serviceInterfaceProblem(iface);
    if (problem !== undefined) {
      diagnostics.push(
        error(
          "services.interface.invalid",
          entry.path,
          `interface ${quote(iface)} is invalid: ${problem}`,
        ),
      );
      continue;
    }
    validateProvidedServiceEntry(entry.path, entry.value, diagnostics);
  }
}

function validateFilesystem(value: unknown, diagnostics: Diagnostic[]): void {
  const path = "capabilities.filesystem";
  if (!Array.isArray(value)) {
    diagnostics.push(
      error("manifest.type", path, "expected an array of tables"),
    );
    return;
  }
  const perAccess = new Map<string, number>();
  let totalPatternBytes = 0;
  value.forEach((entry: unknown, index: number): void => {
    const entryPath = `${path}[${index}]`;
    if (!isTable(entry)) {
      diagnostics.push(error("manifest.type", entryPath, "expected a table"));
      return;
    }
    checkUnknownKeys(entry, ALLOWED_FILESYSTEM_KEYS, entryPath, diagnostics);

    let accessKind: "read" | "write" | undefined;
    const access = entry.access;
    if (access === undefined) {
      diagnostics.push(
        error(
          "manifest.missing-key",
          `${entryPath}.access`,
          "required key is missing",
        ),
      );
    } else if (typeof access !== "string") {
      diagnostics.push(
        error("manifest.type", `${entryPath}.access`, "expected a string"),
      );
    } else if (access !== "read" && access !== "write") {
      diagnostics.push(
        error(
          "capabilities.filesystem.invalid",
          `${entryPath}.access`,
          "must be 'read' or 'write'",
        ),
      );
    } else {
      accessKind = access;
    }

    const paths = entry.paths;
    if (paths === undefined) {
      diagnostics.push(
        error(
          "manifest.missing-key",
          `${entryPath}.paths`,
          "required key is missing",
        ),
      );
      return;
    }
    if (!isStringArray(paths)) {
      diagnostics.push(
        error(
          "manifest.type",
          `${entryPath}.paths`,
          "expected an array of strings",
        ),
      );
      return;
    }
    if (accessKind !== undefined) {
      perAccess.set(
        accessKind,
        (perAccess.get(accessKind) ?? 0) + paths.length,
      );
    }
    if (paths.length === 0) {
      diagnostics.push(
        error(
          "capabilities.filesystem.invalid",
          `${entryPath}.paths`,
          "must contain at least one path pattern",
        ),
      );
    }
    paths.forEach((pattern: string, patternIndex: number): void => {
      const patternPath = `${entryPath}.paths[${patternIndex}]`;
      const problem = pathPatternProblem(pattern);
      if (problem !== undefined) {
        diagnostics.push(
          error(
            "capabilities.filesystem.invalid",
            patternPath,
            `path pattern ${quote(pattern)} is invalid: ${problem}`,
          ),
        );
        return;
      }
      totalPatternBytes += byteLength(pattern);
    });
  });

  for (const [access, count] of perAccess) {
    if (count > MAX_FS_PATTERNS_PER_ACCESS) {
      diagnostics.push(
        error(
          "manifest.limit",
          path,
          `too many ${access} patterns (${count} > ${MAX_FS_PATTERNS_PER_ACCESS} per access kind)`,
        ),
      );
    }
  }
  if (totalPatternBytes > MAX_PATTERN_TEXT_BYTES) {
    diagnostics.push(
      error(
        "manifest.limit",
        path,
        `total pattern text too large (${totalPatternBytes} > ${MAX_PATTERN_TEXT_BYTES} bytes)`,
      ),
    );
  }
}

function validateCapabilities(value: unknown, diagnostics: Diagnostic[]): void {
  const table = checkTable(value, "capabilities", diagnostics);
  if (table === undefined) {
    return;
  }
  for (const [key, rawValue] of Object.entries(table)) {
    if (key === "filesystem") {
      validateFilesystem(rawValue, diagnostics);
      continue;
    }
    const entries: FlatEntry[] = isTable(rawValue)
      ? flatten(rawValue, key)
      : [{ path: key, value: rawValue }];
    if (entries.length === 0) {
      continue;
    }
    for (const entry of entries) {
      if (entry.value !== true) {
        diagnostics.push(
          error(
            "capabilities.value",
            entry.path,
            "requested capabilities must be declared as `= true`",
          ),
        );
        continue;
      }
      diagnostics.push(...validateCapabilityId(entry.path, entry.path));
    }
  }
}

function validateLazyCommandName(
  command: string,
  commandPath: string,
  pluginId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const problem = qualifiedNameProblem(command);
  if (problem !== undefined) {
    diagnostics.push(
      error(
        "lazy.commands.invalid",
        commandPath,
        `command ${quote(command)} is invalid: ${problem}`,
      ),
    );
    return;
  }
  const prefix = command.slice(0, command.indexOf(":"));
  if (pluginId !== undefined && prefix !== pluginId) {
    diagnostics.push(
      error(
        "lazy.commands.owner",
        commandPath,
        `command namespace ${quote(prefix)} does not match plugin id ${quote(pluginId)}`,
      ),
    );
  }
}

/**
 * Validate one `[lazy].commands` entry: the accepted string form or the ADR
 * 0009 table form `{ id, args_schema?, result_schema? }` with bounded JSON
 * Schema metadata. Unknown table keys and schema fragments outside the
 * supported subset stay rejected.
 */
function validateLazyCommandEntry(
  entry: unknown,
  index: number,
  pluginId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const commandPath = `lazy.commands[${index}]`;
  if (typeof entry === "string") {
    validateLazyCommandName(entry, commandPath, pluginId, diagnostics);
    return;
  }
  if (!isTable(entry)) {
    diagnostics.push(
      error(
        "manifest.type",
        commandPath,
        "expected a string or a table with id/args_schema/result_schema",
      ),
    );
    return;
  }

  checkUnknownKeys(entry, ALLOWED_LAZY_COMMAND_KEYS, commandPath, diagnostics);

  const id = entry.id;
  if (typeof id !== "string") {
    diagnostics.push(
      error("manifest.type", `${commandPath}.id`, "expected a string id"),
    );
  } else {
    validateLazyCommandName(id, `${commandPath}.id`, pluginId, diagnostics);
  }

  for (const field of ["args_schema", "result_schema"] as const) {
    const schema = entry[field];
    if (schema === undefined) continue;
    const problem = schemaProblem(schema, field);
    if (problem !== undefined) {
      diagnostics.push(
        error("lazy.commands.schema", `${commandPath}.${field}`, problem),
      );
    }
  }
}

function validateLazy(
  value: unknown,
  pluginId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const table = checkTable(value, "lazy", diagnostics);
  if (table === undefined) {
    return;
  }
  checkUnknownKeys(table, ALLOWED_LAZY_KEYS, "lazy", diagnostics);

  const commands = table.commands;
  if (commands !== undefined) {
    if (!Array.isArray(commands)) {
      diagnostics.push(
        error(
          "manifest.type",
          "lazy.commands",
          "expected an array of command entries (string or table)",
        ),
      );
    } else {
      if (commands.length > MAX_COMMANDS) {
        diagnostics.push(
          error(
            "manifest.limit",
            "lazy.commands",
            `too many commands (${commands.length} > ${MAX_COMMANDS})`,
          ),
        );
      }
      commands.forEach((entry, index): void => {
        validateLazyCommandEntry(entry, index, pluginId, diagnostics);
      });
    }
  }

  const events = table.events;
  if (events !== undefined) {
    if (!isStringArray(events)) {
      diagnostics.push(
        error("manifest.type", "lazy.events", "expected an array of strings"),
      );
    } else {
      if (events.length > MAX_EVENT_TYPES) {
        diagnostics.push(
          error(
            "manifest.limit",
            "lazy.events",
            `too many event types (${events.length} > ${MAX_EVENT_TYPES})`,
          ),
        );
      }
      events.forEach((event: string, index: number): void => {
        const eventPath = `lazy.events[${index}]`;
        if (
          event.length === 0 ||
          byteLength(event) > MAX_EVENT_TYPE_LEN ||
          CONTROL_OR_WHITESPACE.test(event)
        ) {
          diagnostics.push(
            error(
              "lazy.events.invalid",
              eventPath,
              `event type must be 1..${MAX_EVENT_TYPE_LEN} bytes without whitespace or control characters`,
            ),
          );
          return;
        }
        if (!EVENT_KIND_SET.has(event)) {
          diagnostics.push(
            error(
              "lazy.events.unknown",
              eventPath,
              `unknown event kind ${quote(event)} is not part of the closed v1 event set`,
            ),
          );
        }
      });
    }
  }

  const claims = table.claims;
  if (claims !== undefined) {
    if (!isStringArray(claims)) {
      diagnostics.push(
        error("manifest.type", "lazy.claims", "expected an array of strings"),
      );
    } else {
      claims.forEach((claim: string, index: number): void => {
        const claimPath = `lazy.claims[${index}]`;
        if (claim.length === 0 || byteLength(claim) > MAX_CLAIM_LEN) {
          diagnostics.push(
            error(
              "lazy.claims.invalid",
              claimPath,
              `claim must be 1..${MAX_CLAIM_LEN} bytes`,
            ),
          );
        }
      });
    }
  }
}

/**
 * Validate the Layer-2 system-CLI reuse declaration (`[tools.*]`).
 *
 * Only the accepted `[tools.git]` slice (CTX-0425) passes:
 * `{ required: boolean, version: version-range }`. Any other tool table fails
 * closed with `tools.tool.unknown` until its own slice is accepted. Verbs and
 * bounds are host-enforced constants, not manifest fields, so extra keys in
 * `[tools.git]` (such as `args`, `verbs`, or bounds) are rejected as
 * `manifest.unknown-key` rather than validated.
 */
function validateTools(value: unknown, diagnostics: Diagnostic[]): void {
  if (value === undefined) {
    return;
  }
  const table = checkTable(value, "tools", diagnostics);
  if (table === undefined) {
    return;
  }
  for (const key of Object.keys(table)) {
    if (!ALLOWED_TOOLS_KEYS.has(key)) {
      diagnostics.push(
        error(
          "tools.tool.unknown",
          `tools.${key}`,
          `unknown tool '${key}' is not part of the accepted Layer-2 contract (only [tools.git] is accepted)`,
        ),
      );
    }
  }

  const git = table.git;
  if (git === undefined) {
    diagnostics.push(
      error(
        "manifest.missing-key",
        "tools.git",
        "required [tools.git] table is missing (only the accepted [tools.git] slice may be declared)",
      ),
    );
    return;
  }
  const gitTable = checkTable(git, "tools.git", diagnostics);
  if (gitTable === undefined) {
    return;
  }
  checkUnknownKeys(gitTable, ALLOWED_TOOLS_GIT_KEYS, "tools.git", diagnostics);

  const required = gitTable.required;
  if (required === undefined) {
    diagnostics.push(
      error(
        "manifest.missing-key",
        "tools.git.required",
        "required key is missing",
      ),
    );
  } else if (typeof required !== "boolean") {
    diagnostics.push(
      error(
        "manifest.type",
        "tools.git.required",
        "expected a boolean (true fails activation closed when the tool is missing or mismatched)",
      ),
    );
  }

  const version = gitTable.version;
  if (version === undefined) {
    diagnostics.push(
      error(
        "manifest.missing-key",
        "tools.git.version",
        "required key is missing",
      ),
    );
  } else if (typeof version !== "string") {
    diagnostics.push(
      error("manifest.type", "tools.git.version", "expected a string"),
    );
  } else {
    const problem = versionReqProblem(version);
    if (problem !== undefined) {
      diagnostics.push(
        error("tools.version.invalid", "tools.git.version", problem),
      );
    }
  }
}

/**
 * Validate one manifest source string.
 *
 * Returns every diagnostic found; the manifest is valid only when no
 * diagnostic has severity `error` (warnings, such as high-risk capability
 * notices, do not fail validation).
 */
export function lintManifestSource(source: string): LintResult {
  const diagnostics: Diagnostic[] = [];
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MANIFEST_MAX_BYTES) {
    return {
      valid: false,
      diagnostics: [
        error(
          "manifest.size",
          "",
          `manifest is ${bytes} bytes; limit is ${MANIFEST_MAX_BYTES} bytes`,
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(source, { maxDepth: MANIFEST_MAX_DEPTH });
  } catch (cause) {
    const message =
      cause instanceof TomlError
        ? `invalid TOML at ${cause.line}:${cause.column}: ${cause.message}`
        : `invalid TOML: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      valid: false,
      diagnostics: [error("manifest.parse", "", message)],
    };
  }

  if (!isTable(parsed)) {
    return {
      valid: false,
      diagnostics: [error("manifest.type", "", "expected a TOML table")],
    };
  }

  if (exceedsMaxDepth(parsed, 0)) {
    diagnostics.push(
      error(
        "manifest.limit",
        "",
        `manifest nesting exceeds the ${MANIFEST_MAX_DEPTH}-level structure limit`,
      ),
    );
  }

  checkUnknownKeys(parsed, ALLOWED_ROOT_KEYS, "", diagnostics);
  const pluginId = validatePluginSection(parsed.plugin, diagnostics);
  validateCompat(parsed.compat, diagnostics);
  validateDependencies(parsed.dependencies, pluginId, diagnostics);
  validateServices(parsed.services, diagnostics);
  validateCapabilities(parsed.capabilities, diagnostics);
  validateLazy(parsed.lazy, pluginId, diagnostics);
  validateTools(parsed.tools, diagnostics);

  return {
    valid: diagnostics.every((entry) => entry.severity !== "error"),
    diagnostics,
  };
}
