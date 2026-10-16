import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const delegated = `${example.endsWith('\n') ? example : `${example}\n`}delegates:\n  - pane: foreign/w9:p1\n    commands: [up]\n`;
const NOW = new Date('2026-10-12T20:00:00Z');
const SENTENCE = 'team status: this team is not yours to read\n';
const SEAT = 'claude-coordinator-acme';

const quiet = { running: false, agents: [], workspaces: [], screens: {} };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function sources(dir: string, over: Partial<StatusSources> = {}): StatusSources {
  return {
    live: () => quiet,
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home: dir,
    gate: { standing: () => ({ kind: 'none' }), agents: () => [] },
    ...over,
  };
}

function folder(text: string | undefined): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-status-caller-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  if (text !== undefined) writeFileSync(join(dir, '.agents', 'team.yaml'), text);
  return dir;
}

function record(dir: string, pane: string, name = SEAT): void {
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane, workspace: 'w1' };
  });
}

async function run(dir: string, argv: string[], caller: Caller, src: StatusSources = sources(dir)) {
  const io = testIo(dir, caller);
  const code = await runStatus(argv, io, src);
  return { code, out: io.out, err: io.err };
}

function refused(result: { code: number; out: string; err: string }): void {
  expect(result.code).toBe(2);
  expect(result.err).toBe(SENTENCE);
  expect(result.out).toBe('');
}

const owner = { kind: 'owner' } as const;
const seat = { kind: 'seat', name: SEAT, pane: 'w1:p1', session: 'acme-web' } as const;

test('the owner reads with no flag, with --file, and with --session', async () => {
  const dir = folder(example);
  const file = join(dir, '.agents', 'team.yaml');
  const seen: string[] = [];
  const src = sources(dir, { live: (session) => { seen.push(session); return quiet; } });
  const plain = await run(dir, [], owner, src);
  expect(plain.out).toContain('team acme-web, session "acme-web"');
  expect(plain.code).not.toBe(2);
  expect(readState(join(dir, '.agents')).last_valid?.file).toBe(example);
  const aimed = await run(dir, ['--file', file], owner, src);
  expect(aimed.out).toContain('team acme-web, session "acme-web"');
  expect(aimed.code).not.toBe(2);
  seen.length = 0;
  const other = await run(dir, ['--session', 'other-session'], owner, src);
  expect(seen).toEqual(['other-session']);
  expect(other.out).toContain('session "other-session"');
});

test('a seat on its recorded pane reads, and the run writes nothing', async () => {
  const dir = folder(example);
  record(dir, 'w1:p1');
  const result = await run(dir, [], seat);
  expect(result.out).toContain('team acme-web, session "acme-web"');
  expect(result.code).not.toBe(2);
  expect(result.err).not.toBe(SENTENCE);
  expect(readState(join(dir, '.agents')).last_valid).toBeUndefined();
});

test('the same seat on another pane gets the fixed sentence', async () => {
  const dir = folder(example);
  record(dir, 'w1:p1');
  refused(await run(dir, [], { kind: 'seat', name: SEAT, pane: 'w2:p1', session: 'acme-web' }));
});

test('a seat of another team in this folder gets the fixed sentence', async () => {
  const dir = folder(example);
  record(dir, 'w1:p1');
  refused(await run(dir, [], { kind: 'seat', name: 'other-team', pane: 'w1:p1', session: 'other-team' }));
});

test('a pane the approved file names reads', async () => {
  const dir = folder(delegated);
  const checked = validateTeamFile(delegated);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const result = await run(dir, [], { kind: 'pane', pane: 'w9:p1', session: 'foreign' }, sources(dir, {
    standing: () => verifiedOf(checked.team, delegated, dir, NOW),
    gate: {
      standing: () => verifiedOf(checked.team, delegated, dir, NOW),
      agents: () => [],
    },
  }));
  expect(result.code).not.toBe(2);
  expect(result.out).toContain('team acme-web, session "acme-web"');
  expect(result.err).not.toBe(SENTENCE);
});

test('a pane only the live file names reads', async () => {
  const dir = folder(delegated);
  const approved = validateTeamFile(example);
  if (!approved.ok) throw new Error(JSON.stringify(approved.errors));
  const result = await run(dir, [], { kind: 'pane', pane: 'w9:p1', session: 'foreign' }, sources(dir, {
    standing: () => verifiedOf(approved.team, example, dir, NOW),
    gate: {
      standing: () => verifiedOf(approved.team, example, dir, NOW),
      agents: () => [],
    },
  }));
  expect(result.code).not.toBe(2);
  expect(result.out).toContain('team acme-web, session "acme-web"');
  expect(result.err).not.toBe(SENTENCE);
});

test('an unplaced caller gets the fixed sentence', async () => {
  const dir = folder(example);
  refused(await run(dir, [], { kind: 'unplaced', reason: 'it runs under herdr' }));
});

test('an owner without a terminal gets the fixed sentence', async () => {
  const dir = folder(example);
  refused(await run(dir, [], { kind: 'owner-no-tty' }));
});

test('--file from a seat is refused before the file is read', async () => {
  const dir = folder(example);
  const file = join(dir, '.agents', 'team.yaml');
  const unread: StatusSources = {
    ...sources(dir),
    live: () => { throw new Error('a session was read'); },
    standing: () => { throw new Error('the approval was read'); },
  };
  const text = `team status: --file is the owner's, from a terminal outside herdr; this call is ${SEAT}\n`;
  const missing = await run(dir, ['--file', join(dir, 'no-such.yaml')], seat, unread);
  const present = await run(dir, ['--file', file], seat, unread);
  expect(missing).toEqual({ code: 1, out: '', err: text });
  expect(present).toEqual(missing);
});

test('--session from a seat is refused before a session is read', async () => {
  const dir = folder(example);
  const asked: Array<string | undefined> = [];
  const io = testIo(dir);
  io.callerSources = (session) => {
    asked.push(session);
    return {
      ancestors: () => [{ pid: 2, name: 'herdr' }],
      agents: () => { throw new Error('a session was read'); },
      paneRootPid: () => { throw new Error('a pane was read'); },
      env: {},
      stdinIsTTY: true,
    };
  };
  const code = await runStatus(['--session', 'acme-web'], io, {
    ...sources(dir),
    live: () => { throw new Error('a session was read'); },
    standing: () => { throw new Error('the approval was read'); },
  });
  expect(asked).toEqual([undefined]);
  expect(code).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe('team status: --session is the owner\'s, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');

  const named = await run(dir, ['--session', 'acme-web'], seat, {
    ...sources(dir),
    live: () => { throw new Error('a session was read'); },
    standing: () => { throw new Error('the approval was read'); },
  });
  expect(named).toEqual({
    code: 1,
    out: '',
    err: `team status: --session is the owner's, from a terminal outside herdr; this call is ${SEAT}\n`,
  });
});

test('--json does not change the fixed sentence', async () => {
  const dir = folder(example);
  refused(await run(dir, ['--json'], { kind: 'unplaced', reason: 'it runs under herdr' }));
});

test('a missing team file gives a non-owner the fixed sentence', async () => {
  const dir = folder(undefined);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
  refused(await run(dir, [], seat));
});

test('an invalid team file gives a non-owner the fixed sentence', async () => {
  const dir = folder('format: [\n');
  refused(await run(dir, [], seat));
});

test('a file that was never approved gives a non-owner the fixed sentence', async () => {
  const dir = folder(example);
  refused(await run(dir, [], { kind: 'seat', name: 'other-team', pane: 'w9:p1', session: 'other-team' }));
});

test('a refused approval gives a non-owner the fixed sentence', async () => {
  const dir = folder(example);
  refused(await run(dir, [], { kind: 'unplaced', reason: 'it runs under herdr' }, sources(dir, {
    standing: () => ({ kind: 'refused', why: 'the record does not verify' }),
    gate: { standing: () => ({ kind: 'refused', why: 'the record does not verify' }), agents: () => [] },
  })));
});

test('a seat on its recorded pane still reads a file that was never approved', async () => {
  const dir = folder(example);
  record(dir, 'w1:p1');
  const result = await run(dir, [], seat);
  expect(result.out).toContain('team acme-web, session "acme-web"');
  expect(result.err).not.toBe(SENTENCE);
  expect(result.code).not.toBe(2);
});
