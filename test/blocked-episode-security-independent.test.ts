// Independent security coverage of the blocked-episode notice. These scenes exercise the
// ordinary send writer and the daemon entry separately, then run hosted watch passes over
// synthetic screens. No terminal host, real CLI home, credential store or child is used.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realHost, runSend, type SendHost } from '../src/commands/send.ts';
import { runWatch } from '../src/commands/watch.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { sendDaemonDirect } from '../src/reminder/direct-send.ts';
import * as daemonDirect from '../src/reminder/direct-send.ts';
import { attributedBody, compactRule } from '../src/send/sender-claim.ts';
import { verifyRecord, type SignedRecord } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { unreadMachine } from '../src/watch/machine.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import type { Live } from '../src/status/compare.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { claudeBox, testIo } from './helpers.ts';
import { withHostedLoop } from './helpers/hosted-watch.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const RULE = "the daemon's blocked-episode notice";
const BODY = "worker: can't work: model failing";
const WHEN = new Date('2026-11-09T11:45:00Z');
const IDLE = readFileSync(new URL('./fixtures/claude-code/2.1.319/idle.txt', import.meta.url), 'utf8');
const ERROR = `API Error: Connection lost mid-response. The response above may be incomplete.\n${claudeBox('')}`;
const made: World[] = [];
const originalHost = { ...realHost };
beforeEach(() => {
  setHerdrRun(() => { throw new Error('real terminal host is forbidden by this fixture'); });
  forgetIdleEpisodes();
});
afterEach(() => {
  for (const name of Object.keys(realHost)) if (!(name in originalHost)) delete (realHost as Record<string, unknown>)[name];
  Object.assign(realHost, originalHost);
  setHerdrRun(null);
  forgetIdleEpisodes();
  discardFixtures(made.splice(0).map(w => dirname(w.root)));
});

function scene() {
  const w = world(['drop'], [{ name: 'worker', role: 'implementer', cli: 'claude-code', launch: 'claude' }]);
  made.push(w);
  updateState(w.dir, state => {
    const session = state.sessions.acme ??= emptySession();
    session.seats.worker = { stage: 'ready', cli: 'claude-code', pane: 'synthetic-worker', launched: { shell: 11, cli: [22] } };
  });
  return w;
}

function proof(w: World, now = WHEN) {
  writeDaemonState(w.home, { format: 1, pid: process.pid, uid: process.getuid?.() ?? -1,
    since: WHEN.toISOString(), startedBy: 'synthetic', version: 'test', heartbeatAt: now.toISOString(),
    socket: join(w.home, 'daemon.sock'), features: { broker: 'absent' }, stuck: [],
    roots: [{ root: w.root, team: 'acme', send: 'serving', bus: 'serving', why: null }] });
  mkdirSync(dirname(daemonLockPath(w.home)), { recursive: true });
  writeFileSync(daemonLockPath(w.home), `${process.pid}\n`);
}

function records(w: World, seat = 'lead'): SignedRecord[] {
  const folder = join(w.dir, 'send-drops', 'acme', seat);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => !name.startsWith('.') && !name.includes('.'))
    .map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')) as SignedRecord);
}

function render(w: World, record: SignedRecord) {
  expect(verifyRecord(record, messageKeyOf(w.home))).toBe(true);
  return attributedBody(record.payload.body, record.payload.from,
    { record: record.payload, rule: record.payload.rule, root: w.root, home: w.home });
}

function host(w: World, now: () => Date = () => WHEN): SendHost {
  return fake(w, { now, agents: () => [], inboxGraceMs: 0,
    native: { typeText: () => { throw new Error('unexpected typing'); },
      pressEnter: () => { throw new Error('unexpected key'); }, status: () => null, wait: async () => {} } });
}

test('the blocked-notice compact label belongs to its admission rule, never an ordinary seat rule', () => {
  expect(compactRule(RULE)).toBe('daemon');
  for (const rule of ["a seat to its own team's orchestrator", 'a seat to a declared seat of its own team',
    'an orchestrator or operator to a seat of its own team', 'the lead to a seat of its own team',
    'an operator to another operator of its own team', 'a reply to the sender of a record on an open thread']) {
    expect(compactRule(rule)).not.toBe('daemon');
  }
});

test('a caller claiming daemon without an internal principal stages no notice', async () => {
  const w = scene();
  const io = testIo(w.root, { kind: 'daemon' });
  expect(await runSend(['lead', BODY], io, host(w)), io.err + io.out).toBe(1);
  expect(records(w)).toEqual([]);
});

for (const target of ['worker', 'helper', 'native', 'owner']) {
  test(`even a proven blocked-notice principal cannot deliver to ${target}`, async () => {
    const w = scene();
    proof(w);
    const result = await sendDaemonDirect({ reminder: 'seat-blocked', due: WHEN.toISOString(), notice: 'seat-blocked',
      recipients: [{ root: w.root, session: 'acme', seat: target }] },
    { root: w.root, seat: target, body: BODY }, host(w), { stdout: () => {}, stderr: () => {} });
    expect(result.ok, result.text).toBe(false);
    expect(result.staged).toBe(false);
    for (const seat of ['lead', 'worker', 'helper', 'native', 'owner']) expect(records(w, seat)).toEqual([]);
  });
}

test('a recipient entry for another session cannot admit the lead notice', async () => {
  const w = scene();
  proof(w);
  const result = await sendDaemonDirect({ reminder: 'seat-blocked', due: WHEN.toISOString(), notice: 'seat-blocked',
    recipients: [{ root: w.root, session: 'other-session', seat: 'lead' }] },
  { root: w.root, seat: 'lead', body: BODY }, host(w), { stdout: () => {}, stderr: () => {} });
  expect(result.ok, result.text).toBe(false);
  expect(records(w)).toEqual([]);
});

async function watchEpisodes(pattern: readonly boolean[], onCycle?: (index: number, world: World, output: string) => void) {
  const w = scene();
  let index = 0;
  const now = () => new Date(WHEN.getTime() + index * 60_000);
  proof(w, now());
  Object.assign(realHost, host(w, now));
  const live = (): Live => ({ running: true,
    agents: [{ name: 'worker', agent: 'claude', pane: 'synthetic-worker', workspace: 'synthetic-workspace', status: 'idle', cwd: w.root }],
    workspaces: [], screens: { 'synthetic-worker': pattern[index] ? ERROR : IDLE },
    processes: { 'synthetic-worker': { shell: 11, foreground: [22] } },
    foreground: { 'synthetic-worker': ['claude'] } });
  const bus: unknown[] = [];
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runWatch([], io, withHostedLoop({ home: w.home, live, machine: () => unreadMachine(),
    standing: () => ({ kind: 'none' }), readChecks: () => [], readMailbox: () => [],
    screen: () => null, status: () => null, foreground: () => null,
    typeText: () => { throw new Error('watch may not type'); },
    pressEnter: () => { throw new Error('watch may not send keys'); }, sleep: async () => {}, notify: () => {},
    now, pid: process.pid, alive: () => false,
    wait: async () => { onCycle?.(index, w, io.out); index += 1; proof(w, now()); return index < pattern.length; },
    busPublish: async (_root, event) => { bus.push(event); return { kind: 'unavailable' }; } }));
  expect(code, io.err + io.out).toBe(0);
  expect(index).toBe(pattern.length);
  expect(bus).toEqual([]);
  return w;
}

test('recovery followed by the same failure is a new episode and earns its own notice once', async () => {
  const w = await watchEpisodes([true, true, false, true, true]);
  const sent = records(w);
  expect(sent).toHaveLength(2);
  expect(new Set(sent.map(record => record.payload.id)).size).toBe(2);
  for (const record of sent) {
    expect(record.payload.rule).toBe(RULE);
    expect(record.payload.body).toContain(BODY);
  }
}, 20_000);
