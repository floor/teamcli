// The one canonical serialization of a team/registry record: `team-record-c14n-v1`. FROZEN.
//
// A signature over a team covers these bytes, never the text of a file, so how a source orders
// its keys, indents, quotes or comments cannot change what is signed. Changing any rule below
// changes signed bytes and invalidates every signature: a change is a new version with a new
// tag, never an edit of this one. `test/file/canonical-record.test.ts` holds the golden fixture.
//
// The rules, applied recursively:
//   1. Encoding: UTF-8, no BOM, no whitespace between tokens, no trailing newline.
//   2. Objects: plain objects only (a Date, Map, class instance or symbol key is an error). Keys
//      are NFC-normalized and sorted by Unicode code point; two keys that normalize to the same
//      string are an error. A member whose value is `undefined` is omitted, so an absent field
//      and an `undefined` one encode the same.
//   3. Arrays: order is kept (it is meaning: seats, scopes, rules). An `undefined` element is an
//      error, never silently `null`.
//   4. `null` is kept as `null`; it is distinct from an omitted member.
//   5. Strings: NFC-normalized, then JSON-escaped as `JSON.stringify` does (", \\ and controls
//      escaped, `\u00XX` lowercase hex for controls without a short form; everything else
//      literal). A lone surrogate is an error: it has no UTF-8 form.
//   6. Numbers: finite only (NaN and ±Infinity are errors); `-0` is `0`; otherwise the
//      ECMAScript shortest round-trip form (`3`, not `3.0`; `0.5`; `1e+21`).
//   7. Booleans: `true` / `false`. bigint, function and symbol values are errors.
//
// A team record is the validated `TeamFile` minus the fields that only say where the source
// wrote something (`seats[].line`): see `teamRecordOf`.

export const CANONICAL_RECORD_VERSION = 'team-record-c14n-v1';

/** Fields that record a position in the source text, not the team: dropped from a team record. */
const SEAT_SOURCE_FIELDS: readonly string[] = ['line'];

/** A UTF-16 surrogate without its pair: it has no UTF-8 form. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class CanonicalRecordError extends Error {}

function fail(path: string, why: string): never {
  throw new CanonicalRecordError(`${path || '<root>'}: ${why}`);
}

function codePointCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]!.codePointAt(0) ?? 0) - (y[i]!.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function encodeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) fail(path, 'a string with a lone surrogate has no UTF-8 form');
  return JSON.stringify(value.normalize('NFC'));
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return encodeString(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail(path, `the number ${value} is not finite`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      break;
    default:
      fail(path, `a ${typeof value} has no canonical form`);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => {
        if (item === undefined) fail(`${path}[${index}]`, 'an array element is undefined');
        return encode(item, `${path}[${index}]`);
      })
      .join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path, 'only plain objects have a canonical form');
  if (Object.getOwnPropertySymbols(value).length) fail(path, 'a symbol key has no canonical form');
  const members = new Map<string, unknown>();
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) continue;
    if (LONE_SURROGATE.test(key)) fail(path, 'a key with a lone surrogate has no UTF-8 form');
    const normal = key.normalize('NFC');
    if (members.has(normal)) fail(path, `two keys normalize to "${normal}"`);
    members.set(normal, member);
  }
  const keys = [...members.keys()].sort(codePointCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(members.get(key), `${path}.${key}`)}`).join(',')}}`;
}

/** The canonical text of a record (rules above). Throws `CanonicalRecordError` on what has no form. */
export function canonicalRecord(value: unknown): string {
  if (value === undefined) fail('', 'the record is undefined');
  return encode(value, '');
}

/** The canonical bytes of a record: the UTF-8 of `canonicalRecord`. */
export function canonicalRecordBytes(value: unknown): Buffer {
  return Buffer.from(canonicalRecord(value), 'utf8');
}

/** A validated team as a record: the same value without the seats' source positions. Pure. */
export function teamRecordOf(team: { seats?: readonly object[] } & Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(team.seats)) return { ...team };
  return {
    ...team,
    seats: team.seats.map((seat) =>
      Object.fromEntries(Object.entries(seat).filter(([key]) => !SEAT_SOURCE_FIELDS.includes(key))),
    ),
  };
}
