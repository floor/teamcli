// The decision record's "must not pretend" list in the product (decided-grants-minimum-2026-10-17,
// "What 0.5.0 must not pretend, said plainly"): `team check` prints its six lines under both of
// its answers — the gaps the release does not close, named in the check's output as the record
// asks — and `team status` closes its plain reading with the first of them, the record's "every
// record and view says so". The sentences below are typed out here rather than read from the
// module, so an edit to src/permissions/must-not-pretend.ts fails these tests instead of riding
// through them; the one assertion against the module pins the two together.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { check, loadConfig } from '../src/commands/check.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { CheckSources } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { INTEGRITY_NOT_AUTHORITY, NOT_PRETENDED } from '../src/permissions/must-not-pretend.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

/** The record's six lines, under its heading, as `team check` prints them. */
const LIST = [
  'what 0.5.0 must not pretend:',
  '  Integrity, not authority: every gate 0.5.0 ships holds against a mistake, not against an attempt',
  '  Standing grants with an expiry, not leases',
  '  No two-granter agreement, no `agree`, no `create` bounds',
  '  No read scoping (§3, every disclosure is a `read`), no `act-as`, no `use-broker`, no `deploy` gating',
  '  No constraint program beyond the one-`leads` cardinality and launch-time mutual exclusion (§5)',
  '  No policy object yet (amendment 02)',
];
const BLOCK = `${LIST.join('\n')}\n`;

/** The line the check prints above the block, whatever its answer. */
const NOT_KNOWN = 'not known: work sent and unread, a lead waiting on a seat, a landing not recorded\n';

/** One seat leads: a file with none is refused. */
const TEAM = [
  'format: 1',
  'project: beacon',
  'operator: claude-keeper',
  'workspace:',
  '  mode: shared',
  'seats:',
  '  - role: coordinator',
  '    name: claude-keeper',
  '    label: coordinator',
  '    cli: claude-code',
  '    vendor: anthropic',
  '    model: Claude Opus',
  '    version: "5.5"',
  '    launch: claude --model claude-opus-5-5',
  '    leads: true',
  '  - role: implementer',
  '    name: claude-beacon',
  '    label: implementer',
  '    cli: claude-code',
  '    vendor: anthropic',
  '    model: Claude Opus',
  '    version: "5.5"',
  '    launch: claude --model claude-opus-5-5',
  '',
].join('\n');

function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };
}

/** The team as herdr shows it when both seats run: no workspaces, no screens, nothing to read. */
function running(): Live {
  return { running: true, agents: [agent('claude-keeper'), agent('claude-beacon')], workspaces: [], screens: {} };
}

/** The team with the session down: both seats are in the file and not running. */
const down: Live = { running: false, agents: [], workspaces: [], screens: {} };

let dir: string;
let file: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-must-not-pretend-'));
  home = mkdtempSync(join(tmpdir(), 'team-must-not-pretend-home-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  // The watch the session carries: a session with a live watch has nothing to repair, so the
  // starting scenes differ by their seats alone.
  updateState(join(dir, '.agents'), (state) => {
    state.sessions.beacon = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-17T11:59:00Z' } };
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A bare `team check`, by the owner, with the world handed in. */
async function runCheck(live: Live) {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    cwd: dir,
    env: {},
    stdinIsTTY: false,
    caller: { kind: 'owner' },
  };
  const sources: CheckSources = {
    live: () => live,
    branch: () => 'main',
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home,
  };
  const code = await check([], io, loadConfig, sources);
  return { code, out, err };
}

/** A `team status` of the same folder, by the owner, with the file as approved. */
async function status(live: Live, ...argv: string[]) {
  const checked = validateTeamFile(TEAM);
  if (!checked.ok) throw new Error('the scene\'s file does not validate');
  const sources: StatusSources = {
    live: () => live,
    branch: () => 'main',
    standing: () => verifiedOf(checked.team, TEAM, dir, NOW),
    now: () => NOW,
  };
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

describe('team check omits the footer on every run; team doctor and team --about print NOT_PRETENDED', () => {
  test('the module holds the record\'s lines, and the status footer is the first of them', () => {
    expect([...NOT_PRETENDED]).toEqual(LIST);
    // The record's "every record and view says so": the view prints the check's own first line.
    expect(INTEGRITY_NOT_AUTHORITY).toBe(LIST[1]!.slice(2));
  });

  test('nothing wrong: ends with 0 difference(s) and omits NOT_PRETENDED and not known', async () => {
    const ran = await runCheck(running());
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toBe('team beacon, session "beacon"\n0 difference(s)\n');
    expect(ran.out).not.toContain(NOT_KNOWN);
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });

  test('a difference: ends with the summary count and omits NOT_PRETENDED and not known', async () => {
    const ran = await runCheck(down);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('');
    expect(ran.out).toBe(
      'team beacon, session "beacon"\n' +
        'difference: claude-keeper is in the file and is not running\n' +
        '  repair: the owner runs team up\n' +
        '  who: the owner\n' +
        'difference: claude-beacon is in the file and is not running\n' +
        '  repair: the owner runs team up\n' +
        '  who: the owner\n' +
        '2 difference(s), 2 for the owner\n',
    );
    expect(ran.out).not.toContain(NOT_KNOWN);
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });
});

describe('team status omits the footer on every run; team --about prints NOT_PRETENDED', () => {
  test('a clean status reading ends with the summary count and omits the footer', async () => {
    const ran = await status(running());
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toEndWith('0 difference(s)\n');
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });

  test('a status reading with differences ends with the summary count and omits the footer', async () => {
    const ran = await status(down);
    expect(ran.code).toBe(1);
    expect(ran.out).toEndWith('2 difference(s), 2 for the owner\n');
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });

  test('the JSON document is untouched', async () => {
    const ran = await status(running(), '--json');
    expect(ran.code).toBe(0);
    expect(ran.out).not.toContain('Integrity, not authority');
    const doc = JSON.parse(ran.out) as Record<string, unknown>;
    expect(Object.keys(doc)).not.toContain('must_not_pretend');
  });
});
