// Independent runtime regressions for signed message records and their receipts at the queued
// swap boundary. The contract is Draft 3 (§3.1 one signed record per message; §3.3 status is
// derived from signed receipts, never edited onto the record) and docs/design/model-rule.md: a
// swap waits for "a done report, or idle with nothing queued", where "nothing queued" is the
// design's boundary — quiet, no turn, no dialog, no lease, and no work drop waiting.
//
// A message the seat has taken is not waiting work. The status writers in src/send/record.ts are
// the real ones here: every record is signed by the checkout's message key and written by
// `writeRecord`/`writeRecordOver`, and every receipt is signed and written by
// `signReceiptPayload`/`writeReceipt`. The helper scenes call the exported assigned-work check;
// the boundary scenes drive the real `team swap --run` path through `runSwap`, with the herdr and
// launch seams faked at their documented types, in synthetic temporary homes. A reading of the
// source is never the evidence: both kinds of scene execute the shipped code.
//
// The fixture ('lyra') is this file's own. Cleanup uses the system trash per the standing rule:
// no recursive rm.
import { execFileSync, spawnSync } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runSwap } from '../src/commands/swap.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { generalBriefRecord } from '../src/launch/general-brief.ts';
import {
  isRead,
  signReceiptPayload,
  signRecord,
  statusOf,
  writeReceipt,
  writeRecord,
  writeRecordOver,
  type ReceiptStatus,
  type RecordPayload,
} from '../src/send/record.ts';
import { enqueueSwap } from '../src/swap/queue.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { seatHasAssignedWorkOnDisk } from '../src/watch/status-events.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const SESSION = 'lyra';
const OWNER: Caller = { kind: 'owner' };
const RULE = '*=!openai';
const MESSAGE_ID = '0d9c1f0e-5a2b-4c3d-8e4f-1a2b3c4d5e6f';

const LEAD_SEAT = `  - role: project coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true`;

const WORKER_SEAT = `  - role: implementer
    name: worker
    cli: claude-code
    vendor: openai
    model: gpt-5
    version: "1.0"
    launch: claude --model gpt-5`;

/** The seat the recipe moves worker to: the new declaration the queue record carries. */
const RECIPE = {
  cli: 'claude-code',
  vendor: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  display: 'Claude Opus 5.5',
  launch: 'claude --model claude-opus-5-5',
};

type Fixture = { base: string; root: string; home: string; file: string; dir: string; yaml: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) spawnSync('trash', [dir], { stdio: 'ignore' });
});

function teamText(root: string, home: string): string {
  return `format: 1
project: lyra
session: lyra
entity: lab
visibility: public
operator: lead
trust:
  - ${root}
  - ${home}/.config/team/lobbies/lab
workspace:
  mode: shared
seats:
${LEAD_SEAT}
${WORKER_SEAT}
`;
}

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-receipts-')));
  made.push(base);
  const root = join(base, 'lyra');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = teamText(root, home);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

function dropDir(fx: Fixture): string {
  return join(fx.dir, 'send-drops', SESSION, 'worker');
}

function keyOf(fx: Fixture): KeyObject {
  const state = messageKeyState(fx.home);
  if (state.kind !== 'key') throw new Error('the fixture home has no message key');
  return state.key;
}

function context(fx: Fixture): { to: string; root: string; session: string } {
  return { to: 'worker', root: fx.root, session: SESSION };
}

/** The assigned-work check the swap boundary uses, called with the same project and home the
 *  run passes. */
function assigned(fx: Fixture): boolean {
  return seatHasAssignedWorkOnDisk(fx.root, SESSION, 'worker', NOW.getTime(), {
    project: 'lyra',
    home: fx.home,
  });
}

/** One ordinary signed message, written by the real writer. */
function putMessage(fx: Fixture, id = MESSAGE_ID): RecordPayload {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'worker',
    to_id: null,
    root: fx.root,
    session: SESSION,
    at: NOW.toISOString(),
    body: 'from lead — admitted by: the fixture\n\na task for the seat\n',
    from: 'lead',
    from_id: null,
    rule: 'a seat of its own team to a seat of its own team',
    thread: id,
  };
  mkdirSync(dropDir(fx), { recursive: true });
  const written = writeRecord(dropDir(fx), signRecord(payload, fx.home));
  if (!written.ok) throw new Error(written.reason);
  return payload;
}

/** One signed receipt beside a message, written by the real writer. `home` lets a scene forge
 *  the signature with another home's key; `root`/`session` let it name another checkout. */
function putReceipt(
  fx: Fixture,
  id: string,
  status: ReceiptStatus,
  over: { home?: string; root?: string; session?: string; tamper?: boolean } = {},
): void {
  mkdirSync(dropDir(fx), { recursive: true });
  const signed = signReceiptPayload(
    {
      kind: 'receipt',
      status,
      id,
      to: 'worker',
      root: over.root ?? fx.root,
      session: over.session ?? SESSION,
      at: NOW.toISOString(),
    },
    over.home ?? fx.home,
  );
  if (over.tamper) signed.signature = (signed.signature.startsWith('a') ? 'b' : 'a') + signed.signature.slice(1);
  const written = writeReceipt(dropDir(fx), signed, fx.home);
  if (!written.ok) throw new Error(written.reason);
}

/** The launch's current brief for the seat, written and recorded the way the launch does. The
 *  incarnation is the claims cut's delivery lifetime: one fixed value so the derived record id is
 *  stable across scenes, shaped as the mint (`inc_` and twelve lowercase hex digits). */
function currentBrief(fx: Fixture): string {
  const payload = generalBriefRecord({
    to: 'worker',
    root: fx.root,
    session: SESSION,
    at: NOW.toISOString(),
    incarnation: 'inc_0a0b0c0d0e01',
  });
  mkdirSync(dropDir(fx), { recursive: true });
  const written = writeRecordOver(dropDir(fx), signRecord(payload, fx.home));
  if (!written.ok) throw new Error(written.reason);
  updateState(fx.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.briefs = { ...session.briefs, worker: { id: payload.id, at: NOW.toISOString() } };
  });
  return payload.id;
}

/** A brief from an earlier launch: a record from `the launch` at an id the state no longer
 *  records as the seat's current one. */
function supersededBrief(fx: Fixture): string {
  const payload = generalBriefRecord({
    to: 'worker',
    root: fx.root,
    session: SESSION,
    at: NOW.toISOString(),
    incarnation: 'inc_0a0b0c0d0e02',
    handover: join(fx.base, 'handover-old.txt'),
  });
  mkdirSync(dropDir(fx), { recursive: true });
  const written = writeRecordOver(dropDir(fx), signRecord(payload, fx.home));
  if (!written.ok) throw new Error(written.reason);
  return payload.id;
}

function workerState(fx: Fixture): void {
  updateState(fx.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

function queue(fx: Fixture): string {
  const record = enqueueSwap(fx.dir, {
    seat: 'worker',
    from: { cli: 'claude-code', vendor: 'openai', model: 'gpt-5', version: '1.0', display: 'gpt-5 1.0' },
    to: RECIPE,
    reason: 'model-rule',
    waitSeconds: 1800,
    waitFor: "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)",
    rule: RULE,
    now: NOW,
  });
  return record.queuedAt;
}

type Harness = {
  sources: RestartSources;
  did: { downTyped: string[]; typed: string[]; runs: string[]; closed: string[]; created: string[] };
  world: { alive: boolean; status: 'idle' | 'done' | 'working' };
};

/** A live world at the seam the run reads: worker at `pane-old`, a launch opening `pane-new`,
 *  and the old conversation's handover written when the request is typed. */
function harness(fx: Fixture, over: Partial<Harness['world']> = {}): Harness {
  const did = { downTyped: [] as string[], typed: [] as string[], runs: [] as string[], closed: [] as string[], created: [] as string[] };
  let clock = NOW.getTime();
  let shelled = false;
  let created = 0;
  let boxed = claudeBox('');
  const newPanes = new Map<string, { agent: boolean; name: string | null; workspace: string }>();
  const world: Harness['world'] = { alive: true, status: 'idle', ...over };

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fx.root },
    ];
    if (world.alive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: world.status, cwd: fx.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: fx.root });
      }
    }
    return list;
  };

  const closeWorkspace = (_session: string, workspace: string): boolean => {
    if (workspace === 'ws-old') world.alive = false;
    did.closed.push(workspace);
    return true;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.downTyped.push(text);
      boxed = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter: () => {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      created += 1;
      const pane = created === 1 ? 'pane-new' : `pane-new-${created}`;
      const workspace = `ws-new${created === 1 ? '' : `-${created}`}`;
      newPanes.set(pane, { agent: false, name: null, workspace });
      did.created.push(pane);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => (pane === 'pane-old' ? boxed : CLAUDE_IDLE),
    typeText(_session, _pane, text) {
      did.typed.push(text);
      const asked = /successor to (.+?):/.exec(text);
      if (asked) writeFileSync(asked[1]!, 'the handover\n');
      return true;
    },
    pressEnter: () => true,
    agentStatus: (_session, pane) => (pane === 'pane-old' ? world.status : 'idle'),
    foreground: () => ['claude'],
    shellBack: () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => new Date(clock),
    home: fx.home,
  };

  const sources: RestartSources = {
    home: fx.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => (pane === 'pane-old' ? boxed : CLAUDE_IDLE),
    status: (_session, pane) => (pane === 'pane-old' ? world.status : 'idle'),
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, did, world };
}

async function run(fx: Fixture, h: Harness): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(fx.root, OWNER);
  const code = await runSwap(['--run'], io, { home: fx.home, now: () => new Date(h.sources.now()), sources: h.sources });
  return { code, out: io.out, err: io.err };
}

function held(fx: Fixture) {
  return readState(fx.dir).swaps?.worker;
}

function seatPane(fx: Fixture): string | undefined {
  return readState(fx.dir).sessions[SESSION]?.seats.worker?.pane;
}

/** What a queued seat that is not at a boundary must leave behind: the record, the old pane, and
 *  no launch, hook, stop or swapped word. */
function stays(fx: Fixture, h: Harness, queuedAt: string): void {
  expect(held(fx)?.queuedAt).toBe(queuedAt);
  expect(h.did.runs).toEqual([]);
  expect(h.did.created).toEqual([]);
  expect(h.did.closed).toEqual([]);
  expect(seatPane(fx)).toBe('pane-old');
  const log = join(fx.dir, 'team.log');
  if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toContain('worker: swapped');
}

describe('the assigned-work check reads signed receipts, not only file names', () => {
  test('a signed message with no receipt is work the seat has not taken', () => {
    const fx = makeFixture();
    putMessage(fx);
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(false);
    expect(assigned(fx)).toBe(true);
  });

  test('a signed read receipt means the message is taken', () => {
    const fx = makeFixture();
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'read');
    expect(statusOf(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe('read');
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(false);
  });

  test('a signed replied receipt means the message is taken', () => {
    const fx = makeFixture();
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'replied');
    expect(statusOf(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe('replied');
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(false);
  });

  test('a tampered receipt proves nothing and the message is still unread', () => {
    const fx = makeFixture();
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'read', { tamper: true });
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(false);
    expect(assigned(fx)).toBe(true);
  });

  test("a receipt another home's key signed proves nothing", () => {
    const fx = makeFixture();
    putMessage(fx);
    const otherHome = join(fx.base, 'other-home');
    mkdirSync(otherHome, { recursive: true });
    putReceipt(fx, MESSAGE_ID, 'read', { home: otherHome });
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(false);
    expect(assigned(fx)).toBe(true);
  });

  test('a receipt naming another session proves nothing', () => {
    const fx = makeFixture();
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'read', { session: 'other' });
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(false);
    expect(assigned(fx)).toBe(true);
  });

  test('a receipt alone is metadata, not a message waiting for the seat', () => {
    const fx = makeFixture();
    putReceipt(fx, MESSAGE_ID, 'read');
    expect(isRead(dropDir(fx), MESSAGE_ID, context(fx), keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(false);
  });

  test('the current brief and its receipt are not work', () => {
    const fx = makeFixture();
    const id = currentBrief(fx);
    putReceipt(fx, id, 'read');
    expect(isRead(dropDir(fx), id, context(fx), keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(false);
  });

  test('a superseded brief and its receipt are not work', () => {
    const fx = makeFixture();
    const old = supersededBrief(fx);
    putReceipt(fx, old, 'read');
    const current = currentBrief(fx);
    putReceipt(fx, current, 'read');
    expect(isRead(dropDir(fx), old, context(fx), keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(false);
  });

  test('a plain file in the folder is still an unread drop', () => {
    const fx = makeFixture();
    mkdirSync(dropDir(fx), { recursive: true });
    writeFileSync(join(dropDir(fx), 'notes.txt'), 'a task the seat has not taken\n');
    expect(assigned(fx)).toBe(true);
  });
});

describe('a taken message is a safe idle boundary for the queued swap', () => {
  test('an unread signed message keeps the swap queued', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    putMessage(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('a read signed message lets the swap run at idle, before its wait expires', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'read');
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(h.did.created).toEqual(['pane-new']);
    expect(held(fx)).toBeUndefined();
    expect(seatPane(fx)).toBe('pane-new');
  });

  test('a replied signed message lets the swap run at idle, before its wait expires', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, 'replied');
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(held(fx)).toBeUndefined();
  });

  test('a forged read receipt is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    putMessage(fx);
    const otherHome = join(fx.base, 'other-home');
    mkdirSync(otherHome, { recursive: true });
    putReceipt(fx, MESSAGE_ID, 'read', { home: otherHome });
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('the current brief with its receipt is a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    const id = currentBrief(fx);
    putReceipt(fx, id, 'read');
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(held(fx)).toBeUndefined();
  });
});
