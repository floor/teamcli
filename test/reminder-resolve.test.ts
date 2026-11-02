// From an address to the seat a beat can send to: the registry names the team, the team's own
// file names the seat, and a human's pane or an undeclared name refuses the whole reminder. The
// fixtures are a temporary checkout with a real team file and a home registry naming it; no
// session, socket or CLI home is reached.
import { afterEach, describe, expect, test } from 'bun:test';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { ReminderConfigEntry } from '../src/reminder/config.ts';
import { resolveReminderEntries } from '../src/reminder/resolve.ts';
import { world, type World } from './send-native-fixtures.ts';

const made: World[] = [];
afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

function entry(over: Partial<ReminderConfigEntry> = {}): ReminderConfigEntry {
  return {
    entity: 'acme',
    name: 'daily',
    at: ['07:00'],
    zone: 'Europe/Paris',
    catchUp: undefined,
    text: 'Do {team} ({seat}); this is {name}.',
    targets: [{ address: 'lead@acme', text: null }],
    ...over,
  };
}

/** The fixture world's team, recorded in its own home registry: the address resolves through the
 *  registry to this checkout, and the seat through the file it names. */
function registered(withHuman = false): World {
  const one = world(['mcp-inbox', 'typed'], withHuman ? [{ name: 'person', role: 'observer', human: true }] : []);
  made.push(one);
  upsertTeam(one.home, teamIdOf(one.root), {
    project: 'acme',
    session: 'acme',
    root: one.root,
    by: 'reminder-resolve-test',
    at: '2026-11-02T00:00:00.000Z',
  });
  return one;
}

describe('resolving a reminder address', () => {
  test('a lead address becomes the checkout, its session and the declared lead seat, text filled', () => {
    const one = registered();
    const resolved = resolveReminderEntries(one.home, [entry()]);

    expect(resolved.problems).toEqual([]);
    expect(resolved.specs).toEqual([{
      name: 'daily',
      at: ['07:00'],
      zone: 'Europe/Paris',
      targets: [{
        recipient: { root: one.root, session: 'acme', seat: 'lead' },
        text: 'Do acme (lead); this is daily.',
      }],
    }]);
  });

  test('a per-target text fills its own seat name, and a repeated seat is addressed once', () => {
    const one = registered();
    const resolved = resolveReminderEntries(one.home, [
      entry({
        catchUp: false,
        targets: [
          { address: 'helper@acme', text: '{seat} takes the first half.' },
          { address: 'lead@acme', text: null },
          { address: 'helper@acme', text: '{seat} again.' },
        ],
      }),
    ]);

    expect(resolved.problems).toEqual([]);
    expect(resolved.specs[0]?.catchUp).toBe(false);
    expect(resolved.specs[0]?.targets.map((target) => [target.recipient.seat, target.text])).toEqual([
      ['helper', 'helper takes the first half.'],
      ['lead', 'Do acme (lead); this is daily.'],
    ]);
  });

  test('a human seat, an undeclared name and an unregistered team each refuse the reminder alone', () => {
    const one = registered(true);
    const good = entry({ name: 'good' });
    const resolved = resolveReminderEntries(one.home, [
      entry({ name: 'human', targets: [{ address: 'person@acme', text: null }] }),
      entry({ name: 'missing', targets: [{ address: 'nobody@acme', text: null }] }),
      entry({ name: 'unregistered', targets: [{ address: 'lead@ghost', text: null }] }),
      good,
    ]);

    expect(resolved.specs.map((spec) => spec.name)).toEqual(['good']);
    expect(resolved.problems.map((problem) => problem.name)).toEqual(['human', 'missing', 'unregistered']);
    expect(resolved.problems[0]?.why).toContain('person is a human seat');
    expect(resolved.problems[1]?.why).toContain('declares no seat or nickname "nobody"');
    expect(resolved.problems[2]?.why).toContain('no team registry record matches "ghost"');
  });

  test('a scope two records answer is refused, naming both ids', () => {
    const one = registered();
    const other = world();
    made.push(other);
    upsertTeam(other.home, teamIdOf(other.root), {
      project: 'acme',
      session: 'other',
      root: other.root,
      by: 'reminder-resolve-test',
      at: '2026-11-02T00:00:00.000Z',
    });
    // Both records live in the first home's registry: the same team name, two checkouts.
    upsertTeam(one.home, teamIdOf(other.root), {
      project: 'acme',
      session: 'other',
      root: other.root,
      by: 'reminder-resolve-test',
      at: '2026-11-02T00:00:00.000Z',
    });

    const resolved = resolveReminderEntries(one.home, [entry()]);

    expect(resolved.specs).toEqual([]);
    expect(resolved.problems[0]?.why).toContain('names 2 teams');
  });
});
