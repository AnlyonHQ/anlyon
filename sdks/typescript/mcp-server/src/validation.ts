/**
 * Lightweight argument validation against a tool's own inputSchema.
 *
 * Validates the JSON Schema subset our tools actually use (type, required,
 * enum, minLength, minimum/maximum, maxItems, nested array item objects) so
 * malformed calls fail with a clear tool error instead of an opaque SDK/API
 * error. Validating against the same schema advertised via tools/list means
 * the check can never drift from the contract.
 */

interface PropertySchema {
  type?: string;
  enum?: readonly unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: ObjectSchema | PropertySchema;
  properties?: Record<string, PropertySchema>;
  required?: readonly string[];
}

interface ObjectSchema {
  type?: string;
  properties?: Record<string, PropertySchema>;
  required?: readonly string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeOf(value) === 'object';
    default:
      return true;
  }
}

function validateValue(name: string, value: unknown, schema: PropertySchema): string | null {
  if (schema.type && !matchesType(value, schema.type)) {
    return `"${name}" must be of type ${schema.type}, got ${typeOf(value)}`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `"${name}" must be one of: ${schema.enum.join(', ')}`;
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    return `"${name}" must be at least ${schema.minLength} character(s)`;
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    return `"${name}" must be >= ${schema.minimum}`;
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    return `"${name}" must be <= ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `"${name}" must have at most ${schema.maxItems} item(s)`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const error = validateObject(`${name}[${i}]`, value[i], schema.items);
        if (error) return error;
      }
    }
  }
  return null;
}

function validateObject(name: string, value: unknown, schema: ObjectSchema | PropertySchema): string | null {
  if (schema.type && !matchesType(value, schema.type)) {
    return `"${name}" must be of type ${schema.type}, got ${typeOf(value)}`;
  }
  if (typeOf(value) !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) {
      return `"${name}.${key}" is required`;
    }
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (record[key] === undefined) continue;
    const error = validateValue(`${name}.${key}`, record[key], propSchema);
    if (error) return error;
  }
  return null;
}

/**
 * Validate tool call arguments against the tool's inputSchema.
 * Returns an error message, or null when the arguments are valid.
 */
export function validateArgs(
  schema: { properties?: Record<string, unknown>; required?: string[] },
  args: Record<string, unknown>,
): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      return `"${key}" is required`;
    }
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) continue;
    const error = validateValue(key, args[key], propSchema as PropertySchema);
    if (error) return error;
  }
  return null;
}
