/**
 * Generates and validates `lua/bitty.d.lua` from the machine-readable Plugin
 * API v1 surface table (`surface/bitty-plugin-api-v1.json`).
 *
 * The surface table is derived from accepted `bitty-docs` contracts
 * (ADR 0009 and the Plugin API v1 Lua Surface RFC). The generated file is the
 * only LuaLS declaration artifact; `--check` fails when it drifts from the
 * surface table and is part of `just check`.
 *
 * Usage:
 *   bun scripts/generate-lua-defs.ts --check   # default; fail on drift
 *   bun scripts/generate-lua-defs.ts --write   # regenerate lua/bitty.d.lua
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SurfaceSource {
  readonly repository: string;
  readonly path: string;
  readonly status: string;
  readonly revision: string;
}

export interface SurfaceField {
  readonly name: string;
  readonly type: string;
  readonly doc: string;
  readonly optional?: boolean;
}

export interface SurfaceType {
  readonly name: string;
  readonly kind: "alias" | "class";
  readonly type?: string;
  readonly doc: string;
  readonly optional?: boolean;
  readonly fields?: readonly SurfaceField[];
}

export interface SurfaceParam {
  readonly name: string;
  readonly type: string;
  readonly optional?: boolean;
}

export interface SurfaceReturn {
  readonly type: string;
}

/**
 * A capability that is required only under a named accepted condition, such as
 * the `ui.overlay` gate for the `overlay` slot of `bitty.ui.mount`. The
 * `capabilities` array stays reserved for unconditional gates so the rendered
 * annotation never overstates an always-on requirement.
 */
export interface SurfaceConditionalCapability {
  readonly capability: string;
  readonly when: string;
}

export type HostParityStatus = "wired" | "deferred";

export interface SurfaceHostParity {
  readonly repository: string;
  readonly commit: string;
  readonly pr: number;
  readonly note: string;
  readonly namespaces: Readonly<Record<string, HostParityStatus>>;
}

export interface SurfaceFunction {
  readonly path: string;
  readonly level: "L1" | "L2";
  readonly capabilities: readonly string[];
  readonly conditionalCapabilities?: readonly SurfaceConditionalCapability[];
  readonly errors: readonly string[];
  readonly doc: string;
  readonly params: readonly SurfaceParam[];
  readonly returns: readonly SurfaceReturn[];
}

export interface SurfaceEvent {
  readonly name: string;
  readonly class: "Lifecycle" | "Observation" | "Interception";
  readonly payload: string;
}

export interface SurfaceExclusion {
  readonly path: string;
  readonly reason: string;
}

export interface SurfaceExcludedLiteral {
  readonly path: string;
  readonly argument: string;
  readonly value: string;
  readonly reason: string;
}

export interface Surface {
  readonly format: string;
  readonly module: string;
  readonly api_version: string;
  readonly output: string;
  readonly hostParity: SurfaceHostParity;
  readonly sources: readonly SurfaceSource[];
  readonly types: readonly SurfaceType[];
  readonly functions: readonly SurfaceFunction[];
  readonly events: readonly SurfaceEvent[];
  readonly exclusions: readonly SurfaceExclusion[];
  readonly excludedArgumentLiterals: readonly SurfaceExcludedLiteral[];
}

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SURFACE_PATH = join(REPO_ROOT, "surface/bitty-plugin-api-v1.json");
export const OUTPUT_PATH = join(REPO_ROOT, "lua/bitty.d.lua");

const SURFACE_FORMAT = "bitty-plugin-api-surface/v1";
const MODULE_NAME = "bitty";
const DOC_WIDTH = 96;
const BUILTIN_TYPE_TOKENS = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "table",
  "fun",
  "any",
  "nil",
  "true",
  "false",
  "self",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadSurface(path: string = SURFACE_PATH): Surface {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path}: surface table must be a JSON object`);
  }
  return parsed as unknown as Surface;
}

function namespacePrefix(typeName: string): string | undefined {
  const match = /^Bitty([A-Z][A-Za-z0-9]*)Namespace$/.exec(typeName);
  if (match === null) return undefined;
  const stem = match[1] ?? "";
  return stem.charAt(0).toLowerCase() + stem.slice(1);
}

function typeTokens(type: string): string[] {
  const withoutLiterals = type.replace(/"[^"]*"/g, " ");
  return [...withoutLiterals.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map(
    (match) => match[0] ?? "",
  );
}

export function validateSurface(surface: Surface): string[] {
  const problems: string[] = [];

  if (surface.format !== SURFACE_FORMAT) {
    problems.push(`format must be ${SURFACE_FORMAT}`);
  }
  if (surface.module !== MODULE_NAME) {
    problems.push(`module must be ${MODULE_NAME}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(surface.api_version)) {
    problems.push(`api_version must be SemVer 2: ${surface.api_version}`);
  }
  if (surface.output !== "lua/bitty.d.lua") {
    problems.push(`output must be lua/bitty.d.lua: ${surface.output}`);
  }
  for (const source of surface.sources) {
    if (source.status !== "accepted") {
      problems.push(`${source.path}: source status must be accepted`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(source.revision)) {
      problems.push(`${source.path}: revision must be a pinned git object id`);
    }
  }
  if (surface.sources.length === 0) {
    problems.push("at least one accepted source is required");
  }

  const typeNames = new Set<string>();
  for (const type of surface.types) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(type.name)) {
      problems.push(`type name must be PascalCase: ${type.name}`);
    }
    if (typeNames.has(type.name)) {
      problems.push(`duplicate type: ${type.name}`);
    }
    typeNames.add(type.name);
    if (type.doc.trim() === "" || type.doc.includes("\n")) {
      problems.push(`${type.name}: doc must be single-line and non-empty`);
    }
    if (type.kind === "alias") {
      if (
        typeof type.type !== "string" ||
        type.type.trim() !== type.type ||
        type.type === ""
      ) {
        problems.push(`${type.name}: alias requires a trimmed type`);
      }
      if (type.fields !== undefined) {
        problems.push(`${type.name}: alias must not declare fields`);
      }
    } else if (type.kind === "class") {
      if (type.type !== undefined) {
        problems.push(`${type.name}: class must not declare an alias type`);
      }
    } else {
      problems.push(`${type.name}: kind must be alias or class`);
    }
    const fieldNames = new Set<string>();
    for (const field of type.fields ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(field.name)) {
        problems.push(`${type.name}.${field.name}: invalid field name`);
      }
      if (fieldNames.has(field.name)) {
        problems.push(`${type.name}.${field.name}: duplicate field`);
      }
      fieldNames.add(field.name);
      if (field.type.trim() === "" || field.type.includes("\n")) {
        problems.push(`${type.name}.${field.name}: invalid field type`);
      }
      if (field.doc.trim() === "" || field.doc.includes("\n")) {
        problems.push(
          `${type.name}.${field.name}: doc must be single-line and non-empty`,
        );
      }
    }
  }

  for (const type of surface.types) {
    for (const field of type.fields ?? []) {
      for (const token of typeTokens(field.type)) {
        if (/^[A-Z]/.test(token) && !typeNames.has(token)) {
          problems.push(
            `${type.name}.${field.name}: unknown type reference ${token}`,
          );
        }
      }
    }
    if (type.kind === "alias" && type.type !== undefined) {
      for (const token of typeTokens(type.type)) {
        if (/^[A-Z]/.test(token) && !typeNames.has(token)) {
          problems.push(`${type.name}: unknown type reference ${token}`);
        }
      }
    }
  }

  const namespaceTypes = new Map<string, string>();
  for (const type of surface.types) {
    const prefix = namespacePrefix(type.name);
    if (prefix === undefined) {
      if (type.optional === true) {
        problems.push(`${type.name}: only namespace classes may be optional`);
      }
      continue;
    }
    if (type.kind !== "class") {
      problems.push(`${type.name}: namespace must be a class`);
    }
    namespaceTypes.set(prefix, type.name);
  }

  const functionPaths = new Set<string>();
  const prefixesWithFunctions = new Set<string>();
  for (const fn of surface.functions) {
    const [prefix, ...rest] = fn.path.split(".");
    const name = rest.join(".");
    if (prefix === undefined || name === "" || rest.length !== 1) {
      problems.push(`function path must be <namespace>.<name>: ${fn.path}`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(prefix) || !/^[a-z][a-z0-9_]*$/.test(name)) {
      problems.push(`function path has invalid segments: ${fn.path}`);
    }
    if (functionPaths.has(fn.path)) {
      problems.push(`duplicate function: ${fn.path}`);
    }
    functionPaths.add(fn.path);
    prefixesWithFunctions.add(prefix);
    if (!namespaceTypes.has(prefix)) {
      problems.push(
        `${fn.path}: no Bitty${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}Namespace type`,
      );
    }
    if (fn.level !== "L1" && fn.level !== "L2") {
      problems.push(`${fn.path}: level must be L1 or L2`);
    }
    if (fn.doc.trim() === "" || fn.doc.includes("\n")) {
      problems.push(`${fn.path}: doc must be single-line and non-empty`);
    }
    const seenConditional = new Set<string>();
    for (const gate of (fn.conditionalCapabilities ??
      []) as readonly unknown[]) {
      if (!isRecord(gate)) {
        problems.push(
          `${fn.path}: conditional capability entry must be an object`,
        );
        continue;
      }
      const capability = gate.capability;
      const when = gate.when;
      if (
        typeof capability !== "string" ||
        !/^[a-z][a-z0-9_.:-]*$/.test(capability)
      ) {
        problems.push(
          `${fn.path}: invalid conditional capability ${JSON.stringify(capability)}`,
        );
        continue;
      }
      if (seenConditional.has(capability)) {
        problems.push(
          `${fn.path}: duplicate conditional capability ${capability}`,
        );
      }
      seenConditional.add(capability);
      if (typeof when !== "string" || when.trim() === "") {
        problems.push(
          `${fn.path}: conditional capability ${capability} needs a non-empty when condition`,
        );
      }
    }
    const paramNames = new Set<string>();
    for (const param of fn.params) {
      if (!/^[a-z][a-z0-9_]*$/.test(param.name)) {
        problems.push(`${fn.path}.${param.name}: invalid parameter name`);
      }
      if (paramNames.has(param.name)) {
        problems.push(`${fn.path}.${param.name}: duplicate parameter`);
      }
      paramNames.add(param.name);
      for (const token of typeTokens(param.type)) {
        if (/^[A-Z]/.test(token) && !typeNames.has(token)) {
          problems.push(
            `${fn.path}.${param.name}: unknown type reference ${token}`,
          );
        }
      }
    }
    for (const param of fn.params) {
      if (
        param.optional === true &&
        fn.params.indexOf(param) === fn.params.length - 1
      ) {
        continue;
      }
      if (param.optional === true) {
        problems.push(
          `${fn.path}.${param.name}: only trailing parameters may be optional`,
        );
      }
    }
    if (fn.returns.length === 0) {
      problems.push(`${fn.path}: at least one return annotation is required`);
    }
    for (const result of fn.returns) {
      for (const token of typeTokens(result.type)) {
        if (/^[A-Z]/.test(token) && !typeNames.has(token)) {
          problems.push(`${fn.path}: unknown return type reference ${token}`);
        }
      }
    }
  }
  const parityNamespaces =
    surface.hostParity !== undefined && isRecord(surface.hostParity.namespaces)
      ? (surface.hostParity.namespaces as Record<string, unknown>)
      : undefined;
  if (
    surface.hostParity === undefined ||
    typeof surface.hostParity.repository !== "string" ||
    surface.hostParity.repository === "" ||
    typeof surface.hostParity.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(surface.hostParity.commit) ||
    typeof surface.hostParity.pr !== "number" ||
    !Number.isInteger(surface.hostParity.pr) ||
    surface.hostParity.pr <= 0 ||
    parityNamespaces === undefined
  ) {
    problems.push(
      "hostParity must pin the host repository, 40-hex commit, numeric PR, and namespace map",
    );
  } else {
    const missingPrefixes = new Set<string>();
    for (const fn of surface.functions) {
      const prefix = fn.path.split(".")[0] ?? "";
      const status = parityNamespaces[prefix];
      if (status !== "wired" && status !== "deferred") {
        missingPrefixes.add(prefix);
        continue;
      }
      if (status === "deferred") {
        if (fn.errors.length !== 1 || fn.errors[0] !== "E_NOT_IMPLEMENTED") {
          problems.push(
            `${fn.path}: deferred functions must list exactly E_NOT_IMPLEMENTED`,
          );
        }
      } else if (fn.errors.includes("E_NOT_IMPLEMENTED")) {
        problems.push(
          `${fn.path}: wired functions must not list E_NOT_IMPLEMENTED`,
        );
      }
    }
    for (const prefix of missingPrefixes) {
      problems.push(`hostParity.namespaces misses namespace ${prefix}`);
    }
    for (const namespace of Object.keys(parityNamespaces)) {
      if (!prefixesWithFunctions.has(namespace)) {
        problems.push(
          `hostParity.namespaces lists a namespace with no functions: ${namespace}`,
        );
      }
      if (
        parityNamespaces[namespace] !== "wired" &&
        parityNamespaces[namespace] !== "deferred"
      ) {
        problems.push(
          `hostParity.namespaces[${namespace}] must be wired or deferred`,
        );
      }
    }
  }
  for (const [prefix, typeName] of namespaceTypes) {
    if (!prefixesWithFunctions.has(prefix)) {
      problems.push(`${typeName}: namespace has no functions`);
    }
  }

  const eventNames = new Set<string>();
  for (const event of surface.events) {
    if (!/^[a-z][a-z0-9.-]*$/.test(event.name)) {
      problems.push(`event name is invalid: ${event.name}`);
    }
    if (eventNames.has(event.name)) {
      problems.push(`duplicate event: ${event.name}`);
    }
    eventNames.add(event.name);
    if (!typeNames.has(event.payload)) {
      problems.push(`${event.name}: unknown payload type ${event.payload}`);
    }
    if (!["Lifecycle", "Observation", "Interception"].includes(event.class)) {
      problems.push(`${event.name}: invalid event class ${event.class}`);
    }
  }

  const exclusionPaths = new Set<string>();
  for (const exclusion of surface.exclusions) {
    if (!/^bitty\.[a-z][a-z0-9._-]*$/.test(exclusion.path)) {
      problems.push(`exclusion path is invalid: ${exclusion.path}`);
    }
    if (exclusionPaths.has(exclusion.path)) {
      problems.push(`duplicate exclusion: ${exclusion.path}`);
    }
    exclusionPaths.add(exclusion.path);
    const [, ...segments] = exclusion.path.split(".");
    const namespace = segments[0] ?? "";
    if (namespaceTypes.has(namespace) && segments.length === 1) {
      problems.push(
        `exclusion ${exclusion.path} collides with a declared namespace`,
      );
    }
    if (functionPaths.has(segments.join(".")) && segments.length > 1) {
      problems.push(
        `exclusion ${exclusion.path} collides with a declared function`,
      );
    }
    if (typeNames.has(segments.join("."))) {
      problems.push(
        `exclusion ${exclusion.path} collides with a declared type`,
      );
    }
    if (exclusion.reason.trim() === "") {
      problems.push(`${exclusion.path}: exclusion requires a reason`);
    }
  }

  for (const literal of surface.excludedArgumentLiterals) {
    const fn = surface.functions.find((entry) => entry.path === literal.path);
    if (fn === undefined) {
      problems.push(
        `${literal.path}: excluded literal references an unknown function`,
      );
      continue;
    }
    const directParam = fn.params.find(
      (entry) => entry.name === literal.argument,
    );
    const memberTypes: string[] =
      directParam === undefined ? [] : [directParam.type];
    if (directParam === undefined) {
      for (const param of fn.params) {
        for (const token of typeTokens(param.type)) {
          const type = surface.types.find((entry) => entry.name === token);
          const field = type?.fields?.find(
            (entry) => entry.name === literal.argument,
          );
          if (field !== undefined) memberTypes.push(field.type);
        }
      }
    }
    if (memberTypes.length === 0) {
      problems.push(
        `${literal.path}.${literal.argument}: excluded literal references an unknown argument`,
      );
      continue;
    }
    if (
      memberTypes.some((type) =>
        type.split("|").some((part) => part.trim() === `"${literal.value}"`),
      )
    ) {
      problems.push(
        `${literal.path}.${literal.argument}: excluded literal "${literal.value}" must not be a declared type member`,
      );
    }
  }

  return problems;
}

function wrapDoc(doc: string): string[] {
  const words = doc.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= DOC_WIDTH) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function renderType(type: SurfaceType): string[] {
  const lines = wrapDoc(type.doc).map((line) => `--- ${line}`);
  if (type.kind === "alias") {
    lines.push(`---@alias ${type.name} ${type.type ?? ""}`);
    return lines;
  }
  lines.push(`---@class ${type.name}`);
  for (const field of type.fields ?? []) {
    const name = field.optional === true ? `${field.name}?` : field.name;
    lines.push(`---@field ${name} ${field.type} ${field.doc}`);
  }
  return lines;
}

function renderFunction(
  fn: SurfaceFunction,
  namespaceType: string,
  deferred: boolean,
): string[] {
  const lines = wrapDoc(fn.doc).map((line) => `--- ${line}`);
  if (fn.capabilities.length > 0) {
    lines.push(`--- Capabilities: ${fn.capabilities.join(", ")}.`);
  }
  for (const gate of fn.conditionalCapabilities ?? []) {
    lines.push(
      `--- Conditional capabilities: ${gate.capability} (when ${gate.when}).`,
    );
  }
  if (deferred) {
    lines.push(
      "--- Host status: deferred - always fails with E_NOT_IMPLEMENTED (runtime) until the host backend lands.",
    );
  }
  if (fn.errors.length > 0) {
    lines.push(`--- Errors: ${fn.errors.join(", ")}.`);
  }
  for (const param of fn.params) {
    const name = param.optional === true ? `${param.name}?` : param.name;
    lines.push(`---@param ${name} ${param.type}`);
  }
  for (const result of fn.returns) {
    lines.push(`---@return ${result.type}`);
  }
  const name = fn.path.split(".")[1] ?? "";
  const params = fn.params.map((param) => param.name).join(", ");
  lines.push(`function ${namespaceType}.${name}(${params}) end`);
  return lines;
}

export function renderDefinitions(surface: Surface): string {
  const lines: string[] = [
    "--- Bitty Plugin API v1 LuaLS definitions.",
    "--- GENERATED FILE - DO NOT EDIT.",
    `--- Source: ${surface.output === "" ? "" : "surface/bitty-plugin-api-v1.json"}`,
    `--- Contract: ${surface.sources.map((source) => `${source.repository}:${source.path}`).join(" + ")}`,
    "--- Regenerate: bun scripts/generate-lua-defs.ts --write",
    "--- Verify: just lua-defs-check",
    `---@meta ${surface.module}`,
    "",
  ];

  const namespaceByPrefix = new Map<string, SurfaceType>();
  for (const type of surface.types) {
    const prefix = namespacePrefix(type.name);
    if (prefix !== undefined) namespaceByPrefix.set(prefix, type);
  }
  const deferredNamespaces = new Set(
    Object.entries(surface.hostParity.namespaces ?? {})
      .filter(([, status]) => status === "deferred")
      .map(([namespace]) => namespace),
  );

  for (const type of surface.types) {
    lines.push(...renderType(type));
    const prefix = namespacePrefix(type.name);
    if (prefix !== undefined) {
      lines.push(`local ${type.name} = {}`);
      lines.push("");
      for (const fn of surface.functions) {
        if (fn.path.startsWith(`${prefix}.`)) {
          lines.push(
            ...renderFunction(
              fn,
              type.name,
              deferredNamespaces.has(prefix ?? ""),
            ),
          );
          lines.push("");
        }
      }
    } else {
      lines.push("");
    }
  }

  lines.push(
    "--- Host-injected read-only module table; it is not loaded through require.",
  );
  lines.push(`---@class ${surface.module}`);
  lines.push(
    `---@field api_version string Host bridge API version (${surface.api_version}); minor versions are additive only.`,
  );
  for (const type of surface.types) {
    const prefix = namespacePrefix(type.name);
    if (prefix === undefined) continue;
    const field = type.optional === true ? `${prefix}?` : prefix;
    lines.push(`---@field ${field} ${type.name}`);
  }
  lines.push(`${surface.module} = {}`);
  lines.push("");

  return lines.join("\n");
}

interface DiffResult {
  readonly equal: boolean;
  readonly report: string;
}

export function diffDefinitions(expected: string, actual: string): DiffResult {
  if (expected === actual) return { equal: true, report: "" };
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const limit = Math.max(expectedLines.length, actualLines.length);
  let first = -1;
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      first = index;
      break;
    }
  }
  const report: string[] = [];
  report.push(`first difference at line ${first + 1}`);
  for (
    let index = Math.max(0, first - 1);
    index < Math.min(limit, first + 6);
    index += 1
  ) {
    const expectedLine = expectedLines[index] ?? "<missing>";
    const actualLine = actualLines[index] ?? "<missing>";
    report.push(`  expected ${index + 1}: ${expectedLine}`);
    report.push(`  actual   ${index + 1}: ${actualLine}`);
  }
  return { equal: false, report: report.join("\n") };
}

export function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check") || !write;
  if (!write && !check) {
    console.error("usage: bun scripts/generate-lua-defs.ts [--check|--write]");
    return 2;
  }

  let surface: Surface;
  try {
    surface = loadSurface();
  } catch (cause) {
    console.error(`error: cannot read surface table: ${String(cause)}`);
    return 2;
  }

  const problems = validateSurface(surface);
  if (problems.length > 0) {
    console.error(`error: surface table has ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const rendered = renderDefinitions(surface);
  if (write) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, rendered, "utf8");
    console.log(`wrote ${surface.output} from surface table`);
    return 0;
  }

  let current: string;
  try {
    current = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    console.error(`error: ${surface.output} is missing; run with --write`);
    return 1;
  }
  const diff = diffDefinitions(rendered, current);
  if (!diff.equal) {
    console.error(`error: ${surface.output} does not match the surface table`);
    console.error(diff.report);
    return 1;
  }
  console.log(
    `${surface.output} matches the surface table (${surface.functions.length} functions, ${surface.events.length} events)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
