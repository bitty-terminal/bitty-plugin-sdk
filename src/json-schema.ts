/**
 * Bounded JSON Schema subset for the mock host (R-SDK-3).
 *
 * The accepted surface bounds command and service schemas to "depth at most 16,
 * bounded string fields, flag `additionalProperties` explicit, total size at
 * most `CMD_SCHEMA_MAX_BYTES`, no remote `$ref` and no unbounded patterns"
 * (ADR 0009 LUA-OQ-3; CLI Contract RFC). This module implements a strict
 * subset: a schema that uses a keyword or form outside the subset is rejected
 * at registration with `E_SCHEMA_INVALID` instead of being silently ignored,
 * so the mock host is never more permissive than the accepted contract.
 */

import {
  isPlainObject,
  jsonBytes,
  scanStructure,
  utf8Bytes,
} from "./bounded-value.js";
import { MOCK_LIMITS } from "./host-surface.js";

/** JSON-compatible value. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Untyped schema table as it arrives from fixtures or plugin registrations. */
export type JsonSchema = Record<string, unknown>;

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "title",
  "description",
  "default",
]);

const JSON_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "$defs",
  "definitions",
  "pattern",
  "format",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "const",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "contains",
  "prefixItems",
]);

/**
 * Generic depth ceiling for one whole schema table.
 *
 * One semantic schema level (a `properties`/`items` edge) expands to at most
 * two generic JSON levels (the keyword wrapper plus the child table), so the
 * accepted semantic depth of {@link MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH} maps
 * to roughly twice that plus the root. The small constant margin keeps the
 * bound independent of the exact keyword shape; callers still enforce the
 * semantic depth separately.
 */
const SCHEMA_DATA_MAX_DEPTH = 2 * MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH + 4;

/**
 * Validate one bounded JSON-compatible datum embedded in a schema (`enum`
 * member or `default` value). Returns `undefined` when the value is accepted.
 *
 * The scan counts bytes under the schema byte cap, so a huge string member is
 * rejected here instead of being serialized.
 */
function schemaValueProblem(value: unknown, path: string): string | undefined {
  const scan = scanStructure(
    value,
    SCHEMA_DATA_MAX_DEPTH,
    MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES,
    MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES,
  );
  if (scan.cycle) return `${path}: value contains a cyclic reference`;
  if (scan.problem !== undefined) return `${path}: ${scan.problem}`;
  if (
    scan.depth > SCHEMA_DATA_MAX_DEPTH ||
    scan.nodes > MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES ||
    scan.bytes > MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES
  ) {
    return `${path}: value exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES} bytes`;
  }
  return undefined;
}

/** Structural depth of the schema tree (scalar leaves are depth 0). */
function schemaDepth(schema: unknown): number {
  if (!isPlainObject(schema)) return 0;
  let depth = 0;
  for (const key of ["properties", "items"]) {
    const child = schema[key];
    if (key === "properties" && isPlainObject(child)) {
      for (const nested of Object.values(child)) {
        depth = Math.max(depth, schemaDepth(nested));
      }
    } else if (key === "items") {
      depth = Math.max(depth, schemaDepth(child));
    }
  }
  return depth + 1;
}

/**
 * Validate a schema fragment against the supported subset.
 *
 * Returns a bounded problem description, or `undefined` when the schema is
 * acceptable.
 */
export function schemaProblem(schema: unknown, path = "$"): string | undefined {
  if (!isPlainObject(schema)) {
    return `${path}: schema must be a table`;
  }
  // Cycle, depth, node, and byte bounds are enforced by one bounded scan before
  // any serialization: a cyclic schema or one whose byte count (counting every
  // string leaf and object key) already exceeds the cap fails with a bounded
  // problem instead of a native `JSON.stringify` throw or an OOM. Non-plain,
  // non-finite, and unsupported leaves are reported by
  // `schemaNodeProblem`/`schemaValueProblem` with their precise keyword paths.
  const scan = scanStructure(
    schema,
    SCHEMA_DATA_MAX_DEPTH,
    MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES,
    MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES,
  );
  if (scan.cycle) {
    return `${path}: schema contains a cyclic reference`;
  }
  // The bounded scan stops at `SCHEMA_DATA_MAX_DEPTH`; any chain that long is
  // necessarily over the accepted semantic depth, and `schemaDepth` /
  // `schemaNodeProblem` would recurse without bound (or overflow) on a long
  // cyclic chain, so reject it here instead.
  if (scan.depth > SCHEMA_DATA_MAX_DEPTH) {
    return `${path}: schema depth exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH}`;
  }
  if (
    scan.nodes > MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES ||
    scan.bytes > MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES
  ) {
    return `${path}: schema exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES} bytes`;
  }
  if (schemaDepth(schema) > MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH) {
    return `${path}: schema depth exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH}`;
  }
  // Structural validation runs before the exact byte measurement: a hostile
  // leaf (`bigint`, `undefined`, non-plain object) is rejected with its keyword
  // path instead of reaching a `JSON.stringify` throw.
  const structural = schemaNodeProblem(schema, path);
  if (structural !== undefined) return structural;
  // Any non-data value left outside the typed keyword checks (for example a
  // numeric `title`) is still rejected with the bounded scan problem before
  // the exact byte measurement can throw.
  if (scan.problem !== undefined) {
    return `${path}: ${scan.problem}`;
  }
  if (
    jsonBytes(schema, MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES) >
    MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES
  ) {
    return `${path}: schema exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES} bytes`;
  }
  return undefined;
}

function schemaNodeProblem(
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      return `${path}.${key}: keyword is not supported by the mock host subset`;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      return `${path}.${key}: unknown schema keyword`;
    }
  }

  const type = schema.type;
  const types: string[] =
    typeof type === "string"
      ? [type]
      : Array.isArray(type) && type.every((entry) => typeof entry === "string")
        ? (type as string[])
        : type === undefined
          ? []
          : [""];
  if (type !== undefined && types.length === 0) {
    return `${path}.type: type union must not be empty`;
  }
  for (const entry of types) {
    if (!JSON_TYPES.has(entry)) {
      return `${path}.type: unsupported type ${JSON.stringify(entry)}`;
    }
  }

  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      !schema.required.every((entry) => typeof entry === "string")
    ) {
      return `${path}.required: expected an array of strings`;
    }
  }

  const bounds: ReadonlyArray<[string, unknown]> = [
    ["minLength", schema.minLength],
    ["maxLength", schema.maxLength],
    ["minItems", schema.minItems],
    ["maxItems", schema.maxItems],
  ];
  for (const [name, value] of bounds) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      return `${path}.${name}: expected a non-negative integer`;
    }
  }
  if (
    typeof schema.minLength === "number" &&
    typeof schema.maxLength === "number" &&
    schema.minLength > schema.maxLength
  ) {
    return `${path}.minLength: cannot exceed maxLength`;
  }
  if (
    typeof schema.minItems === "number" &&
    typeof schema.maxItems === "number" &&
    schema.minItems > schema.maxItems
  ) {
    return `${path}.minItems: cannot exceed maxItems`;
  }

  for (const name of ["minimum", "maximum"] as const) {
    const value = schema[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return `${path}.${name}: expected a finite number`;
    }
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    return `${path}.minimum: cannot exceed maximum`;
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      return `${path}.enum: expected an array`;
    }
    for (let index = 0; index < schema.enum.length; index += 1) {
      const problem = schemaValueProblem(
        schema.enum[index],
        `${path}.enum[${index}]`,
      );
      if (problem !== undefined) return problem;
    }
  }

  if (schema.default !== undefined) {
    const problem = schemaValueProblem(schema.default, `${path}.default`);
    if (problem !== undefined) return problem;
  }

  const properties = schema.properties;
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      return `${path}.properties: expected a table`;
    }
    for (const [name, child] of Object.entries(properties)) {
      if (!isPlainObject(child)) {
        return `${path}.properties.${name}: expected a table`;
      }
      const problem = schemaNodeProblem(child, `${path}.properties.${name}`);
      if (problem !== undefined) return problem;
    }
  }

  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    return `${path}.additionalProperties: expected a boolean`;
  }

  const wantsObject =
    types.includes("object") ||
    (types.length === 0 &&
      (properties !== undefined ||
        schema.required !== undefined ||
        schema.additionalProperties !== undefined));

  if (wantsObject) {
    if (schema.additionalProperties === undefined) {
      return `${path}.additionalProperties: must be explicit for object schemas`;
    }
  }

  if (types.includes("array")) {
    if (schema.items === undefined) {
      return `${path}.items: array schemas must declare items`;
    }
  }

  if (schema.items !== undefined) {
    if (!isPlainObject(schema.items)) {
      return `${path}.items: expected a table`;
    }
    const problem = schemaNodeProblem(schema.items, `${path}.items`);
    if (problem !== undefined) return problem;
  }

  return undefined;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => deepEquals(entry, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
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

/**
 * Validate one JSON value against a schema accepted by {@link schemaProblem}.
 *
 * Returns a bounded problem description, or `undefined` when the value is
 * valid. Assumes the schema is already shape-validated.
 */
export function valueProblem(
  schema: Record<string, unknown>,
  value: unknown,
  path = "$",
): string | undefined {
  const type = schema.type;
  const types: string[] =
    typeof type === "string"
      ? [type]
      : Array.isArray(type)
        ? (type as string[])
        : [];
  if (types.length > 0 && !types.some((entry) => matchesType(entry, value))) {
    return `${path}: expected ${types.join(" or ")}, got ${jsonTypeOf(value)}`;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((entry) => deepEquals(entry, value))) {
      return `${path}: value is not one of the allowed values`;
    }
  }

  if (typeof value === "string") {
    const bytes = utf8Bytes(value);
    if (typeof schema.minLength === "number" && bytes < schema.minLength) {
      return `${path}: string is shorter than ${schema.minLength} bytes`;
    }
    if (typeof schema.maxLength === "number" && bytes > schema.maxLength) {
      return `${path}: string is longer than ${schema.maxLength} bytes`;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${path}: number is below the minimum`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${path}: number is above the maximum`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path}: fewer items than ${schema.minItems}`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path}: more items than ${schema.maxItems}`;
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items !== undefined && isPlainObject(items)) {
      for (let index = 0; index < value.length; index += 1) {
        const problem = valueProblem(items, value[index], `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        return `${path}.${name}: required field is missing`;
      }
    }
    const properties = isPlainObject(schema.properties)
      ? schema.properties
      : {};
    for (const [name, child] of Object.entries(value)) {
      const propertySchema = properties[name];
      if (isPlainObject(propertySchema)) {
        const problem = valueProblem(propertySchema, child, `${path}.${name}`);
        if (problem !== undefined) return problem;
      } else if (schema.additionalProperties === false) {
        return `${path}.${name}: additional property is not allowed`;
      }
    }
  }

  return undefined;
}
