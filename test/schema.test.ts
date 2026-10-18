// The team file's JSON Schema is generated from the section modules and checked in; this test
// holds the checked-in file to them, and the schema to the validator's own shape: the files the
// validator accepts (the example fixture, the team files the docs pages show) pass the schema,
// and files it refuses are refused here too. The schema is read with a reader for the subset of
// JSON Schema the fragments use, and the reader throws on any keyword it does not know, so a
// schema that outgrows it fails here rather than passing unnoticed.
//
// The profiles' schema (src/profiles/profile.schema.json) is applied to the five shipped
// profiles by test/profile-schema.test.ts and is not applied a second time here.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, NAME, renderSchema } from '../scripts/schema.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { parseYaml, toValue } from '../src/yaml.ts';
import { blocksOf } from './docs/blocks.ts';

type Schema = Record<string, unknown>;
type Errors = string[];

const KNOWN = new Set([
  '$schema', '$id', 'title', 'description', '$comment', 'deprecated',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'propertyNames',
  'items', 'minItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not',
]);

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Every error names the place, so a failure says which field a file went wrong on.
function check(schema: Schema, value: unknown, at: string, root: Schema): Errors {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`the schema reader does not know "${key}" (at ${at})`);
  }
  const errors: Errors = [];
  const note = (message: string) => errors.push(`${at}: ${message}`);
  if (typeof schema.type === 'string') {
    const ok =
      (schema.type === 'object' && isObject(value)) ||
      (schema.type === 'array' && Array.isArray(value)) ||
      (schema.type === 'string' && typeof value === 'string') ||
      (schema.type === 'boolean' && typeof value === 'boolean') ||
      (schema.type === 'number' && typeof value === 'number') ||
      (schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (schema.type === 'null' && value === null);
    if (!ok) note(`must be ${schema.type}`);
  }
  if ('const' in schema && !equal(value, schema.const)) note(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((one) => equal(one, value))) note(`is not one of ${schema.enum.join(', ')}`);
  if (Array.isArray(schema.required) && isObject(value)) {
    for (const key of schema.required) if (!(key in value)) note(`missing "${key}"`);
  }
  if (isObject(schema.properties) && isObject(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...check(sub as Schema, value[key], `${at}.${key}`, root));
    }
  }
  if (isObject(value)) {
    const known = isObject(schema.properties) ? Object.keys(schema.properties) : [];
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!known.includes(key)) note(`"${key}" is not allowed here`);
    } else if (isObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!known.includes(key)) errors.push(...check(schema.additionalProperties as Schema, value[key], `${at}.${key}`, root));
      }
    }
    if (isObject(schema.propertyNames)) {
      for (const key of Object.keys(value)) errors.push(...check(schema.propertyNames as Schema, key, `${at} (a key)`, root));
    }
  }
  if (isObject(schema.items) && Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...check(schema.items as Schema, item, `${at}[${index}]`, root)));
  }
  if (typeof schema.minItems === 'number' && Array.isArray(value) && value.length < schema.minItems) note(`has fewer than ${schema.minItems} items`);
  if (schema.uniqueItems === true && Array.isArray(value)) {
    const seen = new Set(value.map((one) => JSON.stringify(one)));
    if (seen.size !== value.length) note('repeats an item it must not');
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) note(`is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) note(`is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) note(`does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) note(`is below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) note(`is above ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) note(`is not above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) note(`is not below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((sub) => check(sub as Schema, value, at, root));
    const passing = results.filter((one) => one.length === 0).length;
    if (passing !== 1) {
      note(`matches ${passing} of the ${schema.oneOf.length} shapes it must match exactly one of`);
      // No shape at all: say why the closest one refused it.
      if (passing === 0) errors.push(...results.reduce((best, one) => (one.length < best.length ? one : best)).slice(0, 3));
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => check(sub as Schema, value, at, root).length === 0)) note('matches none of the accepted shapes');
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) errors.push(...check(sub as Schema, value, at, root));
  }
  if (isObject(schema.if)) {
    if (check(schema.if, value, at, root).length === 0) {
      if (isObject(schema.then)) errors.push(...check(schema.then, value, at, root));
    } else if (isObject(schema.else)) {
      errors.push(...check(schema.else, value, at, root));
    }
  }
  if (isObject(schema.not) && check(schema.not, value, at, root).length === 0) note('matches a shape it must not');
  return errors;
}

const schema = buildSchema();
const errorsFor = (document: unknown): Errors => check(schema, document, 'the file', schema);
const read = (path: URL | string): string => readFileSync(path, 'utf8');
const documentOf = (text: string): unknown => toValue(parseYaml(text));

// The team files the docs pages show. The docs check runs commands against them, so the ones the
// validator accepts are the pages' working files; a page's broken file is a refusal it prints.
const docsDir = join(import.meta.dir, '..', 'docs', 'commands');
const docsTeamFiles: { page: string; line: number; text: string }[] = [];
const pages = readdirSync(docsDir).filter((name) => name.endsWith('.md') && name !== 'README.md').sort();
for (const page of pages) {
  for (const block of blocksOf(read(join(docsDir, page)))) {
    if ((block.kind === 'yaml' || block.kind === 'file') && block.attrs.file === '.agents/team.yaml') {
      docsTeamFiles.push({ page, line: block.line, text: block.text.endsWith('\n') ? block.text : `${block.text}\n` });
    }
  }
}
const docsAccepted = docsTeamFiles.filter((file) => validateTeamFile(file.text).ok);

describe('the generated team schema', () => {
  test(`the checked-in ${NAME} is what the section modules make`, () => {
    expect(read(new URL('../schema/team.schema.json', import.meta.url))).toBe(renderSchema());
  });

  test('the reader refuses a keyword it does not know', () => {
    expect(() => check({ wibble: true }, 1, 'the file', {})).toThrow(/does not know "wibble"/);
  });

  test('the example fixture passes the validator and the schema', () => {
    const text = read(new URL('./fixtures/example.yaml', import.meta.url));
    expect(validateTeamFile(text).ok).toBe(true);
    expect(errorsFor(documentOf(text))).toEqual([]);
  });

  test('the docs pages carry team files to check', () => {
    expect(docsAccepted.length).toBeGreaterThan(0);
  });

  test('every team file the docs pages validate also passes the schema', () => {
    const failures: string[] = [];
    for (const file of docsAccepted) {
      const errors = errorsFor(documentOf(file.text));
      if (errors.length > 0) failures.push(`${file.page}:${file.line}: ${errors.join('; ')}`);
    }
    expect(failures.join('\n')).toBe('');
  });

  describe('the three refused fixtures are refused the same way', () => {
    const cases = [
      { name: 'unknown-field.yaml', refusal: 'unknown field "temporray" in limits', complaint: '"temporray" is not allowed here' },
      { name: 'wrong-type.yaml', refusal: 'limits.temporary must be a whole number', complaint: 'the file.limits.temporary: must be integer' },
      { name: 'missing-project.yaml', refusal: 'project is required', complaint: 'the file: missing "project"' },
    ];
    for (const one of cases) {
      test(one.name, () => {
        const text = read(new URL(`./fixtures/schema/${one.name}`, import.meta.url));
        const result = validateTeamFile(text);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.map((error) => error.message).join('\n')).toContain(one.refusal);
        expect(errorsFor(documentOf(text)).join('\n')).toContain(one.complaint);
      });
    }
  });
});
