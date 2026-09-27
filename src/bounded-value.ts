/**
 * Shared bounded JSON-value scanning for the mock host and schema validator.
 *
 * Both the schema subset (`json-schema.ts`) and the mock host
 * (`mock-host.ts`) must decide whether an untrusted in-memory value is
 * bounded, plain JSON data before it is used. This module owns that decision
 * so the two call sites cannot drift: one iterative, cycle-aware walk counts
 * depth, nodes, and UTF-8 bytes, and every bound short-circuits as soon as it
 * is exceeded. Byte accounting is a lower bound on the eventual
 * `JSON.stringify` output (string contents, object keys, container braces, and
 * numeric/boolean/null tokens are all counted), so a scan whose byte count
 * exceeds a cap proves the serialized size does too, letting callers reject an
 * oversized value without ever serializing it.
 */

/** UTF-8 byte length of one string. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * True for a plain JSON object: prototype is `Object.prototype` or `null`.
 *
 * `Date`, `Map`, `Set`, `RegExp`, and class instances are rejected so a value
 * cannot masquerade as a JSON table.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Cycle-aware, bounded structural scan report for one JSON-value candidate. */
export interface StructureScan {
  readonly cycle: boolean;
  readonly depth: number;
  readonly nodes: number;
  readonly bytes: number;
  readonly problem?: string;
}

/** Byte overhead of the two quotes surrounding one JSON string. */
const JSON_STRING_OVERHEAD = 2;
/** Byte overhead of one object key: two quotes plus the separating colon. */
const JSON_KEY_OVERHEAD = 3;
/** Byte overhead of one container: its opening and closing bracket/brace. */
const JSON_CONTAINER_OVERHEAD = 2;

/** UTF-8 byte length of the JSON token for `true`/`false`/`null`. */
function primitiveTokenBytes(value: boolean | null): number {
  if (value === null) return 4;
  return value ? 4 : 5;
}

/**
 * Walk `value` with an explicit stack and an ancestor set.
 *
 * The walk is iterative so a deeply nested or self-referential input cannot
 * overflow the call stack, and it tracks ancestors (not all visited nodes) so
 * an acyclic shared-reference (DAG) subtree is not mistaken for a cycle. Every
 * bound — `maxDepth`, `maxNodes`, and `maxBytes` — stops the walk as soon as
 * it is exceeded, returning the accumulated counts; callers compare with `>`.
 * Non-data values (functions, symbols, bigints, `undefined`), non-finite
 * numbers, symbol keys, and non-plain objects fail with a bounded
 * `problem` description. `bytes` counts string contents and object keys fully
 * plus per-node JSON punctuation, so it is a lower bound on the serialized
 * size; when a byte cap is supplied it short-circuits at the cap.
 */
export function scanStructure(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
  maxBytes: number = Number.POSITIVE_INFINITY,
): StructureScan {
  let nodes = 0;
  let depth = 0;
  let bytes = 0;
  let cycle = false;
  let problem: string | undefined;
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; level: number; exit: boolean }> = [
    { value, level: 0, exit: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop() as {
      value: unknown;
      level: number;
      exit: boolean;
    };
    if (frame.exit) {
      ancestors.delete(frame.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > maxNodes) break;
    const current = frame.value;
    if (
      typeof current === "function" ||
      typeof current === "symbol" ||
      typeof current === "bigint" ||
      current === undefined
    ) {
      problem = "value is not JSON-compatible data";
      break;
    }
    if (typeof current === "string") {
      bytes += utf8Bytes(current) + JSON_STRING_OVERHEAD;
      if (bytes > maxBytes) break;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        problem = "value contains a non-finite number";
        break;
      }
      bytes += utf8Bytes(String(current));
      if (bytes > maxBytes) break;
      continue;
    }
    if (current === null || typeof current === "boolean") {
      bytes += primitiveTokenBytes(current);
      if (bytes > maxBytes) break;
      continue;
    }
    if (!Array.isArray(current) && !isPlainObject(current)) {
      problem = "value contains a non-plain object";
      break;
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      problem = "value is not JSON-compatible data";
      break;
    }
    if (ancestors.has(current)) {
      cycle = true;
      break;
    }
    const containerLevel = frame.level + 1;
    if (containerLevel > depth) depth = containerLevel;
    if (containerLevel > maxDepth) break;
    bytes += JSON_CONTAINER_OVERHEAD;
    if (bytes > maxBytes) break;
    ancestors.add(current);
    stack.push({ value: current, level: frame.level, exit: true });
    if (Array.isArray(current)) {
      for (const child of current) {
        stack.push({ value: child, level: containerLevel, exit: false });
      }
    } else {
      for (const [key, child] of Object.entries(current)) {
        bytes += utf8Bytes(key) + JSON_KEY_OVERHEAD;
        if (bytes > maxBytes) break;
        stack.push({ value: child, level: containerLevel, exit: false });
      }
      if (bytes > maxBytes) break;
    }
  }
  return { cycle, depth, nodes, bytes, problem };
}

/**
 * UTF-8 byte length of the JSON encoding of `value`, bounded by `limit`.
 *
 * The bounded structural scan runs first and counts bytes; when the scan shows
 * the value cannot fit (cycle, non-data `problem`, or an exceeded depth, node,
 * or byte cap) `limit + 1` is returned WITHOUT serializing, so a
 * few-node-but-huge-string value or a shared-reference expansion is rejected
 * with a bounded result instead of an unbounded `JSON.stringify` that could
 * exhaust memory. Only when the scan proves the serialized form is bounded
 * does `JSON.stringify` run and return the exact count.
 */
export function jsonBytes(value: unknown, limit: number): number {
  if (Number.isFinite(limit)) {
    const scan = scanStructure(value, limit, limit, limit);
    if (
      scan.cycle ||
      scan.problem !== undefined ||
      scan.nodes > limit ||
      scan.depth > limit ||
      scan.bytes > limit
    ) {
      return limit + 1;
    }
  }
  return utf8Bytes(JSON.stringify(value) ?? "");
}
