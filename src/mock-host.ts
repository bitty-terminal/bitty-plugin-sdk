/**
 * Mock host for Plugin API v1 (R-SDK-3).
 *
 * Models the accepted `bitty` host bridge for plugin and SDK conformance
 * testing: capability gates (deny-by-default), the activation/registration
 * window, generation-owned handles, the closed v1 event set with bounded
 * immutable payloads, bounded command/store/snapshot data, services, and
 * host-owned tasks and timers on a virtual clock. It is a test double, not a
 * host: it performs no I/O, spawns no process, opens no network, and reads no
 * secret. Behavior is derived from ADR 0009 and the accepted Plugin API v1 Lua
 * Surface RFC; it may never be more permissive than those contracts.
 */

import {
  fail,
  HOST_CODES,
  HostError,
  type HostDiagnostic,
} from "./host-diagnostics.js";
import {
  ENV_CAPABILITY_PREFIX,
  ENV_KEY_PATTERN,
  ENV_MAX_VALUE_BYTES,
  EVENT_MAX_BYTES,
  EVENT_PAYLOAD_FIELDS,
  eventKindSpec,
  EXCLUSIVE_CLAIM_SLOTS,
  INTERCEPTION_KINDS,
  LIFECYCLE_KINDS,
  MOCK_LIMITS,
  PLUGIN_API_VERSION,
  SNAPSHOT_SCOPE_ONLY,
  STORE_KEY_PATTERN,
  UI_SLOTS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
} from "./host-surface.js";
import {
  schemaProblem,
  valueProblem,
  type JsonSchema,
  type JsonValue,
} from "./json-schema.js";
import { loadManifestModel, type ManifestModel } from "./manifest-model.js";
import { versionSatisfies } from "./version-range.js";

/** Construction options for one mock host bound to one plugin manifest. */
export interface MockHostOptions {
  /** `bitty-plugin.toml` source; validated by the accepted R-SDK-2 linter. */
  readonly manifestSource: string;
  /** Host environment snapshot; only granted keys are readable. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly schemaValidatingServices?: readonly string[];
}

/** Notification payload accepted by `bitty.notify.show`. */
export interface NotifyPayload {
  readonly title: string;
  readonly body?: string;
  readonly urgency?: "low" | "normal" | "critical";
}

/** Envelope delivered to event handlers. */
export interface HostEvent {
  readonly kind: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Event handler; interception handlers return `false` to veto. */
export type EventHandler = (event: HostEvent) => unknown;

/** Command registration definition. */
export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly args_schema?: JsonSchema;
  readonly result_schema?: JsonSchema;
  readonly run: (args: JsonValue) => unknown;
}

/** Key-binding suggestion definition. */
export interface KeymapSuggestion {
  readonly chord: string;
  readonly command: string;
  readonly when?: string;
}

/** One member function of a provided service. */
export type ServiceMethod = (args?: JsonValue) => unknown;

/** A resolved service table; members fail closed when the provider is gone. */
export interface ResolvedService {
  readonly [method: string]: ServiceMethod;
}

/** Options accepted by `bitty.services.get`. */
export interface ServiceGetOptions {
  readonly version: string;
  readonly optional?: boolean;
}

/** Options accepted by `bitty.terminal.snapshot`. */
export interface SnapshotOptions {
  readonly scope?: string;
  readonly terminal_id?: number;
}

/** Result of publishing one event. */
export interface PublishResult {
  readonly delivered: number;
  readonly vetoed: boolean;
}

export type MockHostState =
  "created" | "activating" | "active" | "suspended" | "disposed";

interface Subscription {
  readonly generation: number;
  readonly kind: string;
  readonly handler: EventHandler;
}

interface UiBlock {
  readonly generation: number;
  readonly slot: string;
  component: Record<string, unknown>;
  version: number;
}

interface TaskRecord {
  readonly generation: number;
  readonly run: () => unknown;
  cancelled: boolean;
  done: boolean;
}

interface TimerRecord {
  readonly generation: number;
  readonly dueAt: number;
  readonly callback: () => unknown;
  cancelled: boolean;
  fired: boolean;
}

interface ServiceRecord {
  readonly generation: number;
  readonly version: string;
  readonly impl: Record<string, ServiceMethod>;
  alive: boolean;
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function normalizeSchema(
  schema: JsonSchema | undefined,
): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  const normalized: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          normalizeSchema(child as JsonSchema),
        ]),
      );
    } else if (key === "items" && isPlainObject(value)) {
      normalized[key] = normalizeSchema(value);
    } else if (key === "type" && typeof value === "string") {
      normalized[key] = [canonicalValue(value)];
    } else if (
      ["required", "enum", "type"].includes(key) &&
      Array.isArray(value)
    ) {
      normalized[key] = value.map(canonicalValue).sort();
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function deepCopy<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing as T;
    const output: unknown[] = [];
    seen.set(value, output);
    for (const entry of value) output.push(deepCopy(entry, seen));
    return output as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing as T;
    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = deepCopy(entry, seen);
    }
    return output as T;
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * UTF-8 byte length of the JSON encoding of `value`, bounded by `limit`.
 *
 * A shared-reference (DAG) input expands to an exponential serialization when
 * a path is duplicated, so building the string first can hang. Every JSON
 * node costs at least one byte, so when the expanded node count (or depth)
 * already exceeds `limit`, `limit + 1` is returned without serializing. A
 * cyclic input is reported the same way, so callers raise their typed
 * size/validation failure instead of an untyped `JSON.stringify` throw.
 * `scanStructure` counts occurrences under a hard visit cap, so the work is
 * proportional to `limit` regardless of the graph shape. When the encoding
 * fits, `JSON.stringify` runs on a value of at most `limit` nodes and the
 * exact byte count is returned.
 */
function jsonBytes(value: unknown, limit: number): number {
  if (Number.isFinite(limit)) {
    const scan = scanStructure(value, limit, limit);
    if (scan.cycle || scan.nodes > limit || scan.depth > limit) {
      return limit + 1;
    }
  }
  return utf8Bytes(JSON.stringify(value) ?? "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Cycle-aware, bounded structural scan of one JSON-compatible candidate. */
interface StructureScan {
  readonly cycle: boolean;
  readonly depth: number;
  readonly nodes: number;
}

/**
 * Walk `value` with an explicit stack and an ancestor set.
 *
 * The scans this replaces recursed without a visited set, so a
 * self-referential table overflowed the call stack before the depth or node
 * bound could reject it. This walk keeps an explicit stack, stops descending
 * at `maxDepth`, and reports a cycle as soon as an ancestor repeats, so
 * cyclic input always yields a bounded result instead of an overflow.
 * `depth` and `nodes` are capped at one past their limits; callers compare
 * with `>`.
 */
function scanStructure(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
): StructureScan {
  let nodes = 0;
  let depth = 0;
  let cycle = false;
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; level: number; exit: boolean }> = [
    { value, level: 0, exit: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop() as {
      value: unknown;
      level: number;
      exit: boolean;
    };
    if (frame.exit) {
      ancestors.delete(frame.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > maxNodes) break;
    const current = frame.value;
    if (current === null || typeof current !== "object") continue;
    if (!Array.isArray(current) && !isPlainObject(current)) continue;
    if (ancestors.has(current)) {
      cycle = true;
      break;
    }
    const containerLevel = frame.level + 1;
    if (containerLevel > depth) depth = containerLevel;
    if (containerLevel > maxDepth) break;
    ancestors.add(current);
    stack.push({ value: current, level: frame.level, exit: true });
    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, level: containerLevel, exit: false });
    }
  }
  return { cycle, depth, nodes };
}

/**
 * True when `value` reaches itself through plain objects or arrays.
 *
 * The walk is iterative, so a cyclic input is detected without recursive
 * calls and without a depth bound that could be raised past the stack limit.
 * The `done` set marks nodes whose whole subtree has been explored, so an
 * acyclic shared-reference (DAG) input is explored once per node instead of
 * once per path; without it a diamond graph is exponential in its depth.
 */
function containsCycle(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const done = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit: boolean }> = [
    { value, exit: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop() as { value: unknown; exit: boolean };
    if (frame.exit) {
      ancestors.delete(frame.value as object);
      done.add(frame.value as object);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") continue;
    if (!Array.isArray(current) && !isPlainObject(current)) continue;
    if (ancestors.has(current)) return true;
    if (done.has(current)) continue;
    ancestors.add(current);
    stack.push({ value: current, exit: true });
    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, exit: false });
  }
  return false;
}

function storeValueProblem(value: unknown): string | undefined {
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    value === undefined
  ) {
    return "value is not JSON-compatible data";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return "value contains a non-finite number";
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value) && !Array.isArray(value)) {
      return "value contains a non-plain object";
    }
    const scan = scanStructure(
      value,
      MOCK_LIMITS.STORE_MAX_DEPTH,
      MOCK_LIMITS.STORE_MAX_NODES,
    );
    if (scan.cycle) {
      return "value contains a cyclic reference";
    }
    if (scan.depth > MOCK_LIMITS.STORE_MAX_DEPTH) {
      return `value depth exceeds ${MOCK_LIMITS.STORE_MAX_DEPTH}`;
    }
    if (scan.nodes > MOCK_LIMITS.STORE_MAX_NODES) {
      return `value node count exceeds ${MOCK_LIMITS.STORE_MAX_NODES}`;
    }
  }
  if (
    jsonBytes(value, MOCK_LIMITS.STORE_MAX_VALUE_BYTES) >
    MOCK_LIMITS.STORE_MAX_VALUE_BYTES
  ) {
    return `value exceeds ${MOCK_LIMITS.STORE_MAX_VALUE_BYTES} bytes`;
  }
  return undefined;
}

function storeKeyProblem(key: unknown): string | undefined {
  if (typeof key !== "string" || !new RegExp(STORE_KEY_PATTERN).test(key)) {
    return "key must match ^[a-z0-9][a-z0-9._-]{0,127}$";
  }
  if (
    key.startsWith(".") ||
    key.endsWith(".") ||
    key.includes("..") ||
    utf8Bytes(key) > MOCK_LIMITS.STORE_KEY_MAX_BYTES
  ) {
    return "key must not contain empty dot segments or exceed the byte bound";
  }
  return undefined;
}

/** Reserved top-level settings root; relative keys must not name it. */
const SETTINGS_ROOT_SEGMENT = "plugins";

/**
 * Validate one `bitty.settings` key.
 *
 * The accepted contract fixes settings keys as dot paths relative to
 * `plugins.<owner>.<name>` and states that plugins cannot read or write
 * outside their own namespace. Relative paths cannot traverse out of the
 * namespace once `..` is rejected, but a leading `plugins` segment names the
 * shared settings root itself and is therefore rejected fail-closed. Only the
 * first segment is reserved: a nested `plugins` component stays a legitimate
 * key inside the plugin's own namespace.
 */
function settingsKeyProblem(key: unknown): string | undefined {
  if (typeof key !== "string" || key.length === 0) {
    return "key must be a non-empty string";
  }
  if (
    key.startsWith(".") ||
    key.endsWith(".") ||
    key.includes("..") ||
    utf8Bytes(key) > 256 ||
    /[\p{Cc}\p{White_Space}]/u.test(key)
  ) {
    return "key must be a plain dot path without controls or empty segments";
  }
  if (key.split(".")[0] === SETTINGS_ROOT_SEGMENT) {
    return `key must stay inside the plugin namespace (a leading '${SETTINGS_ROOT_SEGMENT}' segment addresses the shared settings root)`;
  }
  return undefined;
}

/**
 * Validate a UI component tree and enforce the depth bound.
 *
 * `heights` memoizes the height of every validated subtree: the number of
 * nodes on its longest downward path, itself included. A shared-reference
 * (DAG) component is therefore validated once per node instead of once per
 * path, and a repeated visit is accepted only when this placement keeps the
 * subtree's deepest node within the bound (`depth + height - 1 <=
 * UI_MAX_DEPTH`). Evaluating the bound at each placement, rather than trusting
 * the depth at which the node was first seen, makes the verdict independent of
 * traversal order and of where an aliased subtree sits. Cycles are rejected up
 * front through `containsCycle`, so a memoized height is always finite.
 */
function componentProblem(
  component: unknown,
  depth = 0,
  heights = new WeakMap<object, number>(),
): string | undefined {
  if (depth > MOCK_LIMITS.UI_MAX_DEPTH) {
    return `component depth exceeds ${MOCK_LIMITS.UI_MAX_DEPTH}`;
  }
  if (!isPlainObject(component)) return "component must be a table";
  if (depth === 0 && containsCycle(component)) {
    return "component contains a cyclic reference";
  }
  const knownHeight = heights.get(component);
  if (knownHeight !== undefined) {
    if (depth + knownHeight - 1 > MOCK_LIMITS.UI_MAX_DEPTH) {
      return `component depth exceeds ${MOCK_LIMITS.UI_MAX_DEPTH}`;
    }
    return undefined;
  }
  const kind = component.kind;
  if (typeof kind !== "string") return "component.kind must be a string";
  if (UI_V1_EXCLUDED_NODE_KINDS.includes(kind)) {
    return `node kind ${kind} is excluded from Plugin API v1`;
  }
  if (!UI_V1_NODE_KINDS.includes(kind)) {
    return `unknown node kind ${kind}`;
  }
  if (kind === "Text") {
    if (typeof component.text !== "string") {
      return "Text components require a string text field";
    }
    heights.set(component, 1);
    return undefined;
  }
  const children = component.children;
  if (!Array.isArray(children)) {
    return `${kind} components require a children array`;
  }
  let height = 1;
  for (const child of children) {
    const problem = componentProblem(child, depth + 1, heights);
    if (problem !== undefined) return problem;
    const childHeight = heights.get(child as object);
    if (childHeight !== undefined && childHeight + 1 > height) {
      height = childHeight + 1;
    }
  }
  heights.set(component, height);
  return undefined;
}

/**
 * Accepted modifier aliases, canonicalized to the four bitty modifier names.
 *
 * The shipped configuration grammar (`bitty-config` `Chord::parse`) accepts
 * these spellings case-insensitively and in any order; duplicate modifiers and
 * multiple keys are rejected there and here.
 */
const MODIFIER_ALIASES: ReadonlyMap<string, string> = new Map([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["opt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
  ["super", "super"],
  ["meta", "super"],
  ["cmd", "super"],
  ["command", "super"],
  ["win", "super"],
  ["windows", "super"],
]);

/**
 * Word spellings for keys the `+`-split chord syntax cannot spell literally,
 * mirroring the shipped configuration grammar. They are single-character keys
 * and therefore require a modifier.
 */
const CHAR_ALIASES: ReadonlySet<string> = new Set([
  "plus",
  "minus",
  "equal",
  "equals",
  "eq",
  "underscore",
]);

/** Named keys (with canonical aliases) that may be used without a modifier. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "tab",
  "enter",
  "return",
  "escape",
  "esc",
  "space",
  "spacebar",
  "backspace",
  "bs",
  "delete",
  "del",
  "insert",
  "ins",
  "home",
  "hm",
  "end",
  "pageup",
  "pgup",
  "pu",
  "pagedown",
  "pgdn",
  "pd",
  "up",
  "arrowup",
  "arrow_up",
  "arrow-up",
  "down",
  "arrowdown",
  "arrow_down",
  "arrow-down",
  "left",
  "arrowleft",
  "arrow_left",
  "arrow-left",
  "right",
  "arrowright",
  "arrow_right",
  "arrow-right",
]);

const FUNCTION_KEY = /^f([1-9]|[1-2]\d|3[0-5])$/;
const SINGLE_CHAR_KEY = /^[!-~]$/;

/**
 * Validate one suggested key chord against the shipped configuration grammar.
 *
 * Parsing is trimmed and case-insensitive (both modifiers and the key), so
 * `Ctrl+P` and `ctrl+p` are equivalent; this matches `bitty-config`
 * `Chord::parse` and the configuration-model chord grammar referenced by
 * ADR 0009 LUA-OQ-5. Accepted modifier and named-key aliases are modeled, and
 * a single-character key (literal or word spelling) requires at least one
 * modifier so a suggestion can never steal shell typing.
 */
function chordProblem(chord: unknown): string | undefined {
  if (typeof chord !== "string" || chord.trim().length === 0) {
    return "chord must be a non-empty string";
  }
  const trimmed = chord.trim();
  if (utf8Bytes(trimmed) > MOCK_LIMITS.CHORD_MAX_BYTES) {
    return `chord must be at most ${MOCK_LIMITS.CHORD_MAX_BYTES} bytes`;
  }
  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const part of trimmed.split("+")) {
    const token = part.trim().toLowerCase();
    if (token.length === 0) {
      return `chord '${chord}' has an empty segment`;
    }
    const modifier = MODIFIER_ALIASES.get(token);
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) {
        return `chord repeats modifier '${modifier}'`;
      }
      modifiers.add(modifier);
      continue;
    }
    if (key !== undefined) return "chord must name exactly one key";
    key = token;
  }
  if (key === undefined) return "chord must name one key";
  const charAlias = CHAR_ALIASES.has(key);
  const singleChar = SINGLE_CHAR_KEY.test(key) && key !== "+";
  const named = NAMED_KEYS.has(key) || FUNCTION_KEY.test(key);
  if (!charAlias && !singleChar && !named) {
    return `unsupported key ${key}`;
  }
  if ((charAlias || singleChar) && modifiers.size === 0) {
    return "single-character keys require a modifier";
  }
  return undefined;
}

/** Mock host bound to one plugin manifest and one generation at a time. */
export class MockHost {
  readonly manifest: ManifestModel;
  readonly environment: Readonly<Record<string, string>>;
  readonly notifications: NotifyPayload[] = [];
  readonly handlerViolations: HostDiagnostic[] = [];

  readonly bitty: {
    readonly api_version: string;
    readonly commands: {
      register(def: CommandDefinition): number;
    };
    readonly events: {
      subscribe(kind: string, handler: EventHandler): number;
    };
    readonly keymaps: {
      suggest(def: KeymapSuggestion): number;
    };
    readonly settings: {
      get(key: string): JsonValue;
      set(key: string, value: JsonValue): boolean;
    };
    readonly store: {
      get(key: string): JsonValue;
      set(key: string, value: JsonValue): boolean;
    };
    readonly notify: {
      show(payload: NotifyPayload): boolean;
    };
    readonly env?: {
      get(name: string): string | null;
      has(name: string): boolean;
    };
    readonly ui: {
      mount(slot: string, component: Record<string, unknown>): number;
      update(handle: number, component: Record<string, unknown>): boolean;
    };
    readonly terminal: {
      snapshot(opts?: SnapshotOptions): Record<string, unknown>;
    };
    readonly services: {
      get(iface: string, opts: ServiceGetOptions): ResolvedService | undefined;
      provide(iface: string, impl: Record<string, ServiceMethod>): number;
    };
    readonly tasks: {
      spawn(run: () => unknown): number;
      cancel(handle: number): boolean;
    };
    readonly timers: {
      create(delayMs: number, callback: () => unknown): number;
      cancel(handle: number): boolean;
    };
  };

  private state: MockHostState = "created";
  private generation = 0;
  private handleSequence = 0;
  private eventSequence = 0;
  private virtualNow = 0;
  private readonly grants = new Set<string>();
  private readonly store = new Map<string, JsonValue>();
  private storeBytes = 0;
  private readonly settings = new Map<string, JsonValue>();
  private readonly commands = new Map<
    string,
    { generation: number; def: CommandDefinition }
  >();
  private subscriptions: Subscription[] = [];
  private readonly keymaps: Array<{
    generation: number;
    chord: string;
    command: string;
    when: string;
  }> = [];
  private readonly blocks = new Map<number, UiBlock>();
  private readonly tasks = new Map<number, TaskRecord>();
  private readonly timers = new Map<number, TimerRecord>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly schemaValidatingServices: ReadonlySet<string>;
  private terminalSnapshot: Record<string, unknown> = {};
  private deliveringViolation = false;

  constructor(options: MockHostOptions) {
    this.manifest = loadManifestModel(options.manifestSource);
    this.schemaValidatingServices = new Set(
      options.schemaValidatingServices ?? [],
    );
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    const envDeclared = this.declaredEnvCapabilities().length > 0;

    const env = envDeclared
      ? {
          get: (name: string): string | null => this.envGet(name),
          has: (name: string): boolean => this.envHas(name),
        }
      : undefined;

    this.bitty = {
      api_version: PLUGIN_API_VERSION,
      commands: {
        register: (def: CommandDefinition): number => this.registerCommand(def),
      },
      events: {
        subscribe: (kind: string, handler: EventHandler): number =>
          this.subscribe(kind, handler),
      },
      keymaps: {
        suggest: (def: KeymapSuggestion): number => this.suggestKeymap(def),
      },
      settings: {
        get: (key: string): JsonValue => this.settingsGet(key),
        set: (key: string, value: JsonValue): boolean =>
          this.settingsSet(key, value),
      },
      store: {
        get: (key: string): JsonValue => this.storeGet(key),
        set: (key: string, value: JsonValue): boolean =>
          this.storeSet(key, value),
      },
      notify: {
        show: (payload: NotifyPayload): boolean => this.notifyShow(payload),
      },
      ...(env === undefined ? {} : { env }),
      ui: {
        mount: (slot: string, component: Record<string, unknown>): number =>
          this.uiMount(slot, component),
        update: (handle: number, component: Record<string, unknown>): boolean =>
          this.uiUpdate(handle, component),
      },
      terminal: {
        snapshot: (opts?: SnapshotOptions): Record<string, unknown> =>
          this.terminalSnapshotRead(opts),
      },
      services: {
        get: (
          iface: string,
          opts: ServiceGetOptions,
        ): ResolvedService | undefined => this.servicesGet(iface, opts),
        provide: (iface: string, impl: Record<string, ServiceMethod>): number =>
          this.servicesProvide(iface, impl),
      },
      tasks: {
        spawn: (run: () => unknown): number => this.tasksSpawn(run),
        cancel: (handle: number): boolean => this.tasksCancel(handle),
      },
      timers: {
        create: (delayMs: number, callback: () => unknown): number =>
          this.timersCreate(delayMs, callback),
        cancel: (handle: number): boolean => this.timersCancel(handle),
      },
    };
  }

  /** Current generation number (0 before the first activation). */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Current lifecycle state, for host-side harness cleanup. */
  get currentState(): MockHostState {
    return this.state;
  }

  /** Grant one declared capability explicitly; default is no authority. */
  grant(capability: string): void {
    if (typeof capability !== "string" || capability.length === 0) {
      fail("validation", HOST_CODES.DEF_INVALID, "capability must be a string");
    }
    if (utf8Bytes(capability) > 512) {
      fail("validation", HOST_CODES.DEF_INVALID, "capability id too long");
    }
    this.grants.add(capability);
  }

  /** Revoke one capability; subsequent calls fail closed again. */
  revoke(capability: string): void {
    this.grants.delete(capability);
  }

  /** Whether a capability is currently granted (declaration still required). */
  isGranted(capability: string): boolean {
    return this.grants.has(capability);
  }

  /** Open the activation window for a new generation. */
  beginActivation(): void {
    if (this.state === "disposed" || this.state === "created") {
      this.generation += 1;
      this.state = "activating";
      return;
    }
    fail(
      "validation",
      HOST_CODES.LIFECYCLE_STATE,
      `cannot begin activation from state '${this.state}'`,
    );
  }

  /** Close the activation window and deliver `plugin.activated`. */
  endActivation(): void {
    if (this.state !== "activating") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        `cannot end activation from state '${this.state}'`,
      );
    }
    this.state = "active";
    this.publishLifecycle("plugin.activated");
  }

  /** Suspend the active generation and deliver `plugin.suspended`. */
  suspend(): void {
    if (this.state !== "active") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        `cannot suspend from state '${this.state}'`,
      );
    }
    this.state = "suspended";
    this.publishLifecycle("plugin.suspended");
  }

  /** Dispose the current generation: lifecycle event, then invalidation. */
  dispose(): void {
    if (this.state !== "active" && this.state !== "suspended") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        `cannot dispose from state '${this.state}'`,
      );
    }
    this.publishLifecycle("plugin.disposed");
    this.state = "disposed";
    this.subscriptions = [];
    this.commands.clear();
    this.keymaps.length = 0;
    this.blocks.clear();
    this.tasks.clear();
    this.timers.clear();
    for (const record of this.services.values()) record.alive = false;
    this.services.clear();
    // Deliberate harness simplification, stricter than the accepted grant
    // record: the real host persists manifest-hash-addressed grants across
    // suspend and reload and re-prompts only on a manifest-hash change with
    // added capabilities or after revocation. Clearing here (never on suspend)
    // makes a reload start from deny-by-default so tests re-authorize
    // explicitly; it never makes the mock more permissive than the contract.
    this.grants.clear();
  }

  /** Publish one event into the closed v1 pipeline. */
  publish(kind: string, payload: unknown = {}): PublishResult {
    if (this.state === "disposed" || this.state === "created") {
      fail(
        "runtime",
        HOST_CODES.GENERATION_DISPOSED,
        "the plugin generation is not active",
      );
    }
    const spec = eventKindSpec(kind);
    if (spec === undefined) {
      fail(
        "validation",
        HOST_CODES.EVENT_UNKNOWN,
        `unknown event kind ${kind}`,
      );
    }
    if (!isPlainObject(payload)) {
      fail(
        "validation",
        HOST_CODES.EVENT_PAYLOAD_INVALID,
        "event payload must be a table",
      );
    }
    for (const field of EVENT_PAYLOAD_FIELDS[kind] ?? []) {
      const value = payload[field.name];
      const valid =
        field.type === "string"
          ? typeof value === "string"
          : typeof value === "number" && Number.isInteger(value);
      if (!valid) {
        fail(
          "validation",
          HOST_CODES.EVENT_PAYLOAD_INVALID,
          `event payload field '${field.name}' must be ${field.type}`,
          `payload.${field.name}`,
        );
      }
    }
    if ((EVENT_PAYLOAD_FIELDS[kind] ?? []).length === 0) {
      const extra = Object.keys(payload);
      if (extra.length > 0) {
        fail(
          "validation",
          HOST_CODES.EVENT_PAYLOAD_INVALID,
          `event '${kind}' declares no payload fields; '${extra[0]}' is not part of the v1 shape`,
          `payload.${extra[0]}`,
        );
      }
    }
    if (kind.startsWith("intercept.")) {
      for (const key of Object.keys(payload)) {
        if (!["action", "origin", "preview"].includes(key)) {
          fail(
            "validation",
            HOST_CODES.EVENT_PAYLOAD_INVALID,
            `interception payloads carry bounded sanitized metadata only; '${key}' is not part of the v1 shape`,
            `payload.${key}`,
          );
        }
      }
    }
    if (jsonBytes(payload, EVENT_MAX_BYTES) > EVENT_MAX_BYTES) {
      fail(
        "validation",
        HOST_CODES.EVENT_PAYLOAD_TOO_LARGE,
        `event payload exceeds ${EVENT_MAX_BYTES} bytes`,
      );
    }
    return this.deliver(kind, payload);
  }

  /** Dispatch one registered command after schema validation. */
  dispatchCommand(qualified: string, args: unknown = {}): unknown {
    this.assertOrdinaryDispatch();
    const record = this.commands.get(qualified);
    if (record === undefined || record.generation !== this.generation) {
      fail(
        "validation",
        HOST_CODES.COMMAND_UNDECLARED,
        `command ${qualified} is not registered in this generation`,
      );
    }
    const def = record.def;
    if (def.args_schema !== undefined) {
      const problem = valueProblem(def.args_schema, args, "args");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.ARGS_INVALID, problem);
      }
    }
    const result = def.run(deepCopy(args) as JsonValue);
    if (def.result_schema !== undefined) {
      const problem = valueProblem(def.result_schema, result, "result");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.RESULT_INVALID, problem);
      }
    }
    return deepCopy(result);
  }

  /** Run queued task callbacks cooperatively in insertion order. */
  drainTasks(): void {
    this.assertAlive();
    for (const [handle, record] of this.tasks) {
      if (record.generation !== this.generation) continue;
      if (record.cancelled || record.done) continue;
      if (this.state === "suspended") continue;
      record.done = true;
      this.runHostCallback(record.run, `task ${handle}`);
    }
  }

  /** Advance the virtual clock and fire due one-shot timers. */
  advanceTimers(ms: number): void {
    this.assertAlive();
    if (!Number.isInteger(ms) || ms < 0) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "advanceTimers expects a non-negative integer",
      );
    }
    this.virtualNow += ms;
    const due = [...this.timers.entries()]
      .filter(
        ([, record]) =>
          record.generation === this.generation &&
          !record.cancelled &&
          !record.fired &&
          record.dueAt <= this.virtualNow,
      )
      .sort((left, right) => {
        if (left[1].dueAt !== right[1].dueAt) {
          return left[1].dueAt - right[1].dueAt;
        }
        return left[0] - right[0];
      });
    for (const [handle, record] of due) {
      if (
        this.timers.get(handle) !== record ||
        record.cancelled ||
        record.fired ||
        record.generation !== this.generation ||
        this.state === "disposed" ||
        this.state === "suspended"
      )
        continue;
      record.fired = true;
      this.runHostCallback(record.callback, `timer ${handle}`);
    }
  }

  /**
   * Set the snapshot served to `bitty.terminal.snapshot`.
   *
   * A self-referential snapshot is rejected with a typed validation failure
   * before the copy is frozen; the snapshot is later JSON-serialized for the
   * byte bound, and a cycle would otherwise overflow the copy or throw from
   * serialization.
   */
  setTerminalSnapshot(snapshot: Record<string, unknown>): void {
    if (containsCycle(snapshot)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "terminal snapshot must be JSON-compatible plain data (cyclic reference found)",
      );
    }
    this.terminalSnapshot = deepFreeze(deepCopy(snapshot));
  }

  /** Remove one provided service; consumers fail closed with a gone error. */
  removeService(iface: string): void {
    const record = this.services.get(iface);
    if (record !== undefined) record.alive = false;
    this.services.delete(iface);
  }

  private assertAlive(): void {
    if (this.state === "created" || this.state === "disposed") {
      fail(
        "runtime",
        HOST_CODES.GENERATION_DISPOSED,
        "the plugin generation is not active",
      );
    }
  }

  private assertServiceAvailable(record: ServiceRecord, iface: string): void {
    if (!record.alive || record.generation !== this.generation) {
      fail(
        "runtime",
        HOST_CODES.SERVICE_GONE,
        `provider for service ${iface} is gone`,
      );
    }
    if (this.state === "suspended") {
      fail(
        "runtime",
        HOST_CODES.SERVICE_GONE,
        `provider for service ${iface} is suspended`,
      );
    }
  }

  private assertOrdinaryDispatch(): void {
    this.assertAlive();
    if (this.state === "suspended") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        "the plugin generation is suspended; ordinary dispatch is detached",
      );
    }
  }

  private assertRegistrationOpen(surface: string): void {
    if (this.state === "created" || this.state === "disposed") {
      fail(
        "runtime",
        HOST_CODES.GENERATION_DISPOSED,
        "the plugin generation is not active",
      );
    }
    if (this.state !== "activating") {
      fail(
        "validation",
        HOST_CODES.REGISTRATION_CLOSED,
        `${surface} is valid only during init.lua activation`,
      );
    }
  }

  private assertCapability(surface: string, capability: string): void {
    const declared = this.manifest.capabilities.includes(capability);
    if (!declared || !this.grants.has(capability)) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        `${surface} requires capability ${capability}`,
      );
    }
  }

  private declaredEnvCapabilities(): string[] {
    return this.manifest.capabilities.filter((capability) =>
      capability.startsWith(ENV_CAPABILITY_PREFIX),
    );
  }

  private grantedEnvCapabilities(): string[] {
    return this.declaredEnvCapabilities().filter((capability) =>
      this.grants.has(capability),
    );
  }

  private envAllowed(key: string): boolean {
    for (const capability of this.grantedEnvCapabilities()) {
      const parameter = capability.slice(ENV_CAPABILITY_PREFIX.length);
      if (parameter === "BITTY_*" && key.startsWith("BITTY_")) return true;
      if (parameter === key) return true;
    }
    return false;
  }

  private envKey(name: unknown): string {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 64 ||
      !new RegExp(ENV_KEY_PATTERN).test(name)
    ) {
      fail(
        "validation",
        HOST_CODES.ENV_KEY_INVALID,
        "env key must match ^[A-Z_][A-Z0-9_]*$ and be at most 64 bytes",
      );
    }
    return name;
  }

  private envGet(name: unknown): string | null {
    this.assertAlive();
    if (this.grantedEnvCapabilities().length === 0) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        "bitty.env requires a granted env:<KEY> capability",
      );
    }
    const key = this.envKey(name);
    if (!this.envAllowed(key)) return null;
    const value = this.environment[key];
    if (value === undefined) return null;
    if (utf8Bytes(value) > ENV_MAX_VALUE_BYTES) {
      fail(
        "validation",
        HOST_CODES.ENV_VALUE_TOO_LARGE,
        `env value exceeds ${ENV_MAX_VALUE_BYTES} bytes`,
      );
    }
    return value;
  }

  private envHas(name: unknown): boolean {
    this.assertAlive();
    if (this.grantedEnvCapabilities().length === 0) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        "bitty.env requires a granted env:<KEY> capability",
      );
    }
    const key = this.envKey(name);
    return this.envAllowed(key) && this.environment[key] !== undefined;
  }

  private registerCommand(def: CommandDefinition): number {
    this.assertRegistrationOpen("bitty.commands.register");
    if (!isPlainObject(def)) {
      fail("validation", HOST_CODES.DEF_INVALID, "command def must be a table");
    }
    const id = def.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
      fail(
        "validation",
        HOST_CODES.COMMAND_ID_INVALID,
        "command id must match ^[a-z][a-z0-9-]{0,63}$",
        "def.id",
      );
    }
    if (typeof def.title !== "string" || def.title.length === 0) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "command title must be a non-empty string",
        "def.title",
      );
    }
    if (typeof def.run !== "function") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "command run must be a function",
        "def.run",
      );
    }
    for (const [field, schema] of [
      ["args_schema", def.args_schema],
      ["result_schema", def.result_schema],
    ] as const) {
      if (schema === undefined) continue;
      const problem = schemaProblem(schema, field);
      if (problem !== undefined) {
        fail("validation", HOST_CODES.SCHEMA_INVALID, problem, field);
      }
    }
    const qualified = `${this.manifest.pluginId}:${id}`;
    if (!this.manifest.commands.includes(qualified)) {
      fail(
        "validation",
        HOST_CODES.COMMAND_UNDECLARED,
        `command ${qualified} is not reserved in [lazy].commands`,
      );
    }
    if (this.commands.has(qualified)) {
      fail(
        "validation",
        HOST_CODES.COMMAND_DUPLICATE,
        `command ${qualified} is already registered`,
      );
    }
    const declared = this.manifest.commandSchemas.get(qualified);
    if (declared !== undefined) {
      for (const [field, schema, staticSchema] of [
        ["args_schema", def.args_schema, declared.argsSchema],
        ["result_schema", def.result_schema, declared.resultSchema],
      ] as const) {
        if (
          canonicalValue(normalizeSchema(schema)) !==
          canonicalValue(normalizeSchema(staticSchema))
        ) {
          fail(
            "validation",
            HOST_CODES.SCHEMA_INVALID,
            `${field} differs from the static command declaration`,
            field,
          );
        }
      }
    }
    const handle = this.nextHandle();
    this.commands.set(qualified, {
      generation: this.generation,
      def: deepCopy(def),
    });
    return handle;
  }

  private subscribe(kind: string, handler: EventHandler): number {
    this.assertRegistrationOpen("bitty.events.subscribe");
    if (eventKindSpec(kind) === undefined) {
      fail(
        "validation",
        HOST_CODES.EVENT_UNKNOWN,
        `unknown event kind ${kind}`,
      );
    }
    if (!this.manifest.events.includes(kind)) {
      fail(
        "validation",
        HOST_CODES.EVENT_UNDECLARED,
        `event ${kind} is not declared for this plugin`,
      );
    }
    if (typeof handler !== "function") {
      fail("validation", HOST_CODES.DEF_INVALID, "handler must be a function");
    }
    const handle = this.nextHandle();
    this.subscriptions.push({ generation: this.generation, kind, handler });
    return handle;
  }

  private suggestKeymap(def: KeymapSuggestion): number {
    this.assertRegistrationOpen("bitty.keymaps.suggest");
    if (!isPlainObject(def)) {
      fail("validation", HOST_CODES.DEF_INVALID, "keymap def must be a table");
    }
    const problem = chordProblem(def.chord);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.KEYMAP_CHORD_INVALID, problem, "def.chord");
    }
    if (def.when !== undefined && def.when !== "global") {
      fail(
        "validation",
        HOST_CODES.KEYMAP_WHEN_UNSUPPORTED,
        "only the 'global' context is supported in v1",
        "def.when",
      );
    }
    if (
      typeof def.command !== "string" ||
      !this.commands.has(def.command) ||
      this.commands.get(def.command)?.generation !== this.generation
    ) {
      fail(
        "validation",
        HOST_CODES.KEYMAP_COMMAND_UNKNOWN,
        "keymap command must name a command registered by this generation",
        "def.command",
      );
    }
    const handle = this.nextHandle();
    this.keymaps.push({
      generation: this.generation,
      chord: def.chord,
      command: def.command,
      when: def.when ?? "global",
    });
    return handle;
  }

  private settingsGet(key: string): JsonValue {
    this.assertAlive();
    const problem = settingsKeyProblem(key);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.SETTINGS_KEY_INVALID, problem);
    }
    const value = this.settings.get(key);
    return value === undefined ? null : deepCopy(value);
  }

  private settingsSet(key: string, value: JsonValue): boolean {
    this.assertAlive();
    const problem = settingsKeyProblem(key);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.SETTINGS_KEY_INVALID, problem);
    }
    const valueProblem = storeValueProblem(value);
    if (valueProblem !== undefined) {
      fail("validation", HOST_CODES.STORE_VALUE_INVALID, valueProblem);
    }
    this.settings.set(key, deepCopy(value));
    return true;
  }

  private storeGet(key: string): JsonValue {
    this.assertAlive();
    const problem = storeKeyProblem(key);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.STORE_KEY_INVALID, problem);
    }
    const value = this.store.get(key);
    return value === undefined ? null : deepCopy(value);
  }

  private storeSet(key: string, value: JsonValue): boolean {
    this.assertAlive();
    const problem = storeKeyProblem(key);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.STORE_KEY_INVALID, problem);
    }
    if (value === null || value === undefined) {
      const existing = this.store.get(key);
      if (existing !== undefined) {
        this.storeBytes -= jsonBytes(
          existing,
          MOCK_LIMITS.STORE_MAX_VALUE_BYTES,
        );
        this.store.delete(key);
      }
      return true;
    }
    const valueProblemText = storeValueProblem(value);
    if (valueProblemText !== undefined) {
      fail("validation", HOST_CODES.STORE_VALUE_INVALID, valueProblemText);
    }
    const bytes = jsonBytes(value, MOCK_LIMITS.STORE_MAX_VALUE_BYTES);
    const existing = this.store.get(key);
    const existingBytes =
      existing === undefined
        ? 0
        : jsonBytes(existing, MOCK_LIMITS.STORE_MAX_VALUE_BYTES);
    if (
      this.storeBytes - existingBytes + bytes >
      MOCK_LIMITS.STORE_QUOTA_BYTES
    ) {
      fail(
        "budget",
        HOST_CODES.STORE_QUOTA,
        `store quota of ${MOCK_LIMITS.STORE_QUOTA_BYTES} bytes exceeded`,
      );
    }
    this.store.set(key, deepCopy(value));
    this.storeBytes += bytes - existingBytes;
    return true;
  }

  private notifyShow(payload: NotifyPayload): boolean {
    this.assertAlive();
    this.assertCapability("bitty.notify.show", "platform.notify");
    if (!isPlainObject(payload)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "notify payload must be a table",
      );
    }
    if (typeof payload.title !== "string" || payload.title.length === 0) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "notify title must be a non-empty string",
        "payload.title",
      );
    }
    if (payload.body !== undefined && typeof payload.body !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "notify body must be a string",
        "payload.body",
      );
    }
    if (
      payload.urgency !== undefined &&
      !["low", "normal", "critical"].includes(payload.urgency)
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "notify urgency must be low, normal, or critical",
        "payload.urgency",
      );
    }
    if (jsonBytes(payload, EVENT_MAX_BYTES) > EVENT_MAX_BYTES) {
      fail(
        "validation",
        HOST_CODES.EVENT_PAYLOAD_TOO_LARGE,
        "notify payload exceeds the bounded size",
      );
    }
    this.notifications.push({
      title: payload.title,
      body: payload.body,
      urgency: payload.urgency,
    });
    return true;
  }

  private uiMount(slot: string, component: Record<string, unknown>): number {
    this.assertRegistrationOpen("bitty.ui.mount");
    this.assertCapability("bitty.ui.mount", "ui.rich");
    if (slot === "overlay") {
      this.assertCapability("bitty.ui.mount:overlay", "ui.overlay");
    }
    if (!UI_SLOTS.includes(slot)) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `unknown UI slot ${slot}`,
        "slot",
      );
    }
    if (
      EXCLUSIVE_CLAIM_SLOTS.includes(slot) &&
      !this.manifest.claims.includes(slot)
    ) {
      fail(
        "validation",
        HOST_CODES.UI_CLAIM_REQUIRED,
        `slot '${slot}' is an exclusive claim; declare claims = ["${slot}"] in [lazy]`,
        "slot",
      );
    }
    const problem = componentProblem(component);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.UI_COMPONENT_INVALID, problem, "component");
    }
    if (
      jsonBytes(component, MOCK_LIMITS.SNAPSHOT_MAX_BYTES) >
      MOCK_LIMITS.SNAPSHOT_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component exceeds ${MOCK_LIMITS.SNAPSHOT_MAX_BYTES} bytes`,
        "component",
      );
    }
    const handle = this.nextHandle();
    this.blocks.set(handle, {
      generation: this.generation,
      slot,
      component: deepFreeze(deepCopy(component)),
      version: 1,
    });
    return handle;
  }

  private uiUpdate(
    handle: number,
    component: Record<string, unknown>,
  ): boolean {
    this.assertAlive();
    this.assertCapability("bitty.ui.update", "ui.rich");
    const block = this.blocks.get(handle);
    if (block === undefined || block.generation !== this.generation) {
      return false;
    }
    const problem = componentProblem(component);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.UI_COMPONENT_INVALID, problem, "component");
    }
    if (
      jsonBytes(component, MOCK_LIMITS.SNAPSHOT_MAX_BYTES) >
      MOCK_LIMITS.SNAPSHOT_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component exceeds ${MOCK_LIMITS.SNAPSHOT_MAX_BYTES} bytes`,
        "component",
      );
    }
    block.component = deepFreeze(deepCopy(component));
    block.version += 1;
    return true;
  }

  private terminalSnapshotRead(
    opts: SnapshotOptions = {},
  ): Record<string, unknown> {
    this.assertAlive();
    this.assertCapability("bitty.terminal.snapshot", "terminal.semantic-read");
    // ADR 0009 LUA-OQ-4 / the Lua Surface RFC fix `scope = "semantic"` as the
    // only v1 scope; because it is the sole accepted value an omitted scope is
    // unambiguously semantic, so the mock defaults it rather than rejecting a
    // legitimate call. Any other explicit value still fails closed.
    const scope = opts.scope ?? SNAPSHOT_SCOPE_ONLY;
    if (scope !== SNAPSHOT_SCOPE_ONLY) {
      fail(
        "validation",
        HOST_CODES.SNAPSHOT_SCOPE_UNSUPPORTED,
        `Plugin API v1 supports only scope = '${SNAPSHOT_SCOPE_ONLY}'`,
        "opts.scope",
      );
    }
    if (
      opts.terminal_id !== undefined &&
      (typeof opts.terminal_id !== "number" ||
        !Number.isInteger(opts.terminal_id))
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "terminal_id must be an integer",
        "opts.terminal_id",
      );
    }
    if (
      jsonBytes(this.terminalSnapshot, MOCK_LIMITS.SNAPSHOT_MAX_BYTES) >
      MOCK_LIMITS.SNAPSHOT_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.SNAPSHOT_TOO_LARGE,
        `snapshot exceeds ${MOCK_LIMITS.SNAPSHOT_MAX_BYTES} bytes`,
      );
    }
    return deepCopy(this.terminalSnapshot);
  }

  private servicesProvide(
    iface: string,
    impl: Record<string, ServiceMethod>,
  ): number {
    this.assertRegistrationOpen("bitty.services.provide");
    if (
      typeof iface !== "string" ||
      !this.manifest.providedServices.has(iface)
    ) {
      fail(
        "validation",
        HOST_CODES.SERVICE_UNDECLARED,
        `service ${iface} is not declared in [services.provided]`,
      );
    }
    if (!isPlainObject(impl)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "service impl must be a table",
      );
    }
    for (const [method, member] of Object.entries(impl)) {
      if (typeof member !== "function") {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `service member ${method} must be a function`,
          `impl.${method}`,
        );
      }
    }
    const version = this.manifest.providedServices.get(iface) ?? "0.0.0";
    const handle = this.nextHandle();
    this.services.set(iface, {
      generation: this.generation,
      version,
      impl: { ...impl },
      alive: true,
    });
    return handle;
  }

  private servicesGet(
    iface: string,
    opts: ServiceGetOptions,
  ): ResolvedService | undefined {
    this.assertAlive();
    if (!isPlainObject(opts)) {
      fail(
        "validation",
        HOST_CODES.SERVICE_VERSION_INVALID,
        "services.get requires opts",
        "opts",
      );
    }
    if (typeof opts.version !== "string" || opts.version.length === 0) {
      fail(
        "validation",
        HOST_CODES.SERVICE_VERSION_INVALID,
        "services.get requires opts.version",
        "opts.version",
      );
    }
    const record = this.services.get(iface);
    const optional = opts.optional === true;
    if (this.state === "suspended" || record === undefined || !record.alive) {
      if (optional) return undefined;
      fail(
        "resolution",
        HOST_CODES.SERVICE_RESOLUTION,
        `no provider for service ${iface}`,
      );
    }
    if (opts.version !== undefined) {
      const satisfied = versionSatisfies(record.version, opts.version);
      if (satisfied === undefined) {
        fail(
          "validation",
          HOST_CODES.SERVICE_VERSION_INVALID,
          `invalid version requirement ${opts.version}`,
        );
      }
      if (!satisfied) {
        if (optional) return undefined;
        fail(
          "resolution",
          HOST_CODES.SERVICE_RESOLUTION,
          `provider for ${iface} does not satisfy ${opts.version}`,
        );
      }
    }
    const schemas = this.manifest.providedServiceSchemas.get(iface);
    if (this.schemaValidatingServices.has(iface) && schemas === undefined) {
      if (optional) return undefined;
      fail(
        "resolution",
        HOST_CODES.SERVICE_RESOLUTION,
        `schema-validating consumer requires a table-form provider for ${iface}`,
      );
    }
    const service: Record<string, ServiceMethod> = {};
    for (const [method, member] of Object.entries(record.impl)) {
      service[method] = (args?: JsonValue): unknown => {
        this.assertServiceAvailable(record, iface);
        if (schemas?.argsSchema !== undefined) {
          const problem = valueProblem(schemas.argsSchema, args);
          if (problem !== undefined)
            fail("validation", HOST_CODES.ARGS_INVALID, problem);
        }
        let result: unknown;
        try {
          result = member(deepCopy(args));
        } finally {
          this.assertServiceAvailable(record, iface);
        }
        if (schemas?.resultSchema !== undefined) {
          const problem = valueProblem(schemas.resultSchema, result);
          if (problem !== undefined)
            fail("validation", HOST_CODES.RESULT_INVALID, problem);
        }
        return deepCopy(result);
      };
    }
    return service;
  }

  private tasksSpawn(run: () => unknown): number {
    this.assertRegistrationOpen("bitty.tasks.spawn");
    if (typeof run !== "function") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "task body must be a function",
      );
    }
    const live = [...this.tasks.values()].filter(
      (record) =>
        record.generation === this.generation &&
        !record.cancelled &&
        !record.done,
    ).length;
    if (live >= MOCK_LIMITS.TASKS_MAX) {
      fail(
        "budget",
        HOST_CODES.BUDGET_TASK,
        `task cap of ${MOCK_LIMITS.TASKS_MAX} reached`,
      );
    }
    const handle = this.nextHandle();
    this.tasks.set(handle, {
      generation: this.generation,
      run,
      cancelled: false,
      done: false,
    });
    return handle;
  }

  private tasksCancel(handle: number): boolean {
    const record = this.tasks.get(handle);
    if (
      record === undefined ||
      record.generation !== this.generation ||
      record.cancelled ||
      record.done
    ) {
      return false;
    }
    record.cancelled = true;
    return true;
  }

  private timersCreate(delayMs: number, callback: () => unknown): number {
    this.assertRegistrationOpen("bitty.timers.create");
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MOCK_LIMITS.TIMER_MAX_DELAY_MS
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        `timer delay must be an integer between 0 and ${MOCK_LIMITS.TIMER_MAX_DELAY_MS}`,
      );
    }
    if (typeof callback !== "function") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "timer callback must be a function",
      );
    }
    const live = [...this.timers.values()].filter(
      (record) =>
        record.generation === this.generation &&
        !record.cancelled &&
        !record.fired,
    ).length;
    if (live >= MOCK_LIMITS.TIMERS_MAX) {
      fail(
        "budget",
        HOST_CODES.BUDGET_TIMER,
        `timer cap of ${MOCK_LIMITS.TIMERS_MAX} reached`,
      );
    }
    const handle = this.nextHandle();
    this.timers.set(handle, {
      generation: this.generation,
      dueAt: this.virtualNow + delayMs,
      callback,
      cancelled: false,
      fired: false,
    });
    return handle;
  }

  private timersCancel(handle: number): boolean {
    const record = this.timers.get(handle);
    if (
      record === undefined ||
      record.generation !== this.generation ||
      record.cancelled ||
      record.fired
    ) {
      return false;
    }
    record.cancelled = true;
    return true;
  }

  private runHostCallback(callback: () => unknown, source: string): void {
    try {
      callback();
    } catch (cause) {
      this.recordViolation(
        `${source} callback failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private recordViolation(message: string): void {
    this.handlerViolations.push({
      class: "runtime",
      code: HOST_CODES.HANDLER_VIOLATION,
      message: message.length > 512 ? `${message.slice(0, 512)}...` : message,
    });
    if (this.deliveringViolation) return;
    this.deliveringViolation = true;
    try {
      this.deliver("handler.violation", {});
    } finally {
      this.deliveringViolation = false;
    }
  }

  private publishLifecycle(kind: string): void {
    this.deliver(kind, {});
  }

  private deliver(
    kind: string,
    payload: Record<string, unknown>,
  ): PublishResult {
    const interception = INTERCEPTION_KINDS.has(kind);
    const lifecycle = LIFECYCLE_KINDS.has(kind);
    this.eventSequence += 1;
    const envelope = deepFreeze({
      kind,
      sequence: this.eventSequence,
      payload: deepCopy(payload),
    });
    let delivered = 0;
    let vetoed = false;
    for (const subscription of [...this.subscriptions]) {
      if (subscription.kind !== kind) continue;
      if (subscription.generation !== this.generation) continue;
      if (this.state === "disposed") continue;
      if (!lifecycle && this.state === "suspended") continue;
      delivered += 1;
      try {
        const result = subscription.handler(envelope);
        if (interception && result === false) vetoed = true;
      } catch (cause) {
        this.recordViolation(
          `${lifecycle ? kind : "event"} handler failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    return { delivered, vetoed };
  }

  private nextHandle(): number {
    this.handleSequence += 1;
    return this.handleSequence;
  }
}
