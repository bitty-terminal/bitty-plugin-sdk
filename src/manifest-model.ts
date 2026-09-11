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
import { lintManifestSource } from "./manifest.js";
import { MANIFEST_MAX_DEPTH } from "./schema.js";

/** Closed declaration set read from an accepted manifest. */
export interface ManifestModel {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly pluginApiRange?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly events: readonly string[];
  readonly claims: readonly string[];
  readonly providedServices: ReadonlyMap<string, string>;
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

function readProvidedServices(services: unknown): ReadonlyMap<string, string> {
  const provided = new Map<string, string>();
  if (!isTable(services)) return provided;
  const table = services.provided;
  if (!isTable(table)) return provided;
  for (const [iface, version] of Object.entries(table)) {
    if (typeof version === "string") provided.set(iface, version);
  }
  return provided;
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

  return {
    pluginId,
    name,
    version,
    ...(pluginApiRange === undefined ? {} : { pluginApiRange }),
    capabilities: readCapabilities(capabilities),
    commands: readStringArray(lazy.commands),
    events: readStringArray(lazy.events),
    claims: readStringArray(lazy.claims),
    providedServices: readProvidedServices(parsed.services),
  };
}
