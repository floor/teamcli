// A public-only seat's brief never reaches a service this machine does not run: no rules are
// prepended, and the whole body is read against the machine's private lists first. Every value
// here is synthetic and lives only in this test's temporary folder; the real external lists are
// never read.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/index.ts';
import { isPublicOnly, scanPublicBody } from '../src/send/public-only.ts';

const SECRET = ['qw', 'rtz', '-', 'syn', 'th'].join('');
const OTHER = ['qw', 'rtz', '-', 'oth', 'er'].join('');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'public-only-'));
  dirs.push(dir);
  return dir;
}

/** A list that exists, in the folder this test owns. */
function listFile(contents: string, mode = 0o600): string {
  const path = join(temp(), 'private.txt');
  writeFileSync(path, contents, { mode });
  return path;
}

/** A list that is not there at all: the folder exists, the file does not. */
function absent(name: string): string {
  return join(temp(), name);
}

/** The two lists as a scene hands them in: the contents to write, or `undefined` for a list that
 *  is not there. */
function lists(names?: string, phrases?: string): { names: string; phrases: string } {
  return {
    names: names === undefined ? absent('names.txt') : listFile(names),
    phrases: phrases === undefined ? absent('phrases.txt') : listFile(phrases),
  };
}

describe('which seat is public-only', () => {
  test('the profile\'s word or a seat\'s mark, and neither alone turns another seat public', () => {
    const jules = profileFor('jules');
    const claude = profileFor('claude-code');
    if (jules === null || claude === null) throw new Error('the shipped profiles must load');

    expect(jules.publicOnly).toBe(true);
    expect(claude.publicOnly).toBe(false);
    expect(isPublicOnly(jules, undefined)).toBe(true);
    expect(isPublicOnly(jules, { publicOnly: true })).toBe(true);
    expect(isPublicOnly(claude, undefined)).toBe(false);
    expect(isPublicOnly(claude, { publicOnly: true })).toBe(true);
    expect(isPublicOnly(null, undefined)).toBe(false);
  });
});

describe('scanning a public-only body', () => {
  test('a clean body passes, and the rules that were read are counted', () => {
    expect(scanPublicBody('hello there', lists(`${SECRET}\n${OTHER}\n`))).toEqual({ ok: true, rules: 2 });
  });

  test('a hit names its rule by source and ordinal and never repeats the text', () => {
    const scan = scanPublicBody(`notes for ${SECRET}`, lists(`${SECRET}\n`));
    if (scan.ok) throw new Error('the body named a private entry and the scan passed it');
    expect(scan.why).toBe('the body matches a private rule (names entry 1)');
    expect(scan.why).not.toContain(SECRET);
  });

  test('a class header rides the name, and the phrases list is read too', () => {
    const scan = scanPublicBody(`the ${OTHER} deadline`, lists(undefined, `# class: b phrases\n${OTHER}\n`));
    expect(scan).toEqual({ ok: false, why: 'the body matches a private rule (phrases class b entry 1)' });
  });

  test('a diff-only entry matches a body; a path-only one does not', () => {
    const names = `# class: a names; scope=path\n${SECRET}\n# class: b names\nprepush-only:${OTHER}\n`;
    expect(scanPublicBody(`see ${SECRET}`, lists(names))).toEqual({ ok: true, rules: 2 });
    expect(scanPublicBody(`see ${OTHER}`, lists(names))).toEqual({
      ok: false,
      why: 'the body matches a private rule (names class b entry 2)',
    });
  });

  test('both lists absent is no list at all: the body passes', () => {
    expect(scanPublicBody('hello', lists())).toEqual({ ok: true, rules: 0 });
  });

  test('a list that is there and cannot be read refuses the body', () => {
    const scan = scanPublicBody('hello', { names: listFile(`${SECRET}\n`, 0o644), phrases: absent('phrases.txt') });
    if (scan.ok) throw new Error('the scan passed a body with a list it could not trust');
    expect(scan.why).toContain('the body cannot be checked against the private lists (private list is readable by group or other');
    expect(scan.why).not.toContain(SECRET);
  });
});
