import { describe, expect, test } from "bun:test";
import { schemaProblem, valueProblem } from "../src/json-schema.js";

describe("json-schema validation", () => {
  describe("non-object property schema in properties", () => {
    const table: Array<{
      name: string;
      schema: Record<string, unknown>;
      expectedProblem: string;
    }> = [
      {
        name: "scalar number child in properties without type",
        schema: { properties: { x: 123 } },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "scalar string child in properties",
        schema: { properties: { x: "string" } },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "null child in properties",
        schema: { properties: { x: null } },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "array child in properties",
        schema: { properties: { x: [1, 2] } },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "boolean child in properties",
        schema: { properties: { x: true } },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "object schema with non-object child in properties",
        schema: {
          type: "object",
          properties: { x: 123 },
          additionalProperties: false,
        },
        expectedProblem: "$.properties.x: expected a table",
      },
      {
        name: "object schema with non-table properties field",
        schema: {
          type: "object",
          properties: "invalid",
          additionalProperties: false,
        },
        expectedProblem: "$.properties: expected a table",
      },
      {
        name: "nested property schema with non-object child",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nested: {
              type: "object",
              additionalProperties: false,
              properties: { inner: 42 },
            },
          },
        },
        expectedProblem:
          "$.properties.nested.properties.inner: expected a table",
      },
    ];

    for (const entry of table) {
      test(entry.name, () => {
        expect(schemaProblem(entry.schema)).toBe(entry.expectedProblem);
      });
    }
  });

  describe("non-object or invalid items schemas", () => {
    const table: Array<{
      name: string;
      schema: Record<string, unknown>;
      expectedProblem: string;
    }> = [
      {
        name: "number items without explicit array type",
        schema: { items: 123 },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "string items without explicit array type",
        schema: { items: "string" },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "null items without explicit array type",
        schema: { items: null },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "array items without explicit array type",
        schema: { items: [1, 2] },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "boolean items without explicit array type",
        schema: { items: false },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "array type with number items",
        schema: { type: "array", items: 123 },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "array type with null items",
        schema: { type: "array", items: null },
        expectedProblem: "$.items: expected a table",
      },
      {
        name: "array type without items keyword",
        schema: { type: "array" },
        expectedProblem: "$.items: array schemas must declare items",
      },
      {
        name: "items schema with unsupported type",
        schema: { items: { type: "bogus" } },
        expectedProblem: '$.items.type: unsupported type "bogus"',
      },
      {
        name: "items schema with non-object properties child",
        schema: { items: { properties: { x: 123 } } },
        expectedProblem: "$.items.properties.x: expected a table",
      },
      {
        name: "nested array items with non-object child",
        schema: { type: "array", items: { type: "array", items: 42 } },
        expectedProblem: "$.items.items: expected a table",
      },
      {
        name: "string type with invalid items keyword",
        schema: { type: "string", items: 123 },
        expectedProblem: "$.items: expected a table",
      },
    ];

    for (const entry of table) {
      test(entry.name, () => {
        expect(schemaProblem(entry.schema)).toBe(entry.expectedProblem);
      });
    }
  });

  describe("inverted bounds", () => {
    const table: Array<{
      name: string;
      schema: Record<string, unknown>;
      expectedProblem: string;
    }> = [
      {
        name: "minLength > maxLength",
        schema: { minLength: 5, maxLength: 2 },
        expectedProblem: "$.minLength: cannot exceed maxLength",
      },
      {
        name: "minItems > maxItems",
        schema: { minItems: 5, maxItems: 2 },
        expectedProblem: "$.minItems: cannot exceed maxItems",
      },
      {
        name: "minimum > maximum",
        schema: { minimum: 10, maximum: 5 },
        expectedProblem: "$.minimum: cannot exceed maximum",
      },
      {
        name: "typed string with minLength > maxLength",
        schema: { type: "string", minLength: 10, maxLength: 9 },
        expectedProblem: "$.minLength: cannot exceed maxLength",
      },
      {
        name: "typed array with minItems > maxItems",
        schema: {
          type: "array",
          items: { type: "string" },
          minItems: 4,
          maxItems: 3,
        },
        expectedProblem: "$.minItems: cannot exceed maxItems",
      },
      {
        name: "typed number with minimum > maximum",
        schema: { type: "number", minimum: 1.5, maximum: 0.5 },
        expectedProblem: "$.minimum: cannot exceed maximum",
      },
      {
        name: "nested property schema with minLength > maxLength",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 5, maxLength: 1 },
          },
        },
        expectedProblem: "$.properties.name.minLength: cannot exceed maxLength",
      },
      {
        name: "nested items schema with minimum > maximum",
        schema: {
          type: "array",
          items: { type: "integer", minimum: 20, maximum: 10 },
        },
        expectedProblem: "$.items.minimum: cannot exceed maximum",
      },
    ];

    for (const entry of table) {
      test(entry.name, () => {
        expect(schemaProblem(entry.schema)).toBe(entry.expectedProblem);
      });
    }
  });

  describe("non-finite and invalid bounds", () => {
    const table: Array<{
      name: string;
      schema: Record<string, unknown>;
      expectedProblem: string;
    }> = [
      {
        name: "minLength NaN",
        schema: { minLength: Number.NaN },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "minLength Infinity",
        schema: { minLength: Number.POSITIVE_INFINITY },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "minLength -Infinity",
        schema: { minLength: Number.NEGATIVE_INFINITY },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "minLength float",
        schema: { minLength: 1.5 },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "minLength negative",
        schema: { minLength: -1 },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "minLength string",
        schema: { minLength: "3" },
        expectedProblem: "$.minLength: expected a non-negative integer",
      },
      {
        name: "maxLength NaN",
        schema: { maxLength: Number.NaN },
        expectedProblem: "$.maxLength: expected a non-negative integer",
      },
      {
        name: "maxLength Infinity",
        schema: { maxLength: Number.POSITIVE_INFINITY },
        expectedProblem: "$.maxLength: expected a non-negative integer",
      },
      {
        name: "maxLength float",
        schema: { maxLength: 2.7 },
        expectedProblem: "$.maxLength: expected a non-negative integer",
      },
      {
        name: "maxLength negative",
        schema: { maxLength: -1 },
        expectedProblem: "$.maxLength: expected a non-negative integer",
      },
      {
        name: "minItems NaN",
        schema: { minItems: Number.NaN },
        expectedProblem: "$.minItems: expected a non-negative integer",
      },
      {
        name: "minItems Infinity",
        schema: { minItems: Number.POSITIVE_INFINITY },
        expectedProblem: "$.minItems: expected a non-negative integer",
      },
      {
        name: "minItems float",
        schema: { minItems: 3.14 },
        expectedProblem: "$.minItems: expected a non-negative integer",
      },
      {
        name: "minItems negative",
        schema: { minItems: -2 },
        expectedProblem: "$.minItems: expected a non-negative integer",
      },
      {
        name: "maxItems NaN",
        schema: { maxItems: Number.NaN },
        expectedProblem: "$.maxItems: expected a non-negative integer",
      },
      {
        name: "maxItems Infinity",
        schema: { maxItems: Number.POSITIVE_INFINITY },
        expectedProblem: "$.maxItems: expected a non-negative integer",
      },
      {
        name: "maxItems negative",
        schema: { maxItems: -1 },
        expectedProblem: "$.maxItems: expected a non-negative integer",
      },
      {
        name: "minimum NaN",
        schema: { minimum: Number.NaN },
        expectedProblem: "$.minimum: expected a finite number",
      },
      {
        name: "minimum Infinity",
        schema: { minimum: Number.POSITIVE_INFINITY },
        expectedProblem: "$.minimum: expected a finite number",
      },
      {
        name: "minimum -Infinity",
        schema: { minimum: Number.NEGATIVE_INFINITY },
        expectedProblem: "$.minimum: expected a finite number",
      },
      {
        name: "minimum string",
        schema: { minimum: "0" },
        expectedProblem: "$.minimum: expected a finite number",
      },
      {
        name: "maximum NaN",
        schema: { maximum: Number.NaN },
        expectedProblem: "$.maximum: expected a finite number",
      },
      {
        name: "maximum Infinity",
        schema: { maximum: Number.POSITIVE_INFINITY },
        expectedProblem: "$.maximum: expected a finite number",
      },
      {
        name: "maximum -Infinity",
        schema: { maximum: Number.NEGATIVE_INFINITY },
        expectedProblem: "$.maximum: expected a finite number",
      },
    ];

    for (const entry of table) {
      test(entry.name, () => {
        expect(schemaProblem(entry.schema)).toBe(entry.expectedProblem);
      });
    }
  });

  describe("schema keywords without explicit type annotations", () => {
    test("properties with explicit additionalProperties is accepted", () => {
      expect(
        schemaProblem({
          properties: { x: { type: "string" } },
          additionalProperties: false,
        }),
      ).toBeUndefined();
    });

    test("items table without array type is accepted", () => {
      expect(
        schemaProblem({
          items: { type: "string" },
        }),
      ).toBeUndefined();
    });

    test("bounds without string/array/number type are accepted", () => {
      expect(schemaProblem({ minLength: 2, maxLength: 5 })).toBeUndefined();
      expect(schemaProblem({ minItems: 1, maxItems: 3 })).toBeUndefined();
      expect(schemaProblem({ minimum: 0, maximum: 10 })).toBeUndefined();
    });

    test("required without type requires explicit additionalProperties", () => {
      expect(schemaProblem({ required: ["id"] })).toBe(
        "$.additionalProperties: must be explicit for object schemas",
      );
      expect(
        schemaProblem({ required: ["id"], additionalProperties: false }),
      ).toBeUndefined();
    });

    test("additionalProperties alone without type is accepted when boolean", () => {
      expect(schemaProblem({ additionalProperties: false })).toBeUndefined();
      expect(schemaProblem({ additionalProperties: true })).toBeUndefined();
    });

    test("additionalProperties without type rejects non-boolean", () => {
      expect(schemaProblem({ additionalProperties: 123 })).toBe(
        "$.additionalProperties: expected a boolean",
      );
      expect(schemaProblem({ additionalProperties: "false" })).toBe(
        "$.additionalProperties: expected a boolean",
      );
    });

    test("properties without type requires explicit additionalProperties", () => {
      expect(
        schemaProblem({
          properties: { x: { type: "string" } },
        }),
      ).toBe("$.additionalProperties: must be explicit for object schemas");
    });
  });

  describe("valid bounds and equality edge cases", () => {
    test("equal min and max bounds are valid", () => {
      expect(schemaProblem({ minLength: 0, maxLength: 0 })).toBeUndefined();
      expect(schemaProblem({ minLength: 5, maxLength: 5 })).toBeUndefined();
      expect(schemaProblem({ minItems: 0, maxItems: 0 })).toBeUndefined();
      expect(schemaProblem({ minItems: 3, maxItems: 3 })).toBeUndefined();
      expect(schemaProblem({ minimum: 0, maximum: 0 })).toBeUndefined();
      expect(schemaProblem({ minimum: -10, maximum: -10 })).toBeUndefined();
      expect(schemaProblem({ minimum: -5.5, maximum: 5.5 })).toBeUndefined();
    });

    test("valueProblem validates against shape-validated schema", () => {
      const schema = {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, maxItems: 2 },
          count: { type: "integer", minimum: 0, maximum: 10 },
        },
        required: ["tags"],
        additionalProperties: false,
      };
      expect(schemaProblem(schema)).toBeUndefined();
      expect(
        valueProblem(schema, { tags: ["a", "b"], count: 5 }),
      ).toBeUndefined();
      expect(valueProblem(schema, { tags: ["a", "b", "c"], count: 5 })).toBe(
        "$.tags: more items than 2",
      );
      expect(valueProblem(schema, { tags: ["a"], count: -1 })).toBe(
        "$.count: number is below the minimum",
      );
    });
  });
});
