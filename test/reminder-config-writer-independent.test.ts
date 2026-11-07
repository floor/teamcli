import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueOwnerGeneralGrant, SCOPED_GRANT_REFUSAL } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import { readReminderConfig } from '../src/reminder/config.ts';
import { fixtureBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T07:00:00.000Z');
const ZONE = 'UTC';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; file: string };

function setupWorld(entitiesYaml: string): World {
  const base = fixtureBase('.reminder-writer-indep-');
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'root');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(root, { recursive: true });
  const file = join(home, '.config', 'team', 'entities.yaml');
  writeFileSync(file, entitiesYaml);
  return { base, home, root, file };
}

function sources(w: World): ConfigSources {
  return { home: w.home, now: () => NOW };
}

describe('independent probe: reminder-config-writer (pre-existing same-entity problems, cross-entity isolation, and grant door)', () => {
  test('a pre-existing problem on the same entity never excuses a bad write, across all parser problem types, while curing it succeeds', async () => {
    const initialYaml = [
      '# header comment kept',
      'floor:',
      '  roots:',
      '    - ~',
      '  reminders:',
      '    - name: broken-key',
      '      at: ["08:00"]',
      '      text: "hello"',
      '      to: [lead@acme]',
      '      extra_field: true',
      '    - name: broken-target',
      '      at: ["09:00"]',
      '      text: "world"',
      '      to: [bareseat]',
      'material:',
      '  roots:',
      '    - ~',
      '',
    ].join('\n');

    const w = setupWorld(initialYaml);

    // 1. Editing floor.reminders while preserving the pre-existing "extra_field" problem on broken-key (e.g. changing time + adding a valid reminder) is refused
    const io1 = testIo(w.root, { kind: 'owner' });
    const keepBrokenKey =
      '[{name: broken-key, at: ["10:30"], text: "hello updated", to: [lead@acme], extra_field: true}, {name: valid-added, at: ["11:00"], text: "good", to: [lead@acme]}]';
    expect(await runConfig(['set', 'floor.reminders', keepBrokenKey], io1, sources(w))).toBe(1);
    expect(io1.err).toContain('"extra_field" is not a reminder key');
    expect(readFileSync(w.file, 'utf8')).toBe(initialYaml);

    // 2. Fixing broken-key but keeping the pre-existing bare-seat problem on broken-target is ALSO refused
    const io2 = testIo(w.root, { kind: 'owner' });
    const keepBrokenTarget =
      '[{name: broken-key, at: ["10:30"], text: "hello fixed", to: [lead@acme]}, {name: broken-target, at: ["11:00"], text: "still bare", to: [bareseat]}]';
    expect(await runConfig(['set', 'floor.reminders', keepBrokenTarget], io2, sources(w))).toBe(1);
    expect(io2.err).toContain('is not <seat>@<team>');
    expect(readFileSync(w.file, 'utf8')).toBe(initialYaml);

    // 3. Curing both pre-existing problems on floor in a single valid write succeeds and preserves comments
    const ioCure = testIo(w.root, { kind: 'owner' });
    const curedList =
      '[{name: broken-key, at: ["10:30"], text: "hello fixed", to: [lead@acme]}, {name: broken-target, at: ["11:00"], text: "target fixed", to: [lead@acme]}]';
    expect(await runConfig(['set', 'floor.reminders', curedList], ioCure, sources(w)), ioCure.err).toBe(0);
    expect(ioCure.out).toContain('set floor.reminders: 2 reminders');

    const updatedText = readFileSync(w.file, 'utf8');
    expect(updatedText).toContain('# header comment kept\n');
    const parsed = readReminderConfig(w.home, { defaultZone: ZONE });
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => [e.name, e.at[0]])).toEqual([
      ['broken-key', '10:30'],
      ['broken-target', '11:00'],
    ]);
  });

  test('a pre-existing problem on another entity does not block a valid write, but a newly introduced cross-entity duplicate is refused', async () => {
    const initialYaml = [
      'floor:',
      '  roots:',
      '    - ~',
      'material:',
      '  roots:',
      '    - ~',
      '  reminders:',
      '    - name: material-good',
      '      at: ["08:00"]',
      '      text: "material sync"',
      '      to: [lead@mat]',
      '    - name: material-bad',
      '      at: ["9:00"]',
      '      text: "bad hour format"',
      '      to: [lead@mat]',
      '',
    ].join('\n');

    const w = setupWorld(initialYaml);

    // 1. Writing a reminder to `floor` whose name collides with `material-good` introduces a new problem attributed to `material` -> refused!
    const ioCollide = testIo(w.root, { kind: 'owner' });
    const collidingList = '[{name: material-good, at: ["07:00"], text: "collide", to: [lead@acme]}]';
    expect(await runConfig(['set', 'floor.reminders', collidingList], ioCollide, sources(w))).toBe(1);
    expect(ioCollide.err).toContain('material.reminders: "material-good" is already a reminder of floor');
    expect(readFileSync(w.file, 'utf8')).toBe(initialYaml);

    // 2. Writing a valid, non-colliding reminder to `floor` succeeds despite `material-bad` having a pre-existing bad time
    const ioValid = testIo(w.root, { kind: 'owner' });
    const validList = '[{name: floor-own, at: ["07:30"], text: "clean floor reminder", to: [lead@acme]}]';
    expect(await runConfig(['set', 'floor.reminders', validList], ioValid, sources(w)), ioValid.err).toBe(0);

    const check = readReminderConfig(w.home, { defaultZone: ZONE });
    expect(check.entries.map((e) => [e.entity, e.name])).toEqual([
      ['floor', 'floor-own'],
      ['material', 'material-good'],
    ]);
    // The pre-existing problem on material remains untouched
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]?.entity).toBe('material');
    expect(check.problems[0]?.name).toBe('material-bad');
  });

  test('supports dotted entity names, JSON get/set output, and enforces the owner / wildcard general-grant door', async () => {
    const initialYaml = [
      '# dotted entity record',
      'acme.eu:',
      '  roots:',
      '    - ~',
      '',
    ].join('\n');
    const w = setupWorld(initialYaml);
    const validList = '[{name: eu-digest, at: ["17:00"], zone: "Europe/Paris", catchUp: false, text: "EOD {team}", to: [lead@eu]}]';

    // 1. Non-owner seat without grant is refused
    const seatIo = testIo(w.root, { kind: 'seat', name: 'worker-1', pane: 'pane2' });
    expect(await runConfig(['set', 'acme.eu.reminders', validList], seatIo, sources(w))).toBe(1);
    expect(seatIo.err).toContain('only the owner, or a seat holding the owner\'s general grant for entity "acme.eu"');
    expect(readFileSync(w.file, 'utf8')).toBe(initialYaml);

    // 2. Scoped general grant (entities: ['acme.eu']) is refused by the 0.5.10 wildcard rule
    const pair = newClientKeyPair();
    const keys = writeClientKeyFiles(join(w.home, '.config', 'team-client', 'delegate'), pair);
    if (!keys.ok) throw new Error(keys.why);
    const scopedGrant = issueOwnerGeneralGrant(
      w.home,
      {
        clientId: 'delegate',
        publicKey: pair.publicKey,
        entities: ['acme.eu'],
        ops: ['config'],
        mayIssue: false,
        expires: new Date(NOW.getTime() + 86_400_000),
      },
      NOW,
    );
    if (!scopedGrant.ok) throw new Error(scopedGrant.why);

    const scopedIo = testIo(w.root, { kind: 'seat', name: 'worker-1', pane: 'pane2' });
    expect(
      await runConfig(
        ['set', 'acme.eu.reminders', validList, '--general', scopedGrant.path, '--key', keys.keyPath],
        scopedIo,
        sources(w),
      ),
    ).toBe(1);
    expect(scopedIo.err).toContain(SCOPED_GRANT_REFUSAL);

    // 3. Wildcard general grant (entities: ['*'], ops: ['config']) succeeds on dotted entity name with --json
    const wildcardGrant = issueOwnerGeneralGrant(
      w.home,
      {
        clientId: 'delegate',
        publicKey: pair.publicKey,
        entities: ['*'],
        ops: ['config'],
        mayIssue: false,
        expires: new Date(NOW.getTime() + 86_400_000),
      },
      NOW,
    );
    if (!wildcardGrant.ok) throw new Error(wildcardGrant.why);

    const wildIo = testIo(w.root, { kind: 'seat', name: 'worker-1', pane: 'pane2' });
    expect(
      await runConfig(
        ['set', 'acme.eu.reminders', validList, '--general', wildcardGrant.path, '--key', keys.keyPath, '--json'],
        wildIo,
        sources(w),
      ),
      wildIo.err,
    ).toBe(0);
    const setJson = JSON.parse(wildIo.out) as { path: string; changed: boolean; source: string; comments_kept: boolean };
    expect(setJson).toMatchObject({
      path: 'acme.eu.reminders',
      changed: true,
      source: 'entity',
      comments_kept: true,
    });

    // 4. get --json reads back the exact reminder list for dotted entity acme.eu
    const getIo = testIo(w.root, { kind: 'seat', name: 'worker-1', pane: 'pane2' });
    expect(await runConfig(['get', 'acme.eu.reminders', '--json'], getIo, sources(w))).toBe(0);
    const gotJson = JSON.parse(getIo.out) as { path: string; value: Array<{ name: string; zone: string; catchUp: boolean }> };
    expect(gotJson.path).toBe('acme.eu.reminders');
    expect(gotJson.value).toHaveLength(1);
    expect(gotJson.value[0]).toMatchObject({
      name: 'eu-digest',
      zone: 'Europe/Paris',
      catchUp: false,
    });
  });
});
