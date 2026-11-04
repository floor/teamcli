// What `team daemon run` hands its host: the entity record read into the specs a beat runs, with
// the refused entries named through the beat's log — and the read held between beats until the
// file changes, so an untouched file does not repeat its complaint every five seconds. The start
// is a stand-in that captures its input; no daemon process, socket or session exists here.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { entitiesPath } from '../src/entities.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';
import { world, type World } from './send-native-fixtures.ts';

const made: World[] = [];
afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

function worldWithReminders(text: string): World {
  const one = world();
  made.push(one);
  upsertTeam(one.home, teamIdOf(one.root), {
    project: 'acme',
    session: 'acme',
    root: one.root,
    by: 'reminder-wiring-test',
    at: '2026-11-02T00:00:00.000Z',
  });
  mkdirSync(join(one.home, '.config', 'team'), { recursive: true });
  writeFileSync(entitiesPath(one.home), text);
  return one;
}

async function started(one: World): Promise<Parameters<NonNullable<DaemonCommandSources['start']>>[0]> {
  let captured: Parameters<NonNullable<DaemonCommandSources['start']>>[0] | null = null;
  const io = testIo(one.root, { kind: 'owner' });
  const code = await runDaemon(['run', '--root', one.root], io, {
    home: one.home,
    service: null,
    start: async (input) => {
      captured = input;
      return { kind: 'already-running', pid: 42 };
    },
  });
  expect(code, io.err).toBe(0);
  if (captured === null) throw new Error('the start was never called');
  return captured;
}

describe('the daemon run reads the entity record', () => {
  test('the configured reminder reaches the host resolved, with nothing to log', async () => {
    const one = worldWithReminders(
      [
        'acme:',
        '  reminders:',
        '    - name: daily',
        '      at: ["19:00"]',
        '      zone: Europe/Paris',
        '      to: [lead@acme]',
        '      text: "Go {team}, {seat}."',
      ].join('\n'),
    );
    const input = await started(one);
    const lines: string[] = [];

    const specs = input.reminders?.((line) => lines.push(line));

    expect(lines).toEqual([]);
    expect(specs).toEqual([{
      name: 'daily',
      at: ['19:00'],
      zone: 'Europe/Paris',
      targets: [{ recipient: { root: one.root, session: 'acme', seat: 'lead' }, text: 'Go acme, lead.' }],
    }]);
  });

  test('a refused entry is logged once and the good one still reaches the host', async () => {
    const one = worldWithReminders(
      [
        'acme:',
        '  reminders:',
        '    - name: good',
        '      at: ["19:00"]',
        '      zone: Europe/Paris',
        '      to: [lead@acme]',
        '      text: "Go {team}."',
        '    - name: broken',
        '      at: ["19:00"]',
        '      to: [nobody@acme]',
        '      text: "Hello."',
      ].join('\n'),
    );
    const input = await started(one);
    const lines: string[] = [];

    const first = input.reminders?.((line) => lines.push(line));
    const second = input.reminders?.((line) => lines.push(line));

    expect(first?.map((spec) => spec.name)).toEqual(['good']);
    expect(second).toEqual(first);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('declares no seat or nickname "nobody"');
  });

  test('a target outside the hosted checkouts refuses the reminder at the read, named', async () => {
    const one = worldWithReminders(
      [
        'acme:',
        '  reminders:',
        '    - name: far',
        '      at: ["19:00"]',
        '      to: [lead@beta]',
        '      text: "Go {team}."',
      ].join('\n'),
    );
    // A second checkout in the same home: its file trusts this home's lobby, and its registry
    // record is project beta, but this daemon hosts only `one.root`.
    const other = world();
    made.push(other);
    writeFileSync(
      join(other.root, '.agents', 'team.yaml'),
      [
        'format: 1',
        'project: beta',
        'coordinator: lead',
        'operator: lead',
        'session: beta',
        'workspace:',
        '  mode: shared',
        'trust:',
        `  - ${lobbyDir(one.home)}`,
        `  - ${other.root}`,
        'seats:',
        '  - role: coordinator',
        '    name: lead',
        '    cli: claude-code',
        '    vendor: test',
        '    model: Test',
        '    version: "1"',
        '    launch: claude',
        '    inbound: accept',
      ].join('\n'),
    );
    upsertTeam(one.home, teamIdOf(other.root), {
      project: 'beta',
      session: 'beta',
      root: other.root,
      by: 'reminder-wiring-test',
      at: '2026-11-02T00:00:00.000Z',
    });
    const input = await started(one);
    const lines: string[] = [];

    const specs = input.reminders?.((line) => lines.push(line));

    expect(specs).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`lead@beta: the checkout ${other.root} is not one this daemon hosts`);
  });

  test('an injected status reader is what the host runs, its refused entries logged', async () => {
    const one = worldWithReminders('acme:\n  roots: [/nowhere]\n');
    const lines: string[] = [];
    let captured: Parameters<NonNullable<DaemonCommandSources['start']>>[0] | null = null;
    const code = await runDaemon(['run', '--root', one.root], testIo(one.root, { kind: 'owner' }), {
      home: one.home,
      service: null,
      reminders: () => ({ specs: [], problems: ['alpha.reminders: refused'] }),
      start: async (input) => {
        captured = input;
        return { kind: 'already-running', pid: 42 };
      },
    });

    expect(code).toBe(0);
    expect(captured!.reminders?.((line) => lines.push(line))).toEqual([]);
    expect(lines).toEqual(['alpha.reminders: refused']);
  });

  test('a registry that cannot be read refuses the whole list, says so once, and resumes when repaired', async () => {
    const one = worldWithReminders(
      [
        'acme:',
        '  reminders:',
        '    - name: daily',
        '      at: ["19:00"]',
        '      zone: Europe/Paris',
        '      to: [lead@acme]',
        '      text: "Go {team}, {seat}."',
      ].join('\n'),
    );
    const input = await started(one);
    const lines: string[] = [];
    expect(input.reminders?.((line) => lines.push(line))?.map((spec) => spec.name)).toEqual(['daily']);
    expect(lines).toEqual([]);
    const registry = readFileSync(teamsFile(one.home), 'utf8');

    // The owner edits the entity record (the provider reads on its stamp) while the registry the
    // addresses resolve through is broken: the list cannot be judged, so nothing may fire on the
    // previous reading, which the edit may have replaced.
    writeFileSync(entitiesPath(one.home), [
      'acme:',
      '  reminders:',
      '    - name: daily',
      '      at: ["19:00"]',
      '      zone: Europe/Paris',
      '      to: [lead@acme]',
      '      text: "Go {team}, now."',
    ].join('\n'));
    writeFileSync(teamsFile(one.home), 'teams: [broken\n');

    const refused = input.reminders?.((line) => lines.push(line));

    expect(refused).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the configured list could not be read');
    expect(lines[0]).toContain('teams.yaml');
    // The same broken registry is retried quietly: the complaint is said once, on the change.
    expect(input.reminders?.((line) => lines.push(line))).toEqual([]);
    expect(lines).toHaveLength(1);

    // Repaired, the next read resumes without the entity record changing again.
    writeFileSync(teamsFile(one.home), registry);
    expect(input.reminders?.((line) => lines.push(line))?.map((spec) => spec.name)).toEqual(['daily']);
    expect(lines).toHaveLength(1);
  });
});
