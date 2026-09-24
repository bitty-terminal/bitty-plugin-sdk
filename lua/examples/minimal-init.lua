-- Minimal Plugin API v1 entry point exercising the host-wired L1/L2 surface.
-- This file is a conformance example for lua/bitty.d.lua and is executed
-- against the SDK mock host by tests/example.test.ts using the companion
-- manifest lua/examples/minimal-init.bitty-plugin.toml. It is not a complete
-- plugin and makes no host-behavior claims beyond what the current host
-- wires: only the DEFERRED `env` namespace stays commented out (see below).
--
-- The host assembles the qualified name from the manifest plugin id, so the
-- registration carries only the short segment; [lazy].commands reserves the
-- assembled `xuepoo.example:hello`.
bitty.commands.register({
  id = "hello",
  title = "Say hello",
  description = "Example command from the SDK conformance example.",
  args_schema = { type = "object", properties = {}, additionalProperties = false },
  result_schema = { type = "string" },
  run = function(_args)
    bitty.notify.show({ title = "Hello", body = "from a plugin", urgency = "normal" })
    return "hello"
  end,
})

bitty.events.subscribe("terminal.title-changed", function(event)
  print(event.kind, event.sequence)
end)

bitty.keymaps.suggest({
  chord = "ctrl+shift+h",
  command = "xuepoo.example:hello",
  when = "global",
})

local snapshot = bitty.terminal.snapshot({ scope = "semantic" })
print(snapshot.terminal_id, snapshot.width, snapshot.height, #snapshot.rows)

-- UI components carry an explicit node kind and updates reuse the mount handle.
local block = bitty.ui.mount("statusline", { kind = "Text", text = "hello" })
bitty.ui.update(block, { kind = "Text", text = "hello again" })

bitty.store.set("seen", { count = 1 })
local seen = bitty.store.get("seen")
print(seen)

bitty.settings.set("theme", "dark")
print(bitty.settings.get("theme"))

-- bitty.services.get/provide are WIRED on the current host (bitty #1391):
-- provide registers the manifest-declared implementation and get resolves
-- it back. bitty.env stays DEFERRED (bitty #1303): the spelling stays
-- declared in bitty.d.lua so this file type-checks, but every call fails
-- closed with E_NOT_IMPLEMENTED (runtime) until the host backend lands, so
-- env calls stay commented out below.
bitty.services.provide("example.greeter", {
  hello = function()
    return "hi"
  end,
})
local service = bitty.services.get("example.greeter", { version = ">=1.0.0" })
if service ~= nil then
  print("greeter resolved")
end
-- if bitty.env then
--   print(bitty.env.has("EDITOR"), bitty.env.get("EDITOR"))
-- end

bitty.tasks.spawn(function() end)
bitty.timers.create(250, function() end)
