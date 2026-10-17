import { expect } from 'bun:test';
import type { JsonSchema } from '../../src/file/sections/section.ts';
import { buildCommandOutputSchema, ERROR_OUTPUT_SCHEMA, type CommandSchemaSpec } from '../../src/output/schema.ts';

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI SGR/control escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Assert that non-TTY output contains zero ANSI escape sequences. */
export function assertNoAnsi(text: string): void {
  expect(text).not.toMatch(ANSI_ESCAPE);
}

/**
 * Assert that human-mode command output is free of HTML-escaped entities
 * (`&lt;`, `&gt;`, `&amp;`), `(s)` template plurals, `--    ` mystery prefix rows,
 * and raw `$HOME` paths (when `opts.home` is provided).
 */
export function assertCleanHumanOutput(text: string, opts?: { home?: string }): void {
  const plain = stripAnsi(text);
  expect(plain).not.toMatch(/&(lt|gt|amp);/);
  expect(plain).not.toContain('(s)');
  expect(plain).not.toContain('(es)');
  expect(plain).not.toMatch(/^--\s{2,}/m);
  if (opts?.home) {
    expect(plain).not.toContain(opts.home);
  }
}

/**
 * Golden-text assertion helper for command plain output:
 * - verifies trailing newline and no ANSI sequences when `tty` is false
 * - verifies exact line-by-line match against `expected` (array of lines or full string)
 */
export function assertGoldenOutput(actual: string, expected: string | readonly string[], opts?: { tty?: boolean }): void {
  const expectedText = typeof expected === 'string' ? expected : `${expected.join('\n')}\n`;
  if (!opts?.tty) {
    assertNoAnsi(actual);
  }
  expect(actual).toBe(expectedText);
}

/**
 * Validates a parsed JSON value against a subset of Draft 2020-12 JSON Schema
 * (`type`, `const`, `enum`, `required`, `additionalProperties`, `properties`,
 * `items`, `minLength`, `minimum`, `oneOf`). Returns a list of human-readable
 * violation strings (empty when valid).
 */
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    const branchResults = branches.map((branch) => validateAgainstJsonSchema(value, branch, path));
    if (branchResults.some((errors) => errors.length === 0)) return [];
    return [`${path}: did not match any oneOf branch (${branchResults.map((e) => e.join('; ')).join(' | ')})`];
  }

  const errors: string[] = [];

  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errors;
  }

  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return errors;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : typeof value === 'number' && Number.isInteger(value)
          ? 'integer'
          : typeof value;
    const matches = allowed.some((expected) =>
      expected === actualType || (expected === 'number' && actualType === 'integer'),
    );
    if (!matches) {
      errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${actualType}`);
      return errors;
    }
  }

  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
  }

  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${path}: number ${value} < minimum ${schema.minimum}`);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    const itemSchema = schema.items as JsonSchema;
    value.forEach((item, index) => {
      errors.push(...validateAgainstJsonSchema(item, itemSchema, `${path}[${index}]`));
    });
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const req of schema.required as string[]) {
        if (!(req in record) || record[req] === undefined) {
          errors.push(`${path}: missing required property "${req}"`);
        }
      }
    }
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in record && record[key] !== undefined) {
        errors.push(...validateAgainstJsonSchema(record[key], propSchema, `${path}.${key}`));
      }
    }
  }

  return errors;
}

/**
 * Schema-test helper: parses raw `--json` stdout and asserts that it conforms
 * to `spec` (either a `CommandSchemaSpec` or a raw `JsonSchema`).
 */
export function assertMatchesOutputSchema<T = Record<string, unknown>>(
  rawJson: string,
  spec: CommandSchemaSpec | JsonSchema,
): T {
  const parsed: unknown = JSON.parse(rawJson);
  const schema = 'fileName' in spec && 'name' in spec
    ? buildCommandOutputSchema(spec as CommandSchemaSpec)
    : (spec as JsonSchema);
  const violations = validateAgainstJsonSchema(parsed, schema);
  expect(violations, rawJson).toEqual([]);
  return parsed as T;
}

/** Asserts that raw `--json` output conforms to the standard `team.error` schema. */
export function assertJsonErrorShape(
  rawJson: string,
  expected?: { id?: string; messageContains?: string; repair?: string | null; notice?: string | null },
) {
  const doc = assertMatchesOutputSchema<{
    schema: { name: string; version: number };
    error: { id: string; message: string; repair: string | null; rule?: string | null };
    notice?: string | null;
  }>(rawJson, ERROR_OUTPUT_SCHEMA);
  expect(doc.schema).toEqual({ name: 'team.error', version: 1 });
  if (expected?.id !== undefined) expect(doc.error.id).toBe(expected.id);
  if (expected?.messageContains !== undefined) expect(doc.error.message).toContain(expected.messageContains);
  if (expected?.repair !== undefined) expect(doc.error.repair).toBe(expected.repair);
  if (expected?.notice !== undefined) expect(doc.notice).toBe(expected.notice);
  return doc;
}
