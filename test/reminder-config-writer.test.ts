// The reminder chore's config has a writer: `team config set <entity>.reminders <yaml list>` and
// `team config get <entity>.reminders`, the same owner/general-grant door and comment-keeping
// write as an entity's `names.unique` word. The list is held to the daemon's own parser
// (src/reminder/config.ts) on the exact text that would be written, so a list `team daemon` would
// refuse is never stored: a problem on the entity being written refuses it whatever the file
// carried before, and a problem on another entity refuses only when the edit introduced it.
// Every scene is a synthetic home: the entities file, the grant and the checkouts are the scene's
// own, and no live registry or daemon is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueOwnerGeneralGrant, SCOPED_GRANT_REFUSAL } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import { readReminderConfig } from '../src/reminder/config.ts';
import { fixtureBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const ZONE = 'Europe/Paris';

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; file: string };

/** One machine: a home holding the owner's entities file, and a checkout-shaped folder to run
 *  from. The writer reads no team, so the folder is a plain directory. */
function place(text?: string): World {
  const base = fixtureBase('.reminder-writer-');
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const file = join(home, '.config', 'team', 'entities.yaml');
  mkdirSync(join(base, 'root'), { recursive: true });
  const body = text ?? `# floor's own record\nfloor:\n  roots:\n    - ${base}\nmaterial:\n  roots:\n    - ${base}\n`;
  writeFileSync(file, body);
  return { base, home, root: join(base, 'root'), file };
}

function sourcesOf(world: World): ConfigSources {
  return { home: world.home, now: () => NOW };
}

const LIST = '[{name: standup, at: ["09:00"], text: "Read the board.", to: [lead@acme]}]';

describe('the owner writes an entity’s reminders through team config', () => {
  test('a list is written, the daemon’s parser reads it back, and get prints it', async () => {
    const world = place();
    const set = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], set, sourcesOf(world)), set.err).toBe(0);
    expect(set.out).toContain('set floor.reminders: 1 reminder');
    // The comment above the entry and every other line are still there.
    const text = readFileSync(world.file, 'utf8');
    expect(text).toContain("# floor's own record\n");
    expect(text).toContain('reminders:');
    // The daemon's own read sees the reminder, exactly as written.
    const read = readReminderConfig(world.home, { defaultZone: ZONE });
    expect(read.problems).toEqual([]);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ entity: 'floor', name: 'standup', at: ['09:00'], zone: ZONE, text: 'Read the board.', targets: [{ address: 'lead@acme', text: null }] });
    const got = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['get', 'floor.reminders'], got, sourcesOf(world))).toBe(0);
    expect(got.out).toContain('name: standup');
    expect(got.out).toContain('lead@acme');
  });

  test('get —json answers the list as data, for any caller', async () => {
    const world = place();
    const set = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], set, sourcesOf(world))).toBe(0);
    const got = testIo(world.root, { kind: 'seat', name: 'builder-9', pane: 'pane1' });
    expect(await runConfig(['get', 'floor.reminders', '--json'], got, sourcesOf(world))).toBe(0);
    const answer = JSON.parse(got.out) as { path: string; value: Array<{ name: string }> };
    expect(answer.path).toBe('floor.reminders');
    expect(answer.value[0]?.name).toBe('standup');
  });

  test('the same list again changes nothing', async () => {
    const world = place();
    const first = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], first, sourcesOf(world))).toBe(0);
    const again = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], again, sourcesOf(world))).toBe(0);
    expect(again.out).toContain('nothing changed');
  });

  test('an empty list clears the entity’s reminders', async () => {
    const world = place();
    const set = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], set, sourcesOf(world))).toBe(0);
    const clear = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', '[]'], clear, sourcesOf(world))).toBe(0);
    expect(clear.out).toContain('set floor.reminders: 0 reminders');
    expect(readReminderConfig(world.home, { defaultZone: ZONE }).entries).toEqual([]);
  });
});

describe('a list the daemon would refuse is never written', () => {
  const refused: Array<[string, string, string]> = [
    ['a name in the wrong shape', '[{name: Daily, at: ["09:00"], text: hi, to: [lead@acme]}]', 'a name is lower-case words and dashes'],
    ['no time', '[{name: standup, text: hi, to: [lead@acme]}]', 'a reminder needs at least one time'],
    ['a time outside 24 hours', '[{name: standup, at: ["9:00"], text: hi, to: [lead@acme]}]', 'at holds a value that is not an HH:MM time'],
    ['an unknown key', '[{name: standup, at: ["09:00"], text: hi, to: [lead@acme], when: never}]', '"when" is not a reminder key'],
    ['a bare seat address', '[{name: standup, at: ["09:00"], text: hi, to: [lead]}]', 'is not <seat>@<team>'],
    ['no text anywhere', '[{name: standup, at: ["09:00"], to: [lead@acme]}]', 'writes no text and the reminder writes none'],
  ];
  for (const [what, value, why] of refused) {
    test(`${what} is refused with the parser’s reason, and the file is untouched`, async () => {
      const world = place();
      const before = readFileSync(world.file, 'utf8');
      const io = testIo(world.root, { kind: 'owner' });
      expect(await runConfig(['set', 'floor.reminders', value], io, sourcesOf(world))).toBe(1);
      expect(io.err).toContain(why);
      expect(readFileSync(world.file, 'utf8')).toBe(before);
    });
  }

  test('a name another entity already holds is refused, whichever entity the parser names', async () => {
    const world = place('floor:\n  roots:\n    - ~\nmaterial:\n  roots:\n    - ~\n  reminders:\n    - name: standup\n      at: ["09:00"]\n      text: hi\n      to: [lead@acme]\n');
    const before = readFileSync(world.file, 'utf8');
    const io = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], io, sourcesOf(world))).toBe(1);
    // floor is written first in the file, so the edit would make material the later duplicate:
    // the parser says so exactly, and nothing is written.
    expect(io.err).toContain('material.reminders: "standup" is already a reminder of floor');
    expect(readFileSync(world.file, 'utf8')).toBe(before);
  });

  test('a problem the file already carried on this entity still refuses the write', async () => {
    // `floor` already holds a reminder the parser refuses (an unknown key). The new list keeps
    // that same problem while changing the list: a comparison that excuses a pre-existing problem
    // would store a list the daemon still refuses, so the problem is read on this entity, not
    // against what the file carried before.
    const world = place(
      `floor:\n  roots:\n    - ~\n  reminders:\n    - name: old\n      at: ["09:00"]\n      text: hi\n      to: [lead@acme]\n      when: never\nmaterial:\n  roots:\n    - ~\n`,
    );
    const before = readFileSync(world.file, 'utf8');
    const io = testIo(world.root, { kind: 'owner' });
    const value = '[{name: old, at: ["10:00"], text: hi, to: [lead@acme], when: never}]';
    expect(await runConfig(['set', 'floor.reminders', value], io, sourcesOf(world))).toBe(1);
    expect(io.err).toContain('"when" is not a reminder key');
    expect(readFileSync(world.file, 'utf8')).toBe(before);
  });

  test('a problem the file already carried elsewhere does not block a write', async () => {
    // `material` holds a reminder the parser refuses (an unknown key); writing floor's valid list
    // introduces no problem on floor, so it is written and the old one is left as it was.
    const world = place(
      `floor:\n  roots:\n    - ~\nmaterial:\n  roots:\n    - ~\n  reminders:\n    - name: old\n      at: ["09:00"]\n      text: hi\n      to: [lead@acme]\n      when: never\n`,
    );
    const io = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], io, sourcesOf(world)), io.err).toBe(0);
    const read = readReminderConfig(world.home, { defaultZone: ZONE });
    expect(read.entries.map((entry) => entry.name)).toEqual(['standup']);
    expect(read.problems.map((problem) => problem.entity)).toEqual(['material']);
  });
});

describe('the value must be a list', () => {
  for (const value of ['standup', 'name: standup', '42']) {
    test(`"${value}" is refused before any door, and nothing is written`, async () => {
      const world = place();
      const before = readFileSync(world.file, 'utf8');
      const io = testIo(world.root, { kind: 'owner' });
      expect(await runConfig(['set', 'floor.reminders', value], io, sourcesOf(world))).toBe(1);
      expect(io.err).toContain('is not a YAML list of reminders');
      expect(readFileSync(world.file, 'utf8')).toBe(before);
    });
  }
});

describe('the door is the entity’s own', () => {
  test('a seat without a grant is refused, and the file is untouched', async () => {
    const world = place();
    const before = readFileSync(world.file, 'utf8');
    const io = testIo(world.root, { kind: 'seat', name: 'builder-9', pane: 'pane1' });
    expect(await runConfig(['set', 'floor.reminders', LIST], io, sourcesOf(world))).toBe(1);
    expect(io.err).toContain('only the owner, or a seat holding the owner\'s general grant for entity "floor"');
    expect(io.err).toContain('writes an entity\'s reminders');
    expect(readFileSync(world.file, 'utf8')).toBe(before);
  });

  test('a wildcard general grant admitting config writes the list', async () => {
    const world = place();
    const pair = newClientKeyPair();
    const keys = writeClientKeyFiles(join(world.home, '.config', 'team-client', 'iris'), pair);
    if (!keys.ok) throw new Error(keys.why);
    const grant = issueOwnerGeneralGrant(world.home, {
      clientId: 'iris',
      publicKey: pair.publicKey,
      entities: ['*'],
      ops: ['config'],
      mayIssue: true,
      expires: new Date(Date.now() + 86_400_000),
    }, NOW);
    if (!grant.ok) throw new Error(grant.why);
    const io = testIo(world.root, { kind: 'seat', name: 'builder-9', pane: 'pane1' });
    const code = await runConfig(['set', 'floor.reminders', LIST, '--general', grant.path, '--key', keys.keyPath], io, sourcesOf(world));
    expect(code, io.err).toBe(0);
    expect(io.err).toContain('admitted by general grant');
    expect(readFileSync(world.file, 'utf8')).toContain('reminders:');
  });

  test('a grant that lists entities is refused, and nothing is written', async () => {
    const world = place();
    const before = readFileSync(world.file, 'utf8');
    const pair = newClientKeyPair();
    const keys = writeClientKeyFiles(join(world.home, '.config', 'team-client', 'iris'), pair);
    if (!keys.ok) throw new Error(keys.why);
    const grant = issueOwnerGeneralGrant(world.home, {
      clientId: 'iris',
      publicKey: pair.publicKey,
      entities: ['floor'],
      ops: ['config'],
      mayIssue: true,
      expires: new Date(Date.now() + 86_400_000),
    }, NOW);
    if (!grant.ok) throw new Error(grant.why);
    const io = testIo(world.root, { kind: 'seat', name: 'builder-9', pane: 'pane1' });
    expect(await runConfig(['set', 'floor.reminders', LIST, '--general', grant.path, '--key', keys.keyPath], io, sourcesOf(world))).toBe(1);
    expect(io.err).toContain(SCOPED_GRANT_REFUSAL);
    expect(readFileSync(world.file, 'utf8')).toBe(before);
  });
});

describe('the form and its refusals', () => {
  test('there is no unset: an empty list clears', async () => {
    const world = place();
    const io = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['unset', 'floor.reminders'], io, sourcesOf(world))).toBe(2);
    expect(io.err).toContain('an entity\'s reminders have no unset');
    expect(io.err).toContain('[] clears them');
  });

  test('a missing value and an extra word are usage refusals', async () => {
    const world = place();
    const missing = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders'], missing, sourcesOf(world))).toBe(2);
    expect(missing.err).toContain('a value is required: team config set <entity>.reminders <yaml list>');
    const extra = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', '[]', 'extra'], extra, sourcesOf(world))).toBe(2);
    expect(extra.err).toContain('unexpected "extra"');
  });

  test('get of an entity that writes no reminders says so', async () => {
    const world = place();
    const io = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['get', 'material.reminders'], io, sourcesOf(world))).toBe(1);
    expect(io.err).toContain('entity "material" writes no reminders');
  });

  test('an entity the file does not declare is refused, and nothing is written', async () => {
    const world = place();
    const before = readFileSync(world.file, 'utf8');
    const io = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'omega.reminders', '[]'], io, sourcesOf(world))).toBe(1);
    expect(io.err).toContain('no entry for entity "omega"');
    expect(readFileSync(world.file, 'utf8')).toBe(before);
  });

  test('a list set replaces the whole list, the comment beside the entry kept', async () => {
    const world = place();
    const first = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', LIST], first, sourcesOf(world))).toBe(0);
    const two = '[{name: standup, at: ["09:00"], text: "Read the board.", to: [lead@acme]}, {name: review, at: ["18:00"], text: "Review.", to: [lead@acme]}]';
    const second = testIo(world.root, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.reminders', two], second, sourcesOf(world))).toBe(0);
    expect(second.out).toContain('set floor.reminders: 2 reminders');
    const read = readReminderConfig(world.home, { defaultZone: ZONE });
    expect(read.entries.map((entry) => entry.name)).toEqual(['standup', 'review']);
    expect(readFileSync(world.file, 'utf8')).toContain("# floor's own record");
    expect(existsSync(world.file)).toBe(true);
  });
});
