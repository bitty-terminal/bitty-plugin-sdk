-- Deliberately uses surface excluded from Plugin API v1. LuaLS must reject
-- every statement below; this file is never loaded by the host.

local alias_namespace = bitty.api
local panel = bitty.ui.register_panel
local state = bitty.get_terminal_state(1)
local legacy = bitty.on_event

local raw_scope = bitty.terminal.snapshot({ scope = "raw" })
local singular = bitty.task.spawn
local protocol = bitty.protocol

print(alias_namespace, panel, state, legacy, raw_scope, singular, protocol)
