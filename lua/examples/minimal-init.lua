-- Minimal Plugin API v1 entry point exercising accepted L1/L2 surface.
-- This file is a conformance example for lua/bitty.d.lua; it is not a complete
-- plugin and makes no host-behavior claims beyond the accepted contract.

bitty.commands.register({
  id = "hello",
  title = "Say hello",
  description = "Example command from the SDK conformance example.",
  args_schema = { type = "object", properties = {} },
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

bitty.ui.mount("statusline", { text = "hello" })
bitty.ui.update(0, { text = "hello again" })

bitty.store.set("seen", { count = 1 })
local seen = bitty.store.get("seen")
print(seen)

bitty.settings.set("theme", "dark")
print(bitty.settings.get("theme"))

local service = bitty.services.get("example.greeter", { version = ">=1.0.0", optional = true })
if service ~= nil then
  print(service.hello)
end

bitty.services.provide("example.greeter", {
  hello = function()
    return "hi"
  end,
})

bitty.tasks.spawn(function() end)
bitty.timers.create(250, function() end)

if bitty.env then
  print(bitty.env.has("EDITOR"), bitty.env.get("EDITOR"))
end
