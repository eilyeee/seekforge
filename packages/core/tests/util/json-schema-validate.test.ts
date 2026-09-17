import { describe, expect, it } from "vitest";
import { formatJsonSchemaIssues, jsonSchemaProblems, validateJsonSchema } from "../../src/util/json-schema-validate.js";

const messages = (value: unknown, schema: unknown): string[] =>
  formatJsonSchemaIssues(validateJsonSchema(value, schema));

describe("jsonSchemaProblems", () => {
  it("accepts ordinary schemas", () => {
    expect(
      jsonSchemaProblems({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Result",
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", pattern: "^[a-z]+$" },
          tags: { type: "array", items: { $ref: "#/$defs/tag" } },
        },
        $defs: { tag: { enum: ["a", "b"] } },
        additionalProperties: false,
      }),
    ).toEqual([]);
    expect(jsonSchemaProblems(true)).toEqual([]);
  });

  it("rejects what it could not validate faithfully", () => {
    expect(jsonSchemaProblems("nope")).toEqual(["the schema must be a JSON object (or a boolean)"]);
    const conditional = jsonSchemaProblems(JSON.parse('{"if": {}, "then": {}}')).join();
    expect(conditional).toContain('"if" keyword is not supported');
    expect(conditional).toContain('"then" keyword is not supported');
    expect(jsonSchemaProblems({ properties: { a: { dependentRequired: {} } } }).join()).toContain(
      '#/properties/a: the "dependentRequired" keyword is not supported',
    );
    expect(jsonSchemaProblems({ $ref: "https://example.com/s.json" }).join()).toContain("only local");
    expect(jsonSchemaProblems({ $ref: "#/$defs/missing" }).join()).toContain("does not resolve");
    expect(jsonSchemaProblems({ type: "strin" }).join()).toContain('"type" must be one of');
    expect(jsonSchemaProblems({ type: "string", pattern: "(" }).join()).toContain("valid regular expression");
    expect(jsonSchemaProblems({ required: "a" }).join()).toContain('"required" must be an array');
    expect(jsonSchemaProblems({ minLength: -1 }).join()).toContain("non-negative integer");
    expect(jsonSchemaProblems({ anyOf: [] }).join()).toContain("non-empty array");
    expect(jsonSchemaProblems({ multipleOf: 0 }).join()).toContain("greater than 0");
  });
});

describe("validateJsonSchema", () => {
  it("checks types, including integer and type arrays", () => {
    expect(messages(1.5, { type: "integer" })).toEqual(["(root): expected integer, got number"]);
    expect(messages(2, { type: "number" })).toEqual([]);
    expect(messages(null, { type: ["string", "null"] })).toEqual([]);
    expect(messages([], { type: "object" })).toEqual(["(root): expected object, got array"]);
  });

  it("checks objects: required, additional and pattern properties, names, sizes", () => {
    const schema = {
      type: "object",
      required: ["id", "name"],
      properties: { id: { type: "integer" }, name: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
      propertyNames: { maxLength: 8 },
      maxProperties: 3,
    };
    expect(messages({ id: 1, name: "a", "x-note": "n" }, schema)).toEqual([]);
    expect(messages({ id: "1", "x-note": 2, extra: true }, schema)).toEqual([
      '(root): missing required property "name"',
      "/id: expected integer, got string",
      "/x-note: expected string, got number",
      '(root): unexpected property "extra"',
    ]);
    expect(messages({ id: 1, name: "a", "x-toolongname": "v" }, schema)).toContain(
      '(root): property name "x-toolongname" is not allowed',
    );
    expect(messages({ "a/b": 1 }, { additionalProperties: { type: "string" } })).toEqual([
      "/a~1b: expected string, got number",
    ]);
  });

  it("checks arrays: items, tuples, contains, uniqueness and length", () => {
    expect(messages([1, "a"], { type: "array", items: { type: "integer" } })).toEqual([
      "/1: expected integer, got string",
    ]);
    expect(messages(["a", 1, true], { prefixItems: [{ type: "string" }, { type: "integer" }], items: false })).toEqual([
      "/2: no value is allowed here",
    ]);
    expect(messages(["a", 1, 2], { items: [{ type: "string" }], additionalItems: { type: "integer" } })).toEqual([]);
    expect(messages([{ a: 1 }, { a: 1 }], { uniqueItems: true })).toEqual(["(root): items 0 and 1 must not be equal"]);
    expect(messages([1, 2], { contains: { type: "string" } })).toEqual([
      "(root): must contain at least 1 matching item(s)",
    ]);
    expect(messages([], { minItems: 1 })).toEqual(["(root): must have at least 1 items"]);
  });

  it("checks strings and numbers", () => {
    expect(messages("😀😀", { maxLength: 2 })).toEqual([]);
    expect(messages("abc", { minLength: 4, pattern: "^\\d+$" })).toEqual([
      "(root): must be at least 4 characters",
      "(root): must match pattern ^\\d+$",
    ]);
    expect(messages(10, { minimum: 0, exclusiveMaximum: 10 })).toEqual(["(root): must be < 10"]);
    expect(messages(5, { maximum: 5, exclusiveMaximum: true })).toEqual(["(root): must be < 5"]);
    expect(messages(0.3, { multipleOf: 0.1 })).toEqual([]);
    expect(messages(0.35, { multipleOf: 0.1 })).toEqual(["(root): must be a multiple of 0.1"]);
  });

  it("checks enum and const by JSON equality", () => {
    expect(messages({ b: 2, a: 1 }, { const: { a: 1, b: 2 } })).toEqual([]);
    expect(messages("c", { enum: ["a", "b"] })).toEqual(['(root): must be one of "a", "b"']);
  });

  it("combines schemas with allOf, anyOf, oneOf and not", () => {
    expect(messages(5, { allOf: [{ minimum: 1 }, { maximum: 3 }] })).toEqual(["(root): must be <= 3"]);
    expect(messages("x", { anyOf: [{ type: "integer" }, { type: "string" }] })).toEqual([]);
    expect(messages(true, { anyOf: [{ type: "integer" }, { type: "string" }] })[0]).toContain("anyOf");
    expect(messages(4, { oneOf: [{ minimum: 1 }, { maximum: 10 }] })).toEqual([
      "(root): must match exactly one of the oneOf schemas (matched 2)",
    ]);
    expect(messages("a", { not: { type: "string" } })).toEqual(['(root): must not match the schema in "not"']);
  });

  it("follows local references, including recursive ones", () => {
    const tree = {
      $defs: {
        node: {
          type: "object",
          required: ["children"],
          properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
        },
      },
      $ref: "#/$defs/node",
    };
    expect(messages({ children: [{ children: [] }] }, tree)).toEqual([]);
    expect(messages({ children: [{ kids: [] }] }, tree)).toEqual(['/children/0: missing required property "children"']);
    expect(messages(1, { definitions: { "a/b": { type: "string" } }, $ref: "#/definitions/a~1b" })).toEqual([
      "(root): expected string, got number",
    ]);
  });

  it("stops on a reference cycle instead of recursing forever", () => {
    expect(messages(1, { $ref: "#" })).toEqual(["(root): the schema is too deeply recursive to validate"]);
  });

  it("caps the number of issues", () => {
    const value = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(validateJsonSchema(value, { additionalProperties: { type: "string" } })).toHaveLength(20);
  });
});
