// The machine development mode through the owner seat, exactly as `team config … --request`
// opens that door: `--request` records the switch `set <mode>` as one owner-action request and
// writes nothing; the owner's answer — here a synthetic signature, never a real Touch ID — is the
// approval, and `--approval <id>` applies it. A request binds the caller's repository, team, HEAD
// and words, so an answer for one mode cannot apply another. The card reads the switch's own
// three lines. Every fixture is synthetic: a temporary home, a temporary key and a fake store.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { ownerActionCard } from '../src/client/approval-card.ts';
import { approveOwnerAction, readOwnerActionRecord } from '../src/client/owner-action.ts';
import { runDevelopmentMode } from '../src/commands/development-mode.ts';
import { readDevelopmentMode } from '../src/development_mode.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-02T09:00:00.000Z');
const detached: Caller = { kind: 'owner-no-tty' };
const owner: Caller = { kind: 'owner' };

const made: string[] = [];
afterAll(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Place = { home: string; root: string; store: FakeStore };

/** A git folder and a home holding the owner seat: the request binds the folder's repository. */
function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-mode-request-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const store = seatOwner(home);
  return { home, root, store };
}

async function run(p: Place, argv: string[], caller: Caller = detached): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(p.root, caller);
  const code = await runDevelopmentMode(argv, io, { home: p.home, now: NOW, ownerSeatStore: p.store });
  return { code, out: io.out, err: io.err };
}

function requestId(text: string): string {
  return /owner-seat request (oa_[0-9a-f]{24})/.exec(text)?.[1] ?? '';
}

describe('the development mode through the owner seat', () => {
  test('a request writes no mode, its card names the switch, and the owner answer applies it', async () => {
    const p = place();
    const ask = await run(p, ['set', 'local-fast', '--request']);
    expect(ask.code, ask.err).toBe(0);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    // A request writes nothing: the machine is exactly as it was.
    expect(readDevelopmentMode(p.home).kind).toBe('absent');

    const record = readOwnerActionRecord(p.home, id);
    expect(typeof record).not.toBe('string');
    if (typeof record === 'string') return;
    expect(ownerActionCard(record.params)).toEqual({
      title: 'TeamCLI: development mode',
      question: 'Set development mode to local-fast on this machine?',
      scope: `One-time change. ${record.params.requested_by} asked.`,
    });

    // The owner's answer is a signature; here the fake store signs for her.
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const applied = await run(p, ['set', 'local-fast', '--approval', id]);
    expect(applied.code, applied.err).toBe(0);
    const mode = readDevelopmentMode(p.home);
    expect(mode.kind).toBe('set');
    if (mode.kind === 'set') expect(mode.record.mode).toBe('local-fast');
  });

  test('an answer for one mode does not apply another, and writes nothing', async () => {
    const p = place();
    const ask = await run(p, ['set', 'local-fast', '--request']);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const other = await run(p, ['set', 'off', '--approval', id]);
    expect(other.code).toBe(1);
    expect(other.err).toContain('was approved for other development-mode arguments');
    expect(readDevelopmentMode(p.home).kind).toBe('absent');
  });

  test('a request and the fingerprint show do not mix', async () => {
    const p = place();
    const mixed = await run(p, ['set', 'local-fast', '--show', '--request']);
    expect(mixed.code).toBe(2);
    expect(mixed.err).toContain('pass one');
    expect(readDevelopmentMode(p.home).kind).toBe('absent');
  });

  test('a caller with no answer is still refused, and the owner keeps the direct route', async () => {
    const p = place();
    const refused = await run(p, ['set', 'off']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('only the owner switches the machine development mode');
    // The owner at a terminal is unchanged: no card, and the switch lands.
    const direct = await run(p, ['set', 'off'], owner);
    expect(direct.code, direct.err).toBe(0);
    const mode = readDevelopmentMode(p.home);
    expect(mode.kind).toBe('set');
    if (mode.kind === 'set') expect(mode.record.mode).toBe('off');
  });
});
