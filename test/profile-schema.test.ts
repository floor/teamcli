// The profiles' JSON Schema is the shape's documentation — the package carries no schema
// validator, screen-file.ts is what refuses a file, in words — so nothing checked the
// schema against the profiles it describes. This applies it, with a reader for the subset
// the schema uses, to the five shipped profiles, and pins the two shapes that had drifted
// from the loader: the rule flags it omitted, and the composer's flag on its one mode.
// The reader throws on any keyword it does not know, so a schema that outgrows it fails
// here rather than passing unnoticed.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseYaml, toValue } from '../src/yaml.ts';

type Schema = Record<string, unknown>;
type Errors = string[];

const KNOWN = new Set([
  '$defs', '$schema', '$id', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'pattern',
  'oneOf', 'anyOf', 'allOf', 'if', 'then', 'not', '$ref',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Every error names the place, so a failure says which key a profile went wrong on.
function check(schema: Schema, value: unknown, at: string, root: Schema): Errors {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`the schema reader does not know "${key}" (at ${at})`);
  }
  const errors: Errors = [];
  const note = (message: string) => errors.push(`${at}: ${message}`);
  if (typeof schema.$ref === 'string') {
    let target: unknown = root;
    for (const step of schema.$ref.replace(/^#\//, '').split('/')) target = (target as Schema)[step];
    return check(target as Schema, value, at, root);
  }
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
  if (schema.additionalProperties === false && isObject(value)) {
    const known = isObject(schema.properties) ? Object.keys(schema.properties) : [];
    for (const key of Object.keys(value)) if (!known.includes(key)) note(`"${key}" is not allowed here`);
  }
  if (isObject(schema.items) && Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...check(schema.items as Schema, item, `${at}[${index}]`, root)));
  }
  if (typeof schema.minItems === 'number' && Array.isArray(value) && value.length < schema.minItems) note(`has fewer than ${schema.minItems} items`);
  if (schema.uniqueItems === true && Array.isArray(value)) {
    const seen = new Set<string>();
    for (const item of value) {
      const one = JSON.stringify(item);
      if (seen.has(one)) note(`repeats ${one}`);
      seen.add(one);
    }
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) note(`is below ${schema.minimum}`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) note(`is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) note(`is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) note(`does not match ${schema.pattern}`);
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
    if (check(schema.if, value, at, root).length === 0 && isObject(schema.then)) {
      errors.push(...check(schema.then, value, at, root));
    }
  }
  if (isObject(schema.not) && check(schema.not, value, at, root).length === 0) note('matches a shape it must not');
  return errors;
}

const schema = JSON.parse(readFileSync(new URL('../src/profiles/profile.schema.json', import.meta.url), 'utf8')) as Schema;
const profile = (name: string): unknown => toValue(parseYaml(readFileSync(new URL(`../src/profiles/${name}.yaml`, import.meta.url), 'utf8')));
const errors = (doc: unknown): Errors => check(schema, doc, 'profile', schema);

const COMPOSER = { mode: 'box-to-rule', prompt: '^>', rule: '^-{8}$', placeholders: [{ equals: '' }] };

describe("the profiles' schema", () => {
  test('a provider error and a rate limit are stages, like a question', () => {
    const doc = {
      format: 1,
      cli: 'sample',
      screen: {
        provider_error: [{ any: ['API Error: Connection lost mid-response\\. The response above may be incomplete\\.'] }],
        rate_limit: [{ any: ['API Error: Request rejected \\(429\\)', 'Usage limit reached', 'Your limit will reset at '] }],
        composer: COMPOSER,
      },
    };
    expect(errors(doc)).toEqual([]);
  });

  test('the five shipped profiles pass it', () => {
    for (const name of ['claude-code', 'codex', 'cursor', 'antigravity', 'grok']) {
      expect([name, errors(profile(name))]).toEqual([name, []]);
    }
  });

  test('unread_model takes launch alone, the loader’s one value', () => {
    const doc = (unreadModel: unknown): unknown => ({
      format: 1, cli: 'sample', unread_model: unreadModel,
      screen: { composer: COMPOSER },
    });
    expect(errors(doc('launch'))).toEqual([]);
    expect(errors(doc('screen')).length).toBeGreaterThan(0);
    expect(errors(doc(true)).length).toBeGreaterThan(0);
  });

  test('a rule may carry on_footer and without_rule, the loader’s flags', () => {
    const trust = (rule: unknown): unknown => ({ format: 1, cli: 'sample', screen: { trust: [rule], composer: COMPOSER } });
    expect(errors(trust({ any: ['^x$'], on_footer: true }))).toEqual([]);
    expect(errors(trust({ any: ['^x$'], without_rule: true }))).toEqual([]);
  });

  test('the composer’s ignore_case is the one mode the loader reads it on', () => {
    const doc = (mode: string, ignoreCase = false): unknown => {
      const composer: Record<string, unknown> = { mode, prompt: '^>', placeholders: [{ equals: '' }] };
      if (mode === 'box-to-rule' || mode === 'two-rules-footer-below') composer.rule = '^-{8}$';
      if (mode === 'two-rules-footer-below') composer.footers = ['^status$'];
      if (mode === 'status-last' || mode === 'status-then-one') composer.status_line = '^status$';
      if (mode === 'status-then-one') composer.fallback = [{ all: ['^done$'], kind: 'idle' }];
      if (ignoreCase) composer.ignore_case = true;
      return { format: 1, cli: 'sample', screen: { composer } };
    };
    expect(errors(doc('two-rules-footer-below', true))).toEqual([]);
    for (const mode of ['box-to-rule', 'status-last', 'status-then-one']) {
      expect(errors(doc(mode))).toEqual([]);
      expect(errors(doc(mode, true)).length).toBeGreaterThan(0);
    }
  });

  test('the status line may be a list, and status_below belongs to the modes that read a row', () => {
    const doc = (extra: Record<string, unknown>): unknown => {
      const composer: Record<string, unknown> = { mode: 'status-last', prompt: '^>', status_line: '^status$', placeholders: [{ equals: '' }] };
      Object.assign(composer, extra);
      return { format: 1, cli: 'sample', screen: { composer } };
    };
    expect(errors(doc({ status_line: ['^a$', '^b$'] }))).toEqual([]);
    expect(errors(doc({ status_line: [] })).length).toBeGreaterThan(0);
    expect(errors(doc({ status_below: '^work$' }))).toEqual([]);
    expect(errors(doc({ status_below: { line: '^work$', except: '^EXEMPT$' } }))).toEqual([]);
    expect(errors(doc({ status_below: { except: '^EXEMPT$' } })).length).toBeGreaterThan(0);
    expect(errors(doc({ status_below: { line: '^work$', wat: '^x$' } })).length).toBeGreaterThan(0);
    const box = { mode: 'box-to-rule', prompt: '^>', rule: '^-{8}$', placeholders: [{ equals: '' }], status_below: '^work$' };
    expect(errors({ format: 1, cli: 'sample', screen: { composer: box } }).length).toBeGreaterThan(0);
  });
});
