// Independent scenes for the message-record reader: the unknown-value and unknown-field
// rules, and old records reading as before. Helpers copied from waits.test.ts
// (its world/plant builders); the original describe block is replaced by the three scenes
// below. Pins today's behaviour: an unknown signed field is refused as unsupported; a record
// with neither field reads as before. At 476d644af and after, an unknown kind VALUE is served
// as a plain message (the kind dropped from the projection), never a wait and never refused.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDir } from '../src/commands/messages.ts';
import { runWaits } from '../src/commands/waits.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import {
  signReceiptPayload,
  signRecord,
  writeReceipt,
  writeRecord,
  type RecordPayload,
} from '../src/send/record.ts';
import { testIo } from './helpers.ts';
import type { Caller } from '../src/caller.ts';
import { listUnackedMessages } from '../src/commands/messages.ts';
import { recordAuthOfSealed, recordHolds, sealedRecordOf } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';

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


describe('team waits, unknown kind value and unknown signed field (independent scenes)', () => {
  test('an unknown message_kind value is served as a plain message, never a wait, never refused', async () => {
    made = world();
    const acme: At = { root: made.root, session: 'acme', seat: 'lead' };
    plant(made, { at: acme, id: 'm-task', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'task', sentAt: '2026-10-04T10:00:00.000Z' });
    plant(made, { at: acme, id: 'm-note', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, kind: 'note' as unknown as RecordPayload['message_kind'], sentAt: '2026-10-04T11:00:00.000Z' });
    const ran = await run(made, ['--json'], WORKER);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.err).toBe('');
    const ids = jsonOf(ran.out).waits.map((wait) => wait.id);
    expect(ids).toContain('m-task');
    expect(ids).not.toContain('m-note');
    // Served: the record is a plain message the unacked list shows, so a newer writer's kind
    // never makes an older reader blind to the message itself.
    const unacked = listUnackedMessages(made.root, 'acme', made.home);
    expect(unacked.map((message) => message.id)).toContain('m-note');
    // At the auth layer the record verifies ok and the kind is dropped, never interpreted.
    const state = messageKeyState(made.home);
    if (state.kind !== 'key') throw new Error('no key');
    const sealed = sealedRecordOf(JSON.parse(readFileSync(join(recordDir(made.root, 'acme', 'lead'), 'm-note'), 'utf8')));
    if (sealed === null) throw new Error('m-note not sealed');
    const auth = recordAuthOfSealed(sealed, state.key);
    expect(auth.kind).toBe('ok');
    if (auth.kind === 'ok') expect(auth.value.payload.message_kind).toBeUndefined();
  });

  test('an unknown signed field is refused as unsupported, naming the field, and never becomes a wait', async () => {
    made = world();
    const acme: At = { root: made.root, session: 'acme', seat: 'lead' };
    const payload = {
      kind: 'message', id: 'm-field', to: 'lead', to_id: LEAD_ID, root: made.root, session: 'acme',
      at: '2026-10-04T10:00:00.000Z', body: 'body of m-field', from: 'worker', from_id: WORKER_ID,
      rule: 'the lead to a seat of its own team', thread: 'm-field', message_kind: 'task', priority: 'high',
    } as unknown as RecordPayload;
    const dir = recordDir(made.root, 'acme', 'lead');
    const written = writeRecord(dir, signRecord(payload, made.home));
    if (!written.ok) throw new Error(written.reason);
    const ran = await run(made, ['--json'], WORKER);
    expect(ran.code, ran.err).toBe(0);
    expect(jsonOf(ran.out).waits.map((wait) => wait.id)).not.toContain('m-field');
    const state = messageKeyState(made.home);
    if (state.kind !== 'key') throw new Error('no key');
    const sealed = sealedRecordOf(JSON.parse(readFileSync(join(dir, 'm-field'), 'utf8')));
    if (sealed === null) throw new Error('m-field not sealed');
    const auth = recordAuthOfSealed(sealed, state.key);
    expect(auth.kind).toBe('unsupported');
    expect((auth as { reason?: string }).reason ?? '').toContain('priority');
    expect(recordHolds(join(dir, 'm-field'), payload, made.home)).toBe(false);
  });

  test('an old record with neither field still reads: it is not a wait but it stays in the unacked list', async () => {
    made = world();
    const acme: At = { root: made.root, session: 'acme', seat: 'lead' };
    plant(made, { at: acme, id: 'm-plain', from: 'worker', from_id: WORKER_ID, to: 'lead', to_id: LEAD_ID, sentAt: '2026-10-04T10:00:00.000Z' });
    const ran = await run(made, ['--json'], WORKER);
    expect(ran.code, ran.err).toBe(0);
    expect(jsonOf(ran.out).waits.map((wait) => wait.id)).not.toContain('m-plain');
    const unacked = listUnackedMessages(made.root, 'acme', made.home);
    expect(unacked.map((message) => message.id)).toContain('m-plain');
  });
});
