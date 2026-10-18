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
    // raising side's own `to` is what puts it in the owner's list.
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
    expect(delivery.onEvent(report)).toEqual({ addressed: true, notified: true, recorded: true });
    expect(notes).toEqual([reportText]);
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
