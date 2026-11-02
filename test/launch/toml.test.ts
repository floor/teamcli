// The TOML reader the Grok sandbox file goes through: the shapes the writer produces, the
// constructs a TOML 1.0 document may carry, and the documents that must be refused rather than
// rewritten. Where both parsers accept a document, the values are read a second time by Bun's
// own parser and must agree; a construct TOML 1.0 refuses is refused here even where a runtime's
// parser is more lenient.
import { describe, expect, test } from 'bun:test';
import { parseToml } from '../../src/launch/toml.ts';

const VALID = [
  // The file the writer produces, and the spellings a profile may already have.
  '[profiles.team-seat-acme]\nextends = "workspace"\nread_write = ["/state", "/project"]\n',
  '[ profiles . "team-seat-acme" ] # a comment\nextends = "old"\nread_write = [\n  "/old", # a comment inside\n  "/two",\n]\n',
  'notes = """\n[profiles.team-seat-acme]\nextends = "quoted prose"\n"""\n[profiles.team-seat-acme]\nextends = "old"\n',
  "notes = '''\n[profiles.team-seat-acme]\nextends = \"kept prose\"\n'''\n[profiles.team-seat-acme]\nextends = \"old\"\n",
  'profiles = { other = { extends = "workspace" } }\n',
  '[profiles]\nteam-seat-acme = { extends = "workspace" }\n',
  // Values.
  'a = 42\nb = -1_000\nc = 0x2A\nd = 0o17\ne = 0b101\nf = 1.5\ng = 1e3\nh = true\ni = false\nj = inf\nk = -nan\n',
  's = "q\\"uo\\\\te\\u0041\\U0001F600"\n',
  's = """a \\\n   b"""\n',
  'empty = ""\nlit = \'C:\\Users\\node\'\n',
  'arr = [1, 2, [3, 4], "five", {six = 6}]\n',
  't = { a = 1, b = "two" }\n',
  'a.b.c = 1\na.b.d = 2\n',
  '[a]\nb.c = 1\nb.d = 2\n',
  'a.b = 1\n[a.c]\nx = 1\n',
  '[[fruit]]\nname = "apple"\n[[fruit]]\nname = "banana"\n[fruit.physical]\ncolor = "yellow"\n',
  '# only a comment\n',
  '',
  '[a]\n[a.b]\nx = 1\n',
];

const INVALID = [
  '[profiles.team-seat-acme\nextends = "workspace"\n',
  'a =\n',
  'a = 1 b = 2\n',
  '[a]\n[a]\n',
  '[a]\n[a.b]\nx = 1\n[a]\n',
  'a = 1\na = 2\n',
  'a = "unterminated\n',
  'a = 1.\n',
  'profiles = { x = 1 }\n[profiles.y]\n',
  '[profiles]\nx = 1\nx = 2\n',
  'a = 01\n',
  'a = "no\nnewline"\n',
  'a = [1 2]\n',
  'a = 1979-13-01\n',
  'a = 2021-02-29\n',
  'a = 1979-05-27Z\n',
  'a.b = 1\n[a]\n',
  '[a]\nb = 1\n[a.b]\n',
];

// A construct TOML 1.0 refuses: a time without seconds, a trailing comma in an inline table,
// and an escape TOML does not define. Refused here even where a runtime's parser is lenient.
const TOML_ONE_OH_REFUSES = ['a = 1979-05-27T07:32\n', 'a = {b = 1,}\n', 'a = "\\x41"\n'];

/** Bun's reading of a document, or null when it refuses it. */
function bun(text: string): unknown | null {
  try {
    return Bun.TOML.parse(text);
  } catch {
    return null;
  }
}

describe('a document the sandbox file may carry', () => {
  test('the writer\'s own table reads back with its two fields', () => {
    const parsed = parseToml('[profiles.team-seat-acme]\nextends = "workspace"\nread_write = ["/state", "/project"]\n');
    const profiles = parsed.profiles as Record<string, Record<string, unknown>>;
    expect(profiles['team-seat-acme']?.extends).toBe('workspace');
    expect(profiles['team-seat-acme']?.read_write).toEqual(['/state', '/project']);
  });

  test('a quoted key and a spaced dotted header name the same table', () => {
    const parsed = parseToml('[ profiles . "team-seat-acme" ] # a comment\nextends = "old"\n');
    expect(Object.keys(parsed.profiles as Record<string, unknown>)).toEqual(['team-seat-acme']);
  });

  test('a multi-line string keeps the header-shaped lines inside it as text', () => {
    const parsed = parseToml('notes = """\n[profiles.team-seat-acme]\nextends = "quoted prose"\n"""\n');
    expect(parsed.notes).toBe('[profiles.team-seat-acme]\nextends = "quoted prose"\n');
  });

  test('a date or a time is kept as the text that wrote it, and every form parses', () => {
    const text = 'a = 07:32:00\nb = 1979-05-27\nc = 1979-05-27 07:32:00\nd = 1979-05-27T07:32:00.123Z\ne = 2020-02-29\nf = 07:32:60\n';
    expect(bun(text)).not.toBeNull();
    expect(parseToml(text)).toMatchObject({
      a: '07:32:00', b: '1979-05-27', c: '1979-05-27T07:32:00', d: '1979-05-27T07:32:00.123Z', e: '2020-02-29',
    });
  });

  for (const text of VALID) {
    test(`every value agrees with Bun's reading: ${JSON.stringify(text.slice(0, 40))}`, () => {
      const theirs = bun(text);
      expect(theirs).not.toBeNull();
      const mine = parseToml(text);
      // Dates and times are the one deliberate difference: kept as text, not as a date value.
      const shape = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(shape);
        if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(value)) out[key] = shape((value as Record<string, unknown>)[key]);
          return out;
        }
        return value;
      };
      expect(shape(mine)).toEqual(shape(theirs));
    });
  }

  for (const text of INVALID) {
    test(`a document that does not parse is refused: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(() => parseToml(text)).toThrow(/^line \d+:/);
      expect(bun(text)).toBeNull();
    });
  }

  for (const text of TOML_ONE_OH_REFUSES) {
    test(`TOML 1.0 refuses it: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(() => parseToml(text)).toThrow(/^line \d+:/);
    });
  }
});
