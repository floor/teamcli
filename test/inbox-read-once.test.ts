// The receiver's read-once gate: one message id, one content exposure. A repeat read and a
// second process both get no body once the first has served it; a rival that arrives while the
// claim is held is told `busy`; a claim left by a process that died before any receipt is
// reclaimed and served once; and a claim or receipt that cannot be trusted serves nothing.
// Bodies are counted, never inferred: every scene asserts whether the body string came back.
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admitInboxMessage, admissionFolder, claimPath } from '../src/mcp/inbox-admission.ts';
import { readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { signRecord, signReceiptPayload, verifyReceipt, writeReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';

const SESSION = 'acme';
const LEAD_ID = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e45';
const OTHER_ID = '5a1c9e93-8b9f-4eb3-8f70-ac6bbd3e4f56';
const BODY = 'the one body this id may expose';

const HERE = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative: string): string => pathToFileURL(join(HERE, '..', relative)).href;

type Place = {
  base: string;
  root: string;
  home: string;
  dropDir: string;
  cleanup(): void;
};

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-read-once-')));
  const root = join(base, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(base, 'home'), { mode: 0o700 });
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
  return {
    base,
    root,
    home: join(base, 'home'),
    dropDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function message(at: Place, to: string, id: string, body: string): string {
  const record = signRecord({
    kind: 'message',
    id,
    to,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-20T12:00:00.000Z',
    body,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  const path = join(at.dropDir, id);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function target(at: Place): { dropDir: string; root: string; seat: string; session: string } {
  return { dropDir: at.dropDir, root: at.root, seat: 'lead', session: SESSION };
}

function read(at: Place): ReturnType<typeof readMessage> {
  return readMessage(target(at), LEAD_ID, at.home);
}

function readReceipt(at: Place): SignedReceipt {
  const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir, LEAD_ID), 'utf8')) as SignedReceipt;
  const key = messageKeyState(at.home);
  if (key.kind !== 'key') throw new Error('the fixture wrote no message key');
  expect(verifyReceipt(receipt, key.key)).toBe(true);
  return receipt;
}

/** A real child process that reads one message, optionally after a barrier file appears. */
function writeReadChild(at: Place): string {
  const script = join(at.base, 'read-child.ts');
  writeFileSync(script, `import { existsSync } from 'node:fs';
import { readMessage } from ${JSON.stringify(moduleUrl('src/mcp/inbox.ts'))};
const [dropDir, root, seat, session, home, id, barrier] = process.argv.slice(2);
while (barrier !== '' && !existsSync(barrier)) await new Promise((tick) => setTimeout(tick, 5));
const read = readMessage({ dropDir, root, seat, session }, id, home);
console.log(JSON.stringify(read));
`);
  return script;
}

/** A real child process that takes the claim and exits without releasing it: the crash shape. */
function writeClaimChild(at: Place): string {
  const script = join(at.base, 'claim-child.ts');
  writeFileSync(script, `import { admitInboxMessage } from ${JSON.stringify(moduleUrl('src/mcp/inbox-admission.ts'))};
const [dropDir, root, seat, session, id] = process.argv.slice(2);
const admission = admitInboxMessage({ dropDir, root, seat, session, id, receiptHeld: () => false });
console.log(JSON.stringify(admission.ok
  ? { ok: true, reclaimed: admission.reclaimed, pid: process.pid }
  : admission));
`);
  return script;
}

function runChild(script: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });
}

type Child = { code: number | null; out: string; err: string };

function runInBackground(script: string, args: readonly string[]): Promise<Child> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A pid that is gone: a child prints its own and exits; the caller waits on the exit before
 *  this returns, so the number names no live process of ours. */
function deadPid(at: Place): number {
  const script = join(at.base, 'pid-child.ts');
  writeFileSync(script, 'console.log(process.pid);\n');
  const pid = Number(runChild(script, []).trim());
  expect(Number.isInteger(pid)).toBe(true);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
  return pid;
}

function claimJson(at: Place, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    v: 1,
    id: LEAD_ID,
    root: at.root,
    session: SESSION,
    seat: 'lead',
    pid: deadPid(at),
    at: '2026-10-20T11:00:00.000Z',
    ...overrides,
  }, null, 2)}\n`;
}

function bodies(results: readonly Record<string, unknown>[]): number {
  return results.filter((result) => result.ok === true && typeof result.body === 'string' && result.body === BODY).length;
}

describe('the inbox read-once gate', () => {
  test('a repeat read returns no body and leaves the write-once receipt untouched', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      expect(read(at)).toEqual({ ok: true, body: BODY });
      const receipt = readFileSync(receiptPath(at.dropDir, LEAD_ID), 'utf8');
      expect(readReceipt(at).payload).toMatchObject({ id: LEAD_ID, to: 'lead', status: 'read' });

      const again = read(at);
      expect(again).toEqual({
        ok: false,
        reason: `message ${JSON.stringify(LEAD_ID)} was already served in this inbox`,
        served: 'already-served',
      });
      expect(JSON.stringify(again)).not.toContain(BODY);
      expect(readFileSync(receiptPath(at.dropDir, LEAD_ID), 'utf8')).toBe(receipt);
    } finally {
      at.cleanup();
    }
  });

  test('two real processes reading the same id return exactly one body', async () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const child = writeReadChild(at);
      const barrier = join(at.base, 'go');
      const args = [at.dropDir, at.root, 'lead', SESSION, at.home, LEAD_ID, barrier];
      const first = runInBackground(child, args);
      const second = runInBackground(child, args);
      // Both children are waiting at the barrier: nothing serves this id before the race starts.
      await new Promise((tick) => setTimeout(tick, 100));
      expect(existsSync(barrier)).toBe(false);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);
      writeFileSync(barrier, 'go\n');
      const [a, b] = await Promise.all([first, second]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const results = [JSON.parse(a.out) as Record<string, unknown>, JSON.parse(b.out) as Record<string, unknown>];
      expect(bodies(results)).toBe(1);
      const loser = results.find((result) => result.ok === false);
      expect(loser).toBeDefined();
      expect(loser?.served === 'busy' || loser?.served === 'already-served').toBe(true);
      expect(JSON.stringify(loser)).not.toContain(BODY);
      // The read receipt is the winner's, and no claim is left behind.
      expect(readReceipt(at).payload).toMatchObject({ id: LEAD_ID, to: 'lead', status: 'read' });
      expect(existsSync(claimPath(at.dropDir, LEAD_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a live holder makes another process busy with no body until the claim is released', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const held = admitInboxMessage({
        dropDir: at.dropDir,
        root: at.root,
        seat: 'lead',
        session: SESSION,
        id: LEAD_ID,
        receiptHeld: () => false,
      });
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      const child = writeReadChild(at);
      const busy = JSON.parse(runChild(child, [at.dropDir, at.root, 'lead', SESSION, at.home, LEAD_ID, ''])) as Record<string, unknown>;
      expect(busy).toMatchObject({ ok: false, served: 'busy' });
      expect(JSON.stringify(busy)).not.toContain(BODY);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);

      held.release();
      const served = JSON.parse(runChild(child, [at.dropDir, at.root, 'lead', SESSION, at.home, LEAD_ID, ''])) as Record<string, unknown>;
      expect(served).toEqual({ ok: true, body: BODY });
      expect(existsSync(claimPath(at.dropDir, LEAD_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a claim left by a process that died before any receipt is reclaimed and served once', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const claimer = writeClaimChild(at);
      const claimed = JSON.parse(runChild(claimer, [at.dropDir, at.root, 'lead', SESSION, LEAD_ID])) as {
        ok: boolean;
        pid: number;
      };
      expect(claimed.ok).toBe(true);
      const left = JSON.parse(readFileSync(claimPath(at.dropDir, LEAD_ID), 'utf8')) as { pid: number };
      expect(left.pid).toBe(claimed.pid);
      let alive = true;
      try {
        process.kill(left.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);

      const reader = writeReadChild(at);
      const served = JSON.parse(runChild(reader, [at.dropDir, at.root, 'lead', SESSION, at.home, LEAD_ID, ''])) as Record<string, unknown>;
      expect(served).toEqual({ ok: true, body: BODY });
      expect(existsSync(claimPath(at.dropDir, LEAD_ID))).toBe(false);
      // The restart reads no second copy.
      const again = JSON.parse(runChild(reader, [at.dropDir, at.root, 'lead', SESSION, at.home, LEAD_ID, ''])) as Record<string, unknown>;
      expect(again).toMatchObject({ ok: false, served: 'already-served' });
      expect(JSON.stringify(again)).not.toContain(BODY);
    } finally {
      at.cleanup();
    }
  });

  test('a dead claim is never cleared over a durable receipt', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      expect(read(at)).toEqual({ ok: true, body: BODY });
      const claim = claimJson(at);
      writeFileSync(claimPath(at.dropDir, LEAD_ID), claim, { mode: 0o600 });

      const got = read(at);
      expect(got).toMatchObject({ ok: false, served: 'already-served' });
      expect(JSON.stringify(got)).not.toContain(BODY);
      // The receipt is proof the content went out; the dead claim is evidence, not a licence
      // to serve again, so it is left where it is.
      expect(readFileSync(claimPath(at.dropDir, LEAD_ID), 'utf8')).toBe(claim);
    } finally {
      at.cleanup();
    }
  });

  test('a claim bound to another inbox serves nothing and is preserved', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      mkdirSync(admissionFolder(at.dropDir), { mode: 0o700 });
      const foreign = claimJson(at, { seat: 'worker' });
      writeFileSync(claimPath(at.dropDir, LEAD_ID), foreign, { mode: 0o600 });

      const got = read(at);
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.reason).toContain('bound to another inbox');
        expect(got.served).toBeUndefined();
      }
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);
      expect(readFileSync(claimPath(at.dropDir, LEAD_ID), 'utf8')).toBe(foreign);
    } finally {
      at.cleanup();
    }
  });

  test('an unreadable claim, or a link at its name, is refused and preserved', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      mkdirSync(admissionFolder(at.dropDir), { mode: 0o700 });
      const path = claimPath(at.dropDir, LEAD_ID);
      const garbage = 'not the claim this gate writes\n';
      writeFileSync(path, garbage, { mode: 0o600 });
      const got = read(at);
      expect(got).toMatchObject({ ok: false });
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(readFileSync(path, 'utf8')).toBe(garbage);

      // A link at the claim's name is never followed, and the message is still not served.
      const elsewhere = join(at.base, 'elsewhere.claim');
      writeFileSync(elsewhere, claimJson(at), { mode: 0o600 });
      unlinkSync(path);
      symlinkSync(elsewhere, path);
      const linked = read(at);
      expect(linked).toMatchObject({ ok: false });
      expect(JSON.stringify(linked)).not.toContain(BODY);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('an admission folder that is not private serves nothing', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      mkdirSync(admissionFolder(at.dropDir), { mode: 0o755 });
      chmodSync(admissionFolder(at.dropDir), 0o755);
      const got = read(at);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toContain('not private');
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a corrupt or differently bound receipt does not count as served', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);

      writeFileSync(path, '{ not a receipt\n', { mode: 0o600 });
      expect(read(at)).toEqual({ ok: true, body: BODY });
      expect(readReceipt(at).payload).toMatchObject({ id: LEAD_ID, to: 'lead' });
      expect(read(at)).toMatchObject({ ok: false, served: 'already-served' });

      // A receipt signed by this key for another seat is not proof this inbox served it.
      message(at, 'lead', OTHER_ID, BODY);
      const foreign = signReceiptPayload({
        kind: 'receipt',
        status: 'read',
        id: OTHER_ID,
        to: 'worker',
        root: realpathSync(at.root),
        session: SESSION,
        at: '2026-10-20T11:30:00.000Z',
      }, at.home);
      const written = writeReceipt(at.dropDir, foreign, at.home);
      expect(written.ok).toBe(true);
      const other = readMessage(target(at), OTHER_ID, at.home);
      expect(other).toEqual({ ok: true, body: BODY });
      expect(readMessage(target(at), OTHER_ID, at.home)).toMatchObject({ ok: false, served: 'already-served' });
    } finally {
      at.cleanup();
    }
  });
});
