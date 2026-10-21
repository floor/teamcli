// The decision record's "must not pretend" list in the product (decided-grants-minimum-2026-10-17,
// "What 0.5.0 must not pretend, said plainly"): under the 0.5.0 output contract (§2.3),
// `NOT_PRETENDED` is printed only by `team doctor` and `team --about`, while `team check` and
// `team status` omit `NOT_PRETENDED`, `INTEGRITY_NOT_AUTHORITY`, and `not known:` on every run.
// The sentences below are typed out here rather than read from the module, so an edit to
// src/permissions/must-not-pretend.ts fails these tests instead of riding through them; the one
// assertion against the module pins the two together.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { KEY_ISOLATION_LINE } from '../src/client/records.ts';
import { check, loadConfig } from '../src/commands/check.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { CheckSources } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { INTEGRITY_NOT_AUTHORITY, NOT_PRETENDED, NOT_PRETENDED_ENTRIES } from '../src/permissions/must-not-pretend.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

/** The record's five plain lines, under its heading, as `team doctor` and `team --about` print them. */
const LIST = [
  'what 0.5.0 must not pretend:',
  '  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.',
  '  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.',
  '  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.',
  '  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.',
  '  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.',
];
const BLOCK = `${LIST.join('\n')}\n`;

/** The former `not known:` line, which `team check` no longer prints under the 0.5.0 output contract. */
const NOT_KNOWN = 'not known: work sent and unread, a lead waiting on a seat, a landing not recorded\n';

/** One seat leads: a file with none is refused. */
const TEAM = [
  'format: 1',
  'project: beacon',
  'operator: claude-keeper',
  'workspace:',
  '  mode: shared',
  'seats:',
  '  - role: orchestrator',
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
  test('the module holds the plain lines, keeps Kernel terms out of human lines, and carries refs for JSON and docs', () => {
    expect([...NOT_PRETENDED]).toEqual(LIST);
    // The record's "every record and view says so": the first line is INTEGRITY_NOT_AUTHORITY.
    expect(INTEGRITY_NOT_AUTHORITY).toBe(LIST[1]!.slice(2));
    for (const line of NOT_PRETENDED) {
      expect(line).not.toContain('§');
      expect(line).not.toContain('two-granter');
      expect(line).not.toContain('`agree`');
      expect(line).not.toContain('`act-as`');
      expect(line).not.toContain('`use-broker`');
      expect(line).not.toContain('`read`');
      expect(line).not.toContain('`create`');
    }
    expect(NOT_PRETENDED_ENTRIES.map((e) => e.ref)).toEqual([
      'Kernel §11, §12, §14',
      'Kernel §7, §10, §14, §15 (standing grant vs lease; liveness walk)',
      'Kernel §9, §10 (two-granter agreement, `agree`, `create`)',
      'Kernel §3, §14 (`read` scope, `act-as`, `use-broker`, `deploy`)',
      'Kernel §5, §9 (cardinality, mutual exclusion, separation of duties, cross-lab review)',
    ]);
  });

  test('nothing wrong: ends with no differences and omits NOT_PRETENDED and not known', async () => {
    const ran = await runCheck(running());
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toBe(`team beacon, session "beacon"\n${KEY_ISOLATION_LINE}\nno differences\n`);
    expect(ran.out).not.toContain(NOT_KNOWN);
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });

  test('a difference: ends with the summary count and omits NOT_PRETENDED and not known', async () => {
    const ran = await runCheck(down);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('');
    expect(ran.out).toBe(
      'team beacon, session "beacon"\n' +
        `${KEY_ISOLATION_LINE}\n` +
        'difference: claude-keeper is in the file and is not running\n' +
        '  repair: team up\n' +
        '  who: the owner\n' +
        'difference: claude-beacon is in the file and is not running\n' +
        '  repair: team up\n' +
        '  who: the owner\n' +
        '2 differences, 2 for the owner\n',
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
    expect(ran.out).toEndWith('no differences\n');
    expect(ran.out).not.toContain(INTEGRITY_NOT_AUTHORITY);
  });

  test('a status reading with differences ends with the summary count and omits the footer', async () => {
    const ran = await status(down);
    expect(ran.code).toBe(1);
    expect(ran.out).toEndWith('2 differences, 2 for the owner\n');
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
