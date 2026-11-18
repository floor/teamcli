// The Claude adapter §4.2 (F19): a client is named from its grant, never from a seat label.
//
// Client ingress writes its drop through `writeClientDrop`, the real writer `team send --client`
// uses. On an active root the record is stamped and signs `from_identity` from the grant: the
// client's display name and its grant binding. On a dark root nothing new is signed, and the
// render reads the same identity from the record's `from_client`. The receiving seat's own label
// persona never names the client. Fixtures only: a temporary root and home.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClientDrop } from '../src/client/send.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { attributedBody } from '../src/send/sender-claim.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const NOW = new Date('2026-11-18T11:00:00.000Z');

function place(active: boolean): { root: string; home: string; dropDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'client-identity-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dirs = seatMailDirs(root, SESSION, 'orchestrator');
  mkdirSync(dirs.legacy, { recursive: true, mode: 0o700 });
  if (active) expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  return { root, home, dropDir: dirs.legacy };
}

function drop(at: { root: string; home: string; dropDir: string }) {
  const written = writeClientDrop({
    home: at.home,
    grant: { clientId: 'grok-bot', grantId: 'grant_0a1b2c3d' },
    target: { entity: 'acme', recipientId: 'agt_00000000000a', recipientSeat: 'orchestrator', teamId: 'team_acme', teamRoot: at.root, session: SESSION, dropDir: at.dropDir },
    body: 'from the owner, via the bot: hello',
    now: NOW,
  });
  if (!written.ok) throw new Error(written.why);
  return written.record;
}

describe('F19: client ingress through the real writer', () => {
  test('an active root signs the client name and grant binding, and every leg prints them', () => {
    const record = drop(place(true));
    expect(record.lvl).toBe(3);
    expect(record.from_identity).toEqual({ name: 'Grok Bot', address: 'client:grok-bot (grant grant_0a1b2c3d)' });
    const line = attributedBody(record.body, record.from, { record }).split('\n')[0];
    expect(line).toBe('Grok Bot · client:grok-bot (grant grant_0a1b2c3d) · 2026-11-18 11:00Z · admitted: owner relay');
  });

  test('a dark root signs nothing new, and the render reads the same identity from from_client', () => {
    const at = place(false);
    const record = drop(at);
    expect(record.lvl).toBeUndefined();
    expect('from_identity' in record).toBe(false);
    const line = attributedBody(record.body, record.from, { record, home: at.home }).split('\n')[0];
    expect(line).toBe('Grok Bot · client:grok-bot (grant grant_0a1b2c3d) · 2026-11-18 11:00Z · admitted: owner relay');
  });
});
