// A record path addresses the record's own keys. The three names every object inherits are
// refused as path segments before the command reaches the owner door, and the writer itself
// never walks an inherited key, so a path through one changes no shared object and writes no
// record.
//
// Every scene keeps its team, registry and owner seat under its own temp home; the two object
// scenes read and write only objects they made. Nothing here reads a real team file, grant or
// key, and the marker a refusal keeps is removed by the scene that planted it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { parsePath, withValue } from '../src/config/team-record.ts';
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
  test('refuses a segment that names an inherited property', () => {
    for (const raw of ['__proto__.x', 'seats.worker.__proto__.x', 'seats.worker.constructor', 'constructor.prototype.x', 'prototype', 'seats.worker.prototype']) {
      expect(parsePath(raw)).toBe(`"${raw}" is not a path: __proto__, constructor and prototype cannot be addressed`);
    }
  });

  test('still reads an ordinary dotted path', () => {
    expect(parsePath('seats.worker.model')).toEqual(['seats', 'worker', 'model']);
    expect(parsePath('watch.unread_after')).toEqual(['watch', 'unread_after']);
  });
});

describe('a hand-built path through an inherited name', () => {
  test('writes nothing shared', () => {
    const record = toValue(parseYaml(TEAM));
    try {
      withValue(record, ['seats', 'worker', '__proto__', 'guardProbe'], 'x');
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'guardProbe')).toBe(false);
      expect(({} as { guardProbe?: string }).guardProbe).toBeUndefined();
    } finally {
      delete (Object.prototype as { guardProbe?: string }).guardProbe;
    }
  });

  test('removes nothing shared', () => {
    Object.defineProperty(Object.prototype, 'guardMarker', { value: 'kept', configurable: true, writable: true, enumerable: false });
    try {
      withValue(toValue(parseYaml(TEAM)), ['seats', 'worker', '__proto__', 'guardMarker'], undefined);
      expect(({} as { guardMarker?: string }).guardMarker).toBe('kept');
    } finally {
      delete (Object.prototype as { guardMarker?: string }).guardMarker;
    }
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
