// rfc-event-comms E6 on the legacy paths: the inbox read (and `team drops --read`, the same
// function) honours the exposure claim on an active root, a leg's own delivery record continues its
// claim, the read is dual-written to the per-seat store, and a pre-E6 inbox server (a listener
// marker with no level, as 85f8d5351 writes it) blocks activation.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { signRecord } from '../src/send/record.ts';
import { appendDeliverySync } from '../src/queue/append.ts';
import { activate, floorState, type FloorActor } from '../src/queue/floor.ts';
import { liveFloorActors } from '../src/queue/floor-actors.ts';
import { bodyActor, decideExposure } from '../src/queue/exposure.ts';
import { derivedProgress, readQueueReceipts } from '../src/queue/receipt-store.ts';
import { currentGenerationName } from '../src/queue/append.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 2 };

function place(): { root: string; home: string; dropDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e6-legacy-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Grok
    version: "4.7"
    launch: claude
  - role: worker
    name: worker
    cli: codex
    vendor: test
    model: Grok
    version: "4.7"
    launch: codex
`);
  return { root, home, dropDir };
}

function message(at: { root: string; home: string; dropDir: string }, id: string): void {
  const record = signRecord({
    kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION,
    at: '2026-11-18T00:00:00.000Z', body: `body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id,
  }, at.home);
  appendDeliverySync({ dropDir: at.dropDir, record }, () => {
    writeFileSync(join(at.dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: true };
  }, { home: at.home });
}

const target = (at: { root: string; dropDir: string }) => ({ dropDir: at.dropDir, root: at.root, seat: 'lead', session: SESSION });

describe('E6 legacy read path', () => {
  test('dark: the read serves the body exactly as before', () => {
    const at = place();
    message(at, '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41');
    const read = readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41', at.home);
    expect(read.ok).toBe(true);
  });

  test('active: a body another leg exposed is answered with a pointer, and no read receipt is written', () => {
    const at = place();
    message(at, '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41');
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    expect(decideExposure({ root: at.root, session: SESSION, seat: 'lead', msg_id: '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41' }, bodyActor('channel', '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41'), at.home).kind).toBe('expose');
    const read = readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41', at.home);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('already shown');
    const generation = currentGenerationName(at.dropDir)!;
    expect(readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home)).toEqual([]);
    // The leg that carried it records its own delivery: its claim continues, and the read lands.
    const recorded = readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41', at.home, undefined, undefined, undefined, bodyActor('channel', '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41'));
    expect(recorded.ok).toBe(true);
  });

  test('active: the first reader exposes once; a second automatic read gets no second body', () => {
    const at = place();
    message(at, '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42');
    activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] });
    expect(readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42', at.home).ok).toBe(true);
    expect(readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42', at.home).ok).toBe(false);
  });

  test('a read is dual-written to the per-seat receipt store at the message queue place', () => {
    const at = place();
    message(at, '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41');
    message(at, '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42');
    expect(readMessage(target(at), '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41', at.home).ok).toBe(true);
    const generation = currentGenerationName(at.dropDir)!;
    const receipts = readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home)!;
    expect(receipts.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
    expect(derivedProgress(receipts).prefix).toBe(1);
  });
});

describe('E6 activation against a pre-E6 inbox server', () => {
  test('a live listener marker with no level (as 85f8d5351 writes it) refuses activation', () => {
    const at = place();
    writeFileSync(join(at.dropDir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), version: '0.5.22', build: 'old' })}\n`);
    const actors = liveFloorActors(at.root, at.home)!;
    expect(actors.find(a => a.kind === 'inbox-server')).toMatchObject({ level: null });
    const out = activate(at.root, { home: at.home, build: 'b', actors: () => [daemon, ...actors] });
    expect(out.kind).toBe('refused');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('the same marker at level 2 lets the root activate', () => {
    const at = place();
    writeFileSync(join(at.dropDir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), level: 2 })}\n`);
    const actors = liveFloorActors(at.root, at.home)!;
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon, ...actors] }).kind).toBe('activated');
  });
});
