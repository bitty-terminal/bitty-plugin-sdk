-- Records one run of a Lua Plugin API v1 entry point as a JSON transcript.
--
-- Usage: lua minimal-example-recorder.lua <entry-point.lua>
--
-- The shim accepts every accepted L1/L2 surface without validating argument
-- shapes; tests/example.test.ts replays the transcript through the TypeScript
-- mock host, which owns shape validation. Returning symbolic handle tokens
-- lets the replay substitute the real handles created by the mock host.

local entry = assert(arg[1], "usage: minimal-example-recorder.lua <entry.lua>")

local real_print = print
print = function() end

local calls = {}

local function record(op, args, result)
  calls[#calls + 1] = { op = op, args = args, result = result }
end

local handle_sequence = 0

local function handle()
  handle_sequence = handle_sequence + 1
  return "__handle_" .. handle_sequence .. "__"
end

bitty = {
  api_version = "1.0.0",
  commands = {
    register = function(def)
      local result = handle()
      record("commands.register", def, result)
      return result
    end,
  },
  events = {
    subscribe = function(kind, handler)
      local result = handle()
      record("events.subscribe", { kind = kind, handler = handler }, result)
      return result
    end,
  },
  keymaps = {
    suggest = function(def)
      local result = handle()
      record("keymaps.suggest", def, result)
      return result
    end,
  },
  settings = {
    get = function(key)
      record("settings.get", { key = key })
      return "dark"
    end,
    set = function(key, value)
      record("settings.set", { key = key, value = value })
      return true
    end,
  },
  store = {
    get = function(key)
      record("store.get", { key = key })
      return { count = 1 }
    end,
    set = function(key, value)
      record("store.set", { key = key, value = value })
      return true
    end,
  },
  notify = {
    show = function(payload)
      record("notify.show", payload)
      return true
    end,
  },
  ui = {
    mount = function(slot, component)
      local result = handle()
      record("ui.mount", { slot = slot, component = component }, result)
      return result
    end,
    update = function(block, component)
      record("ui.update", { handle = block, component = component })
      return true
    end,
  },
  terminal = {
    snapshot = function(opts)
      record("terminal.snapshot", opts)
      return {
        terminal_id = 1,
        width = 80,
        height = 24,
        rows = { { text = "hello" } },
      }
    end,
  },
  services = {
    get = function(iface, opts)
      record("services.get", { iface = iface, opts = opts })
      return nil
    end,
    provide = function(iface, impl)
      local result = handle()
      record("services.provide", { iface = iface, impl = impl }, result)
      return result
    end,
  },
  tasks = {
    spawn = function(run)
      local result = handle()
      record("tasks.spawn", { run = run }, result)
      return result
    end,
    cancel = function(cancel_handle)
      record("tasks.cancel", { handle = cancel_handle })
      return false
    end,
  },
  timers = {
    create = function(delay, callback)
      local result = handle()
      record("timers.create", { delay = delay, callback = callback }, result)
      return result
    end,
    cancel = function(cancel_handle)
      record("timers.cancel", { handle = cancel_handle })
      return false
    end,
  },
}

dofile(entry)

local function is_array(value)
  local count = 0
  for key in pairs(value) do
    if type(key) ~= "number" then return false end
    count = count + 1
  end
  if count == 0 then return false end
  for index = 1, count do
    if value[index] == nil then return false end
  end
  return true
end

local function encode(value)
  local value_type = type(value)
  if value == nil then return "null" end
  if value_type == "boolean" then return value and "true" or "false" end
  if value_type == "number" then return tostring(value) end
  if value_type == "function" then return '"__function__"' end
  if value_type == "string" then
    local escaped = value:gsub('[%c\\"]', function(character)
      local named = {
        ["\\"] = "\\\\",
        ['"'] = '\\"',
        ["\n"] = "\\n",
        ["\r"] = "\\r",
        ["\t"] = "\\t",
      }
      return named[character] or string.format("\\u%04x", string.byte(character))
    end)
    return '"' .. escaped .. '"'
  end
  if value_type ~= "table" then
    error("unsupported value type " .. value_type)
  end
  local parts = {}
  if is_array(value) then
    for index = 1, #value do
      parts[#parts + 1] = encode(value[index])
    end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  for key, member in pairs(value) do
    parts[#parts + 1] = encode(tostring(key)) .. ":" .. encode(member)
  end
  table.sort(parts)
  return "{" .. table.concat(parts, ",") .. "}"
end

real_print(encode(calls))
