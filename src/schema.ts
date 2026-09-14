/**
 * `bitty-plugin.toml` schema constants (Plugin API v1).
 *
 * Derived from the accepted contract in `bitty-docs`:
 * `docs/specifications/plugin-platform-rfc.md` (OQ-011, OQ-012, OQ-013).
 * Hard limits and field bounds mirror the reference host models
 * (`bitty-plugin-host/src/manifest.rs`, `bitty-package/src/manifest.rs`) so
 * this validator never accepts a manifest the host rejects.
 */

/** Canonical manifest file name fixed by the accepted contract. */
export const MANIFEST_FILE_NAME = "bitty-plugin.toml";

/** Maximum manifest size in bytes (256 KiB). */
export const MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Maximum TOML nesting depth accepted before parsing is rejected.
 *
 * The schema needs at most four levels (`capabilities.filesystem[].field`);
 * this bound is part of the accepted "hard structure limits" requirement and
 * keeps attacker-controlled input away from parser recursion limits.
 */
export const MANIFEST_MAX_DEPTH = 8;

/** Maximum declared lazy commands. */
export const MAX_COMMANDS = 128;

/** Maximum subscribed lazy event types. */
export const MAX_EVENT_TYPES = 256;

/** Maximum filesystem patterns per access kind (`read` or `write`). */
export const MAX_FS_PATTERNS_PER_ACCESS = 32;

/** Maximum provided services. */
export const MAX_PROVIDED_SERVICES = 16;

/** Maximum plugin dependencies. */
export const MAX_DEPENDENCIES = 8;

/** Maximum total filesystem pattern text in bytes (8 KiB). */
export const MAX_PATTERN_TEXT_BYTES = 8 * 1024;

/** Maximum plugin id length. */
export const MAX_PLUGIN_ID_LEN = 128;

/** Maximum plugin id segment length. */
export const MAX_PLUGIN_ID_SEGMENT_LEN = 64;

/** Maximum display name length. */
export const MAX_NAME_LEN = 128;

/** Maximum description length. */
export const MAX_DESCRIPTION_LEN = 1024;

/** Maximum license expression length. */
export const MAX_LICENSE_LEN = 256;

/** Maximum concrete version length. */
export const MAX_VERSION_LEN = 64;

/** Maximum version requirement length. */
export const MAX_VERSION_REQ_LEN = 128;

/** Maximum qualified name length (`plugin-id:resource`). */
export const MAX_QUALIFIED_NAME_LEN = 256;

/** Maximum qualified name resource segment length. */
export const MAX_QUALIFIED_RESOURCE_LEN = 128;

/** Maximum capability identifier length including parameter. */
export const MAX_CAPABILITY_LEN = 512;

/** Maximum capability parameter length. */
export const MAX_CAPABILITY_PARAM_LEN = 1024;

/** Maximum filesystem path pattern length. */
export const MAX_FS_PATH_LEN = 512;

/** Maximum service interface name length. */
export const MAX_SERVICE_IFACE_LEN = 128;

/** Maximum service interface name segment length. */
export const MAX_SERVICE_IFACE_SEGMENT_LEN = 64;

/** Maximum event type length. */
export const MAX_EVENT_TYPE_LEN = 128;

/** Maximum lazy claim length. */
export const MAX_CLAIM_LEN = 64;

/** Root tables accepted by the manifest schema. */
export const ALLOWED_ROOT_KEYS: ReadonlySet<string> = new Set([
  "plugin",
  "compat",
  "dependencies",
  "services",
  "capabilities",
  "lazy",
]);

/** `[plugin]` keys accepted by the manifest schema. */
export const ALLOWED_PLUGIN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "version",
  "description",
  "license",
]);

/** `[plugin]` keys that must be present. */
export const REQUIRED_PLUGIN_KEYS: readonly string[] = [
  "id",
  "name",
  "version",
  "description",
];

/** `[compat]` keys accepted by the manifest schema. */
export const ALLOWED_COMPAT_KEYS: ReadonlySet<string> = new Set([
  "bitty",
  "plugin-api",
]);

/** `[services]` keys accepted by the manifest schema. */
export const ALLOWED_SERVICES_KEYS: ReadonlySet<string> = new Set(["provided"]);

/** Keys accepted in one table-form `[services.provided]` entry (ADR 0009). */
export const ALLOWED_SERVICES_PROVIDED_KEYS: ReadonlySet<string> = new Set([
  "version",
  "args_schema",
  "result_schema",
]);

/** Keys accepted in one `[[capabilities.filesystem]]` entry. */
export const ALLOWED_FILESYSTEM_KEYS: ReadonlySet<string> = new Set([
  "access",
  "paths",
]);

/** `[lazy]` keys accepted by the manifest schema. */
export const ALLOWED_LAZY_KEYS: ReadonlySet<string> = new Set([
  "commands",
  "events",
  "claims",
]);

/** Keys accepted in one table-form `[lazy].commands` entry (ADR 0009). */
export const ALLOWED_LAZY_COMMAND_KEYS: ReadonlySet<string> = new Set([
  "id",
  "args_schema",
  "result_schema",
]);

/** One flattened `[services.provided]` entry: dotted path plus raw value. */
export interface ProvidedServiceEntry {
  readonly path: string;
  readonly value: unknown;
}

function isServiceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shared `[services.provided]` walker: reconstruct dotted interface names
 * from the nested shape TOML produces for bare dotted and quoted keys. A
 * table carrying any table-form key is the entry itself; an empty table is
 * also an entry so the validator rejects it instead of dropping it silently;
 * every other table is an intermediate namespace and is walked. A string leaf
 * is always the accepted string form.
 *
 * Kept interpretation (CTX-0027, option a): bare `foo.version = "1.0.0"`
 * parses to `{ foo: { version: "1.0.0" } }`, byte-identical to the minimal
 * table form for `foo`, so it stays the table form. Authors must quote
 * interface names whose segments collide with form keys
 * (`"foo.version" = "1.0.0"`).
 */
export function collectProvidedServices(
  table: Record<string, unknown>,
  prefix: string,
  entries: ProvidedServiceEntry[],
): void {
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const isFormTable =
      isServiceRecord(value) &&
      Object.keys(value).some((member) =>
        ALLOWED_SERVICES_PROVIDED_KEYS.has(member),
      );
    if (
      isServiceRecord(value) &&
      !isFormTable &&
      Object.keys(value).length > 0
    ) {
      collectProvidedServices(value, path, entries);
    } else {
      entries.push({ path, value });
    }
  }
}
