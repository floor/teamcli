// Independent check that team ack and team reply admit the caller placed in the team's
// session (src/commands/ack.ts, src/commands/reply.ts, src/caller.ts). The pane host and the
// process ancestry are synthetic. No live host, CLI, or send runs.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callerOf, walkCaller, type CallerSources } from '../src/caller.ts';
import { runAck, type AckHost } from '../src/commands/ack.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { receiptFile } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, recordAt, testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const ACKED = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
const ANSWERED = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const ANSWER = '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';
const PANE = 'fixture-pane-one';
const OTHER = 'fixture-pane-two';
const ROOT = 11;
const OTHER_ROOT = 22;

let bases: string[] = [];
let scratch = '';

afterEach(() => {
  if (bases.length > 0) discardFixtures(bases, { roots: scratch === '' ? [] : [scratch] });
  bases = [];
});

type Made = { root: string; dir: string; home: string };

function world(): Made {
  const base = fixtureBase('place-');
  bases.push(base);
  scratch = dirname(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  const lobby = lobbyDir(home);
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Fixture
    version: "1"
    launch: claude
    inbound: accept
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Fixture
    version: "1"
    launch: claude
    inbound: accept
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Fixture
    version: "1"
    launch: codex
`, { mode: 0o600 });
  return { root, dir, home };
}

function stand(made: Made, seats: Record<string, string>): void {
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: Object.fromEntries(Object.entries(seats).map(([name, pane]) => [name, { stage: 'ready', pane }])),
      worktrees: {},
    };
  });
}

function agent(name: string, pane: string, cwd: string): HerdrAgent {
  return { name, agent: 'fixture', pane, workspace: 'fixture-workspace', status: 'idle', cwd };
}

/** A shell under the pane host. The host lists agents only when the team's session is named. */
function hosted(made: Made, pane: string, rootPid: number, listed: (session: string) => HerdrAgent[]): (session: string | undefined) => CallerSources {
  return (session) => ({
    ancestors: () => [
      { pid: 33, name: 'sh' },
      { pid: rootPid, name: 'seat-shell' },
      { pid: 9, name: 'herdr' },
    ],
    agents: () => (session === undefined ? null : listed(session)),
    paneRootPid: (asked) => (asked === pane ? rootPid : null),
    env: { HERDR_PANE_ID: pane },
    stdinIsTTY: true,
  });
}

function open(made: Made, sources: (session: string | undefined) => CallerSources): TestIo {
  const io = testIo(made.root);
  io.callerSources = sources;
  return io;
}

function ackHost(made: Made): AckHost {
  return { home: made.home, now: () => NOW };
}

function replyHost(made: Made): ReplyHost {
  return { home: made.home, now: () => NOW, newId: () => ANSWER };
}

function plant(made: Made): void {
  plantRecord(made.home, made.root, 'acme', 'helper', ACKED, 'a question', { from: 'lead', at: NOW.toISOString() });
  plantRecord(made.home, made.root, 'acme', 'helper', ANSWERED, 'a question', { from: 'lead', at: NOW.toISOString() });
}

function readReceipt(made: Made): string {
  return receiptFile(recordDir(made.root, 'acme', 'helper'), ACKED, 'read');
}

function answerPath(made: Made): string {
  return join(recordDir(made.root, 'acme', 'lead'), ANSWER);
}

test('a seat shell inside its own pane is admitted, and the sessionless walk still places nobody', async () => {
  const made = world();
  stand(made, { helper: PANE });
  plant(made);
  const sources = hosted(made, PANE, ROOT, (session) => (
    session === 'acme' ? [agent('helper', PANE, made.root)] : []
  ));
  const io = open(made, sources);

  expect(walkCaller(io).kind).toBe('unplaced');
  expect(callerOf(io).kind).toBe('unplaced');
  expect(callerOf(io, 'acme')).toEqual({ kind: 'seat', name: 'helper', pane: PANE, session: 'acme' });

  const ackIo = open(made, sources);
  expect(await runAck([ACKED], ackIo, ackHost(made))).toBe(0);
  expect(ackIo.err).toBe('');
  expect(existsSync(readReceipt(made))).toBe(true);

  const replyIo = open(made, sources);
  expect(await runReply([ANSWERED, 'the answer'], replyIo, replyHost(made))).toBe(0);
  expect(replyIo.err).toBe('');
  expect(recordAt(answerPath(made)).payload.from).toBe('helper');
});

test('a shell in another seat\'s pane is not admitted as the addressee', async () => {
  const made = world();
  stand(made, { helper: PANE, native: OTHER });
  plant(made);
  const sources = hosted(made, OTHER, OTHER_ROOT, (session) => (
    session === 'acme'
      ? [agent('helper', PANE, made.root), agent('native', OTHER, made.root)]
      : []
  ));
  // The other pane's root is the only one this shell carries. The host still lists both seats.
  const placed = callerOf(open(made, sources), 'acme');
  expect(placed).toEqual({ kind: 'seat', name: 'native', pane: OTHER, session: 'acme' });

  const ackIo = open(made, sources);
  expect(await runAck([ACKED], ackIo, ackHost(made))).toBe(1);
  expect(ackIo.err).toContain('addressed to helper, not to native');
  expect(existsSync(readReceipt(made))).toBe(false);

  const replyIo = open(made, sources);
  expect(await runReply([ANSWERED, 'the answer'], replyIo, replyHost(made))).toBe(1);
  expect(replyIo.err).toContain('addressed to helper, not to native');
  expect(existsSync(answerPath(made))).toBe(false);
});

test('a host that names the addressee on another seat\'s pane does not admit it', async () => {
  const made = world();
  stand(made, { helper: PANE, native: OTHER });
  plant(made);
  const sources = hosted(made, OTHER, OTHER_ROOT, (session) => (
    session === 'acme' ? [agent('helper', OTHER, made.root)] : []
  ));

  const ackIo = open(made, sources);
  expect(await runAck([ACKED], ackIo, ackHost(made))).toBe(1);
  expect(ackIo.err).toContain('not this call on its own pane and session');
  expect(existsSync(readReceipt(made))).toBe(false);

  const replyIo = open(made, sources);
  expect(await runReply([ANSWERED, 'the answer'], replyIo, replyHost(made))).toBe(1);
  expect(replyIo.err).toContain('not the pane this call is on');
  expect(existsSync(answerPath(made))).toBe(false);
});

test('a shell outside the pane host, with no placement, is refused by both commands', async () => {
  const made = world();
  stand(made, { helper: PANE });
  plant(made);

  const detached: (session: string | undefined) => CallerSources = () => ({
    ancestors: () => [{ pid: 33, name: 'sh' }, { pid: 2, name: 'zsh' }],
    agents: () => null,
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: false,
  });
  const ackDetached = open(made, detached);
  expect(await runAck([ACKED], ackDetached, ackHost(made))).toBe(1);
  expect(ackDetached.err).toContain('a terminal outside herdr or its own pane');
  const replyDetached = open(made, detached);
  expect(await runReply([ANSWERED, 'the answer'], replyDetached, replyHost(made))).toBe(1);
  expect(replyDetached.err).toContain('a terminal outside herdr or its own pane');
  expect(existsSync(readReceipt(made))).toBe(false);
  expect(existsSync(answerPath(made))).toBe(false);

  const agentOutside: (session: string | undefined) => CallerSources = () => ({
    ancestors: () => [{ pid: 40, name: 'codex' }, { pid: 2, name: 'zsh' }],
    agents: () => [agent('helper', PANE, made.root)],
    paneRootPid: () => ROOT,
    env: { HERDR_PANE_ID: PANE },
    stdinIsTTY: true,
  });
  const ackAgent = open(made, agentOutside);
  expect(await runAck([ACKED], ackAgent, ackHost(made))).toBe(1);
  expect(ackAgent.err).toContain('unplaced');
  expect(ackAgent.err).toContain('outside herdr');
  const replyAgent = open(made, agentOutside);
  expect(await runReply([ANSWERED, 'the answer'], replyAgent, replyHost(made))).toBe(1);
  expect(replyAgent.err).toContain('unplaced');
  expect(existsSync(readReceipt(made))).toBe(false);
  expect(existsSync(answerPath(made))).toBe(false);
});

test('a sessionless caller is not a seat, and a host that never answers stays unplaced', async () => {
  const made = world();
  stand(made, { helper: PANE });
  plant(made);

  const silent: (session: string | undefined) => CallerSources = () => ({
    ancestors: () => [{ pid: 33, name: 'sh' }, { pid: 9, name: 'herdr' }],
    agents: () => null,
    paneRootPid: () => null,
    env: { HERDR_PANE_ID: PANE },
    stdinIsTTY: true,
  });
  expect(walkCaller(open(made, silent)).kind).toBe('unplaced');
  expect(callerOf(open(made, silent), 'acme').kind).toBe('unplaced');
  const ackSilent = open(made, silent);
  expect(await runAck([ACKED], ackSilent, ackHost(made))).toBe(1);
  expect(ackSilent.err).toContain('unplaced');
  const replySilent = open(made, silent);
  expect(await runReply([ANSWERED, 'the answer'], replySilent, replyHost(made))).toBe(1);
  expect(replySilent.err).toContain('unplaced');

  const handed = testIo(made.root, { kind: 'seat', name: 'helper', pane: PANE });
  expect(walkCaller(handed)).toEqual({ kind: 'seat', name: 'helper', pane: PANE });
  expect(await runAck([ACKED], handed, ackHost(made))).toBe(1);
  expect(handed.err).toContain('not this call on its own pane and session');
  const handedReply = testIo(made.root, { kind: 'seat', name: 'helper', pane: PANE });
  expect(await runReply([ANSWERED, 'the answer'], handedReply, replyHost(made))).toBe(1);
  expect(handedReply.err).toContain('not placed in it');
  expect(existsSync(readReceipt(made))).toBe(false);
  expect(existsSync(answerPath(made))).toBe(false);
});
