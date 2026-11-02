// What a send says about a seat that configures a webhook adapter: a readable adapter is a route
// that exists, a configured adapter that cannot post says why, and a webhook-only route always
// reads as queued for the bus, because the bus posts the adapter after the send returns. The
// send never claims that wake; the bus's own report and the seat's recorded delivery outcome
// carry what the adapter answered.
//
// The team is a synthetic world under a temp folder and the secret is a fixture file. No live
// seat, no real routine.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBus, type BusHandle } from '../src/bus/server.ts';
import type { SignedEventRecord } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const extras: string[] = [];
const buses: BusHandle[] = [];
let made: World | null = null;
afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
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
  test('a usable adapter with no bus serving the root is queued for the bus, in the dry run', async () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green', '--dry-run'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('dry-run:');
    expect(io.out).toContain('queued; its webhook fires when the bus takes it');
    expect(io.out).not.toContain('woken through its webhook adapter');
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
    expect(parsed.plan?.[0]?.detail ?? '').toContain('queued; its webhook fires when the bus takes it');
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

  test('a real send with no bus serving the root keeps the drop and claims no wake', async () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('sent (unconfirmed)');
    // The adapter is readable, and it fires only when a bus announces the record: the send
    // itself did not wake the seat, so the line must not say it did.
    expect(io.out).toContain('queued; its webhook fires when the bus takes it');
    expect(io.out).not.toContain('woken through its event adapter');
    expect(io.out).not.toContain(SECRET);
    // The drop the seat's pull reads stays, beside the send's own bookkeeping files.
    const dir = dropDir(at.dir, 'iris');
    expect(existsSync(dir)).toBe(true);
    const record = readdirSync(dir).find((name) => !name.endsWith('.pending') && !name.endsWith('.fallback.json'));
    expect(record).toBeDefined();
    expect(readFileSync(join(dir, record!), 'utf8')).toContain('the gate is green');
  });

  test('a live bus that takes the arrival still reads as queued, never woken', async () => {
    const hook = hookFiles();
    const at = withHookSeat(hook);
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    // The bus is the one that posts an adapter. Even with the real bus serving this root and
    // taking the send's announcement, the send cannot see what the adapter answered, so its own
    // line keeps the queued words and the bus's report carries the outcome.
    const taken: SignedEventRecord[] = [];
    const started = await startBus({
      root: at.root,
      team: loaded.team,
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
      deliver: (record) => { taken.push(record); },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const preview = owner(at.root);
    expect(await runSend(['iris', 'the gate is green', '--dry-run'], preview, fake(at)), preview.err).toBe(0);
    expect(preview.out).toContain('queued; its webhook fires when the bus takes it');
    expect(preview.out).not.toContain('woken through its webhook adapter');
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('sent (unconfirmed)');
    expect(io.out).toContain('queued; its webhook fires when the bus takes it');
    expect(io.out).not.toContain('woken through its event adapter');
    expect(io.out).not.toContain('woken through its webhook adapter');
    expect(taken.some((record) => record.payload.kind === 'message.arrived' && record.payload.to === 'iris')).toBe(true);
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
