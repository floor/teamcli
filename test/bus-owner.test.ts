import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isOwnerAddressed,
  OWNER_MAILBOX,
  OwnerDelivery,
  ownerDeliveryText,
  ownerRecordId,
} from '../src/bus/owner.ts';
import type { EventPayload } from '../src/bus/log.ts';
import { listUnacked, messageFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const dirs: string[] = [];

const SAMPLE_TEAM_YAML = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

function makeScratch(): { root: string; home: string } {
  const base = mkdtempSync(join(realpathSync('/tmp'), 'bo-'));
  dirs.push(base);
  const root = join(base, 'r');
  const home = join(base, 'h');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), SAMPLE_TEAM_YAML);
  return { root, home };
}

function event(overrides: Partial<EventPayload> & Pick<EventPayload, 'seq' | 'kind' | 'record_id'>): EventPayload {
  return {
    v: 1,
    ts: '2026-10-18T12:00:00.000Z',
    session: 'acme',
    ...overrides,
  };
}

/** The body of one stored record, uncounted (listUnacked carries ids only). */
function storedBody(root: string, id: string): string {
  return JSON.parse(readFileSync(messageFile(root, OWNER_MAILBOX, id), 'utf8')).payload.body;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("owner delivery: the notification the watch raises and the owner's own tool's inbox (RFC 002 Amendment 01 §4.5)", () => {
  test("delivers an owner-routed refusal as one notice and one signed record in the owner's mailbox, at mode 0600", () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
      now: () => new Date('2026-10-18T12:00:05.000Z'),
    });
    const refusal = event({
      seq: 7,
      kind: 'team.policy-refused',
      record_id: 'policy-refused:worker-1:seat.at-prompt:2026-10-18T12:00:00.000Z',
      seat: 'worker-1',
      subject: 'worker-1',
      rule: 'privileged-self-subscription',
      reason: 'seat.at-prompt',
    });

    expect(delivery.onEvent(refusal)).toEqual({ addressed: true, notified: true, recorded: true });
    expect(notes).toEqual(['team.policy-refused worker-1: privileged-self-subscription']);

    const id = ownerRecordId(refusal);
    const path = messageFile(root, OWNER_MAILBOX, id);
    expect(path).toBe(join(root, '.agents', 'messages', 'owner', `${id}.json`));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored.payload).toMatchObject({
      kind: 'message',
      id,
      to: 'owner',
      session: 'acme',
      at: '2026-10-18T12:00:05.000Z',
      body: notes[0],
      // The Runtime wrote it: no seat is in the path.
      from: 'runtime',
    });
    expect(typeof stored.signature).toBe('string');
    // The owner's own `team messages` run reads it as an unacked record of its inbox.
    expect(listUnacked(root, 'acme', home).map((record) => record.id)).toEqual([id]);
  });

  test('a re-delivered event is silent and keeps its one record, so a watch restarted from cursor 0 does not ring again', () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });
    const refusal = event({
      seq: 7,
      kind: 'team.policy-refused',
      record_id: 'policy-refused:worker-1:seat.at-prompt:2026-10-18T12:00:00.000Z',
      seat: 'worker-1',
      rule: 'privileged-self-subscription',
      reason: 'seat.at-prompt',
    });

    expect(delivery.onEvent(refusal).notified).toBe(true);
    expect(delivery.onEvent(refusal)).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes.length).toBe(1);
    const mailbox = join(root, '.agents', 'messages', 'owner');
    expect(readdirSync(mailbox).filter((name) => name.endsWith('.json')).length).toBe(1);
  });

  test('an event routed to a lead and the operator only does not reach the owner, and one addressed to `owner` does', () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });

    const blocked = event({
      seq: 8,
      kind: 'seat.blocked',
      record_id: 'blocked-worker-1',
      seat: 'worker-1',
      subject: 'worker-1',
      reason: 'worker-1 is blocked',
    });
    expect(isOwnerAddressed(blocked, parsed.team)).toBe(false);
    expect(delivery.onEvent(blocked)).toEqual({ addressed: false, notified: false, recorded: false });
    expect(notes).toEqual([]);

    // The watch's owner-addressed report: `blocked` alone would not route to the owner, and the
    // raising side's own `to` is what puts it in the owner's list. `seat.blocked` is not on the
    // owner's immediacy list, so it is routine: it waits in the pass and lands as one digest at
    // flush, without ringing (§10).
    const reportText = 'worker-2 is blocked, and its screen is not one the watch recognises';
    const report = event({
      seq: 9,
      kind: 'seat.blocked',
      record_id: 'watch:blocked:worker-2:2026-10-18T12:00:00.000Z',
      seat: 'worker-2',
      subject: 'worker-2',
      to: 'owner',
      reason: reportText,
    });
    expect(delivery.onEvent(report)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(notes).toEqual([]);
    expect(delivery.flush()).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes).toEqual([]);
    const records = listUnacked(root, 'acme', home);
    expect(records.length).toBe(1);
    expect(records[0]!.id.startsWith('digest-')).toBe(true);
    expect(storedBody(root, records[0]!.id)).toBe(`1 event: ${reportText}`);
  });

  test('routine owner events batch into one digest for the pass, and a replayed pass finds it and writes nothing', () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const routine = [
      event({
        seq: 12,
        kind: 'seat.working',
        record_id: 'watch:working:worker-1',
        seat: 'worker-1',
        to: 'owner',
        reason: 'worker-1 started work',
      }),
      event({
        seq: 13,
        kind: 'seat.idle',
        record_id: 'watch:idle:worker-3',
        seat: 'worker-3',
        to: 'owner',
        reason: 'worker-3 went idle',
      }),
    ];

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });
    expect(delivery.onEvent(routine[0]!)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(delivery.onEvent(routine[1]!)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(notes).toEqual([]);
    expect(delivery.flush()).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes).toEqual([]);
    // One record for the batch, not one per event.
    const records = listUnacked(root, 'acme', home);
    expect(records.length).toBe(1);
    expect(storedBody(root, records[0]!.id)).toBe('2 events: worker-1 started work; worker-3 went idle');
    // A second flush with nothing in the pass is silent.
    expect(delivery.flush()).toBeUndefined();

    // The same pass replayed after a restart: the digest id is its content, so the record is
    // already there and nothing is written or rung again.
    const replay = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });
    for (const entry of routine) expect(replay.onEvent(entry).notified).toBe(false);
    expect(replay.flush()).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes).toEqual([]);
    expect(listUnacked(root, 'acme', home).length).toBe(1);
  });

  test("the owner's immediacy list rings at once; the rest of the policy's owner traffic waits for the pass's digest", () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });

    // A lead's `seat.done` is on the list; a worker's is routine.
    const leadDone = event({
      seq: 20,
      kind: 'seat.done',
      record_id: 'watch:done:clerk',
      seat: 'clerk',
      to: 'owner',
      reason: 'clerk finished its work',
    });
    const workerDone = event({
      seq: 21,
      kind: 'seat.done',
      record_id: 'watch:done:worker-1',
      seat: 'worker-1',
      to: 'owner',
      reason: 'worker-1 finished its work',
    });
    expect(delivery.onEvent(leadDone)).toEqual({ addressed: true, notified: true, recorded: true });
    expect(delivery.onEvent(workerDone)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(notes).toEqual(['clerk finished its work']);

    // A prompt kind the owner cares about rings; a prompt that is not one waits.
    const permission = event({
      seq: 22,
      kind: 'seat.at-prompt',
      record_id: 'watch:permission:worker-2',
      seat: 'worker-2',
      to: 'owner',
      prompt: 'permission',
      reason: 'worker-2 waits at a permission prompt',
    });
    const question = event({
      seq: 23,
      kind: 'seat.at-prompt',
      record_id: 'watch:question:worker-3',
      seat: 'worker-3',
      to: 'owner',
      prompt: 'question',
      reason: 'worker-3 asks a question',
    });
    expect(delivery.onEvent(permission)).toEqual({ addressed: true, notified: true, recorded: true });
    expect(delivery.onEvent(question)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(notes).toEqual(['clerk finished its work', 'worker-2 waits at a permission prompt']);
    expect(delivery.flush()).toEqual({ addressed: true, notified: false, recorded: true });

    // The list is a setting: a policy layer that supplies another list is obeyed, and the
    // release default is not applied on top of it.
    const custom: string[] = [];
    const onlyDone = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => custom.push(text),
      atOnceKinds: ['team.policy-refused'],
    });
    expect(onlyDone.onEvent(permission)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(onlyDone.onEvent(leadDone)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(custom).toEqual([]);
  });

  test('the words the watch already told the owner are not a second notice, and the record still lands', () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const text = "worker-3 waits at a permission prompt: its owner's to answer";
    const told = new Set([text]);
    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (line) => notes.push(line),
      alreadyTold: (line) => told.has(line),
    });
    const prompt = event({
      seq: 10,
      kind: 'seat.at-prompt',
      record_id: 'watch:permission:worker-3:2026-10-18T12:00:00.000Z',
      seat: 'worker-3',
      subject: 'worker-3',
      to: 'owner',
      prompt: 'permission',
      reason: text,
    });
    expect(delivery.onEvent(prompt)).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes).toEqual([]);
    expect(listUnacked(root, 'acme', home).map((record) => record.id)).toEqual([ownerRecordId(prompt)]);
  });

  test('without a home the notice still goes and no record is claimed', () => {
    const { root } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      notify: (text) => notes.push(text),
    });
    const refusal = event({
      seq: 11,
      kind: 'team.policy-refused',
      record_id: 'policy-refused:worker-1:seat.at-prompt:later',
      seat: 'worker-1',
      rule: 'privileged-self-subscription',
      reason: 'seat.at-prompt',
    });
    expect(delivery.onEvent(refusal)).toEqual({ addressed: true, notified: true, recorded: false });
    expect(notes.length).toBe(1);
  });

  test('the delivered line is one line: whitespace folds, and a long report clips', () => {
    const folded = ownerDeliveryText(
      event({
        seq: 1,
        kind: 'seat.blocked',
        record_id: 'b-1',
        to: 'owner',
        reason: 'line one\n\tline two',
      }),
    );
    expect(folded).toBe('line one line two');

    const clipped = ownerDeliveryText(
      event({ seq: 2, kind: 'seat.blocked', record_id: 'b-2', to: 'owner', reason: 'x'.repeat(600) }),
    );
    expect(clipped.length).toBe(500);
    expect(clipped.endsWith('…')).toBe(true);
  });
});
