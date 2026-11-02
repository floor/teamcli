// The entity record's `reminders:` list as the parser reads it: every field it accepts, the
// entries it refuses alone, and the words it refuses them with. Nothing here reads a team or
// sends anything; resolving an address is the resolver's scene.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import { fillReminderText, isKnownZone, machineZone, readReminderConfig } from '../src/reminder/config.ts';

const DEFAULT_ZONE = 'Europe/Paris';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function homeWith(text: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'team-reminder-config-'));
  homes.push(home);
  if (text !== null) {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(entitiesPath(home), text);
  }
  return home;
}

function read(text: string | null) {
  return readReminderConfig(homeWith(text), { defaultZone: DEFAULT_ZONE });
}

describe('reading the entity reminders list', () => {
  test('one list per entity, every field, the default zone and the file own order', () => {
    const config = read(
      [
        'alpha:',
        '  reminders:',
        '    - name: daily',
        '      at: ["07:00", "19:00", "07:00"]',
        '      to: [lead@alpha, { to: helper@alpha, text: "Hi {seat} in {team}, this is {name}." }]',
        '      text: "Do {team}."',
        'beta:',
        '  roots: [/nowhere]',
        '  reminders:',
        '    - name: weekly',
        '      at: [ "09:30" ]',
        '      zone: UTC',
        '      catchUp: false',
        '      to: [lead@beta]',
        '      text: "Weekly."',
      ].join('\n'),
    );

    expect(config.problems).toEqual([]);
    expect(config.entries).toEqual([
      {
        entity: 'alpha',
        name: 'daily',
        at: ['07:00', '19:00'],
        zone: DEFAULT_ZONE,
        catchUp: undefined,
        text: 'Do {team}.',
        targets: [
          { address: 'lead@alpha', text: null },
          { address: 'helper@alpha', text: 'Hi {seat} in {team}, this is {name}.' },
        ],
      },
      {
        entity: 'beta',
        name: 'weekly',
        at: ['09:30'],
        zone: 'UTC',
        catchUp: false,
        text: 'Weekly.',
        targets: [{ address: 'lead@beta', text: null }],
      },
    ]);
  });

  test('one bad entry is refused alone and the entries around it read', () => {
    const config = read(
      [
        'alpha:',
        '  reminders:',
        '    - name: good',
        '      at: ["07:00"]',
        '      to: [lead@alpha]',
        '      text: ok',
        '    - name: badtime',
        '      at: ["7:00"]',
        '      to: [lead@alpha]',
        '      text: x',
        '    - name: good2',
        '      at: ["08:00"]',
        '      to: [lead@alpha]',
        '      text: ok',
      ].join('\n'),
    );

    expect(config.entries.map((entry) => entry.name)).toEqual(['good', 'good2']);
    expect(config.problems).toEqual([
      { entity: 'alpha', name: 'badtime', why: 'alpha.reminders: at holds a value that is not an HH:MM time' },
    ]);
  });

  test('a field the parser does not know refuses the entry by name', () => {
    const config = read(
      [
        'alpha:',
        '  reminders:',
        '    - name: daily',
        '      at: ["07:00"]',
        '      when: tomorrow',
        '      to: [lead@alpha]',
        '      text: ok',
      ].join('\n'),
    );

    expect(config.entries).toEqual([]);
    expect(config.problems[0]?.why).toBe('alpha.reminders: "when" is not a reminder key (name, at, zone, catchUp, text, to)');
  });

  test('a name two entities repeat is refused at the second and names the first', () => {
    const config = read(
      [
        'alpha:',
        '  reminders:',
        '    - name: daily',
        '      at: ["07:00"]',
        '      to: [lead@alpha]',
        '      text: ok',
        'beta:',
        '  reminders:',
        '    - name: daily',
        '      at: ["08:00"]',
        '      to: [lead@beta]',
        '      text: ok',
      ].join('\n'),
    );

    expect(config.entries.map((entry) => entry.entity)).toEqual(['alpha']);
    expect(config.problems).toEqual([
      { entity: 'beta', name: 'daily', why: 'beta.reminders: "daily" is already a reminder of alpha' },
    ]);
  });

  test('an address without a team, a text no one writes, and an unknown zone are each refused', () => {
    const config = read(
      [
        'alpha:',
        '  reminders:',
        '    - name: bare',
        '      at: ["07:00"]',
        '      to: [lead]',
        '      text: ok',
        '    - name: quiet',
        '      at: ["07:00"]',
        '      to: [lead@alpha]',
        '    - name: zoned',
        '      at: ["07:00"]',
        '      zone: Nowhere/Base',
        '      to: [lead@alpha]',
        '      text: ok',
      ].join('\n'),
    );

    expect(config.entries).toEqual([]);
    expect(config.problems.map((problem) => problem.name)).toEqual(['bare', 'quiet', 'zoned']);
    expect(config.problems[0]?.why).toContain('"lead" is not <seat>@<team>');
    expect(config.problems[1]?.why).toContain('writes no text and the reminder writes none');
    expect(config.problems[2]?.why).toContain('zone must be a named zone this runtime knows');
  });

  test('a document the YAML reader refuses names its line and reads nothing', () => {
    const config = read('alpha:\n  reminders: [unclosed\n');

    expect(config.entries).toEqual([]);
    expect(config.problems).toHaveLength(1);
    expect(config.problems[0]?.entity).toBeNull();
    expect(config.problems[0]?.why).toMatch(/line \d+: /);
  });

  test('an absent entity record declares no reminder and no problem', () => {
    expect(read(null)).toEqual({ entries: [], problems: [] });
  });

  test('an entity that writes no reminders contributes nothing', () => {
    const config = read('alpha:\n  roots: [/one, /two]\n');
    expect(config).toEqual({ entries: [], problems: [] });
  });
});

describe('the words the text is filled with', () => {
  test('only team, seat and name are filled, and a repeat of each is filled again', () => {
    expect(fillReminderText('{team}/{seat}/{name} for {team}; {other}', { team: 'acme', seat: 'lead', name: 'daily' })).toBe(
      'acme/lead/daily for acme; {other}',
    );
  });

  test('a zone the runtime knows reads as one, and the machine names its own', () => {
    expect(isKnownZone('Europe/Paris')).toBe(true);
    expect(isKnownZone('Nowhere/Base')).toBe(false);
    expect(typeof machineZone()).toBe('string');
    expect(machineZone().length).toBeGreaterThan(0);
  });
});
