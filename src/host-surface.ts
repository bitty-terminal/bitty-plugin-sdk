/**
 * Accepted Plugin API v1 surface table for the mock host (R-SDK-3).
 *
 * Contract sources: ADR 0009 (LUA-OQ-1..12) and the accepted Plugin API v1 Lua
 * Surface RFC. This module is the single place the mock host reads identifiers
 * and bounds from; it may not add or rename a v1 identifier. R-SDK-1
 * (`lua/bitty.d.lua`, `surface/bitty-plugin-api-v1.json`) is the Lua-facing
 * projection of the same accepted contract.
 */

/** Host bridge line reported through `bitty.api_version`. */
export const PLUGIN_API_VERSION = "1.0.0";

/** Event pipeline classes accepted for v1. */
export type EventClass = "lifecycle" | "observation" | "interception";

/** One entry of the closed v1 event set. */
export interface EventKindSpec {
  readonly kind: string;
  readonly class: EventClass;
  readonly coalescable: boolean;
}

/** The closed v1 event set, exactly `EventKind` in `bitty-plugin-host`. */
export const EVENT_KINDS: readonly EventKindSpec[] = [
  { kind: "plugin.activated", class: "lifecycle", coalescable: false },
  { kind: "plugin.suspended", class: "lifecycle", coalescable: false },
  { kind: "plugin.disposed", class: "lifecycle", coalescable: false },
  { kind: "handler.violation", class: "lifecycle", coalescable: false },
  { kind: "terminal.opened", class: "observation", coalescable: false },
  { kind: "terminal.closed", class: "observation", coalescable: false },
  { kind: "terminal.title-changed", class: "observation", coalescable: true },
  { kind: "terminal.cwd-changed", class: "observation", coalescable: true },
  { kind: "terminal.bell", class: "observation", coalescable: false },
  { kind: "focus.changed", class: "observation", coalescable: true },
  { kind: "selection.changed", class: "observation", coalescable: true },
  { kind: "process.exited", class: "observation", coalescable: false },
  { kind: "config.reloaded", class: "observation", coalescable: false },
  {
    kind: "intercept.command-dispatch",
    class: "interception",
    coalescable: false,
  },
  {
    kind: "intercept.terminal-spawn",
    class: "interception",
    coalescable: false,
  },
  { kind: "intercept.paste", class: "interception", coalescable: false },
  { kind: "intercept.open-url", class: "interception", coalescable: false },
];

/**
 * Closed event-kind name set, derived from {@link EVENT_KINDS} so callers that
 * only need membership (the manifest `[lazy].events` check) share one source
 * with the mock host and can never copy a stale list.
 */
export const EVENT_KIND_SET: ReadonlySet<string> = new Set(
  EVENT_KINDS.map((entry) => entry.kind),
);

/** Lifecycle kinds delivered to the owning plugin only. */
export const LIFECYCLE_KINDS: ReadonlySet<string> = new Set(
  EVENT_KINDS.filter((entry) => entry.class === "lifecycle").map(
    (entry) => entry.kind,
  ),
);

/** Observation kinds whose handler return values are ignored. */
export const OBSERVATION_KINDS: ReadonlySet<string> = new Set(
  EVENT_KINDS.filter((entry) => entry.class === "observation").map(
    (entry) => entry.kind,
  ),
);

/** Interception kinds whose handlers return `false` to veto. */
export const INTERCEPTION_KINDS: ReadonlySet<string> = new Set(
  EVENT_KINDS.filter((entry) => entry.class === "interception").map(
    (entry) => entry.kind,
  ),
);

/** Capability gate per capability-gated surface element. */
export interface CapabilityGate {
  readonly surface: string;
  readonly capability: string;
}

/** Accepted capability mapping from the extension-level split table. */
export const CAPABILITY_GATED_SURFACE: readonly CapabilityGate[] = [
  { surface: "bitty.notify.show", capability: "platform.notify" },
  { surface: "bitty.ui.mount", capability: "ui.rich" },
  { surface: "bitty.ui.update", capability: "ui.rich" },
  { surface: "bitty.ui.mount:overlay", capability: "ui.overlay" },
  { surface: "bitty.terminal.snapshot", capability: "terminal.semantic-read" },
  { surface: "bitty.env.get", capability: "env:<KEY>" },
  { surface: "bitty.env.has", capability: "env:<KEY>" },
];

/**
 * Modeled function paths, matching `surface/bitty-plugin-api-v1.json`
 * (R-SDK-1) after its `bitty.` module prefix.
 */
export const V1_SURFACE_FUNCTIONS: readonly string[] = [
  "commands.register",
  "events.subscribe",
  "keymaps.suggest",
  "settings.get",
  "settings.set",
  "store.get",
  "store.set",
  "notify.show",
  "env.get",
  "env.has",
  "services.get",
  "services.provide",
  "ui.mount",
  "ui.update",
  "terminal.snapshot",
  "tasks.spawn",
  "tasks.cancel",
  "timers.create",
  "timers.cancel",
];

/** The only snapshot scope accepted in v1 (`scope = "raw"` is excluded). */
export const SNAPSHOT_SCOPE_ONLY = "semantic";

/** The `bitty.env` capability family prefix (ADR 0006). */
export const ENV_CAPABILITY_PREFIX = "env:";

/** Closed set of accepted UI slots. */
export const UI_SLOTS: readonly string[] = [
  "terminal",
  "top",
  "bottom",
  "left",
  "right",
  "tabline",
  "statusline",
  "overlay",
];

/** v1 declarative node kinds. */
export const UI_V1_NODE_KINDS: readonly string[] = [
  "Text",
  "Row",
  "Column",
  "List",
];

/** SceneNode variants excluded from v1. */
export const UI_V1_EXCLUDED_NODE_KINDS: readonly string[] = [
  "Block",
  "Image",
  "CodeBlock",
  "Table",
  "Rule",
];

/** Pipeline payload bound (`EVENT_MAX_BYTES`, reference host). */
export const EVENT_MAX_BYTES = 8 * 1024;

/** Environment value bound from ADR 0006 (4 KiB). */
export const ENV_MAX_VALUE_BYTES = 4096;

/** Numeric bounds shared by the mock host. */
export const MOCK_LIMITS = {
  TASKS_MAX: 64,
  TIMERS_MAX: 32,
  STORE_QUOTA_BYTES: 256 * 1024,
  STORE_MAX_VALUE_BYTES: 8 * 1024,
  STORE_MAX_DEPTH: 8,
  STORE_MAX_NODES: 1024,
  STORE_KEY_MAX_BYTES: 128,
  SNAPSHOT_MAX_BYTES: 256 * 1024,
  COMMAND_SCHEMA_MAX_BYTES: 16 * 1024,
  COMMAND_SCHEMA_MAX_DEPTH: 16,
  COMMAND_ID_MAX_BYTES: 64,
  UI_MAX_DEPTH: 16,
  TIMER_MAX_DELAY_MS: 24 * 60 * 60 * 1000,
} as const;

/** Command id grammar from the accepted surface. */
export const COMMAND_ID_PATTERN = "^[a-z][a-z0-9-]{0,63}$";

/** Store key grammar from the accepted surface. */
export const STORE_KEY_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";

/** Env key grammar from ADR 0006. */
export const ENV_KEY_PATTERN = "^[A-Z_][A-Z0-9_]*$";

/** Required identity/payload fields per event kind (types checked at emit). */
export const EVENT_PAYLOAD_FIELDS: Readonly<
  Record<string, ReadonlyArray<{ name: string; type: "string" | "integer" }>>
> = {
  "terminal.opened": [
    { name: "terminal_id", type: "integer" },
    { name: "runtime_id", type: "integer" },
    { name: "generation", type: "integer" },
  ],
  "terminal.closed": [
    { name: "terminal_id", type: "integer" },
    { name: "runtime_id", type: "integer" },
    { name: "reason", type: "string" },
  ],
  "terminal.title-changed": [
    { name: "title", type: "string" },
    { name: "terminal_id", type: "integer" },
    { name: "runtime_id", type: "integer" },
  ],
  "terminal.cwd-changed": [
    { name: "cwd", type: "string" },
    { name: "terminal_id", type: "integer" },
    { name: "runtime_id", type: "integer" },
  ],
  "focus.changed": [{ name: "view_id", type: "integer" }],
  "selection.changed": [{ name: "view_id", type: "integer" }],
  "process.exited": [
    { name: "terminal_id", type: "integer" },
    { name: "runtime_id", type: "integer" },
    { name: "exit_code", type: "integer" },
  ],
  "intercept.command-dispatch": [
    { name: "action", type: "string" },
    { name: "origin", type: "string" },
    { name: "preview", type: "string" },
  ],
  "intercept.terminal-spawn": [
    { name: "action", type: "string" },
    { name: "origin", type: "string" },
    { name: "preview", type: "string" },
  ],
  "intercept.paste": [
    { name: "action", type: "string" },
    { name: "origin", type: "string" },
    { name: "preview", type: "string" },
  ],
  "intercept.open-url": [
    { name: "action", type: "string" },
    { name: "origin", type: "string" },
    { name: "preview", type: "string" },
  ],
};

/** Look up one event kind specification. */
export function eventKindSpec(kind: string): EventKindSpec | undefined {
  return EVENT_KINDS.find((entry) => entry.kind === kind);
}
