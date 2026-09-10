/**
 * Closed capability identifier set (Plugin API v1).
 *
 * Mirrors the canonical tables shared by `bitty-package` and
 * `bitty-plugin-host` (closed-set heads, parameter-required heads, high-risk
 * heads). Identifiers are closed symbols: an unknown head is a validation
 * error instead of being ignored, and there is no wildcard form.
 */

import { error, warning, type Diagnostic } from "./diagnostics.js";
import { MAX_CAPABILITY_LEN, MAX_CAPABILITY_PARAM_LEN } from "./schema.js";

/** Capability families in the closed v1 set. */
export const CAPABILITY_FAMILIES: readonly string[] = [
  "terminal",
  "ui",
  "clipboard",
  "fs",
  "process",
  "network",
  "runtime",
  "debug",
  "platform",
  "protocol",
  "panel",
  "browser",
  "agent",
  "mcp",
  "ai",
];

/** Every closed capability head; parameterized heads carry a `:PARAMETER`. */
export const CLOSED_CAPABILITY_HEADS: readonly string[] = [
  "terminal.semantic-read",
  "terminal.raw-read",
  "terminal.input.self",
  "terminal.input.all",
  "terminal.manage",
  "ui.rich",
  "ui.overlay",
  "ui.protocol-register",
  "clipboard.read",
  "clipboard.write",
  "fs.read",
  "fs.write",
  "process.spawn",
  "network.connect",
  "runtime.inspect",
  "runtime.configure",
  "runtime.plugin-manage",
  "debug.inspect",
  "debug.trace",
  "debug.control",
  "platform.notify",
  "platform.open-url",
  "platform.image-file",
  "protocol.register",
  "panel.provider",
  "panel.create",
  "panel.focus",
  "panel.overlay",
  "browser.embed",
  "browser.navigation",
  "browser.file-url",
  "browser.storage",
  "agent.context.terminal",
  "agent.context.workspace",
  "agent.memory",
  "mcp.invoke",
  "ai.provider",
  "ai.stream",
  "ai.model",
];

/** Heads that must carry a `:PARAMETER` constraint. */
export const PARAM_REQUIRED_HEADS: ReadonlySet<string> = new Set([
  "fs.read",
  "fs.write",
  "process.spawn",
  "network.connect",
  "mcp.invoke",
  "agent.memory",
]);

/** Heads the consent flow must present distinctly (RFC capability rule 3). */
export const HIGH_RISK_HEADS: ReadonlySet<string> = new Set([
  "terminal.input.all",
  "terminal.raw-read",
  "ui.protocol-register",
  "debug.control",
  "runtime.plugin-manage",
  "browser.embed",
]);

const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;
const SEGMENT = /^[a-z][a-z0-9_-]*$/;

/** UTF-8 byte length, matching the reference host's `str::len()` bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate one capability identifier against the closed v1 grammar.
 *
 * The identifier must be a non-empty string bounded to
 * {@link MAX_CAPABILITY_LEN} bytes, contain no control or whitespace
 * characters, use `family.resource[.scope]` with 2-3 lowercase segments, and
 * carry a `:PARAMETER` exactly when the head requires one.
 */
export function validateCapabilityId(raw: string, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (raw.length === 0) {
    diagnostics.push(
      error("capabilities.invalid", path, "capability must not be empty"),
    );
    return diagnostics;
  }
  if (byteLength(raw) > MAX_CAPABILITY_LEN) {
    diagnostics.push(
      error(
        "capabilities.invalid",
        path,
        `capability id too long (${byteLength(raw)} > ${MAX_CAPABILITY_LEN})`,
      ),
    );
    return diagnostics;
  }
  if (CONTROL_OR_WHITESPACE.test(raw)) {
    diagnostics.push(
      error(
        "capabilities.invalid",
        path,
        "capability must not contain control characters or whitespace",
      ),
    );
    return diagnostics;
  }

  const colon = raw.indexOf(":");
  const head = colon === -1 ? raw : raw.slice(0, colon);
  const param = colon === -1 ? undefined : raw.slice(colon + 1);

  if (head.includes("*")) {
    diagnostics.push(
      error(
        "capabilities.wildcard",
        path,
        "wildcards are not allowed (deny-by-default, no allow-all)",
      ),
    );
    return diagnostics;
  }
  if (param !== undefined) {
    if (param.length === 0) {
      diagnostics.push(
        error(
          "capabilities.invalid",
          path,
          "capability parameter must not be empty",
        ),
      );
      return diagnostics;
    }
    if (byteLength(param) > MAX_CAPABILITY_PARAM_LEN) {
      diagnostics.push(
        error(
          "capabilities.invalid",
          path,
          `capability parameter too long (${byteLength(param)} > ${MAX_CAPABILITY_PARAM_LEN})`,
        ),
      );
      return diagnostics;
    }
  }

  const parts = head.split(".");
  if (parts.length < 2 || parts.length > 3) {
    diagnostics.push(
      error(
        "capabilities.invalid",
        path,
        "capability must be family.resource or family.resource.scope",
      ),
    );
    return diagnostics;
  }
  for (const segment of parts) {
    if (segment.length === 0 || !SEGMENT.test(segment)) {
      diagnostics.push(
        error(
          "capabilities.invalid",
          path,
          "capability segments must be lowercase [a-z0-9_-] starting with a letter",
        ),
      );
      return diagnostics;
    }
  }

  if (!CLOSED_CAPABILITY_HEADS.includes(head)) {
    diagnostics.push(
      error(
        "capabilities.unknown",
        path,
        `unknown capability '${head}' (closed set; forward compatibility requires an explicit RFC)`,
      ),
    );
    return diagnostics;
  }
  const requiresParam = PARAM_REQUIRED_HEADS.has(head);
  if (requiresParam && param === undefined) {
    diagnostics.push(
      error(
        "capabilities.param-required",
        path,
        `capability '${head}' requires a ':PARAMETER'`,
      ),
    );
    return diagnostics;
  }
  if (!requiresParam && param !== undefined) {
    diagnostics.push(
      error(
        "capabilities.param-forbidden",
        path,
        `capability '${head}' must not have a ':PARAMETER'`,
      ),
    );
    return diagnostics;
  }
  if (HIGH_RISK_HEADS.has(head)) {
    diagnostics.push(
      warning(
        "capabilities.high-risk",
        path,
        `capability '${head}' is high-risk; consent must present it distinctly`,
      ),
    );
  }
  return diagnostics;
}
