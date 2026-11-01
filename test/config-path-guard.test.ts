// A record path addresses the record's own keys. A segment spelled like one every object
// inherits is refused only where the map does not own it, before the command reaches the owner
// door; the writer itself never walks a name the record does not own, so such a path changes no
// shared object and writes no record. The rule is ownership, not spelling: an owned account key
// named `constructor` or `prototype` (the schema allows both), and a list item named so, are
// addressed as any other key or item.
//
// Every scene keeps its team, registry and owner seat under its own temp home; the two object
// scenes read and write only objects they made. Nothing here reads a real team file, grant or
// key, and the marker a refusal keeps is removed by the scene that planted it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { getAt, parsePath, withValue } from '../src/config/team-record.ts';
import { parseYaml, toValue } from '../src/yaml.ts';
import { seatOwner } from './helpers/owner-seat.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T12:00:00.000Z');

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
budgets:
  accounts:
    constructor:
      kind: subscription
      reserve: 20%
      sources: [status_line]
    prototype:
      kind: subscription
      reserve: 20%
      sources: [status_line]
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: constructor
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: prototype
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Place = { base: string; home: string; root: string; store: ReturnType<typeof seatOwner> };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A team in `home`'s registry, with an owner seat beside it, all under a temp home. */
function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-path-guard-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  intoRegistry(root, home);
  return { base, home, root, store: seatOwner(home) };
}

describe('the path grammar', () => {
  test('keeps an inherited name as a segment', () => {
    // Where the segment is a key is decided against the record, not by the spelling: under a
    // list these same segments name items the schema allows.
    expect(parsePath('seats.constructor.model')).toEqual(['seats', 'constructor', 'model']);
    expect(parsePath('seats.prototype.label')).toEqual(['seats', 'prototype', 'label']);
    expect(parsePath('seats.worker.__proto__.x')).toEqual(['seats', 'worker', '__proto__', 'x']);
  });

  test('refuses a malformed path', () => {
    for (const raw of ['', '.x', 'x.', 'x..y']) expect(typeof parsePath(raw)).toBe('string');
  });

  test('still reads an ordinary dotted path', () => {
    expect(parsePath('seats.worker.model')).toEqual(['seats', 'worker', 'model']);
    expect(parsePath('watch.unread_after')).toEqual(['watch', 'unread_after']);
  });
});

describe('a list item named after an inherited property', () => {
  test('is addressed by its name, and by its index', async () => {
    const at = place();
    await underRegistry(async () => {
      const sources = { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store, present: true };
      const byName = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'seats.constructor.model', 'Claude Sonnet', '--request'], byName, sources), byName.err).toBe(0);
      expect(storedTeam(at.root, at.home)!.text).toContain('model: Claude Sonnet');
      const byIndex = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'seats.2.model', 'Claude Haiku', '--request'], byIndex, sources), byIndex.err).toBe(0);
      const text = storedTeam(at.root, at.home)!.text;
      expect(text).toContain('model: Claude Haiku');
      expect(text).not.toContain('model: Claude Sonnet');
      expect(text).toContain('name: prototype');
      expect(at.store.prompts.length).toBe(2);
    });
  });
});

describe('an owned map key named after an inherited property', () => {
  test('reads, writes and removes the account it names', async () => {
    const at = place();
    await underRegistry(async () => {
      const sources = { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store, present: true };
      const get = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['get', 'budgets.accounts.constructor.reserve'], get, sources), get.err).toBe(0);
      expect(get.out.trim()).toBe('20%');
      const set = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'budgets.accounts.constructor.reserve', '10%', '--request'], set, sources), set.err).toBe(0);
      const unset = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['unset', 'budgets.accounts.prototype.sources', '--request'], unset, sources), unset.err).toBe(0);
      const record = toValue(parseYaml(storedTeam(at.root, at.home)!.text));
      expect(getAt(record, ['budgets', 'accounts', 'constructor', 'reserve'])).toEqual({ found: true, value: '10%' });
      expect(getAt(record, ['budgets', 'accounts', 'prototype', 'sources'])).toEqual({ found: false });
      expect(at.store.prompts.length).toBe(2);
    });
  });
});

describe('a reserved name the record does not own', () => {
  test('is refused for every verb, before the door, with no prompt and no write', async () => {
    const at = place();
    await underRegistry(async () => {
      const sources = { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store, present: true };
      const before = storedTeam(at.root, at.home)!.text;
      const prompts = at.store.prompts.length;
      let runs = 0;
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        for (const raw of [key, `${key}.marker`, `seats.worker.${key}.marker`]) {
          for (const argv of [['get', raw], ['set', raw, 'x'], ['unset', raw], ['set', raw, 'x', '--request'], ['unset', raw, '--request']]) {
            const io = testIo(at.root, { kind: 'owner-no-tty' });
            expect(await runConfig(argv, io, sources), `${argv.join(' ')}: ${io.err}`).toBe(2);
            runs += 1;
          }
        }
      }
      expect(runs).toBe(45);
      expect(at.store.prompts.length).toBe(prompts);
      expect(storedTeam(at.root, at.home)!.text).toBe(before);
    });
  });
});

describe('a hand-built path through an inherited name', () => {
  test('writes nothing shared', () => {
    const record = toValue(parseYaml(TEAM));
    try {
      const written = withValue(record, ['seats', 'worker', '__proto__', 'guardProbe'], 'x');
      expect(written.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'guardProbe')).toBe(false);
      expect(({} as { guardProbe?: string }).guardProbe).toBeUndefined();
    } finally {
      delete (Object.prototype as { guardProbe?: string }).guardProbe;
    }
  });

  test('removes nothing shared', () => {
    Object.defineProperty(Object.prototype, 'guardMarker', { value: 'kept', configurable: true, writable: true, enumerable: false });
    try {
      const changed = withValue(toValue(parseYaml(TEAM)), ['seats', 'worker', '__proto__', 'guardMarker'], undefined);
      expect(changed.ok).toBe(false);
      expect(({} as { guardMarker?: string }).guardMarker).toBe('kept');
    } finally {
      delete (Object.prototype as { guardMarker?: string }).guardMarker;
    }
  });

  test('walks an owned key whatever its spelling', () => {
    const record = toValue(parseYaml(TEAM));
    const changed = withValue(record, ['budgets', 'accounts', 'constructor', 'reserve'], '10%');
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(getAt(changed.root, ['budgets', 'accounts', 'constructor', 'reserve'])).toEqual({ found: true, value: '10%' });
  });
});

describe('team config through an inherited name', () => {
  test('set and unset are refused before the owner door, and change nothing', async () => {
    const at = place();
    await underRegistry(async () => {
      const sources = { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store, present: true };
      const before = storedTeam(at.root, at.home)!.text;
      const prompts = at.store.prompts.length;
      Object.defineProperty(Object.prototype, 'guardCommandMarker', { value: 'kept', configurable: true, writable: true, enumerable: false });
      try {
        for (const argv of [
          ['set', 'seats.worker.__proto__.guardSet', 'x', '--request'],
          ['set', 'seats.worker.constructor', 'x', '--request'],
          ['set', 'seats.worker.prototype', 'x', '--request'],
          ['unset', '__proto__.guardCommandMarker', '--request'],
        ]) {
          const io = testIo(at.root, { kind: 'owner' });
          expect(await runConfig(argv, io, sources), io.err).toBe(2);
          expect(io.err).toContain('cannot be addressed');
        }
        expect(at.store.prompts.length).toBe(prompts);
        expect(storedTeam(at.root, at.home)!.text).toBe(before);
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'guardSet')).toBe(false);
        expect(({} as { guardCommandMarker?: string }).guardCommandMarker).toBe('kept');
      } finally {
        delete (Object.prototype as { guardCommandMarker?: string }).guardCommandMarker;
      }
    });
  });

  test('an ordinary path still writes after one presented signature', async () => {
    const at = place();
    await underRegistry(async () => {
      const sources = { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store, present: true };
      const io = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--request'], io, sources), io.err).toBe(0);
      expect(storedTeam(at.root, at.home)!.text).toContain('\nproject: other\n');
      expect(at.store.prompts.length).toBe(1);
    });
  });
});
