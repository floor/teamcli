// The projection the `team` CLI generates from a file's `reach` grants — `<lobby>/reach-roster.json`,
// the one file the bridge and the seat-shuttle daemon both read. The parse of the grant itself is
// test/seat-reach.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { projectionOf, reachProjectionNote, writeReachProjection } from '../src/reach/projection.ts';

const HEAD = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
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
  - role: assistant
    name: iris
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
`;
const LAUNCH = '    launch: claude --model claude-opus-5-5\n';
const REACH = '    reach:\n      to: [grokbot]\n';

function teamText(reach = ''): string {
  return `${HEAD}${reach}${LAUNCH}`;
}

function team(text: string = teamText()): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function seatOf(name: string, text: string = teamText()): TeamFile['seats'][number] {
  const seat = team(text).seats.find((one) => one.name === name);
  if (!seat) throw new Error(`no seat ${name}`);
  return seat;
}

describe('the projection', () => {
  test('derives one default each, and a written value wins', () => {
    const home = '/Users/x';
    expect(projectionOf(team(teamText(REACH)), home)).toEqual({
      version: 1,
      seats: [{ alias: 'iris', route: 'iris', key_id: 'seat-iris-1', guard_dir: '/Users/x/.config/team/lobby/guard-floor-iris', reach: ['grokbot'] }],
    });
    const named = projectionOf(team(teamText('    reach:\n      to: [grokbot]\n      alias: "Lead-X"\n      route: floor-20\n      key_id: seat-iris-1\n      guard_dir: /Users/x/guard-floor-iris\n')), home);
    expect(named.seats).toEqual([{ alias: 'lead-x', route: 'floor-20', key_id: 'seat-iris-1', guard_dir: '/Users/x/guard-floor-iris', reach: ['grokbot'] }]);
  });

  test('the generator emits only seats whose reach.to includes a known front', () => {
    // The invariant the review asked to pin, held against a hand-built team the parse would
    // never pass: no grant, and a grant whose only front is unknown, project nothing — no
    // roster entry, no front entry, no lane. The parse refuses those shapes, so this check
    // keeps a future parser change honest.
    const plain = { ...seatOf('iris', teamText(REACH)) };
    delete plain.reach;
    const granted = seatOf('iris', teamText(REACH));
    const hand: TeamFile = {
      ...team(teamText()),
      seats: [
        { ...plain, name: 'none' },
        { ...granted, name: 'unknown', reach: { to: ['other-front'] } },
        { ...granted, name: 'granted' },
      ],
    };
    expect(projectionOf(hand, '/Users/x').seats.map((seat) => seat.alias)).toEqual(['granted']);
  });
});

describe('the projection file', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'team-reach-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function lobbyOf(mode: number): string {
    const lobby = join(home, '.config', 'team', 'lobby');
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, mode);
    return lobby;
  }

  test('writes atomically beside a real lobby, and then leaves an unchanged file alone', () => {
    const lobby = lobbyOf(0o700);
    const path = join(lobby, 'reach-roster.json');
    const first = writeReachProjection(team(teamText(REACH)), home);
    expect(first).toEqual({ written: true, reason: null, path, seats: 1 });
    expect(reachProjectionNote(first)).toBe('reach projection: 1 seat');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      seats: [{ alias: 'iris', route: 'iris', key_id: 'seat-iris-1', guard_dir: join(lobby, 'guard-floor-iris'), reach: ['grokbot'] }],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(lobby, 'reach-roster.json.tmp'))).toBe(false);
    const again = writeReachProjection(team(teamText(REACH)), home);
    expect(again.written).toBe(false);
    expect(again.reason).toBeNull();
    expect(reachProjectionNote(again)).toBeNull();
  });

  test('a team that clears every grant writes the empty projection: omission is the revocation', () => {
    const lobby = lobbyOf(0o700);
    writeReachProjection(team(teamText(REACH)), home);
    const cleared = writeReachProjection(team(teamText()), home);
    expect(cleared.written).toBe(true);
    expect(cleared.seats).toBe(0);
    expect(reachProjectionNote(cleared)).toBe('reach projection: 0 seats');
    expect(JSON.parse(readFileSync(join(lobby, 'reach-roster.json'), 'utf8'))).toEqual({ version: 1, seats: [] });
  });

  test('a missing or non-0700 lobby is a skip with a reason, never a made folder', () => {
    const missing = writeReachProjection(team(teamText(REACH)), home);
    expect(missing.written).toBe(false);
    expect(missing.reason).toBe(`no lobby at ${join(home, '.config', 'team', 'lobby')}`);
    expect(reachProjectionNote(missing)).toBe(`reach projection not written: no lobby at ${join(home, '.config', 'team', 'lobby')}`);
    expect(existsSync(join(home, '.config'))).toBe(false);
    const lobby = lobbyOf(0o755);
    const loose = writeReachProjection(team(teamText(REACH)), home);
    expect(loose.written).toBe(false);
    expect(loose.reason).toBe(`the lobby ${lobby} has mode 0755, not 0700`);
    expect(existsSync(join(lobby, 'reach-roster.json'))).toBe(false);
  });

  test('a seat the readers would refuse is not written at all — the last good file stands', () => {
    const lobby = lobbyOf(0o700);
    const path = join(lobby, 'reach-roster.json');
    writeReachProjection(team(teamText(REACH)), home);
    const before = readFileSync(path, 'utf8');
    const hand: TeamFile = {
      ...team(teamText()),
      seats: [{ ...seatOf('iris', teamText(REACH)), reach: { to: ['grokbot'], alias: 'no good' } }],
    };
    const refused = writeReachProjection(hand, home);
    expect(refused.written).toBe(false);
    expect(refused.reason).toBe('invalid reach seat "iris": alias "no good", route "no good", key_id "seat-no good-1"');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
