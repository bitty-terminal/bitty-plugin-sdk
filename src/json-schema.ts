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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "");
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
  if (schemaDepth(schema) > MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH) {
    return `${path}: schema depth exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_DEPTH}`;
  }
  if (jsonBytes(schema) > MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES) {
    return `${path}: schema exceeds ${MOCK_LIMITS.COMMAND_SCHEMA_MAX_BYTES} bytes`;
  }
  return schemaNodeProblem(schema, path);
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
    if (value !== undefined && (typeof value !== "number" || value < 0)) {
      return `${path}.${name}: expected a non-negative number`;
    }
  }
  for (const name of ["minimum", "maximum"] as const) {
    const value = schema[name];
    if (value !== undefined && typeof value !== "number") {
      return `${path}.${name}: expected a number`;
    }
  }

  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return `${path}.enum: expected an array`;
  }

  const properties = schema.properties;
  const wantsObject =
    types.includes("object") ||
    (types.length === 0 &&
      (properties !== undefined || schema.required !== undefined));

  if (wantsObject) {
    if (properties !== undefined && !isPlainObject(properties)) {
      return `${path}.properties: expected a table`;
    }
    if (schema.additionalProperties === undefined) {
      return `${path}.additionalProperties: must be explicit for object schemas`;
    }
    if (typeof schema.additionalProperties !== "boolean") {
      return `${path}.additionalProperties: expected a boolean`;
    }
    if (isPlainObject(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        const problem = schemaNodeProblem(
          child as Record<string, unknown>,
          `${path}.properties.${name}`,
        );
        if (problem !== undefined) return problem;
      }
    }
  }

  if (types.includes("array")) {
    if (schema.items === undefined) {
      return `${path}.items: array schemas must declare items`;
    }
    if (isPlainObject(schema.items)) {
      const problem = schemaNodeProblem(schema.items, `${path}.items`);
      if (problem !== undefined) return problem;
    } else {
      return `${path}.items: expected a table`;
    }
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
    if (items !== undefined) {
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
