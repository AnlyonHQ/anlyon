const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "default",
]);

export const FORMATS: Record<string, (value: string) => boolean> = {
  uri: (value) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  date: (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  },
  "date-time": (value) =>
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
  email: (value) => /^[^\s@]+@[^\s@]+$/.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
};

const COUNT_KEYWORDS = ["minLength", "maxLength", "minItems", "maxItems"] as const;

const BOUND_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;

const SUPPORTED_TYPES = new Set([
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
]);

const MAX_DEPTH = 8;

export const MAX_PATTERN_LENGTH = 512;

export const MAX_PATTERN_SUBJECT_LENGTH = 4096;

export function unsafePatternReason(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `it is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  type Frame = { quantified: boolean; alternation: boolean; start: number; body?: string };
  const groups: Frame[] = [];
  let lastGroup: Frame | null = null;

  const markQuantifier = () => {
    if (groups.length > 0) groups[groups.length - 1].quantified = true;
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const closed = lastGroup;
    lastGroup = null;

    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) {
        return "it uses a backreference";
      }
      i++;
      continue;
    }

    if (ch === "[") {
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      continue;
    }

    if (ch === "(") {
      const frame: Frame = { quantified: false, alternation: false, start: i + 1 };
      groups.push(frame);
      if (pattern[i + 1] === "?") {
        i++;
        if (pattern[i + 1] === "<" && pattern[i + 2] !== "=" && pattern[i + 2] !== "!") {
          const end = pattern.indexOf(">", i);
          if (end !== -1) i = end;
        } else {
          i++;
        }
      }
      frame.start = i + 1;
      continue;
    }

    if (ch === ")") {
      const body = groups.pop();
      if (body) {
        body.body = pattern.slice(body.start, i);
        lastGroup = body;
        if (body.quantified) markQuantifier();
      }
      continue;
    }

    if (ch === "|") {
      if (groups.length > 0) groups[groups.length - 1].alternation = true;
      continue;
    }

    const isQuantifier = ch === "*" || ch === "+" || ch === "?" || (ch === "{" && /^\{\d*(,\d*)?\}/.test(pattern.slice(i)));
    if (isQuantifier) {
      const repeats = ch !== "?" && !(ch === "{" && /^\{\d+\}/.test(pattern.slice(i)));
      if (closed && repeats) {
        if (closed.alternation) return "a repeated group contains an alternation (like (a|a)*)";
        if (closed.quantified && !isDelimitedBody(closed.body ?? "")) {
          return "a repeated group contains another quantifier (nested quantifiers, like (a+)+)";
        }
      }
      markQuantifier();
      if (ch === "{") i = pattern.indexOf("}", i);
      continue;
    }
  }

  return null;
}

type PatternAtom =
  | { kind: "char"; ch: string; quantified: boolean }
  | { kind: "set"; matches: (c: string) => boolean; quantified: boolean }
  | { kind: "group"; atoms: PatternAtom[]; quantified: boolean }
  | { kind: "zero-width"; quantified: boolean };

function isDelimitedBody(body: string): boolean {
  const atoms = parseSequence(body);
  if (!atoms || !noAdjacentRepeats(atoms)) return false;
  return atoms.some((separator) => {
    if (separator.kind !== "char" || separator.quantified) return false;
    const c = separator.ch;
    const clashes = (list: PatternAtom[], top: boolean): boolean =>
      list.some((atom) => {
        if (atom === separator) return false;
        if (top && atom.kind === "char" && !atom.quantified && atom.ch === c) return false;
        if (atom.kind === "char") return atom.ch === c;
        if (atom.kind === "set") return atom.matches(c);
        if (atom.kind === "group") return clashes(atom.atoms, false);
        return false;
      });
    return !clashes(atoms, true);
  });
}

function noAdjacentRepeats(atoms: PatternAtom[]): boolean {
  const pieces = atoms.filter((atom) => atom.kind !== "zero-width");
  for (let k = 0; k < pieces.length; k++) {
    const atom = pieces[k];
    if (atom.quantified && pieces[k + 1]?.quantified) return false;
    if (atom.kind === "group" && !noAdjacentRepeats(atom.atoms)) return false;
  }
  return true;
}

const CLASS_ESCAPES: Record<string, (c: string) => boolean> = {
  d: (c) => /\d/.test(c),
  D: (c) => !/\d/.test(c),
  w: (c) => /\w/.test(c),
  W: (c) => !/\w/.test(c),
  s: (c) => /\s/.test(c),
  S: (c) => !/\s/.test(c),
};

const LITERAL_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", "0": "\0" };

function parseSequence(src: string): PatternAtom[] | null {
  let i = 0;

  const parseClass = (): ((c: string) => boolean) | null => {
    i++;
    const negated = src[i] === "^";
    if (negated) i++;
    const tests: Array<(c: string) => boolean> = [];
    let first = true;
    const single = (): string | ((c: string) => boolean) | null => {
      if (src[i] === "\\") {
        const e = src[i + 1];
        i += 2;
        if (e === undefined || e === "u" || e === "x" || e === "c" || e === "p" || e === "P") return null;
        return CLASS_ESCAPES[e] ?? LITERAL_ESCAPES[e] ?? e;
      }
      return src[i++];
    };
    while (i < src.length && (src[i] !== "]" || first)) {
      first = false;
      const lo = single();
      if (lo === null) return null;
      if (typeof lo === "string" && src[i] === "-" && src[i + 1] !== undefined && src[i + 1] !== "]") {
        i++;
        const hi = single();
        if (hi === null || typeof hi !== "string") return null;
        tests.push((c) => c >= lo && c <= hi);
      } else if (typeof lo === "string") {
        tests.push((c) => c === lo);
      } else {
        tests.push(lo);
      }
    }
    if (src[i] !== "]") return null;
    i++;
    return (c) => tests.some((t) => t(c)) !== negated;
  };

  const parse = (depth: number): PatternAtom[] | null => {
    const atoms: PatternAtom[] = [];
    while (i < src.length) {
      const ch = src[i];
      let atom: PatternAtom;
      if (ch === ")") {
        if (depth === 0) return null;
        return atoms;
      }
      if (ch === "|") return null;
      if (ch === "(") {
        if (src.startsWith("(?=", i) || src.startsWith("(?!", i) || src.startsWith("(?<=", i) || src.startsWith("(?<!", i)) {
          let level = 0;
          for (; i < src.length; i++) {
            if (src[i] === "\\") i++;
            else if (src[i] === "[") {
              const end = src.indexOf("]", i + 2);
              if (end === -1) return null;
              i = end;
            } else if (src[i] === "(") level++;
            else if (src[i] === ")" && --level === 0) break;
          }
          if (i >= src.length) return null;
          i++;
          atom = { kind: "zero-width", quantified: false };
        } else {
          i++;
          if (src.startsWith("?:", i)) i += 2;
          else if (src[i] === "?" && src[i + 1] === "<") {
            const end = src.indexOf(">", i);
            if (end === -1) return null;
            i = end + 1;
          }
          const inner = parse(depth + 1);
          if (!inner || src[i] !== ")") return null;
          i++;
          atom = { kind: "group", atoms: inner, quantified: false };
        }
      } else if (ch === "[") {
        const matches = parseClass();
        if (!matches) return null;
        atom = { kind: "set", matches, quantified: false };
      } else if (ch === "\\") {
        const e = src[i + 1];
        i += 2;
        if (e === undefined || e === "u" || e === "x" || e === "c" || e === "p" || e === "P") return null;
        if (e === "b" || e === "B") atom = { kind: "zero-width", quantified: false };
        else if (CLASS_ESCAPES[e]) atom = { kind: "set", matches: CLASS_ESCAPES[e], quantified: false };
        else atom = { kind: "char", ch: LITERAL_ESCAPES[e] ?? e, quantified: false };
      } else if (ch === "^" || ch === "$") {
        i++;
        atom = { kind: "zero-width", quantified: false };
      } else if (ch === ".") {
        i++;
        atom = { kind: "set", matches: (c) => c !== "\n" && c !== "\r", quantified: false };
      } else {
        i++;
        atom = { kind: "char", ch, quantified: false };
      }

      const q = src[i];
      const counted = q === "{" ? /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i)) : null;
      if (q === "*" || q === "+" || q === "?" || counted) {
        atom.quantified = !(counted && counted[2] === undefined);
        i += counted ? counted[0].length : 1;
        if (src[i] === "?") i++;
      }
      atoms.push(atom);
    }
    return depth === 0 ? atoms : null;
  };

  return parse(0);
}

export interface SchemaCheckResult {
  valid: boolean;
  errors: string[];
}

type JsonSchema = Record<string, unknown>;

export function checkSchemaDefinition(schema: unknown, path = "schema", depth = 0): string[] {
  const errors: string[] = [];

  if (depth > MAX_DEPTH) {
    return [`${path}: schema nesting exceeds ${MAX_DEPTH} levels`];
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [`${path}: must be a JSON Schema object`];
  }

  const s = schema as JsonSchema;

  const allowed = SUPPORTED_KEYWORDS;
  for (const key of Object.keys(s)) {
    if (!allowed.has(key)) {
      errors.push(
        `${path}: unsupported keyword "${key}". Supported: ${[...allowed].join(", ")}`
      );
    }
  }

  if (s.type !== undefined) {
    if (typeof s.type !== "string" || !SUPPORTED_TYPES.has(s.type)) {
      errors.push(
        `${path}.type: must be one of ${[...SUPPORTED_TYPES].join(", ")} (unions are not supported)`
      );
    }
  }

  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    errors.push(`${path}.enum: must be a non-empty array`);
  }

  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") {
      errors.push(`${path}.pattern: must be a string`);
    } else {
      let compiles = true;
      try {
        new RegExp(s.pattern);
      } catch {
        compiles = false;
        errors.push(`${path}.pattern: invalid regular expression`);
      }
      const unsafe = compiles ? unsafePatternReason(s.pattern) : null;
      if (unsafe) {
        errors.push(
          `${path}.pattern: refused because ${unsafe}, which can make matching take exponential time. ` +
            "Rewrite it without repeating a group that contains a quantifier or an alternation, or without the backreference."
        );
      }
    }
  }

  for (const key of COUNT_KEYWORDS) {
    const value = s[key];
    if (value !== undefined && !(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      errors.push(`${path}.${key}: must be a non-negative integer`);
    }
  }
  for (const key of BOUND_KEYWORDS) {
    const value = s[key];
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value))) {
      errors.push(
        typeof value === "boolean"
          ? `${path}.${key}: must be a number (the boolean form of draft 4 is not supported; put the bound itself here)`
          : `${path}.${key}: must be a number`
      );
    }
  }
  for (const [low, high] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minimum", "maximum"],
  ] as const) {
    if (typeof s[low] === "number" && typeof s[high] === "number" && (s[low] as number) > (s[high] as number)) {
      errors.push(`${path}: ${low} is greater than ${high}, so no value could pass`);
    }
  }

  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")) {
      errors.push(`${path}.required: must be an array of property names`);
    }
  }

  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
    errors.push(`${path}.additionalProperties: must be a boolean`);
  }

  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
      errors.push(`${path}.properties: must be an object of sub-schemas`);
    } else {
      for (const [name, sub] of Object.entries(s.properties as JsonSchema)) {
        errors.push(...checkSchemaDefinition(sub, `${path}.properties.${name}`, depth + 1));
      }
    }
  }

  if (s.items !== undefined) {
    errors.push(...checkSchemaDefinition(s.items, `${path}.items`, depth + 1));
  }

  return errors;
}

export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  path = "input"
): SchemaCheckResult {
  const errors: string[] = [];
  walk(schema as JsonSchema, value, path, errors, 0);
  return { valid: errors.length === 0, errors };
}

function walk(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): void {
  if (depth > MAX_DEPTH) return;
  if (typeof schema !== "object" || schema === null) return;

  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => deepEqual(a, value))) {
      errors.push(`${path}: must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
      return;
    }
  }

  if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    return;
  }

  const branchResults = (branches: unknown[]) => branches.map((branch) => {
    const branchErrors: string[] = [];
    walk(branch as JsonSchema, value, path, branchErrors, depth + 1);
    return branchErrors;
  });
  if (Array.isArray(schema.anyOf)) {
    const results = branchResults(schema.anyOf);
    if (!results.some((r) => r.length === 0)) {
      errors.push(`${path}: matches none of the allowed forms (${results[0]?.[0] ?? "no form"})`);
      return;
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const results = branchResults(schema.oneOf);
    const matched = results.filter((r) => r.length === 0).length;
    if (matched !== 1) {
      errors.push(matched === 0
        ? `${path}: matches none of the allowed forms (${results[0]?.[0] ?? "no form"})`
        : `${path}: matches ${matched} of the allowed forms, and must match exactly one`);
      return;
    }
  }

  const types = schema.type === undefined ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
  if (types && !types.some((t) => matchesType(t, value))) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${describe(value)}`);
    return;
  }

  if (typeof value === "string" && typeof schema.format === "string") {
    const check = Object.hasOwn(FORMATS, schema.format) ? FORMATS[schema.format] : null;
    if (!check || !check(value)) errors.push(`${path}: is not a valid ${schema.format}`);
  }

  if (typeof value === "string" && typeof schema.pattern === "string") {
    const unsafe = unsafePatternReason(schema.pattern);
    if (unsafe) {
      errors.push(`${path}: cannot be checked, because the schema's pattern is refused (${unsafe}); update the schema's pattern`);
    } else if (value.length > MAX_PATTERN_SUBJECT_LENGTH) {
      errors.push(`${path}: is ${value.length} characters, longer than the ${MAX_PATTERN_SUBJECT_LENGTH} a pattern is checked against`);
    } else if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters, got ${length}`);
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters, got ${length}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: must be at least ${schema.minimum}, got ${value}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: must be at most ${schema.maximum}, got ${value}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: must be greater than ${schema.exclusiveMinimum}, got ${value}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: must be less than ${schema.exclusiveMaximum}, got ${value}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} items, got ${value.length}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: must have at most ${schema.maxItems} items, got ${value.length}`);
    }
  }

  const objectRules = types
    ? types.includes("object")
    : Boolean(schema.properties);
  if (objectRules && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties as JsonSchema | undefined) ?? {};

    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const name of required) {
      if (obj[name] === undefined) {
        errors.push(`${path}.${name}: required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }

    for (const [name, sub] of Object.entries(properties)) {
      if (obj[name] !== undefined) {
        walk(sub as JsonSchema, obj[name], `${path}.${name}`, errors, depth + 1);
      }
    }

    if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(obj)) {
        if (!Object.hasOwn(properties, key)) {
          walk(schema.additionalProperties, obj[key], `${path}.${key}`, errors, depth + 1);
        }
      }
    }
    if (isPlainObject(schema.propertyNames)) {
      for (const key of Object.keys(obj)) {
        walk(schema.propertyNames, key, `${path}.${key} (the name)`, errors, depth + 1);
      }
    }
  }

  const arrayRules = types ? types.includes("array") : false;
  if (arrayRules && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      walk(schema.items as JsonSchema, item, `${path}[${i}]`, errors, depth + 1);
    });
  }
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
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
