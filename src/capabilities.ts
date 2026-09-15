/**
 * Closed capability identifier set (Plugin API v1).
 *
 * Mirrors the canonical tables shared by `bitty-package` and
 * `bitty-plugin-host` (closed-set heads, parameter-required heads, high-risk
 * heads). Identifiers are closed symbols: an unknown head is a validation
 * error instead of being ignored, and there is no wildcard form.
 */

import { error, warning, type Diagnostic } from "./diagnostics.js";
import { pathPatternProblem } from "./path-pattern.js";
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
  "env",
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

/**
 * Heads the consent flow must present distinctly and reviewers must flag
 * (RFC capability rule 3; ADR 0009).
 *
 * The set covers escalation shapes that reach beyond presentation: host
 * management (terminal/runtime/plugin control, debugger control), arbitrary
 * code or protocol execution, outbound process/network authority, destructive
 * file writes, sensitive input reads, and agent or external-tool calls. Heads
 * that stay presentation-only or that expose no secret, execution, or
 * host-management authority (for example `platform.notify`, `runtime.inspect`,
 * `ui.rich`, `platform.open-url`, `clipboard.write`) deliberately stay out so
 * the warning keeps its signal; a broad list would train authors to ignore it.
 */
export const HIGH_RISK_HEADS: ReadonlySet<string> = new Set([
  "terminal.input.all",
  "terminal.raw-read",
  "terminal.manage",
  "ui.protocol-register",
  "clipboard.read",
  "fs.write",
  "process.spawn",
  "network.connect",
  "protocol.register",
  "runtime.plugin-manage",
  "debug.control",
  "browser.embed",
  "agent.context.terminal",
  "agent.context.workspace",
  "agent.memory",
  "mcp.invoke",
]);

/** Maximum `env:<KEY>` parameter length in bytes (ADR 0006 key bound). */
export const MAX_ENV_KEY_LEN = 64;

/** Exact environment key grammar accepted after `env:` (ADR 0006). */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** The single accepted environment suffix-wildcard form (ADR 0006). */
export const ENV_PATTERN = "BITTY_*";

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

  if (head === "env") {
    if (param === undefined) {
      diagnostics.push(
        error(
          "capabilities.param-required",
          path,
          `capability 'env' requires ':KEY' or the '${ENV_PATTERN}' pattern`,
        ),
      );
      return diagnostics;
    }
    if (param !== ENV_PATTERN && !ENV_KEY_PATTERN.test(param)) {
      diagnostics.push(
        error(
          "capabilities.invalid",
          path,
          `env capability parameter must match ${ENV_KEY_PATTERN.source} or be '${ENV_PATTERN}'`,
        ),
      );
      return diagnostics;
    }
    if (byteLength(param) > MAX_ENV_KEY_LEN) {
      diagnostics.push(
        error(
          "capabilities.invalid",
          path,
          `env capability parameter too long (${byteLength(param)} > ${MAX_ENV_KEY_LEN})`,
        ),
      );
      return diagnostics;
    }
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
  if ((head === "fs.read" || head === "fs.write") && param !== undefined) {
    const problem = pathPatternProblem(param);
    if (problem !== undefined) {
      diagnostics.push(
        error(
          "capabilities.filesystem.invalid",
          path,
          `filesystem path pattern is invalid: ${problem}`,
        ),
      );
      return diagnostics;
    }
  }
  if (HIGH_RISK_HEADS.has(head)) {
    diagnostics.push(
      warning(
        "capabilities.high-risk",
        path,
        `capability '${head}' is high-risk; consent must present it distinctly and grant it only when no narrower capability (one entry, exact key or path) suffices`,
      ),
    );
  }
  return diagnostics;
}
