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
  INTERCEPTION_KINDS,
  LIFECYCLE_KINDS,
  MOCK_LIMITS,
  PLUGIN_API_VERSION,
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

/** Construction options for one mock host bound to one plugin manifest. */
export interface MockHostOptions {
  /** `bitty-plugin.toml` source; validated by the accepted R-SDK-2 linter. */
  readonly manifestSource: string;
  /** Host environment snapshot; only granted keys are readable. */
  readonly environment?: Readonly<Record<string, string>>;
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
  readonly version?: string;
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

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepCopy(entry)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = deepCopy(entry);
    }
    return output as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
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

function containerDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let depth = 0;
    for (const entry of value) depth = Math.max(depth, containerDepth(entry));
    return depth + 1;
  }
  if (isPlainObject(value)) {
    let depth = 0;
    for (const entry of Object.values(value)) {
      depth = Math.max(depth, containerDepth(entry));
    }
    return depth + 1;
  }
  return 0;
}

function countNodes(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce<number>((sum, entry) => sum + countNodes(entry), 0);
  }
  if (isPlainObject(value)) {
    return (
      1 +
      Object.values(value).reduce<number>(
        (sum, entry) => sum + countNodes(entry),
        0,
      )
    );
  }
  return 1;
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
    if (containerDepth(value) > MOCK_LIMITS.STORE_MAX_DEPTH) {
      return `value depth exceeds ${MOCK_LIMITS.STORE_MAX_DEPTH}`;
    }
    if (countNodes(value) > MOCK_LIMITS.STORE_MAX_NODES) {
      return `value node count exceeds ${MOCK_LIMITS.STORE_MAX_NODES}`;
    }
  }
  if (jsonBytes(value) > MOCK_LIMITS.STORE_MAX_VALUE_BYTES) {
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
  return undefined;
}

function componentProblem(component: unknown, depth = 0): string | undefined {
  if (depth > MOCK_LIMITS.UI_MAX_DEPTH) {
    return `component depth exceeds ${MOCK_LIMITS.UI_MAX_DEPTH}`;
  }
  if (!isPlainObject(component)) return "component must be a table";
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
    return undefined;
  }
  const children = component.children;
  if (!Array.isArray(children)) {
    return `${kind} components require a children array`;
  }
  for (const child of children) {
    const problem = componentProblem(child, depth + 1);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function versionParts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number | undefined {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function versionSatisfies(version: string, range: string): boolean | undefined {
  if (versionParts(version) === undefined) return undefined;
  const clauses = range.split(",").map((entry) => entry.trim());
  if (clauses.length === 0) return undefined;
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|==|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(clause);
    if (match === null) return undefined;
    const operator = match[1] ?? "=";
    const target = match[2] ?? "";
    const comparison = compareVersions(version, target);
    if (comparison === undefined) return undefined;
    let ok: boolean;
    switch (operator) {
      case ">=":
        ok = comparison >= 0;
        break;
      case ">":
        ok = comparison > 0;
        break;
      case "<=":
        ok = comparison <= 0;
        break;
      case "<":
        ok = comparison < 0;
        break;
      case "^": {
        const parts = versionParts(target);
        if (parts === undefined) return undefined;
        ok = comparison >= 0 && versionParts(version)?.[0] === parts[0];
        break;
      }
      case "~": {
        const parts = versionParts(target);
        const actual = versionParts(version);
        if (parts === undefined || actual === undefined) return undefined;
        ok =
          comparison >= 0 && actual[0] === parts[0] && actual[1] === parts[1];
        break;
      }
      default:
        ok = comparison === 0;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

const MODIFIERS: ReadonlySet<string> = new Set([
  "ctrl",
  "alt",
  "shift",
  "super",
]);

function chordProblem(chord: unknown): string | undefined {
  if (typeof chord !== "string" || chord.length === 0) {
    return "chord must be a non-empty string";
  }
  if (chord !== chord.trim() || chord !== chord.toLowerCase()) {
    return "chord must be trimmed and lowercase";
  }
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (key.length === 0) return "chord must end with a key";
  for (const modifier of parts.slice(0, -1)) {
    if (!MODIFIERS.has(modifier)) {
      return `unknown modifier ${modifier}`;
    }
  }
  const named =
    /^(tab|enter|space|backspace|escape|esc|ins|del|hm|end|pu|pd|f([1-9]|[1-2]\d|3[0-5]))$/.test(
      key,
    );
  if (!named && !/^[a-z0-9]$/.test(key)) {
    return `unsupported key ${key}`;
  }
  if (!named && parts.length < 2) {
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
      get(iface: string, opts?: ServiceGetOptions): ResolvedService | undefined;
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
  private terminalSnapshot: Record<string, unknown> = {};
  private deliveringViolation = false;

  constructor(options: MockHostOptions) {
    this.manifest = loadManifestModel(options.manifestSource);
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
          opts?: ServiceGetOptions,
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
    if (jsonBytes(payload) > EVENT_MAX_BYTES) {
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
    this.assertAlive();
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
    const result = def.run(args as JsonValue);
    if (def.result_schema !== undefined) {
      const problem = valueProblem(def.result_schema, result, "result");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.RESULT_INVALID, problem);
      }
    }
    return result;
  }

  /** Run queued task callbacks cooperatively in insertion order. */
  drainTasks(): void {
    this.assertAlive();
    for (const [handle, record] of this.tasks) {
      if (record.generation !== this.generation) continue;
      if (record.cancelled || record.done) continue;
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
      record.fired = true;
      this.runHostCallback(record.callback, `timer ${handle}`);
    }
  }

  /** Set the snapshot served to `bitty.terminal.snapshot`. */
  setTerminalSnapshot(snapshot: Record<string, unknown>): void {
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
    const handle = this.nextHandle();
    this.commands.set(qualified, { generation: this.generation, def });
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
    return value === undefined ? null : value;
  }

  private settingsSet(key: string, value: JsonValue): boolean {
    this.assertAlive();
    const problem = settingsKeyProblem(key);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.SETTINGS_KEY_INVALID, problem);
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
        this.storeBytes -= jsonBytes(existing);
        this.store.delete(key);
      }
      return true;
    }
    const valueProblemText = storeValueProblem(value);
    if (valueProblemText !== undefined) {
      fail("validation", HOST_CODES.STORE_VALUE_INVALID, valueProblemText);
    }
    const bytes = jsonBytes(value);
    const existing = this.store.get(key);
    const existingBytes = existing === undefined ? 0 : jsonBytes(existing);
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
    if (jsonBytes(payload) > EVENT_MAX_BYTES) {
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
    this.assertAlive();
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
    const problem = componentProblem(component);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.UI_COMPONENT_INVALID, problem, "component");
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
    block.component = deepFreeze(deepCopy(component));
    block.version += 1;
    return true;
  }

  private terminalSnapshotRead(
    opts: SnapshotOptions = {},
  ): Record<string, unknown> {
    this.assertAlive();
    this.assertCapability("bitty.terminal.snapshot", "terminal.semantic-read");
    if (opts.scope !== "semantic") {
      fail(
        "validation",
        HOST_CODES.SNAPSHOT_SCOPE_UNSUPPORTED,
        "Plugin API v1 supports only scope = 'semantic'",
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
    if (jsonBytes(this.terminalSnapshot) > MOCK_LIMITS.SNAPSHOT_MAX_BYTES) {
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
    opts: ServiceGetOptions = {},
  ): ResolvedService | undefined {
    this.assertAlive();
    const record = this.services.get(iface);
    const optional = opts.optional === true;
    if (record === undefined || !record.alive) {
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
    const service: Record<string, ServiceMethod> = {};
    for (const [method, member] of Object.entries(record.impl)) {
      service[method] = (args?: JsonValue): unknown => {
        if (!record.alive || record.generation !== this.generation) {
          fail(
            "runtime",
            HOST_CODES.SERVICE_GONE,
            `provider for service ${iface} is gone`,
          );
        }
        return member(args);
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
      message,
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
