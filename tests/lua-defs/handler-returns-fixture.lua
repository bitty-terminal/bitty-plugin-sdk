-- Positive fixture for the widened `BittyEventHandler` return domain.
--
-- Observation and lifecycle handler return values are ignored, and every
-- interception return other than the literal `false` approves, so `false`,
-- `nil`, and representative non-boolean values must all type-check. LuaLS
-- must report no diagnostics for this file against `lua/bitty.d.lua`.

bitty.events.subscribe("terminal.bell", function(_event)
  return nil
end)

bitty.events.subscribe("intercept.paste", function(_event)
  return false
end)

bitty.events.subscribe("intercept.paste", function(_event)
  return 1
end)

bitty.events.subscribe("intercept.paste", function(_event)
  return "approve"
end)

bitty.events.subscribe("plugin.activated", function(_event)
  return { approved = true }
end)
