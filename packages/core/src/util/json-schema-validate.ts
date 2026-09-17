/**
 * A dependency-free JSON Schema validator for the subset a caller-supplied
 * output schema realistically uses (CLI `--json-schema`). `tools/json-schema.ts`
 * only converts zod to JSON Schema; nothing else in the repository validates a
 * value against one.
 *
 * Supported: type (incl. type arrays), enum, const, numeric bounds and
 * multipleOf, string length and pattern, array items/prefixItems/
 * additionalItems/contains/uniqueness/length, object properties/
 * patternProperties/additionalProperties/propertyNames/required/size,
 * allOf/anyOf/oneOf/not, and local `$ref` (`#`, `#/$defs/…`,
 * `#/definitions/…`). Annotations (title, description, format, …) are ignored,
 * as the specification allows.
 *
 * Assertion keywords outside that subset are REJECTED by jsonSchemaProblems
 * rather than ignored: a validator that silently skips `if`/`then` would
 * certify output the schema's author meant to refuse.
 */

export type JsonSchemaIssue = { path: string; message: string };

const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

const UNSUPPORTED_KEYWORDS = [
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$dynamicRef",
  "$recursiveRef",
  "contentSchema",
] as const;

/** Keywords whose value is a subschema. */
const SCHEMA_KEYWORDS = ["additionalProperties", "propertyNames", "contains", "not", "additionalItems"] as const;
/** Keywords whose value is a map of subschemas. */
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"] as const;
/** Keywords whose value is a non-empty array of subschemas. */
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const NUMBER_KEYWORDS = ["minimum", "maximum", "multipleOf"] as const;
const COUNT_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
] as const;

/** Schema steps (including `$ref` hops) one validation may take before giving up. */
const MAX_SCHEMA_STEPS = 100_000;
/** Nesting depth of schema or value the validator follows. */
const MAX_DEPTH = 128;
const MAX_ISSUES = 20;

type Schema = boolean | Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "boolean" || isObject(value);
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Resolves a local `$ref` against the root schema; undefined when it does not resolve. */
function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#")) return undefined;
  let fragment: string;
  try {
    fragment = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const raw of fragment.slice(1).split("/")) {
    const key = pointerSegment(raw);
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      node = node[Number(key)];
    } else if (isObject(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return isSchema(node) ? node : undefined;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
}

/**
 * Structural problems that make `schema` unusable here: not a schema, an
 * unsupported assertion keyword, a malformed keyword value, a pattern that does
 * not compile, or a `$ref` that is not local or does not resolve. Empty when
 * the schema can be validated against.
 */
export function jsonSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isSchema(schema)) return ["the schema must be a JSON object (or a boolean)"];
  const root = schema;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (problems.length >= MAX_ISSUES) return;
    if (depth > MAX_DEPTH) {
      problems.push(`${path}: schema nesting is deeper than ${MAX_DEPTH}`);
      return;
    }
    if (typeof node === "boolean") return;
    if (!isObject(node)) {
      problems.push(`${path}: a subschema must be an object or a boolean`);
      return;
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(node, keyword)) problems.push(`${path}: the "${keyword}" keyword is not supported`);
    }
    if (Object.hasOwn(node, "type")) {
      const type = node.type;
      const list = Array.isArray(type) ? type : [type];
      if (list.length === 0 || !list.every((t) => typeof t === "string" && TYPES.has(t))) {
        problems.push(`${path}: "type" must be one of ${[...TYPES].join(", ")} (or an array of them)`);
      }
    }
    if (Object.hasOwn(node, "enum") && !Array.isArray(node.enum)) problems.push(`${path}: "enum" must be an array`);
    if (Object.hasOwn(node, "required")) {
      const required = node.required;
      if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
        problems.push(`${path}: "required" must be an array of strings`);
      }
    }
    for (const keyword of NUMBER_KEYWORDS) {
      if (Object.hasOwn(node, keyword) && (typeof node[keyword] !== "number" || !Number.isFinite(node[keyword]))) {
        problems.push(`${path}: "${keyword}" must be a number`);
      }
    }
    if (typeof node.multipleOf === "number" && node.multipleOf <= 0) {
      problems.push(`${path}: "multipleOf" must be greater than 0`);
    }
    for (const keyword of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
      if (!Object.hasOwn(node, keyword)) continue;
      const value = node[keyword];
      // Draft 4 spelled these as booleans modifying minimum/maximum.
      if (typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
        problems.push(`${path}: "${keyword}" must be a number`);
      }
    }
    for (const keyword of COUNT_KEYWORDS) {
      if (Object.hasOwn(node, keyword) && !isCount(node[keyword])) {
        problems.push(`${path}: "${keyword}" must be a non-negative integer`);
      }
    }
    if (Object.hasOwn(node, "uniqueItems") && typeof node.uniqueItems !== "boolean") {
      problems.push(`${path}: "uniqueItems" must be a boolean`);
    }
    if (Object.hasOwn(node, "pattern")) {
      if (typeof node.pattern !== "string" || compilePattern(node.pattern) === undefined) {
        problems.push(`${path}: "pattern" must be a valid regular expression`);
      }
    }
    if (Object.hasOwn(node, "$ref")) {
      const ref = node.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#")) {
        problems.push(`${path}: only local "$ref" values (starting with "#") are supported`);
      } else if (resolveRef(root, ref) === undefined) {
        problems.push(`${path}: "$ref" ${ref} does not resolve to a schema`);
      }
    }
    for (const keyword of SCHEMA_KEYWORDS) {
      if (Object.hasOwn(node, keyword)) visit(node[keyword], `${path}/${keyword}`, depth + 1);
    }
    if (Object.hasOwn(node, "items")) {
      const items = node.items;
      if (Array.isArray(items)) {
        for (const [i, item] of items.entries()) visit(item, `${path}/items/${i}`, depth + 1);
      } else {
        visit(items, `${path}/items`, depth + 1);
      }
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      if (!Object.hasOwn(node, keyword)) continue;
      const map = node[keyword];
      if (!isObject(map)) {
        problems.push(`${path}: "${keyword}" must be an object`);
        continue;
      }
      for (const [key, sub] of Object.entries(map)) {
        if (keyword === "patternProperties" && compilePattern(key) === undefined) {
          problems.push(`${path}/patternProperties: "${key}" is not a valid regular expression`);
        }
        visit(sub, `${path}/${keyword}/${key}`, depth + 1);
      }
    }
    for (const keyword of SCHEMA_LIST_KEYWORDS) {
      if (!Object.hasOwn(node, keyword)) continue;
      const list = node[keyword];
      if (!Array.isArray(list) || list.length === 0) {
        problems.push(`${path}: "${keyword}" must be a non-empty array of schemas`);
        continue;
      }
      for (const [i, sub] of list.entries()) visit(sub, `${path}/${keyword}/${i}`, depth + 1);
    }
  };
  visit(schema, "#", 0);
  return problems.slice(0, MAX_ISSUES);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function childPath(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function describe(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  if (!Number.isFinite(quotient)) return false;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/**
 * Validates a JSON value against `schema`. Returns up to 20 issues, each with
 * a JSON-pointer path into the value; empty means valid. Call
 * jsonSchemaProblems first — a schema it rejects is not validated faithfully.
 */
export function validateJsonSchema(value: unknown, schema: unknown): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  if (!isSchema(schema)) return [{ path: "", message: "the schema is not a JSON Schema" }];
  const root = schema;
  let steps = 0;

  // `collect` returns this node's issues without recording them, so anyOf /
  // oneOf / not can try a branch and discard what it said.
  const check = (node: Schema, data: unknown, path: string, depth: number, out: JsonSchemaIssue[]): void => {
    if (out.length >= MAX_ISSUES) return;
    steps++;
    if (steps > MAX_SCHEMA_STEPS || depth > MAX_DEPTH) {
      out.push({ path, message: "the schema is too deeply recursive to validate" });
      return;
    }
    if (node === true) return;
    if (node === false) {
      out.push({ path, message: "no value is allowed here" });
      return;
    }
    const push = (message: string, at = path): void => {
      if (out.length < MAX_ISSUES) out.push({ path: at, message });
    };
    const trial = (sub: unknown, at: string, target: unknown = data): JsonSchemaIssue[] => {
      const local: JsonSchemaIssue[] = [];
      if (isSchema(sub)) check(sub, target, at, depth + 1, local);
      return local;
    };
    const nested = (sub: unknown, target: unknown, at: string): void => {
      if (isSchema(sub)) check(sub, target, at, depth + 1, out);
    };

    if (typeof node.$ref === "string") {
      const target = resolveRef(root, node.$ref);
      if (target === undefined) push(`$ref ${node.$ref} does not resolve`);
      else check(target, data, path, depth + 1, out);
    }

    if (node.type !== undefined) {
      const types = (Array.isArray(node.type) ? node.type : [node.type]).filter(
        (t): t is string => typeof t === "string",
      );
      if (!types.some((type) => matchesType(data, type))) {
        push(`expected ${types.join(" or ")}, got ${typeOf(data) === "integer" ? "number" : typeOf(data)}`);
        return;
      }
    }
    if (Array.isArray(node.enum) && !node.enum.some((option) => jsonEqual(option, data))) {
      push(`must be one of ${node.enum.map(describe).join(", ")}`);
    }
    if (Object.hasOwn(node, "const") && !jsonEqual(node.const, data)) {
      push(`must equal ${describe(node.const)}`);
    }

    if (typeof data === "number") {
      if (typeof node.minimum === "number") {
        const exclusive = node.exclusiveMinimum === true;
        if (exclusive ? data <= node.minimum : data < node.minimum) {
          push(`must be ${exclusive ? ">" : ">="} ${node.minimum}`);
        }
      }
      if (typeof node.maximum === "number") {
        const exclusive = node.exclusiveMaximum === true;
        if (exclusive ? data >= node.maximum : data > node.maximum) {
          push(`must be ${exclusive ? "<" : "<="} ${node.maximum}`);
        }
      }
      if (typeof node.exclusiveMinimum === "number" && data <= node.exclusiveMinimum) {
        push(`must be > ${node.exclusiveMinimum}`);
      }
      if (typeof node.exclusiveMaximum === "number" && data >= node.exclusiveMaximum) {
        push(`must be < ${node.exclusiveMaximum}`);
      }
      if (typeof node.multipleOf === "number" && node.multipleOf > 0 && !isMultipleOf(data, node.multipleOf)) {
        push(`must be a multiple of ${node.multipleOf}`);
      }
    }

    if (typeof data === "string") {
      const length = Array.from(data).length;
      if (typeof node.minLength === "number" && length < node.minLength) {
        push(`must be at least ${node.minLength} characters`);
      }
      if (typeof node.maxLength === "number" && length > node.maxLength) {
        push(`must be at most ${node.maxLength} characters`);
      }
      if (typeof node.pattern === "string") {
        const pattern = compilePattern(node.pattern);
        if (!pattern) push(`pattern ${node.pattern} is not a valid regular expression`);
        else if (!pattern.test(data)) push(`must match pattern ${node.pattern}`);
      }
    }

    if (Array.isArray(data)) {
      if (typeof node.minItems === "number" && data.length < node.minItems) {
        push(`must have at least ${node.minItems} items`);
      }
      if (typeof node.maxItems === "number" && data.length > node.maxItems) {
        push(`must have at most ${node.maxItems} items`);
      }
      if (node.uniqueItems === true) {
        outer: for (let i = 0; i < data.length; i++) {
          for (let j = i + 1; j < data.length; j++) {
            if (jsonEqual(data[i], data[j])) {
              push(`items ${i} and ${j} must not be equal`);
              break outer;
            }
          }
        }
      }
      // Draft 2020-12 tuples use prefixItems + items; draft 4-7 use an items
      // array + additionalItems.
      const tuple = Array.isArray(node.prefixItems)
        ? node.prefixItems
        : Array.isArray(node.items)
          ? node.items
          : undefined;
      const rest = Array.isArray(node.prefixItems)
        ? node.items
        : Array.isArray(node.items)
          ? node.additionalItems
          : node.items;
      data.forEach((item, i) => {
        const at = childPath(path, i);
        if (tuple && i < tuple.length) nested(tuple[i], item, at);
        else if (rest !== undefined) nested(rest, item, at);
      });
      if (node.contains !== undefined) {
        const matches = data.filter((item, i) => trial(node.contains, childPath(path, i), item).length === 0).length;
        const min = typeof node.minContains === "number" ? node.minContains : 1;
        if (matches < min) push(`must contain at least ${min} matching item(s)`);
        if (typeof node.maxContains === "number" && matches > node.maxContains) {
          push(`must contain at most ${node.maxContains} matching item(s)`);
        }
      }
    }

    if (isObject(data)) {
      const keys = Object.keys(data);
      if (typeof node.minProperties === "number" && keys.length < node.minProperties) {
        push(`must have at least ${node.minProperties} properties`);
      }
      if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) {
        push(`must have at most ${node.maxProperties} properties`);
      }
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (typeof key === "string" && !Object.hasOwn(data, key)) push(`missing required property "${key}"`);
        }
      }
      const properties = isObject(node.properties) ? node.properties : {};
      const patterns = isObject(node.patternProperties)
        ? Object.entries(node.patternProperties).map(([source, sub]) => [compilePattern(source), sub] as const)
        : [];
      for (const key of keys) {
        const at = childPath(path, key);
        let matched = false;
        if (Object.hasOwn(properties, key)) {
          matched = true;
          nested(properties[key], data[key], at);
        }
        for (const [pattern, sub] of patterns) {
          if (pattern?.test(key)) {
            matched = true;
            nested(sub, data[key], at);
          }
        }
        if (!matched && node.additionalProperties !== undefined) {
          if (node.additionalProperties === false) push(`unexpected property "${key}"`);
          else nested(node.additionalProperties, data[key], at);
        }
        if (node.propertyNames !== undefined && trial(node.propertyNames, at, key).length > 0) {
          push(`property name "${key}" is not allowed`);
        }
      }
    }

    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((sub) => {
        nested(sub, data, path);
      });
    }
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf.map((sub) => trial(sub, path));
      if (!branches.some((branch) => branch.length === 0)) {
        push(`must match at least one of the anyOf schemas (${branches[0]?.[0]?.message ?? "no match"})`);
      }
    }
    if (Array.isArray(node.oneOf)) {
      const passing = node.oneOf.filter((sub) => trial(sub, path).length === 0).length;
      if (passing !== 1) push(`must match exactly one of the oneOf schemas (matched ${passing})`);
    }
    if (node.not !== undefined && trial(node.not, path).length === 0) {
      push('must not match the schema in "not"');
    }
  };

  check(root, value, "", 0, issues);
  return issues.slice(0, MAX_ISSUES);
}

/** One line per issue, e.g. `/items/0/name: expected string, got number`. */
export function formatJsonSchemaIssues(issues: JsonSchemaIssue[]): string[] {
  return issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`);
}
