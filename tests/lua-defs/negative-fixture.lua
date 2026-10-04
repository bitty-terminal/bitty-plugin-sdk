-- Deliberately uses surface excluded from Plugin API v1. LuaLS must reject
-- every statement below; this file is never loaded by the host.

local alias_namespace = bitty.api
local panel = bitty.ui.register_panel
local state = bitty.get_terminal_state(1)
local legacy = bitty.on_event

local raw_scope = bitty.terminal.snapshot({ scope = "raw" })
local singular = bitty.task.spawn
local protocol = bitty.protocol
local unconstrained_spawn = bitty.process.spawn
local terminal_history = bitty.terminal.history
local live_search = bitty.search
local session_snapshot = bitty.history.session
local live_selection = bitty.selection.get

local missing_opts = bitty.services.get("bitty.example")
local missing_version = bitty.services.get("bitty.example", {})
local missing_version_with_optional = bitty.services.get("bitty.example", {
  optional = true,
})

print(
  alias_namespace,
  panel,
  state,
  legacy,
  raw_scope,
  singular,
  protocol,
  unconstrained_spawn,
  terminal_history,
  live_search,
  session_snapshot,
  live_selection,
  missing_opts,
  missing_version,
  missing_version_with_optional
)
