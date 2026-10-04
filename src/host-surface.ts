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
  // CTX-0889 (ADR-0014): workspace observation events, delivered only to
  // `workspace.read` holders and coalesced per host tick by the diff tracker.
  { kind: "workspace.created", class: "observation", coalescable: false },
  { kind: "workspace.closed", class: "observation", coalescable: false },
  { kind: "workspace.renamed", class: "observation", coalescable: false },
  { kind: "workspace.focused", class: "observation", coalescable: false },
  { kind: "workspace.changed", class: "observation", coalescable: false },
  // CTX-0065 (W-01 accepted): focusable-overlay lifecycle observation. Any
  // subscriber may observe it; no phase may intercept or veto it.
  { kind: "overlay.released", class: "observation", coalescable: false },
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
  { surface: "bitty.ui.overlay.acquire", capability: "ui.overlay.focus" },
  { surface: "bitty.ui.overlay.update", capability: "ui.overlay.focus" },
  { surface: "bitty.ui.overlay.poll", capability: "ui.overlay.focus" },
  { surface: "bitty.ui.overlay.release", capability: "ui.overlay.focus" },
  { surface: "bitty.terminal.snapshot", capability: "terminal.semantic-read" },
  // CTX-0068 (W-82 accepted): composer submit path through the paste
  // pipeline, gated by the additive v2 capability terminal.input.submit.
  { surface: "bitty.terminal.submit", capability: "terminal.input.submit" },
  // CTX-0068 (W-82 accepted): allowlisted external-editor round trip, gated
  // by the additive v2 capability process.editor; the temp file never leaves
  // Core and grants no general fs.write authority.
  { surface: "bitty.process.editor.start", capability: "process.editor" },
  { surface: "bitty.env.get", capability: "env.read:<KEY>" },
  { surface: "bitty.env.has", capability: "env.read:<KEY>" },
  { surface: "bitty.debug.inspect", capability: "debug.inspect" },
  { surface: "bitty.debug.trace", capability: "debug.trace" },
  { surface: "bitty.debug.trace_get", capability: "debug.trace" },
  { surface: "bitty.debug.control", capability: "debug.control" },
  { surface: "bitty.workspace.list", capability: "workspace.read" },
  { surface: "bitty.workspace.focus", capability: "workspace.control" },
  { surface: "bitty.workspace.new", capability: "workspace.control" },
  { surface: "bitty.workspace.next", capability: "workspace.control" },
  { surface: "bitty.workspace.close", capability: "workspace.control" },
  { surface: "bitty.workspace.rename", capability: "workspace.control" },
  { surface: "bitty.workspace.move_panel", capability: "workspace.control" },
];

/** Event-kind prefix of the workspace domain; receipt requires `workspace.read`. */
export const WORKSPACE_EVENT_PREFIX = "workspace.";

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
  "ui.overlay.acquire",
  "ui.overlay.update",
  "ui.overlay.poll",
  "ui.overlay.release",
  "terminal.snapshot",
  "terminal.submit",
  "tasks.spawn",
  "tasks.cancel",
  "timers.create",
  "timers.cancel",
  "debug.inspect",
  "debug.trace",
  "debug.trace_get",
  "debug.control",
  "workspace.list",
  "workspace.focus",
  "workspace.new",
  "workspace.next",
  "workspace.close",
  "workspace.rename",
  "workspace.move_panel",
  "process.editor.start",
];

/** The only snapshot scope accepted in v1 (`scope = "raw"` is excluded). */
export const SNAPSHOT_SCOPE_ONLY = "semantic";

/** The `bitty.env` capability family prefix (accepted manifest spec, section 1). */
export const ENV_CAPABILITY_PREFIX = "env.read:";

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

/**
 * Slots that are exclusive claims and therefore require a matching
 * `[lazy].claims` declaration before mounting.
 *
 * `surface/bitty-plugin-api-v1.json` (`BittyUiSlot`) states that `tabline` is
 * an exclusive claim while status components compose and overlay is
 * non-focusable presentation content. The accepted corpus does not yet name a
 * separate claim grammar, so a claim is matched to its slot by the identical
 * accepted slot name.
 */
export const EXCLUSIVE_CLAIM_SLOTS: readonly string[] = ["tabline"];

/**
 * Accepted v1 slots the host has no surface for, each with the host's reason
 * wording.
 *
 * Mirrors bitty `bitty_runtime::runtime::band_slots::ui_slot_placement`
 * (CTX-0923, bitty #1609): `ui.mount` fails closed on these slots with the
 * existing v1 code `E_UI_UNAVAILABLE` (class `runtime`), after the capability
 * (`ui.rich` / `ui.overlay`) and `tabline` exclusive-claim gates, so a granted
 * `overlay` or a claimed `tabline` still fails. The message is
 * `UI slot '<slot>' <reason>`.
 */
export const UI_UNAVAILABLE_SLOT_REASONS: Readonly<Record<string, string>> =
  Object.freeze({
    tabline: "is reserved for panel tabs (PW-10) and has no host surface yet",
    overlay: "has no plugin overlay host in this build yet",
    terminal: "has no terminal-attached block host in this build yet",
  });

/** Accepted v1 slots `ui.mount` rejects with `E_UI_UNAVAILABLE`. */
export const UI_UNAVAILABLE_SLOTS: readonly string[] = Object.freeze(
  Object.keys(UI_UNAVAILABLE_SLOT_REASONS),
);

/** Accepted v1 slots the host presents (`ui.mount` can succeed). */
export const UI_HOSTED_SLOTS: readonly string[] = Object.freeze(
  UI_SLOTS.filter((slot) => !UI_UNAVAILABLE_SLOTS.includes(slot)),
);

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
  // UI node/text/block budgets mirror `bitty-lua` `ui.rs` (`UI_MAX_NODES`,
  // `UI_MAX_TEXT_BYTES`, `UI_MAX_BLOCKS`, `UI_MAX_AGGREGATED_TEXT_BYTES`).
  // Node and text bounds are per mounted component (`SCN-1`/`SCN-3`); block
  // and aggregated-text bounds are per plugin generation (`SCN-5`/`SCN-4`).
  UI_MAX_NODES: 2048,
  UI_MAX_TEXT_BYTES: 256 * 1024,
  UI_MAX_BLOCKS: 64,
  UI_MAX_AGGREGATED_TEXT_BYTES: 2 * 1024 * 1024,
  // Marshalling byte ceiling for one raw component value before shape
  // validation, mirroring `bitty-lua` `ui.rs` `UI_MARSHAL_LIMITS.max_bytes`
  // (`UI_MAX_TEXT_BYTES + 64 KiB`). The semantic node/text budgets above are
  // the exact `SCN-1`/`SCN-3` numbers the host enforces on the parsed node.
  UI_MARSHAL_MAX_BYTES: 256 * 1024 + 64 * 1024,
  TIMER_MAX_DELAY_MS: 24 * 60 * 60 * 1000,
  CHORD_MAX_BYTES: 64,
  // Command metadata byte ceilings mirror `bitty-lua` `host.rs`
  // (`REGISTRATION_MAX_TITLE_BYTES`/`REGISTRATION_MAX_DESCRIPTION_BYTES`).
  COMMAND_TITLE_MAX_BYTES: 128,
  COMMAND_DESCRIPTION_MAX_BYTES: 1024,
  // Accepted signed `exit_code` range: `bitty-runtime` `registry.rs`
  // (`TerminalExited` `exited: Option<Option<i32>>`), so the status value is a
  // signed 32-bit integer.
  EXIT_CODE_MIN: -2147483648,
  EXIT_CODE_MAX: 2147483647,
  // Bridge marshalling bounds mirror `bitty-lua` `host.rs`
  // (`DEFAULT_MAX_DEPTH`/`DEFAULT_MAX_NODES`/`DEFAULT_MAX_VALUE_BYTES`).
  BRIDGE_MAX_DEPTH: 8,
  BRIDGE_MAX_NODES: 1024,
  BRIDGE_MAX_VALUE_BYTES: 8 * 1024,
  // Workspace domain bounds mirror `bitty-lua` `host.rs` (CTX-0889):
  // `WORKSPACE_LIST_MAX_ITEMS` (= Core `MAX_WORKSPACES`),
  // `WORKSPACE_NAME_MAX_CHARS`, `WORKSPACE_RENAME_MAX_BYTES`, and the
  // runtime-shared `WORKSPACE_REQUEST_QUEUE_CAPACITY` (2 x list bound).
  WORKSPACE_LIST_MAX_ITEMS: 16,
  WORKSPACE_NAME_MAX_CHARS: 32,
  WORKSPACE_RENAME_MAX_BYTES: 256,
  WORKSPACE_REQUEST_QUEUE_CAPACITY: 32,
  // Debug backend bounds mirror `bitty-runtime` `plugin_runtime/debug.rs`
  // (CTX-0897).
  DEBUG_INSPECT_MAX_ITEMS: 1024,
  DEBUG_TRACE_DEFAULT_MAX_EVENTS: 1000,
  DEBUG_TRACE_MIN_EVENTS: 1,
  DEBUG_TRACE_MAX_EVENTS: 10_000,
  DEBUG_TRACES_PER_PLUGIN: 4,
  DEBUG_TRACE_PAYLOAD_MAX_BYTES: 4096,
  DEBUG_TRACE_FILTER_MAX_BYTES: 128,
  DEBUG_TRACE_BUFFER_MAX_BYTES: 1024 * 1024,
  // W-01 overlay bounds (CTX-0065, accepted): 256-event queue depth,
  // 4096-byte per-event and per-call ceilings, 30s idle timeout, single
  // global owner. Scene content reuses the v1 UI node/text/marshal budgets.
  OVERLAY_QUEUE_MAX: 256,
  OVERLAY_PAYLOAD_MAX_BYTES: 4096,
  OVERLAY_CALL_MAX_BYTES: 4096,
  OVERLAY_IDLE_TIMEOUT_MS: 30_000,
  // W-82 composer bounds (CTX-0068, accepted): 64 KiB edit-buffer and temp
  // cap (`COMPOSER_MAX_BYTES`), 13-byte bracketed-paste framing overhead
  // (`ESC[200~` + content + `ESC[201~` + `CR`), 120 s default / 300 s ceiling
  // editor wait. The submit byte-window cap is caller-supplied per DEC-W103-4
  // (Isolation/Resource lane owns the numeric policy); the mock default below
  // is a harness convenience, never a contract value.
  COMPOSER_MAX_BYTES: 64 * 1024,
  SUBMIT_FRAME_OVERHEAD_BYTES: 13,
  SUBMIT_BUDGET_DEFAULT_BYTES: 1024 * 1024,
  EDITOR_TIMEOUT_DEFAULT_MS: 120_000,
  EDITOR_TIMEOUT_MAX_MS: 300_000,
  EDITOR_SPAWN_DETAIL_MAX_BYTES: 512,
} as const;

/** Closed editor program allowlist (W-82, CTX-0068): bare names only, exact match. */
export const EDITOR_ALLOWLIST: readonly string[] = ["nvim", "vim", "vi"];

/** terminal.submit outcome tags (W-82, CTX-0068); mirrors TerminalSubmitOutcome. */
export const SUBMIT_OUTCOME_STATUSES: readonly string[] = [
  "accepted",
  "denied",
  "unavailable",
];

/** terminal.submit denial details (W-82, CTX-0068); mirrors SubmitDeny. */
export const SUBMIT_DENY_KINDS: readonly string[] = [
  "too-large",
  "lease-denied",
  "budget-exceeded",
];

/** terminal.submit unavailability details (W-82, CTX-0068); mirrors TerminalSubmitUnavailable. */
export const SUBMIT_UNAVAILABLE_REASONS: readonly string[] = [
  "no-focused-view",
  "buffered-only",
];

/** process.editor.start outcome tags (W-82, CTX-0068); mirrors EditorOutcome minus hosted-only Signal. */
export const EDITOR_OUTCOME_STATUSES: readonly string[] = [
  "edited",
  "cancelled",
  "denied",
  "timeout",
  "spawn-failed",
  "non-zero",
  "unavailable",
];

/** process.editor.start denial details (W-82, CTX-0068); mirrors EditorDeny. */
export const EDITOR_DENY_KINDS: readonly string[] = [
  "no-editor",
  "not-allowed",
];

/**
 * process.editor.start unavailability details (W-82, CTX-0068); SDK
 * kebab-case projection of the static EditorOutcome::Unavailable reasons,
 * never a path or payload.
 */
export const EDITOR_UNAVAILABLE_REASONS: readonly string[] = [
  "temp-unavailable",
  "read-unavailable",
  "too-large",
  "invalid-utf8",
  "wait-unavailable",
];

/** Decided overlay input-event tags (W-01); field encodings stay parked. */
export const OVERLAY_EVENT_TAGS: readonly string[] = [
  "key",
  "text",
  "pointer",
  "paste",
];

/** Full release-reason vocabulary (W-01); only `submitted`/`cancelled` are owner-suppliable. */
export const OVERLAY_RELEASE_REASONS: readonly string[] = [
  "released",
  "submitted",
  "cancelled",
  "focus_switched",
  "unloaded",
  "crashed",
  "timeout",
];

/** Owner-suppliable release dispositions (W-01); omitted defaults to `released`. */
export const OVERLAY_OWNER_RELEASE_REASONS: readonly string[] = [
  "submitted",
  "cancelled",
];

/** Poll statuses (W-01): `active` holds capture, `released` is terminal per handle. */
export const OVERLAY_POLL_STATUSES: readonly string[] = ["active", "released"];

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
  "workspace.created": [
    { name: "id", type: "integer" },
    { name: "name", type: "string" },
  ],
  "workspace.closed": [{ name: "id", type: "integer" }],
  "workspace.renamed": [
    { name: "id", type: "integer" },
    { name: "name", type: "string" },
  ],
  "workspace.focused": [{ name: "id", type: "integer" }],
  "workspace.changed": [{ name: "id", type: "integer" }],
  "overlay.released": [
    { name: "owner", type: "string" },
    { name: "reason", type: "string" },
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

/** Host wiring status of one v1 namespace. */
export type HostParityStatus = "wired" | "deferred";

/** One per-namespace parity verdict. */
export interface NamespaceHostParity {
  readonly namespace: string;
  readonly status: HostParityStatus;
}

/**
 * Host revision the parity verdicts below are frozen against.
 *
 * The verdict SET comes from bitty #1303 (CTX-0707): `keymaps.suggest` and
 * `tasks.spawn`/`cancel` as bridge captures, `process.spawn` v1-OUT. Bitty
 * #1391 (CTX-0767, LUA-OQ-8) then wired `services.get`/`provide` to the host
 * backend (shape checks, manifest-gated provide capture, deterministic
 * resolution with typed `E_SERVICE_*` failures); `env.get`/`has` stay
 * grant-gated and deny with the backend-absent code until an
 * `env.read:<KEY>` grant exists. Bitty #1604 (CTX-0906, DIR-030) moved no
 * verdict: it removed the embedded Lua network binding from Core, so
 * `bitty.network` stays a v1 exclusion and the out-of-process `net`
 * component's Lua request surface remains deferred, not wired. Bitty #1563 /
 * #1573 (CTX-0894/CTX-0897) wired the read-only `bitty.debug` backend
 * (`inspect`, `trace`, `trace_get`) while `debug.control` stays deferred
 * (see {@link FUNCTION_HOST_PARITY}); bitty #1584 (CTX-0889, ADR-0014) wired
 * `bitty.workspace` and the `workspace.*` observation events. Both landed
 * before #1604 but were synced here at bitty `main` `2cb49afe` (SDK CTX-0063).
 * SDK task CTX-0067 (W-43) re-verifies at bitty `main` `fb44a867` (PR 1641):
 * bitty #1633 (W-28, CTX-0941) added the provisional focusable overlay and
 * transient input-capture mechanism `bitty.ui.overlay.acquire`/`release`/`poll`
 * (existing `ui.overlay` grant, no new capability; application wiring tracked
 * as CTX-0943 and not landed) and bitty #1641 (W-29, CTX-0942) added thin
 * targeting bindings `bitty.ui.targets.*` and `bitty.ui.labels.*` with no new
 * capability and no Event-Bus exposure; both stayed pending per W-120 at that
 * pin, deferred and not wired into v1, so no v1 namespace verdict moved.
 * SDK task CTX-0065 (W-120) now wires the accepted W-01 contract: the
 * `bitty.ui.overlay.acquire`/`update`/`poll`/`release` spellings plus the
 * `overlay.released` bus event under the single coupled grant
 * `ui.overlay.focus` (no `input.capture` head) live under the already-wired
 * `ui` namespace, so no namespace verdict moves; the thin `bitty.ui.targets`
 * and `bitty.ui.labels` bindings stay pending per W-120, deferred and not
 * wired (see the surface table exclusions `bitty.ui.targets`,
 * `bitty.ui.labels`).
 * SDK task CTX-0068 (W-103 S-2) wires the accepted W-82 composer operations
 * additively: `bitty.terminal.submit` (gated on the additive v2 capability
 * `terminal.input.submit`, typed accepted/denied/unavailable outcomes with
 * per-plugin byte-window charging) lives under the already-wired `terminal`
 * namespace, so no verdict moves there; `bitty.process.editor.start` (gated
 * on the additive v2 capability `process.editor`, typed
 * edited/cancelled/denied/timeout/spawn-failed/non-zero/unavailable
 * outcomes, Core-owned temp file that never leaves Core) records the new
 * wired `process` namespace verdict above, while unconstrained
 * `process.spawn` stays v1-OUT. Mechanism evidence is bitty #1661 (CTX-0929,
 * `1df0459e`) and #1654 (CTX-0941, `2f49934d`); `api_version` stays `1.0.0`
 * (additive only) and the pin stays `fb44a867` (#1641).
 * `commit` is the last re-verified bitty `main`; `pr` is the pin PR that
 * carries the re-verification (last v1 verdict move remains #1584). Mirrors
 * `surface/bitty-plugin-api-v1.json` `hostParity`; `just host-parity-check`
 * fails when the two drift apart.
 *
 * SDK task W-139 (CTX-0066) adds no verdict: the plugin-facing
 * history/search/selection surface the W-135/W-137/W-138 draft contracts
 * delegate to W-139 has no accepted closed-set capability and no host entry
 * point, so it is not declared as accepted SDK surface here (see the surface
 * table exclusion `bitty.history`).
 */
export const HOST_PARITY_SOURCE = {
  repository: "bitty",
  commit: "fb44a8671ea7526c985d8f0ca3f57ef9b82f09e0",
  pr: 1641,
} as const;

/**
 * Per-namespace parity verdicts, frozen on the accepted v1 surface.
 *
 * `wired` namespaces generate full bindings; `deferred` namespaces stay
 * present but fail closed with `E_NOT_IMPLEMENTED` until a host follow-up
 * wires their backend. Every v1 function prefix appears exactly once.
 */
export const NAMESPACE_HOST_PARITY: readonly NamespaceHostParity[] = [
  { namespace: "commands", status: "wired" },
  { namespace: "events", status: "wired" },
  { namespace: "keymaps", status: "wired" },
  { namespace: "settings", status: "wired" },
  { namespace: "store", status: "wired" },
  { namespace: "notify", status: "wired" },
  { namespace: "env", status: "deferred" },
  { namespace: "services", status: "wired" },
  { namespace: "ui", status: "wired" },
  { namespace: "terminal", status: "wired" },
  { namespace: "tasks", status: "wired" },
  { namespace: "timers", status: "wired" },
  { namespace: "debug", status: "wired" },
  { namespace: "workspace", status: "wired" },
  // CTX-0068 (W-82 accepted, W-103 S-2): the constrained process namespace is
  // wired for the allowlisted external-editor round trip only
  // (`process.editor.start` gated on `process.editor`); unconstrained
  // `process.spawn` stays v1-OUT (see the surface table exclusion
  // `bitty.process.spawn`). Mechanism evidence: bitty #1661 (CTX-0929,
  // 1df0459e).
  { namespace: "process", status: "wired" },
];

/** One per-function parity override inside a wired namespace. */
export interface FunctionHostParity {
  readonly path: string;
  readonly status: HostParityStatus;
}

/**
 * Functions that stay deferred inside an otherwise wired namespace.
 *
 * `debug.control` is registered by the host bridge, but the runtime
 * implementation fails closed with `E_NOT_IMPLEMENTED` before reading the
 * grant or the target (bitty `services.rs` `debug_control`).
 */
export const FUNCTION_HOST_PARITY: readonly FunctionHostParity[] = [
  { path: "debug.control", status: "deferred" },
];

/** Function paths that fail closed with `E_NOT_IMPLEMENTED` individually. */
export const DEFERRED_FUNCTIONS: ReadonlySet<string> = new Set(
  FUNCTION_HOST_PARITY.filter((entry) => entry.status === "deferred").map(
    (entry) => entry.path,
  ),
);

/**
 * Namespaces whose calls fail closed with `E_NOT_IMPLEMENTED`, derived from
 * {@link NAMESPACE_HOST_PARITY} so the mock host and the generator share one
 * source and can never disagree about which namespaces are deferred.
 */
export const DEFERRED_NAMESPACES: ReadonlySet<string> = new Set(
  NAMESPACE_HOST_PARITY.filter((entry) => entry.status === "deferred").map(
    (entry) => entry.namespace,
  ),
);

/** Look up one namespace wiring status. */
export function namespaceHostParity(
  namespace: string,
): HostParityStatus | undefined {
  return NAMESPACE_HOST_PARITY.find((entry) => entry.namespace === namespace)
    ?.status;
}
