// Independent runtime regressions for the checkout a launch-brief record names. The assigned-work
// check settles a delivery the seat has taken: a signed read or reply receipt, and a launch brief
// record this home's message key signed for this seat, this session and this delivered body. A
// record's `root` binds it to one checkout exactly as a receipt's does — receipts are compared on
// the folders' resolved paths, so one folder spelled two ways still matches, and another folder
// never does. The brief check must hold the same boundary: a brief record naming another checkout
// is not this checkout's delivery, whatever key signed it, and the drop it sits in stays work.
// The message key lives in HOME, not the checkout, so a signature alone cannot tell two checkouts
// apart.
//
// The writers are the real ones: `signRecord`/`writeRecordOver` for records,
// `signReceiptPayload`/`writeReceipt` for receipts, `generalBriefRecord` for the launch's brief,
// and the exported assigned-work check. The boundary scenes drive the real `team swap --run` path
// through `runSwap`, with the herdr and launch seams faked at their documented types, in synthetic
// temporary homes. A reading of the source is never the evidence: both kinds of scene execute the
// shipped code.
//
// The fixture ('vega') is this file's own. Cleanup uses the system trash per the standing rule:
// no recursive rm.
import { execFileSync, spawnSync } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
  readRecord,
  signReceiptPayload,
  signRecord,
  verifyRecord,
  writeReceipt,
  writeRecord,
  writeRecordOver,
  type RecordPayload,
  type SignedRecord,
} from '../src/send/record.ts';
import { enqueueSwap } from '../src/swap/queue.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { seatHasAssignedWorkOnDisk } from '../src/watch/status-events.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const SESSION = 'vega';
const OWNER: Caller = { kind: 'owner' };
const RULE = '*=!openai';
const MESSAGE_ID = '6b1e2f3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

// Fixed lifetimes, shaped as the mint (`inc_` and twelve lowercase hex digits), so each derived
// brief id is stable across runs of a scene.
const FOREIGN_INC = 'inc_0d0e0f101112';
const ALIAS_INC = 'inc_131415161718';
const OTHER_KEY_INC = 'inc_191a1b1c1d1e';
const TAMPERED_INC = 'inc_1f2021222324';
const OTHER_TO_INC = 'inc_25262728292a';
const OTHER_SESSION_INC = 'inc_2b2c2d2e2f30';
const CURRENT_INC = 'inc_313233343536';

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
project: vega
session: vega
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-brief-root-')));
  made.push(base);
  const root = join(base, 'vega');
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
function assigned(fx: Fixture, home = fx.home): boolean {
  return seatHasAssignedWorkOnDisk(fx.root, SESSION, 'worker', NOW.getTime(), {
    project: 'vega',
    home,
  });
}

/** One ordinary signed message, written by the real writer. */
function putMessage(fx: Fixture): void {
  const payload: RecordPayload = {
    kind: 'message',
    id: MESSAGE_ID,
    to: 'worker',
    to_id: null,
    root: fx.root,
    session: SESSION,
    at: NOW.toISOString(),
    body: 'from lead — admitted by: the fixture\n\na task for the seat\n',
    from: 'lead',
    from_id: null,
    rule: 'a seat of its own team to a seat of its own team',
    thread: MESSAGE_ID,
  };
  mkdirSync(dropDir(fx), { recursive: true });
  const written = writeRecord(dropDir(fx), signRecord(payload, fx.home));
  if (!written.ok) throw new Error(written.reason);
}

/** One signed receipt beside a message, written by the real writer. `root` lets a scene name
 *  another checkout. */
function putReceipt(fx: Fixture, id: string, root: string): void {
  mkdirSync(dropDir(fx), { recursive: true });
  const signed = signReceiptPayload(
    {
      kind: 'receipt',
      status: 'read',
      id,
      to: 'worker',
      root,
      session: SESSION,
      at: NOW.toISOString(),
    },
    fx.home,
  );
  const written = writeReceipt(dropDir(fx), signed, fx.home);
  if (!written.ok) throw new Error(written.reason);
}

/** One launch brief record, posted where the scan reads it. `home` lets a scene sign with
 *  another home's key; `tamper` breaks the signature after signing. */
function putBrief(fx: Fixture, payload: RecordPayload, over: { home?: string; tamper?: boolean } = {}): string {
  mkdirSync(dropDir(fx), { recursive: true });
  const signed: SignedRecord = signRecord(payload, over.home ?? fx.home);
  if (over.tamper) signed.signature = (signed.signature.startsWith('a') ? 'b' : 'a') + signed.signature.slice(1);
  const written = writeRecordOver(dropDir(fx), signed);
  if (!written.ok) throw new Error(written.reason);
  return payload.id;
}

function brief(fx: Fixture, over: { root?: string; to?: string; session?: string; incarnation: string }): RecordPayload {
  return generalBriefRecord({
    to: over.to ?? 'worker',
    root: over.root ?? fx.root,
    session: over.session ?? SESSION,
    at: NOW.toISOString(),
    incarnation: over.incarnation,
  });
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

describe('the assigned-work check reads the checkout a brief record names', () => {
  test("a brief naming another checkout is not this checkout's delivery", () => {
    const fx = makeFixture();
    const otherRoot = join(fx.base, 'other-checkout');
    mkdirSync(otherRoot, { recursive: true });
    const payload = brief(fx, { root: otherRoot, incarnation: FOREIGN_INC });
    putBrief(fx, payload);

    // The record is the one this home's key signed, addressed to this seat and session: the
    // checkout it names is the only thing that makes it another delivery.
    const read = readRecord(join(dropDir(fx), payload.id), payload.id);
    expect(read.ok && read.record !== null && verifyRecord(read.record, keyOf(fx))).toBe(true);
    expect(assigned(fx)).toBe(true);
  });

  test('a brief naming this checkout through another path spelling is this delivery', () => {
    const fx = makeFixture();
    const alias = join(fx.base, 'vega-alias');
    symlinkSync(fx.root, alias);
    expect(realpathSync(alias)).toBe(fx.root);
    putBrief(fx, brief(fx, { root: alias, incarnation: ALIAS_INC }));
    expect(assigned(fx)).toBe(false);
  });

  test('a receipt naming another checkout is not a read of the ordinary message', () => {
    const fx = makeFixture();
    const otherRoot = join(fx.base, 'other-checkout');
    mkdirSync(otherRoot, { recursive: true });
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, otherRoot);
    expect(assigned(fx)).toBe(true);
  });

  test("a brief another home's key signed proves nothing", () => {
    const fx = makeFixture();
    const otherHome = join(fx.base, 'other-home');
    mkdirSync(otherHome, { recursive: true });
    putBrief(fx, brief(fx, { incarnation: OTHER_KEY_INC }), { home: otherHome });
    expect(assigned(fx)).toBe(true);
  });

  test('a tampered brief record proves nothing', () => {
    const fx = makeFixture();
    putBrief(fx, brief(fx, { incarnation: TAMPERED_INC }), { tamper: true });
    expect(assigned(fx)).toBe(true);
  });

  test("a brief record addressed to another seat is not this seat's delivery", () => {
    const fx = makeFixture();
    putBrief(fx, brief(fx, { to: 'lead', incarnation: OTHER_TO_INC }));
    expect(assigned(fx)).toBe(true);
  });

  test("a brief record naming another session is not this session's delivery", () => {
    const fx = makeFixture();
    putBrief(fx, brief(fx, { session: 'other', incarnation: OTHER_SESSION_INC }));
    expect(assigned(fx)).toBe(true);
  });

  test('a home with no message key settles nothing', () => {
    const fx = makeFixture();
    const emptyHome = join(fx.base, 'no-key-home');
    mkdirSync(emptyHome, { recursive: true });
    putBrief(fx, brief(fx, { incarnation: ALIAS_INC }));
    expect(assigned(fx, emptyHome)).toBe(true);
  });

  test('the current brief the state records is not work', () => {
    const fx = makeFixture();
    const payload = brief(fx, { incarnation: CURRENT_INC });
    putBrief(fx, payload);
    updateState(fx.dir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.briefs = { ...session.briefs, worker: { id: payload.id, at: NOW.toISOString() } };
    });
    expect(assigned(fx)).toBe(false);
  });
});

describe('a brief record naming another checkout is no safe idle boundary', () => {
  test('a foreign-root signed brief keeps the queued swap queued', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const otherRoot = join(fx.base, 'other-checkout');
    mkdirSync(otherRoot, { recursive: true });
    putBrief(fx, brief(fx, { root: otherRoot, incarnation: FOREIGN_INC }));
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('a brief naming this checkout through another path spelling is a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    const alias = join(fx.base, 'vega-alias');
    symlinkSync(fx.root, alias);
    putBrief(fx, brief(fx, { root: alias, incarnation: ALIAS_INC }));
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(held(fx)).toBeUndefined();
    expect(seatPane(fx)).toBe('pane-new');
  });

  test('a foreign-root receipt leaves the ordinary message as work', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const otherRoot = join(fx.base, 'other-checkout');
    mkdirSync(otherRoot, { recursive: true });
    putMessage(fx);
    putReceipt(fx, MESSAGE_ID, otherRoot);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });
});
