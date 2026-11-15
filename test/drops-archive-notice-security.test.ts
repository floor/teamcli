// The daily drops-archive notice's admission: a proven daemon principal carrying the notice
// reaches the loaded team's lead and nobody else, and a caller merely claiming the daemon stages
// nothing. Synthetic world only; no terminal host, real CLI home or credential store is used.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realHost, type SendHost } from '../src/commands/send.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { sendDaemonDirect } from '../src/reminder/direct-send.ts';
import type { SignedRecord } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const WHEN = new Date('2026-11-15T04:00:00Z');
const BODY = 'drops archive (daily, 2026-11-15): moved 3 read or acknowledged message(s) into archive/<YYYY-MM>/. Nothing was deleted.';
const made: World[] = [];
const originalHost = { ...realHost };
beforeEach(() => {
  setHerdrRun(() => { throw new Error('real terminal host is forbidden by this fixture'); });
});
afterEach(() => {
  for (const name of Object.keys(realHost)) if (!(name in originalHost)) delete (realHost as Record<string, unknown>)[name];
  Object.assign(realHost, originalHost);
  setHerdrRun(null);
  discardFixtures(made.splice(0).map(w => dirname(w.root)));
});

function scene(): World {
  const w = world(['drop'], [{ name: 'worker', role: 'implementer', cli: 'claude-code', launch: 'claude' }]);
  made.push(w);
  updateState(w.dir, state => {
    const session = state.sessions.acme ??= emptySession();
    session.seats.worker = { stage: 'ready', cli: 'claude-code', pane: 'synthetic-worker', launched: { shell: 11, cli: [22] } };
  });
  writeDaemonState(w.home, { format: 1, pid: process.pid, uid: process.getuid?.() ?? -1,
    since: WHEN.toISOString(), startedBy: 'synthetic', version: 'test', heartbeatAt: WHEN.toISOString(),
    socket: join(w.home, 'daemon.sock'), features: { broker: 'absent' }, stuck: [],
    roots: [{ root: w.root, team: 'acme', send: 'serving', bus: 'serving', why: null }] });
  mkdirSync(dirname(daemonLockPath(w.home)), { recursive: true });
  writeFileSync(daemonLockPath(w.home), `${process.pid}\n`);
  return w;
}

function records(w: World, seat: string): SignedRecord[] {
  const folder = join(w.dir, 'send-drops', 'acme', seat);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => !name.startsWith('.') && !name.includes('.'))
    .map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')) as SignedRecord);
}

function host(w: World): SendHost {
  return fake(w, { now: () => WHEN, agents: () => [], inboxGraceMs: 0,
    native: { typeText: () => { throw new Error('unexpected typing'); },
      pressEnter: () => { throw new Error('unexpected key'); }, status: () => null, wait: async () => {} } });
}

for (const target of ['worker', 'owner']) {
  test(`the drops-archive notice cannot reach ${target}`, async () => {
    const w = scene();
    const result = await sendDaemonDirect({ reminder: 'drops-archived', due: 'd1', notice: 'drops-archived',
      recipients: [{ root: w.root, session: 'acme', seat: target }] },
    { root: w.root, seat: target, body: BODY }, host(w), { stdout: () => {}, stderr: () => {} });
    expect(result.ok, result.text).toBe(false);
    expect(result.staged).toBe(false);
    for (const seat of ['lead', 'worker', 'owner']) expect(records(w, seat)).toEqual([]);
  });
}

test('the drops-archive notice reaches the lead under its own rule', async () => {
  const w = scene();
  const result = await sendDaemonDirect({ reminder: 'drops-archived', due: 'd1', notice: 'drops-archived',
    recipients: [{ root: w.root, session: 'acme', seat: 'lead' }] },
  { root: w.root, seat: 'lead', body: BODY }, host(w), { stdout: () => {}, stderr: () => {} });
  expect(result.staged, result.text).toBe(true);
  const sent = records(w, 'lead');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.payload.rule).toBe("the daemon's drops-archive notice");
  expect(sent[0]?.payload.body).toEndWith(BODY);
});
