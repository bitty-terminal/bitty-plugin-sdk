/**
 * Mock host for Plugin API v1 (R-SDK-3).
 *
 * Models the accepted `bitty` host bridge for plugin and SDK conformance
 * testing: capability gates (deny-by-default), the activation/registration
 * window, generation-owned handles, the closed v1 event set with bounded
 * immutable payloads, bounded command/store/snapshot data, the deferred `env`
 * namespace that fails closed with E_NOT_IMPLEMENTED, wired `services`
 * provide/get/resolve/call semantics (bitty #1391),
 * host-owned tasks and timers on a virtual clock, the W-82 composer submit
 * path with per-plugin byte windows (bitty #1661), and the allowlisted
 * external-editor round trip with Core-owned temp files (bitty #1661). It is
 * a test double, not a host: it performs no I/O, spawns no process, opens no
 * network, and reads no secret. Behavior is derived from ADR 0009, the
 * accepted Plugin API v1 Lua Surface RFC, and the accepted W-01/W-82
 * contracts; it may never be more permissive than those contracts.
 */

import {
  isPlainObject,
  jsonBytes,
  scanStructure,
  utf8Bytes,
} from "./bounded-value.js";
import {
  fail,
  HOST_CODES,
  HostError,
  type HostDiagnostic,
} from "./host-diagnostics.js";
import {
  DEFERRED_FUNCTIONS,
  DEFERRED_NAMESPACES,
  EDITOR_ALLOWLIST,
  EDITOR_UNAVAILABLE_REASONS,
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
  OVERLAY_EVENT_TAGS,
  OVERLAY_OWNER_RELEASE_REASONS,
  OVERLAY_RELEASE_REASONS,
  SNAPSHOT_SCOPE_ONLY,
  STORE_KEY_PATTERN,
  UI_SLOTS,
  UI_UNAVAILABLE_SLOT_REASONS,
  UI_V1_EXCLUDED_NODE_KINDS,
  UI_V1_NODE_KINDS,
  WORKSPACE_EVENT_PREFIX,
} from "./host-surface.js";
import {
  schemaProblem,
  valueProblem,
  type JsonSchema,
  type JsonValue,
} from "./json-schema.js";
import { loadManifestModel, type ManifestModel } from "./manifest-model.js";
import { versionSatisfies } from "./version-range.js";

/** Default Plugin API version provided by the mock host bridge. */
export const MOCK_PLUGIN_API_VERSION = "1.0.0";

/** Construction options for one mock host bound to one plugin manifest. */
export interface MockHostOptions {
  /** `bitty-plugin.toml` source; validated by the accepted R-SDK-2 linter. */
  readonly manifestSource: string;
  /** Host environment snapshot; only granted keys are readable. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly schemaValidatingServices?: readonly string[];
  /** Mock host Plugin API bridge version; defaults to MOCK_PLUGIN_API_VERSION. */
  readonly pluginApiVersion?: string;
  /**
   * Injected `git` presence for the accepted Layer-2 `[tools.git]` slice
   * (CTX-0425): a `MAJOR.MINOR.PATCH` string means git is present at that
   * version, while `null` or an omitted value means git is absent from the
   * activation environment. Only a manifest with
   * `[tools.git] required = true` reads this field; `required = false`
   * declares an optional dependency and never gates activation.
   */
  readonly toolsGitVersion?: string | null;
  /**
   * Safe-mode flag for the W-01 overlay surface (CTX-0065): when true the
   * mock models `bitty --safe` with zero third-party plugins loaded. Any
   * `bitty.ui.overlay.acquire` attempt fails with `E_UI_UNAVAILABLE`, no
   * focusable surface is presented, no capture session starts, and no
   * `overlay.released` bus event is emitted. Defaults to false.
   */
  readonly safeMode?: boolean;
  /**
   * Per-plugin submit byte-window cap for `bitty.terminal.submit` (W-82,
   * CTX-0068): mirrors the caller-supplied `SubmitBudget` window at bitty
   * `1df0459e`. The numeric policy belongs to the Isolation/Resource lane
   * (DEC-W103-4), so this is harness-supplied; the default is a mock-owned
   * harness convenience (`SUBMIT_BUDGET_DEFAULT_BYTES`), never a contract
   * value. Must be a non-negative safe integer.
   */
  readonly submitBudgetBytes?: number;
  /**
   * Panel-lease write rule for `bitty.terminal.submit` (W-82, CTX-0068):
   * `false` models a lease the focused panel refused (not the holder or
   * tenure lapsed) and every submit returns denied `lease-denied`.
   * Defaults to true (the composer holds the lease on the normal path).
   */
  readonly submitLeaseGranted?: boolean;
  /**
   * PTY delivery behind `bitty.terminal.submit` (W-82, CTX-0068): `live`
   * delivers the frame in one write and charges the budget; `buffered`
   * models a session-less leaf with no live writer (unavailable
   * `buffered-only`, budget untouched); `none` models no focused view
   * (unavailable `no-focused-view`). Defaults to `live`.
   */
  readonly submitDelivery?: SubmitDelivery;
  /**
   * Harness-seeded editor child result for `bitty.process.editor.start`
   * (W-82, CTX-0068). The mock performs no I/O and spawns no process, so
   * the blocking round trip resolves against this seed; the default is
   * `{ kind: "cancelled" }` (cancel writes nothing, the safe no-op).
   */
  readonly editorResult?: EditorSeed;
}

/** PTY delivery behind `bitty.terminal.submit` (W-82, CTX-0068). */
export type SubmitDelivery = "live" | "buffered" | "none";

/** `bitty.terminal.submit` typed outcome (W-82, CTX-0068). */
export type SubmitOutcome =
  | { readonly status: "accepted"; readonly bytes: number }
  | {
      readonly status: "denied";
      readonly deny: "too-large" | "lease-denied" | "budget-exceeded";
      readonly wanted?: number;
      readonly used?: number;
      readonly cap?: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no-focused-view" | "buffered-only";
    };

/** Options accepted by `bitty.process.editor.start` (W-82, CTX-0068). */
export interface EditorStartOpts {
  readonly draft?: string;
  readonly timeout_ms?: number;
}

/**
 * Harness-seeded editor child result (not a Lua surface). `edited` carries
 * the content the editor left behind; `non-zero` carries the exit code when
 * known; `spawn-failed` carries bounded host detail; `unavailable` carries
 * one of `EDITOR_UNAVAILABLE_REASONS` (defaults to `temp-unavailable`).
 */
export type EditorSeed =
  | { readonly kind: "edited"; readonly content: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" }
  | { readonly kind: "spawn-failed"; readonly detail?: string }
  | { readonly kind: "non-zero"; readonly code?: number | null }
  | { readonly kind: "unavailable"; readonly reason?: string };

/** `bitty.process.editor.start` typed outcome (W-82, CTX-0068). */
export type EditorOutcome =
  | { readonly status: "edited"; readonly content: string }
  | { readonly status: "cancelled" }
  | { readonly status: "denied"; readonly deny: "no-editor" | "not-allowed" }
  | { readonly status: "timeout" }
  | { readonly status: "spawn-failed"; readonly detail: string }
  | { readonly status: "non-zero"; readonly code?: number }
  | { readonly status: "unavailable"; readonly reason: string };

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

/** Presentation hints accepted by `bitty.ui.overlay.acquire` (W-01). */
export interface OverlayAcquireSpec {
  readonly title?: string;
  readonly placeholder?: string;
}

/** One queued overlay input event (W-01); field encodings stay parked. */
export interface OverlayInputEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/** `bitty.ui.overlay.poll` result envelope (W-01). */
export interface OverlayPollResult {
  readonly status: "active" | "released";
  readonly seq: number;
  readonly events: readonly OverlayInputEvent[];
  readonly overflowed: boolean;
  readonly reason?: string;
}

/** Result of publishing one event. */
export interface PublishResult {
  readonly delivered: number;
  readonly vetoed: boolean;
}

/** One `bitty.workspace.list()` row (bitty `WorkspaceInfo`, CTX-0889). */
export interface WorkspaceInfo {
  readonly id: number;
  readonly name: string;
  readonly active: boolean;
  readonly panel_count: number;
  readonly attention: {
    readonly bell: boolean;
    readonly activity: boolean;
    readonly exited: boolean;
  };
}

/** `bitty.workspace.focus` target: a stable id or a 1-based `{ index }`. */
export type WorkspaceFocusTarget = number | { readonly index: number };

/**
 * One validated, queued workspace mutation (bitty `WorkspaceRequest`). The
 * mock records requests for `drainWorkspaceRequests()`; it never applies
 * them, exactly like the host bridge, which only enqueues.
 */
export type WorkspaceRequest =
  | { readonly kind: "focus_id"; readonly id: number }
  | { readonly kind: "focus_index"; readonly index: number }
  | { readonly kind: "new" }
  | { readonly kind: "next" }
  | { readonly kind: "close"; readonly id: number | null }
  | { readonly kind: "rename"; readonly id: number; readonly name: string }
  | { readonly kind: "move_panel"; readonly id: number };

/** `bitty.debug.inspect` result shape. */
export interface DebugInspectResult {
  readonly target: string;
  readonly items: readonly unknown[];
  readonly truncated: boolean;
}

/** `bitty.debug.trace` options. */
export interface DebugTraceOptions {
  readonly enabled?: boolean;
  readonly filter?: string;
  readonly max_events?: number;
  readonly handle?: number;
}

/** One drained trace record. */
export interface DebugTraceRecord {
  readonly topic: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** `bitty.debug.trace_get` result shape. */
export interface DebugTraceDrain {
  readonly records: readonly DebugTraceRecord[];
  readonly dropped: number;
}

export type MockHostState =
  "created" | "activating" | "active" | "suspended" | "disposing" | "disposed";

interface Subscription {
  readonly generation: number;
  readonly kind: string;
  readonly handler: EventHandler;
}

interface UiBlock {
  readonly generation: number;
  readonly slot: string;
  component: Record<string, unknown>;
  textBytes: number;
  version: number;
}

interface OverlaySession {
  readonly handle: number;
  readonly ownerPluginId: string;
  readonly ownerGeneration: number;
  spec: Record<string, unknown>;
  scene: Record<string, unknown>;
  queue: OverlayInputEvent[];
  nextSeq: number;
  lastDeliveredSeq: number;
  overflowed: boolean;
  status: "active" | "released";
  reason?: string;
  lastActivity: number;
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

type TraceFilter =
  | { readonly kind: "all" }
  | { readonly kind: "exact"; readonly topic: string }
  | { readonly kind: "prefix"; readonly prefix: string };

interface TraceState {
  readonly generation: number;
  readonly declared: ReadonlySet<string>;
  readonly granted: ReadonlySet<string>;
  readonly filter: TraceFilter;
  readonly maxEvents: number;
  records: Array<DebugTraceRecord & { readonly bytes: number }>;
  bytes: number;
  dropped: number;
}

/** Lowercase lifecycle label served by `bitty.debug.inspect("plugins")`. */
const DEBUG_STATE_LABEL: Readonly<Record<MockHostState, string>> = {
  created: "unloaded",
  activating: "activating",
  active: "active",
  suspended: "suspended",
  disposing: "disposing",
  disposed: "disposed",
};

const DEBUG_TRACE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "filter",
  "max_events",
  "handle",
]);

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Positive Lua integer as the host bridge accepts for workspace ids. */
function isPositiveLuaInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Validate a stable workspace id argument (bitty `workspace_id_arg`). */
function workspaceIdArg(value: unknown, what: string): number {
  if (!isPositiveLuaInteger(value)) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      `${what} must be a positive integer workspace id`,
    );
  }
  return value;
}

/** Validate a rename name (bitty `workspace_name_arg`). */
function workspaceNameArg(value: unknown): string {
  if (typeof value !== "string") {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "workspace.rename name must be a string",
    );
  }
  if (LONE_SURROGATE.test(value)) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "workspace.rename name must be valid UTF-8",
    );
  }
  if (utf8Bytes(value) > MOCK_LIMITS.WORKSPACE_RENAME_MAX_BYTES) {
    fail(
      "validation",
      HOST_CODES.DEF_LIMIT,
      `workspace.rename name exceeds ${MOCK_LIMITS.WORKSPACE_RENAME_MAX_BYTES} bytes`,
    );
  }
  if (value.trim().length === 0 || CONTROL_CHARACTER.test(value)) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "workspace.rename name must be non-blank without control characters",
    );
  }
  return value;
}

/** Truncate a workspace name to the bridge character bound. */
function boundedWorkspaceName(name: string): string {
  return [...name].slice(0, MOCK_LIMITS.WORKSPACE_NAME_MAX_CHARS).join("");
}

/**
 * Truncate host detail to a byte ceiling (W-82, CTX-0068). Mirrors the Core
 * 512-byte truncation of editor spawn/wait detail: over-long detail is cut
 * at the byte boundary and undecodable tails decode leniently.
 */
function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

/** Parse a trace topic filter (bitty `TraceFilter::parse`). */
function parseTraceFilter(pattern: string): TraceFilter {
  if (
    pattern.length === 0 ||
    utf8Bytes(pattern) > MOCK_LIMITS.DEBUG_TRACE_FILTER_MAX_BYTES
  ) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      `debug.trace filter must be 1..=${MOCK_LIMITS.DEBUG_TRACE_FILTER_MAX_BYTES} bytes`,
    );
  }
  if (!/^[\x21-\x7e]+$/.test(pattern)) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "debug.trace filter must be printable ASCII without spaces",
    );
  }
  const star = pattern.indexOf("*");
  if (star === -1) return { kind: "exact", topic: pattern };
  if (star === pattern.length - 1) {
    return { kind: "prefix", prefix: pattern.slice(0, star) };
  }
  fail(
    "validation",
    HOST_CODES.DEF_INVALID,
    "debug.trace filter allows a single trailing '*' only",
  );
}

function traceFilterMatches(filter: TraceFilter, topic: string): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "exact") return topic === filter.topic;
  return topic.startsWith(filter.prefix);
}

/** Lua integer check for debug option and handle values. */
function isLuaInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Validate a harness-seeded editor child result (W-82, CTX-0068). Seeds are
 * harness input, not plugin calls, but malformed seeds fail with the same
 * typed validation failure the bridge raises for misshaped arguments so a
 * bad fixture cannot silently resolve to a wrong outcome.
 */
function checkEditorSeed(seed: unknown): asserts seed is EditorSeed {
  if (!isPlainObject(seed)) {
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "editor result seed must be a table with a kind",
    );
  }
  const kind = (seed as Record<string, unknown>).kind;
  if (kind === "cancelled" || kind === "timeout") return;
  if (kind === "edited") {
    if (typeof (seed as Record<string, unknown>).content !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "edited editor seed needs a string content",
      );
    }
    return;
  }
  if (kind === "spawn-failed") {
    const detail = (seed as Record<string, unknown>).detail;
    if (detail !== undefined && typeof detail !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "spawn-failed editor seed detail must be a string",
      );
    }
    return;
  }
  if (kind === "non-zero") {
    const code = (seed as Record<string, unknown>).code;
    if (
      code !== undefined &&
      code !== null &&
      (!Number.isSafeInteger(code) ||
        (code as number) < MOCK_LIMITS.EXIT_CODE_MIN ||
        (code as number) > MOCK_LIMITS.EXIT_CODE_MAX)
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "non-zero editor seed code must be a signed 32-bit integer or null",
      );
    }
    return;
  }
  if (kind === "unavailable") {
    const reason = (seed as Record<string, unknown>).reason;
    if (
      reason !== undefined &&
      (typeof reason !== "string" ||
        !EDITOR_UNAVAILABLE_REASONS.includes(reason))
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        `unavailable editor seed reason must be one of ${EDITOR_UNAVAILABLE_REASONS.join(", ")}`,
      );
    }
    return;
  }
  fail(
    "validation",
    HOST_CODES.DEF_INVALID,
    "editor result seed kind must be edited, cancelled, timeout, spawn-failed, non-zero, or unavailable",
  );
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

/**
 * Bounded bridge-value conversion for command args and results.
 *
 * Independent of any optional command schema, the bridge marshals every value
 * across the same discipline as the real host bridge: depth at most
 * `BRIDGE_MAX_DEPTH`, at most `BRIDGE_MAX_NODES` nodes, at most
 * `BRIDGE_MAX_VALUE_BYTES` serialized bytes, and only plain JSON data.
 * Cyclic, non-plain, non-finite, symbol-keyed, and non-data values fail with a
 * bounded problem description so schema-less dispatch cannot bless a value the
 * host would reject. `undefined` is reported by `scanStructure` as non-data
 * here; callers that must tolerate Lua `nil` (a command returning no value)
 * normalize it before calling this.
 */
function bridgeValueProblem(value: unknown, path: string): string | undefined {
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    value === undefined
  ) {
    return `${path}: value is not JSON-compatible data`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `${path}: value contains a non-finite number`;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value) && !Array.isArray(value)) {
      return `${path}: value contains a non-plain object`;
    }
    const scan = scanStructure(
      value,
      MOCK_LIMITS.BRIDGE_MAX_DEPTH,
      MOCK_LIMITS.BRIDGE_MAX_NODES,
      MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES,
    );
    if (scan.cycle) {
      return `${path}: value contains a cyclic reference`;
    }
    if (scan.problem !== undefined) {
      return `${path}: ${scan.problem}`;
    }
    if (scan.depth > MOCK_LIMITS.BRIDGE_MAX_DEPTH) {
      return `${path}: value depth exceeds ${MOCK_LIMITS.BRIDGE_MAX_DEPTH}`;
    }
    if (scan.nodes > MOCK_LIMITS.BRIDGE_MAX_NODES) {
      return `${path}: value node count exceeds ${MOCK_LIMITS.BRIDGE_MAX_NODES}`;
    }
    // The scan counts string and key bytes, so a huge leaf is rejected here
    // without serializing. The exact `jsonBytes` below only refines
    // escape-expansion for values already proven bounded.
    if (scan.bytes > MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES) {
      return `${path}: value exceeds ${MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES} bytes`;
    }
  }
  if (
    jsonBytes(value, MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES) >
    MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES
  ) {
    return `${path}: value exceeds ${MOCK_LIMITS.BRIDGE_MAX_VALUE_BYTES} bytes`;
  }
  return undefined;
}

/**
 * Nonnegative-safe-integer predicate for registry identity fields.
 *
 * Accepted identity fields are Lua integers (u64 within the i64 range), so a
 * JS handling value must be a nonnegative safe integer. This deliberately does
 * not apply to status values such as `exit_code`, which stay signed.
 */
function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Numeric event payload fields that are signed status values, not identity.
 *
 * Identity fields (`terminal_id`, `runtime_id`, `view_id`, `generation`) are
 * u64 within the Lua integer range and must stay nonnegative. `exit_code` is
 * the accepted signed `TerminalExited` status and may be negative (for
 * example `-9` for a signal-killed process).
 */
const SIGNED_INTEGER_EVENT_FIELDS: ReadonlySet<string> = new Set(["exit_code"]);

/** Resource totals for one UI component subtree. */
interface ComponentResourceCounts {
  readonly nodes: number;
  readonly textBytes: number;
}

/**
 * Count nodes and text bytes in a UI component subtree.
 *
 * The walk mirrors the accepted `UiNode` accounting: every node counts once
 * and each `Text` leaf contributes its UTF-8 byte length. Cycles are rejected
 * before this runs (via `containsCycle`), so the traversal terminates. A
 * shared-reference (DAG) subtree expands per reference, so the walk stops as
 * soon as either budget is exceeded (returning one past the bound); callers
 * only need the exceed verdict, and this keeps the cost proportional to the
 * bound rather than to the exponential expansion.
 */
function countComponentResources(component: unknown): ComponentResourceCounts {
  let nodes = 0;
  let textBytes = 0;
  const stack: unknown[] = [component];
  while (stack.length > 0) {
    if (
      nodes > MOCK_LIMITS.UI_MAX_NODES ||
      textBytes > MOCK_LIMITS.UI_MAX_TEXT_BYTES
    ) {
      break;
    }
    const current = stack.pop();
    if (!isPlainObject(current)) continue;
    nodes += 1;
    if (current.kind === "Text" && typeof current.text === "string") {
      textBytes += utf8Bytes(current.text);
    }
    const children = current.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
  return { nodes, textBytes };
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
      MOCK_LIMITS.STORE_MAX_VALUE_BYTES,
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
    if (scan.problem !== undefined) {
      return scan.problem;
    }
    if (scan.bytes > MOCK_LIMITS.STORE_MAX_VALUE_BYTES) {
      return `value exceeds ${MOCK_LIMITS.STORE_MAX_VALUE_BYTES} bytes`;
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

function quote(raw: string): string {
  return raw.length > 80 ? `'${raw.slice(0, 77)}...'` : `'${raw}'`;
}

/** Mock host bound to one plugin manifest and one generation at a time. */
export class MockHost {
  readonly manifest: ManifestModel;
  readonly environment: Readonly<Record<string, string>>;
  readonly pluginApiVersion: string;
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
      readonly overlay: {
        acquire(spec?: OverlayAcquireSpec | null): number;
        update(handle: number, scene: Record<string, unknown>): boolean;
        poll(handle: number): OverlayPollResult;
        release(handle: number, reason?: string | null): boolean;
      };
    };
    readonly terminal: {
      snapshot(opts?: SnapshotOptions): Record<string, unknown>;
      submit(text: string): SubmitOutcome;
    };
    readonly process: {
      readonly editor: {
        start(opts?: EditorStartOpts | null): EditorOutcome;
      };
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
    readonly debug: {
      inspect(target: string): DebugInspectResult;
      trace(opts?: DebugTraceOptions | null): number;
      trace_get(handle: number): DebugTraceDrain | null;
      control(action: string, target: string): unknown;
    };
    readonly workspace: {
      list(): WorkspaceInfo[];
      focus(target: WorkspaceFocusTarget): boolean;
      readonly new: () => boolean;
      next(): boolean;
      close(id?: number | null): boolean;
      rename(id: number, name: string): boolean;
      move_panel(id: number): boolean;
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
  private aggregatedTextBytes = 0;
  private readonly tasks = new Map<number, TaskRecord>();
  private readonly timers = new Map<number, TimerRecord>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly schemaValidatingServices: ReadonlySet<string>;
  private readonly toolsGitVersion: string | null | undefined;
  private readonly safeMode: boolean;
  private overlaySession: OverlaySession | undefined;
  private terminalSnapshot: Record<string, unknown> = {};
  // W-82 composer submit/editor state (CTX-0068). The byte window is
  // per-generation (reset on activation); delivery, lease, and the editor
  // seed are host-provided facts that persist across generations until the
  // harness changes them. Temp counters are host-lifetime so cleanup holds on
  // every path; submitted frames accumulate for byte-exactness assertions.
  private submitBudgetBytes: number;
  private submitUsed = 0;
  private submitLeaseGranted: boolean;
  private submitDelivery: SubmitDelivery;
  private editorSeed: EditorSeed | undefined;
  private editorTempsCreatedCount = 0;
  private editorTempsRemovedCount = 0;
  private lastEditorTimeoutMsValue = 0;
  readonly submittedFrames: Uint8Array[] = [];
  private deliveringViolation = false;
  private workspaceRows: WorkspaceInfo[] = [];
  private workspaceQueue: WorkspaceRequest[] = [];
  private droppedWorkspaceRequests = 0;
  private readonly traces = new Map<number, TraceState>();
  private traceHandleSequence = 0;

  constructor(options: MockHostOptions) {
    this.manifest = loadManifestModel(options.manifestSource);
    this.pluginApiVersion = options.pluginApiVersion ?? MOCK_PLUGIN_API_VERSION;
    this.schemaValidatingServices = new Set(
      options.schemaValidatingServices ?? [],
    );
    this.toolsGitVersion = options.toolsGitVersion ?? null;
    this.safeMode = options.safeMode === true;
    if (
      options.submitBudgetBytes !== undefined &&
      (!Number.isSafeInteger(options.submitBudgetBytes) ||
        options.submitBudgetBytes < 0)
    ) {
      throw new Error("submitBudgetBytes must be a non-negative safe integer");
    }
    this.submitBudgetBytes =
      options.submitBudgetBytes ?? MOCK_LIMITS.SUBMIT_BUDGET_DEFAULT_BYTES;
    this.submitLeaseGranted = options.submitLeaseGranted ?? true;
    if (
      options.submitDelivery !== undefined &&
      options.submitDelivery !== "live" &&
      options.submitDelivery !== "buffered" &&
      options.submitDelivery !== "none"
    ) {
      throw new Error('submitDelivery must be "live", "buffered", or "none"');
    }
    this.submitDelivery = options.submitDelivery ?? "live";
    if (options.editorResult !== undefined) {
      checkEditorSeed(options.editorResult);
      this.editorSeed = options.editorResult;
    }
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    const envDeclared = this.declaredEnvCapabilities().length > 0;

    const env = envDeclared
      ? {
          get: (name: string): string | null => this.envGet(name),
          has: (name: string): boolean => this.envHas(name),
        }
      : undefined;

    this.bitty = {
      api_version: this.pluginApiVersion,
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
        overlay: {
          acquire: (spec?: OverlayAcquireSpec | null): number =>
            this.overlayAcquire(spec),
          update: (handle: number, scene: Record<string, unknown>): boolean =>
            this.overlayUpdate(handle, scene),
          poll: (handle: number): OverlayPollResult => this.overlayPoll(handle),
          release: (handle: number, reason?: string | null): boolean =>
            this.overlayRelease(handle, reason),
        },
      },
      terminal: {
        snapshot: (opts?: SnapshotOptions): Record<string, unknown> =>
          this.terminalSnapshotRead(opts),
        submit: (text: string): SubmitOutcome => this.terminalSubmit(text),
      },
      process: {
        editor: {
          start: (opts?: EditorStartOpts | null): EditorOutcome =>
            this.processEditorStart(opts),
        },
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
      debug: {
        inspect: (target: string): DebugInspectResult =>
          this.debugInspect(target),
        trace: (opts?: DebugTraceOptions | null): number =>
          this.debugTrace(opts),
        trace_get: (handle: number): DebugTraceDrain | null =>
          this.debugTraceGet(handle),
        control: (action: string, target: string): unknown =>
          this.debugControl(action, target),
      },
      workspace: {
        list: (): WorkspaceInfo[] => this.workspaceList(),
        focus: (target: WorkspaceFocusTarget): boolean =>
          this.workspaceRequest(() => this.workspaceFocusArg(target)),
        new: (): boolean => this.workspaceRequest(() => ({ kind: "new" })),
        next: (): boolean => this.workspaceRequest(() => ({ kind: "next" })),
        close: (id?: number | null): boolean =>
          this.workspaceRequest(() => ({
            kind: "close",
            id:
              id === undefined || id === null
                ? null
                : workspaceIdArg(id, "workspace.close id"),
          })),
        rename: (id: number, name: string): boolean =>
          this.workspaceRequest(() => ({
            kind: "rename",
            id: workspaceIdArg(id, "workspace.rename id"),
            name: workspaceNameArg(name),
          })),
        move_panel: (id: number): boolean =>
          this.workspaceRequest(() => ({
            kind: "move_panel",
            id: workspaceIdArg(id, "workspace.move_panel target"),
          })),
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

  /**
   * Fail closed when a `required = true` `[tools.git]` declaration cannot be
   * satisfied by the injected activation environment. An omitted or `null`
   * `toolsGitVersion` means git is absent (`E_TOOL_ABSENT`, `resolution`);
   * a present version that does not satisfy `[tools.git].version` (including
   * a malformed injected version) fails with `E_TOOL_MISMATCH`
   * (`validation`). `required = false` never gates activation.
   */
  private checkToolsGitActivation(): void {
    const toolsGit = this.manifest.toolsGit;
    if (toolsGit === undefined || !toolsGit.required) return;
    const provided = this.toolsGitVersion;
    if (provided === undefined || provided === null) {
      fail(
        "resolution",
        HOST_CODES.TOOL_ABSENT,
        `plugin requires git ${quote(toolsGit.version)}, but git is absent from the activation environment`,
        "tools.git",
      );
    }
    const satisfied = versionSatisfies(provided, toolsGit.version);
    if (satisfied === undefined || !satisfied) {
      fail(
        "validation",
        HOST_CODES.TOOL_MISMATCH,
        `plugin requires git ${quote(toolsGit.version)}, but activation provides git ${quote(provided)}`,
        "tools.git.version",
      );
    }
  }

  /**
   * Fail closed when the manifest declares a `workspace.*` event kind without
   * a granted `workspace.read` capability (bitty CTX-0889): the host rejects
   * activation before any VM exists instead of letting the subscription
   * silently never fire.
   */
  private checkWorkspaceEventActivation(): void {
    if (this.hasCapability("workspace.read")) return;
    const kind = this.manifest.events.find((entry) =>
      entry.startsWith(WORKSPACE_EVENT_PREFIX),
    );
    if (kind !== undefined) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        `event '${kind}' requires the 'workspace.read' capability`,
        "lazy.events",
      );
    }
  }

  /** Open the activation window for a new generation. */
  beginActivation(): void {
    if (this.manifest.pluginApiRange !== undefined) {
      const satisfied = versionSatisfies(
        this.pluginApiVersion,
        this.manifest.pluginApiRange,
      );
      if (satisfied === undefined || !satisfied) {
        fail(
          "validation",
          HOST_CODES.LIFECYCLE_STATE,
          `plugin requires Plugin API ${quote(this.manifest.pluginApiRange)}, but mock host provides ${this.pluginApiVersion}`,
        );
      }
    }
    this.checkToolsGitActivation();
    this.checkWorkspaceEventActivation();
    if (this.state === "disposed" || this.state === "created") {
      this.generation += 1;
      // W-82 (CTX-0068): the submit byte window is per-generation, so a new
      // generation starts uncharged; the editor seed resets to the safe
      // cancelled default. Delivery, lease, and temp counters are host facts
      // and persist.
      this.submitUsed = 0;
      this.editorSeed = undefined;
      this.lastEditorTimeoutMsValue = 0;
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
    // W-01 (CTX-0065): suspend revokes capture like the Core mechanism. Release
    // before entering `suspended` so the observation-only `overlay.released`
    // bus event still delivers (observation deliveries detach once suspended).
    this.terminateOverlayForCause("unloaded");
    this.state = "suspended";
    this.publishLifecycle("plugin.suspended");
  }

  /** Dispose the current generation: lifecycle event, then invalidation. */
  dispose(): void {
    // Reentrant disposal (a `plugin.disposed`/`plugin.suspended` handler
    // calling `dispose()` again) is idempotent: the terminal transition is
    // published exactly once and never redelivered. A first call from any
    // other state is still a typed lifecycle failure.
    if (this.state === "disposing" || this.state === "disposed") return;
    if (this.state !== "active" && this.state !== "suspended") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        `cannot dispose from state '${this.state}'`,
      );
    }
    // W-01 (CTX-0065): dispose revokes capture with `unloaded` before the
    // terminal transition, so the `overlay.released` observation still
    // delivers. The released session is retained (not cleared) for
    // generation-fenced stale-handle detection; a new acquire replaces it.
    this.terminateOverlayForCause("unloaded");
    // Enter the terminal state before publication so a reentrant handler sees
    // a non-disposable state and the event is published at most once, while
    // the accepted event-before-invalidation observation order is preserved:
    // the lifecycle event is delivered before the generation resources below
    // are cleared.
    this.state = "disposing";
    this.publishLifecycle("plugin.disposed");
    this.state = "disposed";
    this.subscriptions = [];
    this.commands.clear();
    this.keymaps.length = 0;
    this.blocks.clear();
    this.aggregatedTextBytes = 0;
    this.tasks.clear();
    this.timers.clear();
    for (const record of this.services.values()) record.alive = false;
    this.services.clear();
    // Traces never outlive the generation (bitty `drop_traces`).
    this.traces.clear();
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
      let valid: boolean;
      let expected: string;
      if (field.type === "string") {
        valid = typeof value === "string";
        expected = "a string";
      } else if (SIGNED_INTEGER_EVENT_FIELDS.has(field.name)) {
        // `exit_code` is the accepted signed status value (`i32` in
        // `bitty-runtime` `registry.rs`); identity fields are u64 and must be
        // nonnegative safe integers instead.
        valid =
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= MOCK_LIMITS.EXIT_CODE_MIN &&
          value <= MOCK_LIMITS.EXIT_CODE_MAX;
        expected = `a signed 32-bit integer (${MOCK_LIMITS.EXIT_CODE_MIN}..${MOCK_LIMITS.EXIT_CODE_MAX})`;
      } else {
        valid = isNonnegativeSafeInteger(value);
        expected = "a nonnegative safe integer";
      }
      if (!valid) {
        fail(
          "validation",
          HOST_CODES.EVENT_PAYLOAD_INVALID,
          `event payload field '${field.name}' must be ${expected}`,
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
    // bitty `deliver_event` records every published event into open traces
    // once, before fan-out, under the sequence the envelope will carry.
    this.recordTrace(kind, this.eventSequence + 1, payload);
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
    // The bridge marshals every value, schema or not: reject unsupported,
    // cyclic, non-plain, or over-bound args before the callback runs.
    const argsProblem = bridgeValueProblem(args, "args");
    if (argsProblem !== undefined) {
      fail("validation", HOST_CODES.ARGS_INVALID, argsProblem);
    }
    if (def.args_schema !== undefined) {
      const problem = valueProblem(def.args_schema, args, "args");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.ARGS_INVALID, problem);
      }
    }
    // Command callbacks run inside the same error boundary as task, timer, and
    // event callbacks: a fault is recorded as a handler violation (delivering
    // `handler.violation`) and surfaced as the typed command-callback failure
    // instead of escaping as a raw JS error.
    let result: unknown = undefined;
    try {
      result = def.run(deepCopy(args) as JsonValue);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.recordViolation(`command ${qualified} callback failed: ${message}`);
      fail(
        "runtime",
        HOST_CODES.COMMAND_CALLBACK_FAILED,
        `command ${qualified} callback failed: ${message}`,
      );
    }
    // A Lua command that returns nothing marshals to `nil`; tolerate the
    // JS `undefined` equivalent as a valid (empty) result. Every other value
    // crosses the same bounded bridge conversion as the args.
    if (result !== undefined) {
      const resultProblem = bridgeValueProblem(result, "result");
      if (resultProblem !== undefined) {
        fail("validation", HOST_CODES.RESULT_INVALID, resultProblem);
      }
    }
    if (def.result_schema !== undefined) {
      const problem = valueProblem(def.result_schema, result, "result");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.RESULT_INVALID, problem);
      }
    }
    return deepCopy(result);
  }

  /**
   * Run queued task callbacks cooperatively in insertion order.
   *
   * Eligible records are snapshotted before any callback runs, then each is
   * rechecked against the live map, its own cancelled/done flags, the
   * generation, and the host state. A callback that disposes and reloads
   * stops the drain as soon as the generation changes, so a newly queued
   * generation-N+1 task can never run inside an old drain (matching the timer
   * path).
   */
  drainTasks(): void {
    this.assertAlive();
    const generation = this.generation;
    const eligible = [...this.tasks.entries()].filter(
      ([, record]) =>
        record.generation === generation && !record.cancelled && !record.done,
    );
    for (const [handle, record] of eligible) {
      if (this.generation !== generation) break;
      if (this.tasks.get(handle) !== record) continue;
      if (record.cancelled || record.done) continue;
      if (record.generation !== generation) continue;
      if (this.state === "suspended" || this.state === "disposing") continue;
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
    // W-01 (CTX-0065): the same virtual clock drives the 30s overlay idle
    // timeout; an expired session releases with `timeout` here so a test that
    // only advances time still observes the terminal cause on its next poll.
    this.expireOverlayIfIdle();
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
        this.state === "disposing" ||
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

  /**
   * Set PTY delivery behind `bitty.terminal.submit` (harness-only, W-82,
   * CTX-0068): `live` delivers and charges, `buffered` reports unavailable
   * `buffered-only` without charging, `none` reports unavailable
   * `no-focused-view`.
   */
  setSubmitDelivery(delivery: SubmitDelivery): void {
    if (delivery !== "live" && delivery !== "buffered" && delivery !== "none") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        'submit delivery must be "live", "buffered", or "none"',
      );
    }
    this.submitDelivery = delivery;
  }

  /**
   * Set the panel-lease write rule behind `bitty.terminal.submit`
   * (harness-only, W-82, CTX-0068). `false` models a refused lease and every
   * submit returns denied `lease-denied` with nothing emitted.
   */
  setSubmitLease(granted: boolean): void {
    if (typeof granted !== "boolean") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "submit lease must be a boolean",
      );
    }
    this.submitLeaseGranted = granted;
  }

  /**
   * Seed the editor child result behind `bitty.process.editor.start`
   * (harness-only, W-82, CTX-0068). The mock spawns no process, so the
   * blocking round trip resolves against this seed after capability and
   * allowlist checks pass.
   */
  setEditorResult(seed: EditorSeed): void {
    checkEditorSeed(seed);
    this.editorSeed = seed;
  }

  /** Remove one provided service; consumers fail closed with a gone error. */
  removeService(iface: string): void {
    const record = this.services.get(iface);
    if (record !== undefined) record.alive = false;
    this.services.delete(iface);
  }

  /**
   * Set the Core workspace summary served to `bitty.workspace.list()`.
   *
   * Models the host's per-tick live workspace source: rows are validated,
   * copied, truncated to `WORKSPACE_LIST_MAX_ITEMS`, and names are cut to
   * `WORKSPACE_NAME_MAX_CHARS` characters exactly like the bridge. Before the
   * first call the source is empty.
   */
  setWorkspaces(rows: readonly WorkspaceInfo[]): void {
    if (!Array.isArray(rows)) {
      fail("validation", HOST_CODES.DEF_INVALID, "workspaces must be an array");
    }
    const bounded: WorkspaceInfo[] = [];
    for (const [index, row] of rows.entries()) {
      if (index >= MOCK_LIMITS.WORKSPACE_LIST_MAX_ITEMS) break;
      const path = `workspaces[${index}]`;
      if (
        !isPlainObject(row) ||
        !isPositiveLuaInteger(row.id) ||
        typeof row.name !== "string" ||
        typeof row.active !== "boolean" ||
        !isNonnegativeSafeInteger(row.panel_count)
      ) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `${path} must carry a positive integer id, string name, boolean active, and nonnegative integer panel_count`,
          path,
        );
      }
      const attention = isPlainObject(row.attention) ? row.attention : {};
      bounded.push({
        id: row.id,
        name: boundedWorkspaceName(row.name),
        active: row.active,
        panel_count: row.panel_count,
        attention: {
          bell: attention.bell === true,
          activity: attention.activity === true,
          exited: attention.exited === true,
        },
      });
    }
    this.workspaceRows = bounded;
  }

  /**
   * Drain queued `bitty.workspace.*` mutations in FIFO order, as the host
   * application does once per tick. The mock never applies them.
   */
  drainWorkspaceRequests(): WorkspaceRequest[] {
    const drained = this.workspaceQueue;
    this.workspaceQueue = [];
    return drained;
  }

  /** Requests dropped because the bounded workspace queue was full. */
  get workspaceRequestsDropped(): number {
    return this.droppedWorkspaceRequests;
  }

  /** Submit byte-window bytes charged in the current generation (W-82). */
  get submitBudgetUsed(): number {
    return this.submitUsed;
  }

  /** Editor temp files created over host lifetime (W-82 temp rules). */
  get editorTempsCreated(): number {
    return this.editorTempsCreatedCount;
  }

  /** Editor temp files removed over host lifetime (cleanup is structural). */
  get editorTempsRemoved(): number {
    return this.editorTempsRemovedCount;
  }

  /** Effective bounded editor wait of the last start in milliseconds. */
  get lastEditorTimeoutMs(): number {
    return this.lastEditorTimeoutMsValue;
  }

  /**
   * Fail closed for an accepted v1 namespace the host has not wired yet.
   *
   * Only `env` remains deferred (bitty #1303 froze the verdict set; bitty
   * #1391 wired `services.get`/`provide` to the host backend, so the
   * full-contract `servicesProvide`/`servicesGet` implementation below is
   * live). Deferred spellings stay present and callable so the gap is
   * observable, and every call fails with typed E_NOT_IMPLEMENTED (runtime)
   * before activation, capability, or argument checks run; the mock is never
   * more permissive than the host.
   */
  private assertNamespaceWired(namespace: string, item: string): void {
    if (DEFERRED_NAMESPACES.has(namespace)) {
      fail(
        "runtime",
        HOST_CODES.NOT_IMPLEMENTED,
        `${item} is not implemented by this host`,
      );
    }
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
    if (this.state === "suspended" || this.state === "disposing") {
      fail(
        "validation",
        HOST_CODES.LIFECYCLE_STATE,
        `the plugin generation is ${this.state}; ordinary dispatch is detached`,
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
      if (parameter.endsWith("_*")) {
        const prefix = parameter.slice(0, -1);
        if (key.startsWith(prefix)) return true;
        continue;
      }
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
    this.assertNamespaceWired("env", "bitty.env.get");
    this.assertAlive();
    if (this.grantedEnvCapabilities().length === 0) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        "bitty.env requires a granted env.read:<KEY> capability",
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
    this.assertNamespaceWired("env", "bitty.env.has");
    this.assertAlive();
    if (this.grantedEnvCapabilities().length === 0) {
      fail(
        "runtime",
        HOST_CODES.CAPABILITY_DENIED,
        "bitty.env requires a granted env.read:<KEY> capability",
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
    if (utf8Bytes(def.title) > MOCK_LIMITS.COMMAND_TITLE_MAX_BYTES) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        `command title exceeds ${MOCK_LIMITS.COMMAND_TITLE_MAX_BYTES} bytes`,
        "def.title",
      );
    }
    if (def.description !== undefined) {
      if (typeof def.description !== "string") {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "command description must be a string",
          "def.description",
        );
      }
      if (
        utf8Bytes(def.description) > MOCK_LIMITS.COMMAND_DESCRIPTION_MAX_BYTES
      ) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `command description exceeds ${MOCK_LIMITS.COMMAND_DESCRIPTION_MAX_BYTES} bytes`,
          "def.description",
        );
      }
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
    // CTX-0923 parity: an accepted slot the host does not present fails closed
    // after the capability and claim gates, before component validation and
    // budgets, so nothing is admitted that the host would never render.
    if (Object.hasOwn(UI_UNAVAILABLE_SLOT_REASONS, slot)) {
      fail(
        "runtime",
        HOST_CODES.UI_UNAVAILABLE,
        `UI slot '${slot}' ${UI_UNAVAILABLE_SLOT_REASONS[slot]}`,
        "slot",
      );
    }
    const problem = componentProblem(component);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.UI_COMPONENT_INVALID, problem, "component");
    }
    // Node and text budgets are checked on the parsed node before the raw
    // marshalling byte cap, matching `bitty-lua` `ui.rs`: the semantic
    // `SCN-1`/`SCN-3` numbers are exact, while the byte cap only guards the
    // raw value (text + 64 KiB).
    const counts = countComponentResources(component);
    if (counts.nodes > MOCK_LIMITS.UI_MAX_NODES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component node count exceeds ${MOCK_LIMITS.UI_MAX_NODES}`,
        "component",
      );
    }
    if (counts.textBytes > MOCK_LIMITS.UI_MAX_TEXT_BYTES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component text exceeds ${MOCK_LIMITS.UI_MAX_TEXT_BYTES} bytes`,
        "component",
      );
    }
    if (
      jsonBytes(component, MOCK_LIMITS.UI_MARSHAL_MAX_BYTES) >
      MOCK_LIMITS.UI_MARSHAL_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component exceeds ${MOCK_LIMITS.UI_MARSHAL_MAX_BYTES} bytes`,
        "component",
      );
    }
    // Block and aggregate-text budgets are per generation; reject before any
    // mutation so a rejected mount retains the prior generation state.
    if (this.blocks.size >= MOCK_LIMITS.UI_MAX_BLOCKS) {
      fail(
        "budget",
        HOST_CODES.UI_BLOCK_BUDGET,
        `ui block registry is full (${MOCK_LIMITS.UI_MAX_BLOCKS} blocks)`,
      );
    }
    if (
      this.aggregatedTextBytes + counts.textBytes >
      MOCK_LIMITS.UI_MAX_AGGREGATED_TEXT_BYTES
    ) {
      fail(
        "budget",
        HOST_CODES.UI_BLOCK_BUDGET,
        `ui block text budget exceeded (${MOCK_LIMITS.UI_MAX_AGGREGATED_TEXT_BYTES} bytes aggregated)`,
      );
    }
    const handle = this.nextHandle();
    this.aggregatedTextBytes += counts.textBytes;
    this.blocks.set(handle, {
      generation: this.generation,
      slot,
      component: deepFreeze(deepCopy(component)),
      textBytes: counts.textBytes,
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
    const counts = countComponentResources(component);
    if (counts.nodes > MOCK_LIMITS.UI_MAX_NODES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component node count exceeds ${MOCK_LIMITS.UI_MAX_NODES}`,
        "component",
      );
    }
    if (counts.textBytes > MOCK_LIMITS.UI_MAX_TEXT_BYTES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component text exceeds ${MOCK_LIMITS.UI_MAX_TEXT_BYTES} bytes`,
        "component",
      );
    }
    if (
      jsonBytes(component, MOCK_LIMITS.UI_MARSHAL_MAX_BYTES) >
      MOCK_LIMITS.UI_MARSHAL_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `component exceeds ${MOCK_LIMITS.UI_MARSHAL_MAX_BYTES} bytes`,
        "component",
      );
    }
    // Apply the update delta against the generation aggregate, rejecting before
    // the block is mutated so the last good component is retained.
    const newAggregate =
      this.aggregatedTextBytes - block.textBytes + counts.textBytes;
    if (newAggregate > MOCK_LIMITS.UI_MAX_AGGREGATED_TEXT_BYTES) {
      fail(
        "budget",
        HOST_CODES.UI_BLOCK_BUDGET,
        `ui block text budget exceeded (${MOCK_LIMITS.UI_MAX_AGGREGATED_TEXT_BYTES} bytes aggregated)`,
      );
    }
    this.aggregatedTextBytes = newAggregate;
    block.component = deepFreeze(deepCopy(component));
    block.textBytes = counts.textBytes;
    block.version += 1;
    return true;
  }

  /**
   * W-01 overlay session helpers (CTX-0065, accepted contract).
   *
   * Single global owner, generation-fenced handles, bounded 256-event queue
   * with drop-oldest plus sticky `overflowed`, 4096-byte per-event and
   * per-call ceilings, v1 scene budgets per update, 30s idle timeout
   * resetting on input, poll, or update, idempotent release, and safe-mode
   * `E_UI_UNAVAILABLE` on acquire. All four entry points require the coupled
   * grant `ui.overlay.focus` (no `input.capture` head); without it every call
   * fails `E_CAPABILITY_DENIED`.
   */

  private assertOverlayHandle(handle: unknown): number {
    if (
      typeof handle !== "number" ||
      !Number.isSafeInteger(handle) ||
      handle <= 0
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    return handle;
  }

  private overlaySpecArg(spec: unknown): Record<string, unknown> {
    if (spec === undefined || spec === null) return {};
    if (!isPlainObject(spec)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "overlay spec must be a table with optional title and placeholder",
      );
    }
    const output: Record<string, unknown> = {};
    for (const field of ["title", "placeholder"] as const) {
      const value = (spec as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `overlay spec.${field} must be a string`,
          `spec.${field}`,
        );
      }
      output[field] = value;
    }
    // Unknown spec fields are ignored per the v1 rule; only the decided hints
    // are retained.
    if (
      jsonBytes(output, MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES) >
      MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        `overlay spec exceeds ${MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES} bytes`,
        "spec",
      );
    }
    return output;
  }

  private overlaySceneArg(scene: unknown): Record<string, unknown> {
    if (!isPlainObject(scene)) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        "overlay scene must be a table",
        "scene",
      );
    }
    const problem = componentProblem(scene);
    if (problem !== undefined) {
      fail("validation", HOST_CODES.UI_COMPONENT_INVALID, problem, "scene");
    }
    const counts = countComponentResources(scene);
    if (counts.nodes > MOCK_LIMITS.UI_MAX_NODES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `overlay scene node count exceeds ${MOCK_LIMITS.UI_MAX_NODES}`,
        "scene",
      );
    }
    if (counts.textBytes > MOCK_LIMITS.UI_MAX_TEXT_BYTES) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `overlay scene text exceeds ${MOCK_LIMITS.UI_MAX_TEXT_BYTES} bytes`,
        "scene",
      );
    }
    if (
      jsonBytes(scene, MOCK_LIMITS.UI_MARSHAL_MAX_BYTES) >
      MOCK_LIMITS.UI_MARSHAL_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `overlay scene exceeds ${MOCK_LIMITS.UI_MARSHAL_MAX_BYTES} bytes`,
        "scene",
      );
    }
    if (
      jsonBytes(scene, MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES) >
      MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.UI_COMPONENT_INVALID,
        `overlay scene exceeds the per-update ${MOCK_LIMITS.OVERLAY_CALL_MAX_BYTES}-byte ceiling`,
        "scene",
      );
    }
    return scene as Record<string, unknown>;
  }

  private overlayReleaseReasonArg(reason: unknown): string {
    if (reason === undefined || reason === null) return "released";
    if (typeof reason !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "overlay release reason must be submitted, cancelled, or omitted",
        "reason",
      );
    }
    if (
      reason === "released" ||
      OVERLAY_OWNER_RELEASE_REASONS.includes(reason)
    ) {
      return reason;
    }
    fail(
      "validation",
      HOST_CODES.DEF_INVALID,
      "overlay release reason must be submitted, cancelled, or omitted (defaults to released)",
      "reason",
    );
  }

  private expireOverlayIfIdle(): void {
    const session = this.overlaySession;
    if (session === undefined || session.status !== "active") return;
    if (session.ownerGeneration !== this.generation) return;
    if (
      this.virtualNow - session.lastActivity >=
      MOCK_LIMITS.OVERLAY_IDLE_TIMEOUT_MS
    ) {
      this.terminateOverlayForCause("timeout");
    }
  }

  private terminateOverlayForCause(reason: string): void {
    const session = this.overlaySession;
    if (session === undefined || session.status !== "active") return;
    if (session.ownerGeneration !== this.generation) return;
    if (!OVERLAY_RELEASE_REASONS.includes(reason)) return;
    session.status = "released";
    session.reason = reason;
    if (!this.safeMode) {
      this.deliver("overlay.released", {
        owner: session.ownerPluginId,
        reason,
      });
    }
  }

  private overlayAcquire(spec: unknown): number {
    this.assertAlive();
    this.assertCapability("bitty.ui.overlay.acquire", "ui.overlay.focus");
    if (this.safeMode) {
      fail(
        "runtime",
        HOST_CODES.UI_UNAVAILABLE,
        "bitty.ui.overlay.acquire is unavailable in safe mode",
      );
    }
    this.expireOverlayIfIdle();
    const active = this.overlaySession;
    if (
      active !== undefined &&
      active.status === "active" &&
      active.ownerGeneration === this.generation
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_ALREADY_CAPTURED,
        "an overlay session is already active",
      );
    }
    // A stale released session from a previous generation never blocks a new
    // acquire; it is replaced below. An active session from another generation
    // cannot exist (dispose releases), but guard anyway.
    if (
      active !== undefined &&
      active.status === "active" &&
      active.ownerGeneration !== this.generation
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_ALREADY_CAPTURED,
        "an overlay session is already active",
      );
    }
    const parsed = this.overlaySpecArg(spec);
    const handle = this.nextHandle();
    this.overlaySession = {
      handle,
      ownerPluginId: this.manifest.pluginId,
      ownerGeneration: this.generation,
      spec: deepFreeze(deepCopy(parsed)),
      scene: deepFreeze({ kind: "Text", text: "" }),
      queue: [],
      nextSeq: 1,
      lastDeliveredSeq: 0,
      overflowed: false,
      status: "active",
      reason: undefined,
      lastActivity: this.virtualNow,
    };
    return handle;
  }

  private overlayUpdate(handle: unknown, scene: unknown): boolean {
    this.assertAlive();
    this.assertCapability("bitty.ui.overlay.update", "ui.overlay.focus");
    this.expireOverlayIfIdle();
    const id = this.assertOverlayHandle(handle);
    const session = this.overlaySession;
    if (
      session === undefined ||
      session.ownerGeneration !== this.generation ||
      session.handle !== id ||
      session.status !== "active"
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    const parsed = this.overlaySceneArg(scene);
    session.scene = deepFreeze(deepCopy(parsed));
    session.lastActivity = this.virtualNow;
    return true;
  }

  private overlayPoll(handle: unknown): OverlayPollResult {
    this.assertAlive();
    this.assertCapability("bitty.ui.overlay.poll", "ui.overlay.focus");
    this.expireOverlayIfIdle();
    const id = this.assertOverlayHandle(handle);
    const session = this.overlaySession;
    if (
      session === undefined ||
      session.ownerGeneration !== this.generation ||
      session.handle !== id
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    if (session.status === "active") {
      session.lastActivity = this.virtualNow;
    }
    const drained = session.queue.splice(0, session.queue.length);
    if (drained.length > 0) {
      session.lastDeliveredSeq =
        drained[drained.length - 1]?.seq ?? session.lastDeliveredSeq;
    }
    const result: OverlayPollResult = {
      status: session.status,
      seq: session.lastDeliveredSeq,
      events: deepCopy(drained),
      overflowed: session.overflowed,
      ...(session.status === "released" && session.reason !== undefined
        ? { reason: session.reason }
        : {}),
    };
    return deepFreeze(result) as OverlayPollResult;
  }

  private overlayRelease(handle: unknown, reason: unknown): boolean {
    this.assertAlive();
    this.assertCapability("bitty.ui.overlay.release", "ui.overlay.focus");
    this.expireOverlayIfIdle();
    const wanted = this.overlayReleaseReasonArg(reason);
    // Handle shape is ownership: a non-integer handle is never owned.
    if (
      typeof handle !== "number" ||
      !Number.isSafeInteger(handle) ||
      handle <= 0
    ) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    const session = this.overlaySession;
    if (session === undefined) {
      // Never-held handle within the owning (current) generation succeeds
      // idempotently with no state change and no bus event.
      return true;
    }
    if (session.ownerGeneration !== this.generation) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    if (session.status === "released") {
      // Idempotent: already-released handle succeeds without changing the
      // recorded reason and without re-emitting the bus event. A never-held
      // handle number in the same generation also succeeds here.
      return true;
    }
    if (session.handle !== handle) {
      fail(
        "runtime",
        HOST_CODES.UI_NOT_OWNER,
        "overlay handle is not owned by this plugin generation",
      );
    }
    session.status = "released";
    session.reason = wanted;
    if (!this.safeMode) {
      this.deliver("overlay.released", {
        owner: session.ownerPluginId,
        reason: wanted,
      });
    }
    return true;
  }

  /**
   * Harness-only Core input injection for the overlay queue (not a Lua
   * surface). Routes one input event into the active session without invoking
   * Lua, resetting the idle clock. Drops the oldest event with the sticky
   * `overflowed` flag when the 256-event queue is full; an oversize single
   * event is rejected before enqueue. A call with no active session is a
   * no-op (input flows to the terminal) and returns undefined.
   */
  injectOverlayInput(event: {
    readonly type: string;
    readonly data?: unknown;
  }): number | undefined {
    this.assertAlive();
    const session = this.overlaySession;
    if (
      session === undefined ||
      session.status !== "active" ||
      session.ownerGeneration !== this.generation
    ) {
      return undefined;
    }
    const type = event?.type;
    if (typeof type !== "string" || !OVERLAY_EVENT_TAGS.includes(type)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "overlay input event type must be key, text, pointer, or paste",
      );
    }
    const candidate = {
      type,
      ...(event.data === undefined ? {} : { data: event.data }),
    };
    if (
      jsonBytes(candidate, MOCK_LIMITS.OVERLAY_PAYLOAD_MAX_BYTES) >
      MOCK_LIMITS.OVERLAY_PAYLOAD_MAX_BYTES
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        `overlay input event exceeds ${MOCK_LIMITS.OVERLAY_PAYLOAD_MAX_BYTES} bytes`,
      );
    }
    const seq = session.nextSeq;
    session.nextSeq += 1;
    const stored: OverlayInputEvent = deepFreeze({
      seq,
      type,
      ...(event.data === undefined ? {} : { data: deepCopy(event.data) }),
    }) as OverlayInputEvent;
    if (session.queue.length >= MOCK_LIMITS.OVERLAY_QUEUE_MAX) {
      session.queue.shift();
      session.overflowed = true;
    }
    session.queue.push(stored);
    session.lastActivity = this.virtualNow;
    return seq;
  }

  /**
   * Harness-only focus-switch revoke (not a Lua surface). Ends the active
   * session with `focus_switched` and emits the observation bus event.
   * A call with no active session is a no-op.
   */
  simulateOverlayFocusSwitch(): void {
    this.assertAlive();
    this.expireOverlayIfIdle();
    this.terminateOverlayForCause("focus_switched");
  }

  /**
   * Harness-only crash revoke (not a Lua surface). Ends the active session
   * with `crashed` and emits the observation bus event. A call with no active
   * session is a no-op.
   */
  simulateOverlayCrash(): void {
    this.assertAlive();
    this.expireOverlayIfIdle();
    this.terminateOverlayForCause("crashed");
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
      !isNonnegativeSafeInteger(opts.terminal_id)
    ) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "terminal_id must be a nonnegative safe integer",
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

  /**
   * Submit text to the focused panel PTY through the paste pipeline (W-82,
   * CTX-0068). Order mirrors `Runtime::terminal_submit` at bitty `1df0459e`
   * (all fail-closed, nothing emitted on refusal): focused-view check, then
   * the panel-lease gate, then the byte cap, then the per-plugin budget
   * probe, then delivery. The budget charges framed bytes only after delivery
   * is confirmed live; denials and buffered-only frames leave it untouched.
   */
  private terminalSubmit(text: unknown): SubmitOutcome {
    this.assertAlive();
    this.assertCapability("bitty.terminal.submit", "terminal.input.submit");
    if (typeof text !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "terminal.submit text must be a string",
        "text",
      );
    }
    if (LONE_SURROGATE.test(text)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "terminal.submit text must be valid UTF-8",
        "text",
      );
    }
    if (this.submitDelivery === "none") {
      return deepFreeze({
        status: "unavailable",
        reason: "no-focused-view",
      }) as SubmitOutcome;
    }
    if (!this.submitLeaseGranted) {
      return deepFreeze({
        status: "denied",
        deny: "lease-denied",
      }) as SubmitOutcome;
    }
    const bytes = utf8Bytes(text);
    if (bytes > MOCK_LIMITS.COMPOSER_MAX_BYTES) {
      return deepFreeze({
        status: "denied",
        deny: "too-large",
        wanted: bytes,
      }) as SubmitOutcome;
    }
    const framed = bytes + MOCK_LIMITS.SUBMIT_FRAME_OVERHEAD_BYTES;
    const wanted = this.submitUsed + framed;
    if (wanted > this.submitBudgetBytes) {
      return deepFreeze({
        status: "denied",
        deny: "budget-exceeded",
        used: this.submitUsed,
        cap: this.submitBudgetBytes,
      }) as SubmitOutcome;
    }
    if (this.submitDelivery === "buffered") {
      return deepFreeze({
        status: "unavailable",
        reason: "buffered-only",
      }) as SubmitOutcome;
    }
    this.submitUsed = wanted;
    this.submittedFrames.push(
      Buffer.concat([
        // Byte-exact bracketed-paste frame: ESC[200~ + content + ESC[201~ + CR.
        Buffer.from("\u001b[200~", "utf8"),
        Buffer.from(text, "utf8"),
        Buffer.from("\u001b[201~", "utf8"),
        Buffer.from("\r", "utf8"),
      ]),
    );
    return deepFreeze({
      status: "accepted",
      bytes: framed,
    }) as SubmitOutcome;
  }

  /**
   * Run one allowlisted external-editor round trip (W-82, CTX-0068). Mirrors
   * `process_editor_start` at bitty `1df0459e`: resolve and allowlist
   * `$VISUAL`/`$EDITOR` first (a hostile value is denied before any temp
   * file exists), then create the `0600` temp file, resolve the harness-seeded
   * child result, read back bounded UTF-8, and remove the temp file on every
   * path. The outcome never carries the temp path. The mock performs no I/O
   * and spawns no process: wall-clock waiting, tree kill, and crash-restart
   * sweep stay Core-owned and out of mock scope.
   */
  private processEditorStart(opts: unknown): EditorOutcome {
    this.assertAlive();
    this.assertCapability("bitty.process.editor.start", "process.editor");
    let table: Record<string, unknown> = {};
    if (opts !== undefined && opts !== null) {
      if (!isPlainObject(opts)) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "process.editor.start opts must be a table",
          "opts",
        );
      }
      table = opts as Record<string, unknown>;
    }
    // Unknown opts fields are ignored per the v1 rule.
    const draft = table.draft ?? "";
    if (typeof draft !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "process.editor.start draft must be a string",
        "opts.draft",
      );
    }
    if (LONE_SURROGATE.test(draft as string)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "process.editor.start draft must be valid UTF-8",
        "opts.draft",
      );
    }
    let timeoutMs: number = MOCK_LIMITS.EDITOR_TIMEOUT_DEFAULT_MS;
    if (table.timeout_ms !== undefined) {
      if (
        !Number.isSafeInteger(table.timeout_ms) ||
        (table.timeout_ms as number) < 1
      ) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "process.editor.start timeout_ms must be a positive integer",
          "opts.timeout_ms",
        );
      }
      timeoutMs = Math.min(
        table.timeout_ms as number,
        MOCK_LIMITS.EDITOR_TIMEOUT_MAX_MS,
      );
    }
    this.lastEditorTimeoutMsValue = timeoutMs;
    const program = this.resolveEditorProgram();
    if (program === undefined) {
      return deepFreeze({
        status: "denied",
        deny: "no-editor",
      }) as EditorOutcome;
    }
    if (program === null) {
      return deepFreeze({
        status: "denied",
        deny: "not-allowed",
      }) as EditorOutcome;
    }
    if (utf8Bytes(draft as string) > MOCK_LIMITS.COMPOSER_MAX_BYTES) {
      // The Core write fails past the cap and the file is removed: model the
      // create/remove pair with no content retained.
      this.editorTempsCreatedCount += 1;
      this.editorTempsRemovedCount += 1;
      return deepFreeze({
        status: "unavailable",
        reason: "too-large",
      }) as EditorOutcome;
    }
    this.editorTempsCreatedCount += 1;
    const seed = this.editorSeed ?? { kind: "cancelled" as const };
    const finish = (outcome: EditorOutcome): EditorOutcome => {
      this.editorTempsRemovedCount += 1;
      return deepFreeze(outcome) as EditorOutcome;
    };
    switch (seed.kind) {
      case "edited": {
        const content = seed.content;
        if (LONE_SURROGATE.test(content)) {
          return finish({ status: "unavailable", reason: "invalid-utf8" });
        }
        if (utf8Bytes(content) > MOCK_LIMITS.COMPOSER_MAX_BYTES) {
          return finish({ status: "unavailable", reason: "too-large" });
        }
        return finish({ status: "edited", content });
      }
      case "cancelled":
        return finish({ status: "cancelled" });
      case "timeout":
        return finish({ status: "timeout" });
      case "spawn-failed": {
        const detail =
          seed.detail === undefined || seed.detail === ""
            ? "spawn failed"
            : seed.detail;
        return finish({
          status: "spawn-failed",
          detail: truncateBytes(
            detail,
            MOCK_LIMITS.EDITOR_SPAWN_DETAIL_MAX_BYTES,
          ),
        });
      }
      case "non-zero":
        return finish(
          seed.code === undefined || seed.code === null
            ? { status: "non-zero" }
            : { status: "non-zero", code: seed.code },
        );
      case "unavailable":
        return finish({
          status: "unavailable",
          reason: seed.reason ?? "temp-unavailable",
        });
    }
  }

  /**
   * Resolve the editor program from the host environment snapshot (W-82,
   * CTX-0068). Mirrors `resolve_editor` at bitty `1df0459e`: `$VISUAL`,
   * then `$EDITOR`; the first non-empty trimmed value wins and is matched
   * exactly against the bare-name allowlist with no fallback to the other
   * variable. Resolution reads the host snapshot directly (like the Core
   * process environment); `env.read` grants are irrelevant. Returns the
   * program, `null` for a hostile value, or `undefined` when neither variable
   * names an editor.
   */
  private resolveEditorProgram(): string | null | undefined {
    for (const key of ["VISUAL", "EDITOR"] as const) {
      const raw = this.environment[key];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      if (!EDITOR_ALLOWLIST.includes(trimmed)) return null;
      return trimmed;
    }
    return undefined;
  }

  private servicesProvide(
    iface: string,
    impl: Record<string, ServiceMethod>,
  ): number {
    this.assertNamespaceWired("services", "bitty.services.provide");
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
    this.assertNamespaceWired("services", "bitty.services.get");
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

  /** Whether a capability is both declared and granted (no implication). */
  private hasCapability(capability: string): boolean {
    return (
      this.manifest.capabilities.includes(capability) &&
      this.grants.has(capability)
    );
  }

  /** Fail closed for one host entry point that is still deferred. */
  private assertFunctionWired(path: string): void {
    if (DEFERRED_FUNCTIONS.has(path)) {
      fail(
        "runtime",
        HOST_CODES.NOT_IMPLEMENTED,
        `bitty.${path} is not implemented by this host`,
      );
    }
  }

  private workspaceList(): WorkspaceInfo[] {
    this.assertAlive();
    this.assertCapability("bitty.workspace.list", "workspace.read");
    return deepCopy(this.workspaceRows);
  }

  private workspaceFocusArg(target: unknown): WorkspaceRequest {
    if (isPlainObject(target)) {
      // The host reads only `index` from a table target.
      const index = target.index;
      if (!isPositiveLuaInteger(index)) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "workspace.focus { index = n } needs a positive integer index",
        );
      }
      return { kind: "focus_index", index };
    }
    return {
      kind: "focus_id",
      id: workspaceIdArg(target, "workspace.focus target"),
    };
  }

  /**
   * Shared `workspace.control` mutation path: the bridge validates argument
   * shapes first, then the host checks the grant and enqueues into the bounded
   * queue. Returns whether the request was queued, never whether it applied.
   */
  private workspaceRequest(parse: () => WorkspaceRequest): boolean {
    this.assertAlive();
    const request = parse();
    this.assertCapability("bitty.workspace", "workspace.control");
    if (
      this.workspaceQueue.length >= MOCK_LIMITS.WORKSPACE_REQUEST_QUEUE_CAPACITY
    ) {
      this.droppedWorkspaceRequests += 1;
      return false;
    }
    this.workspaceQueue.push(deepFreeze({ ...request }));
    return true;
  }

  private debugInspect(target: unknown): DebugInspectResult {
    this.assertAlive();
    if (typeof target !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.inspect target must be a string",
      );
    }
    this.assertCapability("bitty.debug.inspect", "debug.inspect");
    const compare = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0;
    const pluginId = this.manifest.pluginId;
    let items: unknown[];
    switch (target) {
      case "plugins":
        items = [
          {
            id: pluginId,
            version: this.manifest.version,
            state: DEBUG_STATE_LABEL[this.state],
            generation: this.generation,
          },
        ];
        break;
      case "commands":
        items = [...this.commands.values()]
          .filter((record) => record.generation === this.generation)
          .map((record) => ({
            plugin: pluginId,
            id: record.def.id,
            title: record.def.title,
          }))
          .sort(
            (left, right) =>
              compare(left.id, right.id) || compare(left.title, right.title),
          );
        break;
      case "events":
        items = this.subscriptions
          .filter((entry) => entry.generation === this.generation)
          .map((entry) => ({ plugin: pluginId, kind: entry.kind }))
          .sort((left, right) => compare(left.kind, right.kind));
        break;
      case "grants":
        items = this.manifest.capabilities
          .filter((capability) => this.grants.has(capability))
          .sort(compare);
        break;
      case "panels":
        fail(
          "runtime",
          HOST_CODES.NOT_IMPLEMENTED,
          "bitty.debug.inspect panels is not implemented by this host",
        );
      default:
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "debug.inspect target must be one of plugins, commands, events, grants, panels",
        );
    }
    const truncated = items.length > MOCK_LIMITS.DEBUG_INSPECT_MAX_ITEMS;
    return {
      target,
      items: items.slice(0, MOCK_LIMITS.DEBUG_INSPECT_MAX_ITEMS),
      truncated,
    };
  }

  private debugTrace(opts: unknown): number {
    this.assertAlive();
    if (opts !== undefined && opts !== null && !isPlainObject(opts)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.trace opts must be a table or nil",
      );
    }
    if (opts !== undefined && opts !== null) {
      const problem = bridgeValueProblem(opts, "opts");
      if (problem !== undefined) {
        fail("validation", HOST_CODES.DEF_INVALID, problem);
      }
    }
    this.assertCapability("bitty.debug.trace", "debug.trace");
    let enabled = true;
    let filter: TraceFilter = { kind: "all" };
    let filterSet = false;
    let maxEvents: number | undefined;
    let handle: number | undefined;
    for (const [key, value] of Object.entries(opts ?? {})) {
      if (!DEBUG_TRACE_OPTION_KEYS.has(key)) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `debug.trace opts.${key} is not supported`,
        );
      }
      const wrongType = (): never =>
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          `debug.trace opts.${key} has the wrong type`,
        );
      if (key === "enabled") {
        if (typeof value !== "boolean") wrongType();
        enabled = value as boolean;
      } else if (key === "filter") {
        if (typeof value !== "string") wrongType();
        filter = parseTraceFilter(value as string);
        filterSet = true;
      } else if (key === "max_events") {
        if (!isLuaInteger(value)) wrongType();
        const count = value as number;
        if (
          count < MOCK_LIMITS.DEBUG_TRACE_MIN_EVENTS ||
          count > MOCK_LIMITS.DEBUG_TRACE_MAX_EVENTS
        ) {
          fail(
            "validation",
            HOST_CODES.DEF_INVALID,
            `debug.trace max_events must be ${MOCK_LIMITS.DEBUG_TRACE_MIN_EVENTS}..=${MOCK_LIMITS.DEBUG_TRACE_MAX_EVENTS}`,
          );
        }
        maxEvents = count;
      } else {
        if (!isLuaInteger(value)) wrongType();
        handle = value as number;
      }
    }
    if (!enabled) {
      if (filterSet || maxEvents !== undefined) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "debug.trace opts.filter/max_events are invalid with enabled = false",
        );
      }
      if (handle === undefined) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "debug.trace enabled = false requires opts.handle",
        );
      }
      // Unknown and foreign handles are indistinguishable.
      const trace = this.traces.get(handle);
      if (trace === undefined || trace.generation !== this.generation) {
        fail(
          "validation",
          HOST_CODES.DEF_INVALID,
          "debug.trace handle is not an open trace of this plugin",
        );
      }
      this.traces.delete(handle);
      return handle;
    }
    if (handle !== undefined) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.trace opts.handle is only valid with enabled = false",
      );
    }
    if (this.traces.size >= MOCK_LIMITS.DEBUG_TRACES_PER_PLUGIN) {
      fail(
        "budget",
        HOST_CODES.DEF_LIMIT,
        `debug.trace limit (${MOCK_LIMITS.DEBUG_TRACES_PER_PLUGIN} per plugin) exceeded`,
      );
    }
    this.traceHandleSequence += 1;
    const traceHandle = this.traceHandleSequence;
    this.traces.set(traceHandle, {
      generation: this.generation,
      declared: new Set(this.manifest.events),
      granted: new Set(
        this.manifest.capabilities.filter((capability) =>
          this.grants.has(capability),
        ),
      ),
      filter,
      maxEvents: maxEvents ?? MOCK_LIMITS.DEBUG_TRACE_DEFAULT_MAX_EVENTS,
      records: [],
      bytes: 0,
      dropped: 0,
    });
    return traceHandle;
  }

  private debugTraceGet(handle: unknown): DebugTraceDrain | null {
    this.assertAlive();
    if (!isLuaInteger(handle)) {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.trace_get handle must be an integer",
      );
    }
    this.assertCapability("bitty.debug.trace_get", "debug.trace");
    const trace = this.traces.get(handle);
    if (trace === undefined || trace.generation !== this.generation) {
      return null;
    }
    const records = trace.records.map(({ bytes: _bytes, ...record }) =>
      deepFreeze(deepCopy(record)),
    );
    const dropped = trace.dropped;
    trace.records = [];
    trace.bytes = 0;
    trace.dropped = 0;
    return { records, dropped };
  }

  private debugControl(action: unknown, target: unknown): unknown {
    this.assertAlive();
    if (typeof action !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.control action must be a string",
      );
    }
    if (typeof target !== "string") {
      fail(
        "validation",
        HOST_CODES.DEF_INVALID,
        "debug.control target must be a string",
      );
    }
    // The host fails closed before reading the grant or the target.
    this.assertFunctionWired("debug.control");
    this.assertCapability("bitty.debug.control", "debug.control");
    fail(
      "runtime",
      HOST_CODES.NOT_IMPLEMENTED,
      "bitty.debug.control is not implemented by this host",
    );
  }

  /**
   * Record one published event into every open trace whose snapshot of the
   * manifest `[lazy].events` declares it and whose filter matches, while the
   * generation is active (bitty `TraceHub::record`). Payloads are redacted for
   * the owner's grant snapshot (`intercept.paste` keeps only action/origin
   * without `clipboard.read`), then bounded by the trace payload ceiling.
   */
  private recordTrace(
    kind: string,
    sequence: number,
    payload: Record<string, unknown>,
  ): void {
    if (this.traces.size === 0 || this.state !== "active") return;
    for (const trace of this.traces.values()) {
      if (trace.generation !== this.generation) continue;
      if (!trace.declared.has(kind)) continue;
      // Workspace kinds stay gated on the live workspace.read grant, so a
      // revoked grant stops trace observation exactly like delivery.
      if (
        kind.startsWith(WORKSPACE_EVENT_PREFIX) &&
        !this.hasCapability("workspace.read")
      ) {
        continue;
      }
      if (!traceFilterMatches(trace.filter, kind)) continue;
      let view: Record<string, unknown> = payload;
      if (kind === "intercept.paste" && !trace.granted.has("clipboard.read")) {
        view = { redacted: true };
        for (const field of ["action", "origin"]) {
          if (field in payload) view[field] = payload[field];
        }
      }
      const encoded = utf8Bytes(JSON.stringify(view));
      let bounded: Record<string, unknown> = deepCopy(view);
      let payloadBytes = encoded;
      if (encoded > MOCK_LIMITS.DEBUG_TRACE_PAYLOAD_MAX_BYTES) {
        bounded = { truncated: true, bytes: encoded };
        payloadBytes = utf8Bytes(JSON.stringify(bounded));
      }
      const bytes = utf8Bytes(kind) + payloadBytes;
      while (
        trace.records.length > 0 &&
        (trace.records.length >= trace.maxEvents ||
          trace.bytes + bytes > MOCK_LIMITS.DEBUG_TRACE_BUFFER_MAX_BYTES)
      ) {
        const old = trace.records.shift();
        if (old !== undefined) trace.bytes -= old.bytes;
        trace.dropped += 1;
      }
      trace.bytes += bytes;
      trace.records.push({
        topic: kind,
        sequence,
        timestamp: this.virtualNow,
        payload: bounded,
        bytes,
      });
    }
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
    // Workspace events reach only `workspace.read` holders (bitty CTX-0889).
    if (
      kind.startsWith(WORKSPACE_EVENT_PREFIX) &&
      !this.hasCapability("workspace.read")
    ) {
      return { delivered, vetoed };
    }
    for (const subscription of [...this.subscriptions]) {
      if (subscription.kind !== kind) continue;
      if (subscription.generation !== this.generation) continue;
      if (this.state === "disposed") continue;
      if (
        !lifecycle &&
        (this.state === "suspended" || this.state === "disposing")
      )
        continue;
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
