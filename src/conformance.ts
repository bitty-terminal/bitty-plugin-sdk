/**
 * Conformance fixture runner for the Plugin API v1 mock host (R-SDK-3).
 *
 * A conformance case is a declarative, closed-vocabulary scenario: one
 * validated `bitty-plugin.toml`, explicit grants (deny-by-default: absent means
 * no authority), and an ordered step list. The runner executes steps against
 * `MockHost`, records per-step assertions, and reports reproducible evidence.
 * It performs no network or process work; every case is bounded by a timeout,
 * a file-size limit, and a step-count limit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { HostError } from "./host-diagnostics.js";
import { lintManifestSource } from "./manifest.js";
import { MockHost, type ResolvedService } from "./mock-host.js";
import { MANIFEST_MAX_BYTES } from "./schema.js";

/** One declarative conformance step (closed vocabulary). */
export interface ConformanceStep {
  readonly op: string;
  readonly [key: string]: unknown;
}

/** One conformance case file. */
export interface ConformanceCase {
  readonly name: string;
  readonly description: string;
  readonly manifest: string;
  readonly tags?: readonly string[];
  readonly grants?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly steps: readonly ConformanceStep[];
}

/** One recorded assertion. */
export interface ConformanceAssertion {
  readonly op: string;
  readonly detail: string;
}

/** Outcome of one conformance case. */
export interface ConformanceCaseResult {
  readonly name: string;
  readonly file: string;
  readonly passed: boolean;
  readonly assertions: readonly ConformanceAssertion[];
  readonly publishedKinds: readonly string[];
  readonly error?: string;
  readonly durationMs: number;
}

/** Runner options. */
export interface ConformanceRunOptions {
  /** Directory manifest paths are resolved against. */
  readonly rootDir: string;
  /** Per-case wall-clock bound in milliseconds. */
  readonly timeoutMs?: number;
}

const CASE_MAX_BYTES = 1024 * 1024;
const CASE_MAX_STEPS = 512;
const DEFAULT_TIMEOUT_MS = 5000;
const SUPPORTED_STEP_OPS: ReadonlySet<string> = new Set([
  "grant",
  "revoke",
  "register",
  "subscribe",
  "publish",
  "dispatch",
  "call",
  "call-service",
  "expect-event",
  "expect-capture",
  "expect-bitty-env",
  "begin-activation",
  "end-activation",
  "suspend",
  "dispose",
  "advance-time",
  "drain-tasks",
  "set-terminal-snapshot",
  "remove-service",
]);

class CaseFailure extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRefs(value: unknown, captures: Map<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveRefs(entry, captures));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$ref") {
      const name = value["$ref"];
      if (typeof name !== "string" || !captures.has(name)) {
        throw new CaseFailure(`unresolved $ref '${String(name)}'`);
      }
      return captures.get(name);
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = resolveRefs(entry, captures);
    }
    return output;
  }
  return value;
}

function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => deepEquals(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          deepEquals(left[key], right[key]),
      )
    );
  }
  return false;
}

function parseCase(source: string, file: string): ConformanceCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new CaseFailure(
      `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isRecord(parsed)) throw new CaseFailure("case must be a JSON object");
  const name = parsed.name;
  const description = parsed.description;
  const manifest = parsed.manifest;
  const steps = parsed.steps;
  if (typeof name !== "string" || name.length === 0) {
    throw new CaseFailure("case.name must be a non-empty string");
  }
  if (typeof description !== "string") {
    throw new CaseFailure("case.description must be a string");
  }
  if (typeof manifest !== "string" || manifest.length === 0) {
    throw new CaseFailure("case.manifest must be a non-empty path");
  }
  if (manifest.startsWith("/") || manifest.includes("..")) {
    throw new CaseFailure("case.manifest must stay inside the fixture root");
  }
  if (!Array.isArray(steps))
    throw new CaseFailure("case.steps must be an array");
  if (steps.length > CASE_MAX_STEPS) {
    throw new CaseFailure(`case has more than ${CASE_MAX_STEPS} steps`);
  }
  for (const step of steps) {
    if (!isRecord(step) || typeof step.op !== "string") {
      throw new CaseFailure("every step must be an object with an op");
    }
    if (!SUPPORTED_STEP_OPS.has(step.op)) {
      throw new CaseFailure(`unsupported step op '${step.op}'`);
    }
  }
  const grants = parsed.grants;
  if (grants !== undefined && !Array.isArray(grants)) {
    throw new CaseFailure("case.grants must be an array");
  }
  return {
    name,
    description,
    manifest,
    ...(Array.isArray(parsed.tags)
      ? {
          tags: parsed.tags.filter(
            (tag): tag is string => typeof tag === "string",
          ),
        }
      : {}),
    ...(Array.isArray(grants)
      ? {
          grants: grants.filter(
            (grant): grant is string => typeof grant === "string",
          ),
        }
      : {}),
    ...(isRecord(parsed.environment)
      ? {
          environment: Object.fromEntries(
            Object.entries(parsed.environment).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
    steps: steps as ConformanceStep[],
  };
}

function expectProblem(
  actual: { ok: boolean; result?: unknown; error?: HostError },
  expected: unknown,
  captures: Map<string, unknown>,
): string | undefined {
  if (!isRecord(expected)) return "expect must be an object";
  const wanted = resolveRefs(expected, captures);
  if (!isRecord(wanted)) return "expect must resolve to an object";
  if (wanted.denial !== undefined) {
    if (actual.ok) return "expected a typed denial but the call succeeded";
    const denial = wanted.denial;
    if (!isRecord(denial)) return "expect.denial must be an object";
    const diagnostic = actual.error?.diagnostic;
    if (diagnostic === undefined) return "expected a HostError denial";
    if (denial.code !== undefined && diagnostic.code !== denial.code) {
      return `expected denial ${String(denial.code)} but got ${diagnostic.code}`;
    }
    if (denial.class !== undefined && diagnostic.class !== denial.class) {
      return `expected denial class ${String(denial.class)} but got ${diagnostic.class}`;
    }
    if (denial.path !== undefined && diagnostic.path !== denial.path) {
      return `expected denial path ${String(denial.path)} but got ${String(diagnostic.path)}`;
    }
    return undefined;
  }
  if (!actual.ok) {
    return `expected success but got ${actual.error?.diagnostic.code ?? "error"}: ${actual.error?.message ?? ""}`;
  }
  if (
    wanted.result !== undefined &&
    !deepEquals(actual.result, wanted.result)
  ) {
    return `expected result ${JSON.stringify(wanted.result)} but got ${JSON.stringify(actual.result)}`;
  }
  return undefined;
}

function callbackFrom(
  spec: Record<string, unknown>,
  captures: Map<string, unknown>,
  counter: unknown,
): () => unknown {
  return () => {
    if (typeof counter === "string") {
      const current = captures.get(counter);
      captures.set(counter, typeof current === "number" ? current + 1 : 1);
    }
    if (spec.run_throw !== undefined) {
      throw new Error(String(spec.run_throw));
    }
    if (spec.echo_arg !== undefined) {
      const args = spec.args;
      if (isRecord(args)) return args[String(spec.echo_arg)];
    }
    return spec.run_result === undefined
      ? null
      : resolveRefs(spec.run_result, captures);
  };
}

function callSurface(
  host: MockHost,
  surface: string,
  args: unknown,
  captures: Map<string, unknown>,
  counter: unknown,
): unknown {
  const table = isRecord(args) ? args : {};
  switch (surface) {
    case "notify.show":
      return host.bitty.notify.show(table as never);
    case "env.get":
      return host.bitty.env?.get(String(table.name));
    case "env.has":
      return host.bitty.env?.has(String(table.name));
    case "settings.get":
      return host.bitty.settings.get(String(table.key));
    case "settings.set":
      return host.bitty.settings.set(String(table.key), table.value as never);
    case "store.get":
      return host.bitty.store.get(String(table.key));
    case "store.set":
      return host.bitty.store.set(String(table.key), table.value as never);
    case "keymaps.suggest":
      return host.bitty.keymaps.suggest(table as never);
    case "ui.mount":
      return host.bitty.ui.mount(
        String(table.slot),
        (table.component ?? {}) as Record<string, unknown>,
      );
    case "ui.update":
      return host.bitty.ui.update(
        Number(table.handle),
        (table.component ?? {}) as Record<string, unknown>,
      );
    case "terminal.snapshot":
      return host.bitty.terminal.snapshot(table as never);
    case "services.get":
      return (
        host.bitty.services.get(String(table.iface), table.opts as never) ??
        null
      );
    case "services.provide": {
      const spec = isRecord(table.impl) ? table.impl : {};
      const impl: Record<string, (args?: unknown) => unknown> = {};
      for (const [method, member] of Object.entries(spec)) {
        if (!isRecord(member)) {
          throw new CaseFailure(
            `service method ${method} must be an object spec`,
          );
        }
        impl[method] = (args?: unknown) => {
          if (member.run_throw !== undefined) {
            throw new Error(String(member.run_throw));
          }
          if (member.echo_arg !== undefined && isRecord(args)) {
            return args[String(member.echo_arg)];
          }
          if (typeof member.template === "string" && isRecord(args)) {
            return member.template.replace(/\{(\w+)\}/g, (_, field: string) =>
              String(args[field] ?? ""),
            );
          }
          return member.run_result === undefined
            ? null
            : resolveRefs(member.run_result, captures);
        };
      }
      return host.bitty.services.provide(String(table.iface), impl as never);
    }
    case "tasks.spawn":
      return host.bitty.tasks.spawn(callbackFrom(table, captures, counter));
    case "tasks.cancel":
      return host.bitty.tasks.cancel(Number(table.handle));
    case "timers.create":
      return host.bitty.timers.create(
        Number(table.delay_ms),
        callbackFrom(table, captures, counter),
      );
    case "timers.cancel":
      return host.bitty.timers.cancel(Number(table.handle));
    default:
      throw new CaseFailure(`unsupported surface '${surface}'`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  startedAt?: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remainingMs =
    startedAt !== undefined
      ? Math.max(0, timeoutMs - (performance.now() - startedAt))
      : timeoutMs;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CaseFailure(`${label} exceeded ${timeoutMs} ms`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run one conformance case file against the mock host.
 *
 * The manifest is validated by the accepted linter before the host is built;
 * any invalid fixture fails the case instead of being skipped.
 */
export async function runConformanceCaseFile(
  file: string,
  options: ConformanceRunOptions,
): Promise<ConformanceCaseResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const assertions: ConformanceAssertion[] = [];
  const publishedKinds: string[] = [];
  let name = file;
  let activeHost: MockHost | undefined;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new CaseFailure("case path is not a file");
    if (stats.size > CASE_MAX_BYTES) {
      throw new CaseFailure(`case file exceeds ${CASE_MAX_BYTES} bytes`);
    }
    const conformanceCase = parseCase(readFileSync(file, "utf8"), file);
    name = conformanceCase.name;

    const manifestFile = join(options.rootDir, conformanceCase.manifest);
    // Reject an oversized fixture before reading it so a hostile manifest
    // cannot be used as a memory amplifier: the accepted linter only rejects
    // after the whole source is already in memory.
    const manifestStats = statSync(manifestFile);
    if (!manifestStats.isFile()) {
      throw new CaseFailure("fixture manifest path is not a file");
    }
    if (manifestStats.size > MANIFEST_MAX_BYTES) {
      throw new CaseFailure(
        `fixture manifest exceeds ${MANIFEST_MAX_BYTES} bytes`,
      );
    }
    const manifestSource = readFileSync(manifestFile, "utf8");
    const lint = lintManifestSource(manifestSource);
    if (!lint.valid) {
      const codes = lint.diagnostics
        .filter((entry) => entry.severity === "error")
        .map((entry) => entry.code)
        .join(", ");
      throw new CaseFailure(`fixture manifest is invalid: ${codes}`);
    }
    assertions.push({
      op: "manifest",
      detail: `${conformanceCase.manifest} passes the accepted validator`,
    });

    const host = new MockHost({
      manifestSource,
      ...(conformanceCase.environment === undefined
        ? {}
        : { environment: conformanceCase.environment }),
    });
    activeHost = host;
    for (const capability of conformanceCase.grants ?? []) {
      host.grant(capability);
    }

    const captures = new Map<string, unknown>();
    const record = (ok: boolean, op: string, detail: string): void => {
      if (!ok) throw new CaseFailure(`${op}: ${detail}`);
      assertions.push({ op, detail });
    };

    const runStep = (step: ConformanceStep): void => {
      const table = step as Record<string, unknown>;
      switch (step.op) {
        case "grant":
          host.grant(String(table.capability));
          assertions.push({
            op: "grant",
            detail: `granted ${String(table.capability)}`,
          });
          break;
        case "revoke":
          host.revoke(String(table.capability));
          assertions.push({
            op: "revoke",
            detail: `revoked ${String(table.capability)}`,
          });
          break;
        case "register": {
          const definition = isRecord(table.command) ? table.command : {};
          let registerOutcome: {
            ok: boolean;
            result?: unknown;
            error?: HostError;
          };
          try {
            registerOutcome = {
              ok: true,
              result: host.bitty.commands.register({
                id: String(definition.id),
                title: String(definition.title ?? definition.id),
                ...(definition.description === undefined
                  ? {}
                  : { description: String(definition.description) }),
                ...(definition.args_schema === undefined
                  ? {}
                  : { args_schema: definition.args_schema as never }),
                ...(definition.result_schema === undefined
                  ? {}
                  : { result_schema: definition.result_schema as never }),
                run: (args) => {
                  if (definition.run_throw !== undefined) {
                    throw new Error(String(definition.run_throw));
                  }
                  if (definition.echo_arg !== undefined && isRecord(args)) {
                    return args[String(definition.echo_arg)];
                  }
                  return definition.run_result === undefined
                    ? null
                    : resolveRefs(definition.run_result, captures);
                },
              }),
            };
          } catch (cause) {
            if (!(cause instanceof HostError)) throw cause;
            registerOutcome = { ok: false, error: cause };
          }
          if (typeof table.capture === "string" && registerOutcome.ok) {
            captures.set(table.capture, registerOutcome.result);
          }
          const registerProblem = expectProblem(
            registerOutcome,
            table.expect ?? {},
            captures,
          );
          record(
            registerProblem === undefined,
            "register",
            `${String(definition.id)} ${registerProblem ?? "matched"}`,
          );
          break;
        }
        case "subscribe": {
          const capture =
            typeof table.capture === "string" ? table.capture : undefined;
          const events: unknown[] = [];
          if (capture !== undefined) captures.set(capture, events);
          const handlerSpec = isRecord(table.handler) ? table.handler : {};
          let subscribeOutcome: {
            ok: boolean;
            result?: unknown;
            error?: HostError;
          };
          try {
            subscribeOutcome = {
              ok: true,
              result: host.bitty.events.subscribe(
                String(table.event),
                (event) => {
                  if (capture !== undefined) {
                    events.push({
                      kind: event.kind,
                      sequence: event.sequence,
                      payload: event.payload,
                    });
                  }
                  if (handlerSpec.decision === "veto") return false;
                  if (handlerSpec.decision === "throw") {
                    throw new Error("fixture handler throws");
                  }
                  return undefined;
                },
              ),
            };
          } catch (cause) {
            if (!(cause instanceof HostError)) throw cause;
            subscribeOutcome = { ok: false, error: cause };
          }
          const subscribeProblem = expectProblem(
            subscribeOutcome,
            table.expect ?? {},
            captures,
          );
          record(
            subscribeProblem === undefined,
            "subscribe",
            `${String(table.event)} ${subscribeProblem ?? "matched"}`,
          );
          break;
        }
        case "publish": {
          const result = host.publish(
            String(table.event),
            table.payload === undefined
              ? {}
              : resolveRefs(table.payload, captures),
          );
          publishedKinds.push(String(table.event));
          const problem = expectProblem(
            { ok: true, result },
            table.expect ?? { result },
            captures,
          );
          record(
            problem === undefined,
            "publish",
            `${String(table.event)} ${problem ?? "matched"}`,
          );
          break;
        }
        case "dispatch": {
          let outcome: { ok: boolean; result?: unknown; error?: HostError };
          try {
            outcome = {
              ok: true,
              result: host.dispatchCommand(
                String(table.command),
                table.args === undefined
                  ? {}
                  : resolveRefs(table.args, captures),
              ),
            };
          } catch (cause) {
            if (!(cause instanceof HostError)) throw cause;
            outcome = { ok: false, error: cause };
          }
          const problem = expectProblem(outcome, table.expect ?? {}, captures);
          record(
            problem === undefined,
            "dispatch",
            `${String(table.command)} ${problem ?? "matched"}`,
          );
          break;
        }
        case "call": {
          if (
            typeof table.counter === "string" &&
            !captures.has(table.counter)
          ) {
            captures.set(table.counter, 0);
          }
          let outcome: { ok: boolean; result?: unknown; error?: HostError };
          try {
            outcome = {
              ok: true,
              result: callSurface(
                host,
                String(table.surface),
                table.args === undefined
                  ? {}
                  : resolveRefs(table.args, captures),
                captures,
                table.counter,
              ),
            };
          } catch (cause) {
            if (!(cause instanceof HostError)) throw cause;
            outcome = { ok: false, error: cause };
          }
          if (typeof table.capture === "string" && outcome.ok) {
            captures.set(table.capture, outcome.result);
          }
          const problem = expectProblem(outcome, table.expect ?? {}, captures);
          record(
            problem === undefined,
            "call",
            `${String(table.surface)} ${problem ?? "matched"}`,
          );
          break;
        }
        case "call-service": {
          const service = captures.get(String(table.service));
          const method = (service as ResolvedService | undefined)?.[
            String(table.method)
          ];
          let outcome: { ok: boolean; result?: unknown; error?: HostError };
          try {
            if (typeof method !== "function") {
              throw new CaseFailure(
                `service capture '${String(table.service)}' has no method ${String(table.method)}`,
              );
            }
            outcome = {
              ok: true,
              result: method(
                table.args === undefined
                  ? undefined
                  : (resolveRefs(table.args, captures) as never),
              ),
            };
          } catch (cause) {
            if (!(cause instanceof HostError)) throw cause;
            outcome = { ok: false, error: cause };
          }
          const problem = expectProblem(outcome, table.expect ?? {}, captures);
          record(
            problem === undefined,
            "call-service",
            `${String(table.method)} ${problem ?? "matched"}`,
          );
          break;
        }
        case "expect-event": {
          const capture = String(table.capture);
          const actual = captures.get(capture);
          if (!Array.isArray(actual)) {
            throw new CaseFailure(`capture '${capture}' is not an event list`);
          }
          const expected = resolveRefs(table.events ?? [], captures);
          if (!Array.isArray(expected)) {
            throw new CaseFailure("expect-event.events must be an array");
          }
          if (actual.length !== expected.length) {
            throw new CaseFailure(
              `capture '${capture}' has ${actual.length} events, expected ${expected.length}`,
            );
          }
          expected.forEach((entry, index) => {
            const recorded = actual[index];
            if (!isRecord(entry) || !isRecord(recorded)) {
              throw new CaseFailure(
                `capture '${capture}' event ${index} is not an object`,
              );
            }
            if (recorded.kind !== entry.kind) {
              throw new CaseFailure(
                `capture '${capture}' event ${index} kind ${String(recorded.kind)} != ${String(entry.kind)}`,
              );
            }
            if (
              entry.sequence !== undefined &&
              recorded.sequence !== entry.sequence
            ) {
              throw new CaseFailure(
                `capture '${capture}' event ${index} sequence ${String(recorded.sequence)} != ${String(entry.sequence)}`,
              );
            }
            if (!deepEquals(recorded.payload, entry.payload)) {
              throw new CaseFailure(
                `capture '${capture}' event ${index} payload mismatch: ${JSON.stringify(recorded.payload)}`,
              );
            }
          });
          assertions.push({
            op: "expect-event",
            detail: `${capture} matched ${expected.length} event(s)`,
          });
          break;
        }
        case "expect-capture": {
          const capture = String(table.capture);
          const actual = captures.get(capture);
          const expected = resolveRefs(table.value, captures);
          if (!deepEquals(actual, expected)) {
            throw new CaseFailure(
              `capture '${capture}' was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
            );
          }
          assertions.push({
            op: "expect-capture",
            detail: `${capture} matched`,
          });
          break;
        }
        case "expect-bitty-env": {
          const present = host.bitty.env !== undefined;
          const expected = table.present === true;
          if (present !== expected) {
            throw new CaseFailure(
              `bitty.env present=${present}, expected ${expected}`,
            );
          }
          assertions.push({
            op: "expect-bitty-env",
            detail: `bitty.env present=${present}`,
          });
          break;
        }
        case "begin-activation":
          host.beginActivation();
          assertions.push({ op: "begin-activation", detail: "window opened" });
          break;
        case "end-activation":
          host.endActivation();
          assertions.push({ op: "end-activation", detail: "window closed" });
          break;
        case "suspend":
          host.suspend();
          assertions.push({ op: "suspend", detail: "suspended" });
          break;
        case "dispose":
          host.dispose();
          assertions.push({ op: "dispose", detail: "generation disposed" });
          break;
        case "advance-time":
          host.advanceTimers(Number(table.ms));
          assertions.push({
            op: "advance-time",
            detail: `advanced ${String(table.ms)} ms`,
          });
          break;
        case "drain-tasks":
          host.drainTasks();
          assertions.push({ op: "drain-tasks", detail: "tasks drained" });
          break;
        case "set-terminal-snapshot":
          host.setTerminalSnapshot(
            (table.snapshot ?? {}) as Record<string, unknown>,
          );
          assertions.push({
            op: "set-terminal-snapshot",
            detail: "snapshot installed",
          });
          break;
        case "remove-service":
          host.removeService(String(table.interface));
          assertions.push({
            op: "remove-service",
            detail: `removed ${String(table.interface)}`,
          });
          break;
        default:
          throw new CaseFailure(`unsupported step op '${step.op}'`);
      }
    };

    await withTimeout(
      (async () => {
        for (const step of conformanceCase.steps) {
          if (performance.now() - startedAt > timeoutMs) {
            throw new CaseFailure(
              `case '${conformanceCase.name}' exceeded ${timeoutMs} ms`,
            );
          }
          runStep(step);
        }
        if (performance.now() - startedAt > timeoutMs) {
          throw new CaseFailure(
            `case '${conformanceCase.name}' exceeded ${timeoutMs} ms`,
          );
        }
      })(),
      timeoutMs,
      `case '${conformanceCase.name}'`,
      startedAt,
    );

    if (host.currentState === "active" || host.currentState === "suspended") {
      host.dispose();
    }

    return {
      name,
      file,
      passed: true,
      assertions,
      publishedKinds,
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    };
  } catch (cause) {
    if (
      activeHost !== undefined &&
      (activeHost.currentState === "active" ||
        activeHost.currentState === "suspended")
    ) {
      activeHost.dispose();
    }
    return {
      name,
      file,
      passed: false,
      assertions,
      publishedKinds,
      error: cause instanceof Error ? cause.message : String(cause),
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    };
  }
}

/** Run every `*.json` case in a directory, sorted by file name. */
export async function runConformanceDirectory(
  dir: string,
  options: ConformanceRunOptions,
): Promise<ConformanceCaseResult[]> {
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const results: ConformanceCaseResult[] = [];
  for (const entry of files) {
    results.push(await runConformanceCaseFile(`${dir}/${entry}`, options));
  }
  return results;
}
