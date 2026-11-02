// `team waits`: who waits on whom, and since when.
//
// A wait is a signed message record of kind `task` or `question` with no verifying `replied`
// receipt beside it. A seat sees the records it sent; a lead sees every seat of its team,
// including records its seats wrote into another team's checkout. Records are verified with the
// checkout's message key, so a tampered file proves nothing and is never listed. The retention
// window is the `event-retention-days` threshold of the caller's chain (30 by default).
//
// Fixtures only: two checkouts, a synthetic home and registry, planted signed records.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDir } from '../src/commands/messages.ts';
import { runWaits } from '../src/commands/waits.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { messageKeyPath } from '../src/store/keys.ts';
import {
  signReceiptPayload,
  signRecord,
  writeReceipt,
  writeRecord,
  type RecordPayload,
} from '../src/send/record.ts';
import { testIo } from './helpers.ts';
import type { Caller } from '../src/caller.ts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const LEAD_ID = 'agt_111111111111';
const WORKER_ID = 'agt_222222222222';
const PEER_LEAD_ID = 'agt_333333333333';
const PEER_WORKER_ID = 'agt_444444444444';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type World = { base: string; root: string; peerRoot: string; home: string };

let made: World | null = null;
afterEach(() => {
  if (made !== null) rmSync(made.base, { recursive: true, force: true });
  made = null;
});

function registryOf(w: World): string {
  const acme = teamIdOf(w.root);
  const other = teamIdOf(w.peerRoot);
  return `teams:
  "${acme}":
    project: acme
    project_id: null
    entity: acme
    session: acme
    root: ${w.root}
    roster:
      - { agent: ${LEAD_ID}, seat: lead, role: coordinator, leads: true }
      - { agent: ${WORKER_ID}, seat: worker, role: implementer }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" }
  "${other}":
    project: other
    project_id: null
    entity: other
    session: other
    root: ${w.peerRoot}
    roster:
      - { agent: ${PEER_LEAD_ID}, seat: lead, role: coordinator, leads: true }
      - { agent: ${PEER_WORKER_ID}, seat: worker, role: implementer }
      - { agent: ${PEER_WORKER_ID}, seat: engineer, role: implementer }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" }
`;
}

function world(): World {
  const base = mkdtempSync(join(tmpdir(), 'team-waits-'));
  const root = join(base, 'acme');
  const peerRoot = join(base, 'other');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(peerRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const built = { base, root, peerRoot, home };
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), registryOf(built));
  return built;
}

type At = { root: string; session: string; seat: string };

type Planted = {
  at: At;
  id: string;
  from: string;
  from_id: string | null;
  to: string;
  to_id?: string | null;
  kind?: RecordPayload['message_kind'];
  work?: string;
  sentAt: string;
  replied?: boolean;
  tamper?: boolean;
};

function plant(w: World, item: Planted): void {
  const payload: RecordPayload = {
    kind: 'message',
    id: item.id,
    to: item.to,
    to_id: item.to_id ?? null,
    root: item.at.root,
    session: item.at.session,
    at: item.sentAt,
    body: `body of ${item.id}`,
    from: item.from,
    from_id: item.from_id,
    rule: 'the lead to a seat of its own team',
    thread: item.id,
    ...(item.kind === undefined ? {} : { message_kind: item.kind }),
    ...(item.work === undefined ? {} : { work: item.work }),
  };
  const dir = recordDir(item.at.root, item.at.session, item.at.seat);
  const written = writeRecord(dir, signRecord(payload, w.home));
  if (!written.ok) throw new Error(written.reason);
  if (item.replied === true) {
    const receipt = writeReceipt(dir, signReceiptPayload({
      kind: 'receipt',
      status: 'replied',
      id: item.id,
      to: item.to,
      root: item.at.root,
      session: item.at.session,
      at: item.sentAt,
    }, w.home), w.home);
    if (!receipt.ok) throw new Error(receipt.reason);
  }
  if (item.tamper === true) {
    const raw = JSON.parse(readFileSync(written.path, 'utf8')) as { payload: { body: string } };
    raw.payload.body = 'changed after signing';
    writeFileSync(written.path, `${JSON.stringify(raw, null, 2)}\n`);
  }
}

/** One world with every record the cases read: waits, a reply, kinds that are not waits, a
 *  tampered file, a stale file, a same-named seat in another team, and a declared sender. */
function scene(): World {
  const w = world();
  const acme: At = { root: w.root, session: 'acme', seat: 'lead' };
  // The worker's two waits, oldest first.
  plant(w, { at: acme, id: 'm-task', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', work: '#42', sentAt: '2026-10-04T10:00:00.000Z' });
  plant(w, { at: acme, id: 'm-question', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'question', sentAt: '2026-10-04T11:30:00.000Z' });
  // The lead's own waits.
  plant(w, { at: { root: w.root, session: 'acme', seat: 'worker' }, id: 'm-lead', from: 'lead', from_id: LEAD_ID, to: 'worker', to_id: WORKER_ID, kind: 'task', sentAt: '2026-10-04T11:00:00.000Z' });
  plant(w, { at: { root: w.root, session: 'acme', seat: 'worker' }, id: 'm-declared', from: 'lead', from_id: null, to: 'worker', to_id: WORKER_ID, kind: 'task', sentAt: '2026-10-04T11:40:00.000Z' });
  // Not waits: answered, no kind, an answer kind, tampered, and older than the default window.
  plant(w, { at: acme, id: 'm-answered', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', sentAt: '2026-10-04T09:00:00.000Z', replied: true });
  plant(w, { at: acme, id: 'm-plain', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, sentAt: '2026-10-04T08:00:00.000Z' });
  plant(w, { at: acme, id: 'm-answer', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'answer', sentAt: '2026-10-04T07:00:00.000Z' });
  plant(w, { at: acme, id: 'm-tampered', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', sentAt: '2026-10-04T06:00:00.000Z', tamper: true });
  plant(w, { at: acme, id: 'm-old', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', sentAt: '2026-08-25T12:00:00.000Z' });
  // Inside the default window, outside a one-day setting.
  plant(w, { at: acme, id: 'm-stale', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', sentAt: '2026-10-01T12:00:00.000Z' });
  // A wait of another team, and a same-named seat of another team: neither is this team's.
  plant(w, { at: { root: w.peerRoot, session: 'other', seat: 'engineer' }, id: 'm-cross', from: 'worker', from_id: WORKER_ID, to: 'engineer', kind: 'question', sentAt: '2026-10-04T10:30:00.000Z' });
  plant(w, { at: { root: w.peerRoot, session: 'other', seat: 'lead' }, id: 'm-peer', from: 'worker', from_id: PEER_WORKER_ID, to: 'lead', to_id: PEER_LEAD_ID, kind: 'task', sentAt: '2026-10-04T10:45:00.000Z' });
  return w;
}

const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
const WORKER: Caller = { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' };

async function run(w: World, argv: string[] = [], caller: Caller = LEAD): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, caller);
  const code = await runWaits(argv, io, { home: w.home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

type WaitDoc = {
  schema: { name: string; version: number };
  scope: string;
  retention_days: number;
  seat: string;
  waits: { id: string; from: string; to: string; kind: string; work?: string; age_seconds: number; to_team: string | null }[];
  notes?: string[];
};

function jsonOf(out: string): WaitDoc {
  return JSON.parse(out) as WaitDoc;
}

describe('team waits', () => {
  test('a seat sees the task and question it sent, with the work item and the age', async () => {
    made = scene();
    const ran = await run(made, [], WORKER);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toBe(`team acme, session "acme"
  WAITER  AWAITED         KIND      WORK  WAITING
  worker  lead            task      -     3d ago
  worker  lead            task      #42   2h ago
  worker  engineer@other  question  -     1h ago
  worker  lead            question  -     30m ago

4 waits
`);
  });

  test('a lead sees every seat of its team, including a record written into another checkout', async () => {
    made = scene();
    const ran = await run(made);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain('team acme, session "acme"');
    expect(ran.out).toContain('  worker  lead            task      #42   2h ago');
    expect(ran.out).toContain('  worker  engineer@other  question  -     1h ago');
    expect(ran.out).toContain('  lead    worker          task      -     1h ago');
    expect(ran.out).toContain('  lead    worker          task      -     20m ago');
    expect(ran.out).toContain('  worker  lead            question  -     30m ago');
    expect(ran.out).toContain('\n6 waits\n');
    expect(ran.out).not.toContain('0 waits');
  });

  test('--json carries the caller scope, the retention window and each wait', async () => {
    made = scene();
    const ran = await run(made, ['--json']);
    expect(ran.code, ran.err).toBe(0);
    const doc = jsonOf(ran.out);
    expect(doc.schema).toEqual({ name: 'team.waits', version: 1 });
    expect(doc.scope).toBe('team');
    expect(doc.seat).toBe('lead');
    expect(doc.retention_days).toBe(30);
    expect(doc.waits.map((wait) => wait.id)).toEqual(['m-stale', 'm-task', 'm-cross', 'm-lead', 'm-question', 'm-declared']);
    expect(doc.waits[0]?.age_seconds).toBe(3 * 24 * 60 * 60);
    expect(doc.waits[2]).toMatchObject({ id: 'm-cross', from: 'worker', to: 'engineer', to_team: 'other', kind: 'question' });
    expect(doc.waits[1]).toMatchObject({ id: 'm-task', from: 'worker', to: 'lead', to_team: 'acme', kind: 'task', work: '#42', age_seconds: 7200 });
    expect(doc.waits.map((wait) => wait.id)).not.toContain('m-peer');
  });

  test('a worker sees only its own waits: the lead is not its team', async () => {
    made = scene();
    const ran = await run(made, ['--json'], WORKER);
    expect(ran.code, ran.err).toBe(0);
    const doc = jsonOf(ran.out);
    expect(doc.scope).toBe('seat');
    expect(doc.waits.map((wait) => wait.id)).toEqual(['m-stale', 'm-task', 'm-cross', 'm-question']);
  });

  test('a reply, a record of no kind, an answer and a tampered file are not waits', async () => {
    made = scene();
    const ran = await run(made, ['--json'], WORKER);
    const ids = jsonOf(ran.out).waits.map((wait) => wait.id);
    for (const id of ['m-answered', 'm-plain', 'm-answer', 'm-tampered', 'm-old', 'm-peer']) expect(ids).not.toContain(id);
  });

  test('the retention setting bounds the list, and the default is 30 days', async () => {
    made = scene();
    const before = jsonOf((await run(made, ['--json'])).out);
    expect(before.retention_days).toBe(30);
    expect(before.waits.map((wait) => wait.id)).toContain('m-stale');
    expect(before.waits.map((wait) => wait.id)).not.toContain('m-old');

    const written = writePolicySet(made.home, {
      level: 'team',
      target: teamIdOf(made.root),
      teamRoot: made.root,
      name: 'event-retention-days',
      value: 1,
    }, { now: NOW });
    if (!written.ok) throw new Error(written.why);

    const after = jsonOf((await run(made, ['--json'])).out);
    expect(after.retention_days).toBe(1);
    expect(after.waits.map((wait) => wait.id)).not.toContain('m-stale');
    expect(after.waits.map((wait) => wait.id)).toContain('m-task');
  });

  test('the owner and a seat of another team are refused', async () => {
    made = scene();
    const owner = await run(made, [], { kind: 'owner' });
    expect(owner.code).toBe(1);
    expect(owner.out).toBe('');
    expect(owner.err).toContain('only a seat of this team sees its waits');
    expect(owner.err).toContain('the owner');

    const foreign = await run(made, ['--json'], { kind: 'seat', name: 'engineer', pane: 'pane-engineer', session: 'other' });
    expect(foreign.code).toBe(1);
    const doc = JSON.parse(foreign.out) as { error: { id: string; message: string } };
    expect(doc.error.id).toBe('waits.refused');
    expect(doc.error.message).toContain('engineer');
  });

  test('an empty tree prints no waits and creates no key', async () => {
    made = world();
    const ran = await run(made);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain('  WAITER  AWAITED  KIND  WORK  WAITING');
    expect(ran.out).toContain('no waits');
    expect(ran.out).toContain('note: the message key is not in this home');
    expect(existsSync(messageKeyPath(made.home))).toBe(false);
  });

  test('an unknown argument is a usage error', async () => {
    made = world();
    const ran = await run(made, ['--all']);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('--all');
    expect(ran.err).toContain('Usage: team waits');
  });
});
