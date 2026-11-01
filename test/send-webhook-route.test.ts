// What a send says about a seat that configures a webhook adapter: the dry run names the route
// in the delivery classes' own words, a configured adapter that cannot post says why, and a real
// send keeps the drop file as the backup while the class reports the wake.
//
// The team is a synthetic world under a temp folder and the secret is a fixture file. No live
// seat, no real routine.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const extras: string[] = [];
let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
  for (const dir of extras.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'synthetic-secret-value';

/** The two files the seat row names: a loopback URL the send never dials, and a 0600 secret. */
function hookFiles(secret = SECRET): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-')));
  extras.push(base);
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, 'http://127.0.0.1:1/routine\n');
  writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

function withHookSeat(webhook: { urlFile: string; secretFile: string }): World {
  made = world(['drop'], [{ name: 'iris', role: 'remote', webhook }]);
  return made;
}

describe('team send names the webhook route', () => {
  test('a usable adapter is an eligible, waking route in the dry run', async () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green', '--dry-run'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('dry-run:');
    expect(io.out).toContain('woken through its webhook adapter');
    expect(io.out).toContain('nothing was written');
    // Neither value is ever printed.
    expect(io.out).not.toContain(SECRET);
    expect(io.out).not.toContain(hook.secretFile);
  });

  test('the json document carries the same clause', async () => {
    const at = withHookSeat(hookFiles());
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green', '--dry-run', '--json'], io, fake(at));
    expect(code, io.err).toBe(0);
    const parsed = JSON.parse(io.out) as { plan?: { detail?: string }[] };
    expect(parsed.plan?.[0]?.detail ?? '').toContain('woken through its webhook adapter');
    expect(io.out).toContain('nothing was written');
  });

  test('a missing secret is said in plain words, and the route is not claimed', async () => {
    const hook = hookFiles();
    const at = withHookSeat({ urlFile: hook.urlFile, secretFile: join(hook.urlFile, '..', 'no-such-secret') });
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green', '--dry-run'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('its webhook adapter cannot deliver:');
    expect(io.out).toContain('missing or unreadable');
    expect(io.out).not.toContain('woken through its webhook adapter');
  });

  test('a secret readable by group or others is refused with its mode, never its value', async () => {
    const hook = hookFiles('group-readable-secret');
    chmodSync(hook.secretFile, 0o644);
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green', '--dry-run'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('readable by group or others');
    expect(io.out).toContain('0600');
    expect(io.out).not.toContain('group-readable-secret');
  });

  test('a real send keeps the drop file and reports the wake', async () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('sent (unconfirmed)');
    expect(io.out).toContain('woken through its event adapter');
    expect(io.out).not.toContain(SECRET);
    // The drop the seat's pull reads stays, beside the send's own bookkeeping files.
    const dir = dropDir(at.dir, 'iris');
    expect(existsSync(dir)).toBe(true);
    const record = readdirSync(dir).find((name) => !name.endsWith('.pending') && !name.endsWith('.fallback.json'));
    expect(record).toBeDefined();
    expect(readFileSync(join(dir, record!), 'utf8')).toContain('the gate is green');
  });

  test('a real send with an unreadable secret keeps the drop and claims no wake', async () => {
    const hook = hookFiles();
    const at = withHookSeat({ urlFile: hook.urlFile, secretFile: join(hook.urlFile, '..', 'no-such-secret') });
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('sent (unconfirmed)');
    expect(io.out).toContain('queued; iris reads it at its next turn (pull-only)');
    expect(io.out).not.toContain('woken through its event adapter');
    const dir = dropDir(at.dir, 'iris');
    const record = readdirSync(dir).find((name) => !name.endsWith('.pending') && !name.endsWith('.fallback.json'));
    expect(record).toBeDefined();
    expect(readFileSync(join(dir, record!), 'utf8')).toContain('the gate is green');
  });
});

describe('the delivery class reads the adapter as push evidence', () => {
  test('a readable adapter is push, in the existing words', () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const read = seatDeliveryClass({
      dir: at.dir,
      root: at.root,
      session: 'acme',
      seat: 'iris',
      declared: { cli: 'claude-code', launch: 'claude', webhook: hook },
      home: at.home,
    });
    expect(read.class).toBe('push');
    expect(read.words).toBe('woken through its event adapter');
    expect(read.evidence.webhook).toBe(true);
    expect(read.evidence.webhookReason).toBeNull();
  });

  test('an adapter that cannot post is no wake, and the evidence says why', () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const read = seatDeliveryClass({
      dir: at.dir,
      root: at.root,
      session: 'acme',
      seat: 'iris',
      declared: { cli: 'claude-code', launch: 'claude', webhook: { urlFile: hook.urlFile, secretFile: join(hook.urlFile, '..', 'no-such-secret') } },
      home: at.home,
    });
    expect(read.class).not.toBe('push');
    expect(read.evidence.webhook).toBe(false);
    expect(read.evidence.webhookReason ?? '').toContain('missing or unreadable');
  });

  test('a seat with no adapter reads as before', () => {
    const at = withHookSeat(hookFiles());
    const read = seatDeliveryClass({
      dir: at.dir,
      root: at.root,
      session: 'acme',
      seat: 'iris',
      declared: { cli: 'claude-code', launch: 'claude' },
      home: at.home,
    });
    expect(read.evidence.webhook).toBe(false);
    expect(read.evidence.webhookReason).toBeNull();
  });
});
