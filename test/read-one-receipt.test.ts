// The send path diet (step 5): one read writes one signed receipt. Every file a read leaves is
// counted: `team ack` on a plain record, and on a stamped record (an active root) the seat's
// inbox read followed by its channel ack. Fixtures only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runAck } from '../src/commands/ack.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { activate } from '../src/queue/floor.ts';
import { appendDeliverySync } from '../src/queue/append.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { isRead, signRecord, stampedPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const ID = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** Every file under `top` modified at or after `since` (ms), relative to `base`. */
function writtenSince(top: string, since: number, base: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.mtimeMs >= since) out.push(relative(base, path));
    }
  };
  walk(top);
  return out.sort();
}

/** Back-dates every file under `top`, so the next act's writes are the only fresh ones. */
function age(top: string): number {
  const past = new Date(Date.now() - 60_000);
  const walk = (at: string): void => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else utimesSync(path, past, past);
    }
  };
  walk(top);
  return Date.now() - 1_000;
}

const list = (label: string, written: string[]): void => {
  if (process.env.SEND_DIET_LIST === '1') process.stderr.write(`${label}: ${String(written.length)} files\n${written.join('\n')}\n`);
};

function team(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-read-diet-')));
  cleanup = () => rmSync(base, { recursive: true, force: true });
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1\nproject: acme\ncoordinator: lead\noperator: lead\nsession: ${SESSION}\nworkspace:\n  mode: shared\nseats:\n  - role: coordinator\n    name: lead\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n`);
  messageKeyOf(home);
  return { root, home };
}

describe('one read writes one receipt', () => {
  test('team ack on a plain record: the signed read receipt, and nothing else', async () => {
    const { root, home } = team();
    plantRecord(home, root, SESSION, 'owner', ID, 'from the lead\n\na question', { from: 'lead' });
    const since = age(root);
    const io = testIo(root, { kind: 'owner' });
    expect(await runAck([ID], io, { home, now: () => new Date() })).toBe(0);
    const written = writtenSince(join(root, '.agents'), since, root).filter((path) => !path.endsWith('team.log'));
    list('team ack', written);
    expect(written).toEqual([`.agents/send-drops/${SESSION}/owner/${ID}.read.json`]);
  });

  test('a stamped record: the inbox read writes no receipt, the channel ack writes the one receipt', () => {
    const { root, home, dropDir, key, context } = stampedScene();
    const target = { dropDir, root, session: SESSION, seat: 'lead' };

    let since = age(root);
    expect(readMessage(target, ID, home).ok).toBe(true);
    const onRead = writtenSince(join(root, '.agents'), since, root).filter((path) => !path.endsWith('team.log'));
    list('inbox read', onRead);
    // Only the copy's delivery number: no read receipt, no per-seat store file, no pending marker.
    expect(onRead.every((path) => path.includes('/.exposures/'))).toBe(true);
    expect(isRead(dropDir, ID, context, key)).toBe(false);

    since = age(root);
    expect(publishRecordRead({ dropDir, id: ID, to: 'lead', root, session: SESSION, home, key, at: new Date().toISOString(), readBy: 'channel' }).kind).toBe('published');
    const onAck = writtenSince(join(root, '.agents'), since, root).filter((path) => !path.endsWith('team.log'));
    list('channel ack after an inbox read', onAck);
    expect(onAck).toHaveLength(1);
    expect(onAck[0]?.endsWith(`/${ID}.read.json`)).toBe(true);
    expect(isRead(dropDir, ID, context, key)).toBe(true);
  });

  test('a stamped record pushed on the channel: its ack writes the one receipt', () => {
    const { root, home, dropDir, key, context } = stampedScene();
    const since = age(root);
    expect(publishRecordRead({ dropDir, id: ID, to: 'lead', root, session: SESSION, home, key, at: new Date().toISOString(), readBy: 'channel' }).kind).toBe('published');
    const onAck = writtenSince(join(root, '.agents'), since, root).filter((path) => !path.endsWith('team.log'));
    list('channel ack', onAck);
    expect(onAck).toEqual([`.agents/send-drops/${SESSION}/lead/${ID}.read.json`]);
    expect(isRead(dropDir, ID, context, key)).toBe(true);
  });
});

/** An active root with one stamped, queued record to `lead`, as `team send` leaves it. */
function stampedScene() {
  const { root, home } = team();
  const daemon = { kind: 'daemon' as const, name: 'daemon', pid: 1, build: 'b', level: 3 };
  expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const record = signRecord(stampedPayload({
    kind: 'message', id: ID, to: 'lead', to_id: null, root, session: SESSION,
    at: new Date().toISOString(), body: 'hello', from: 'worker', from_id: null, rule: 'the owner', thread: ID,
  }, home), home);
  expect(record.payload.lvl).toBe(3);
  // A queued delivery, as `team send` makes it.
  appendDeliverySync({ dropDir, record }, () => {
    writeFileSync(join(dropDir, ID), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: true };
  }, { home });
  return { root, home, dropDir, key: messageKeyOf(home), context: { to: 'lead', root, session: SESSION } };
}
