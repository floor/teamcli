// The receiver's read-once gate: one message id, one content exposure. The signed read receipt is
// the per-id gate, published exclusively with `link` before any body is returned, so two real
// processes that race it return exactly one body and the loser is told `already-served`. A repeat
// read returns no body. An entry at a receipt name that does not verify is uncertainty, not proof
// unserved: it is preserved and served nothing, never replaced.
// Bodies are counted, never inferred: every scene asserts whether the body string came back.
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishReadReceipt } from '../src/mcp/inbox-admission.ts';
import { readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { signRecord, signReceiptPayload, verifyReceipt, writeReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';

const SESSION = 'acme';
const LEAD_ID = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e45';
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

/** A real child process that reads one message after a barrier file appears. */
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

/** A real child process that races one exclusive receipt publication after a barrier file
 *  appears. It never checks the name first: both children call the primitive, which is the point. */
function writePublishChild(at: Place): string {
  const script = join(at.base, 'publish-child.ts');
  writeFileSync(script, `import { existsSync } from 'node:fs';
import { publishReadReceipt } from ${JSON.stringify(moduleUrl('src/mcp/inbox-admission.ts'))};
const [path, content, barrier] = process.argv.slice(2);
while (barrier !== '' && !existsSync(barrier)) await new Promise((tick) => setTimeout(tick, 5));
console.log(JSON.stringify({ result: publishReadReceipt(path, content) }));
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
      expect(loser?.served).toBe('already-served');
      expect(JSON.stringify(loser)).not.toContain(BODY);
      // The one receipt is the winner's, and neither child's temp is left behind.
      expect(readReceipt(at).payload).toMatchObject({ id: LEAD_ID, to: 'lead', status: 'read' });
      expect(readdirSync(at.dropDir).filter((name) => name.endsWith('.new'))).toEqual([]);
    } finally {
      at.cleanup();
    }
  });

  test('two real processes publishing the receipt name: exactly one wins and the name is never replaced', async () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);
      const child = writePublishChild(at);
      const barrier = join(at.base, 'publish-go');
      const first = runInBackground(child, [path, 'first writer\n', barrier]);
      const second = runInBackground(child, [path, 'second writer\n', barrier]);
      await new Promise((tick) => setTimeout(tick, 100));
      expect(existsSync(path)).toBe(false);
      writeFileSync(barrier, 'go\n');
      const [a, b] = await Promise.all([first, second]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const firstResult = JSON.parse(a.out) as { result: string };
      const secondResult = JSON.parse(b.out) as { result: string };
      const results = [firstResult.result, secondResult.result];
      expect(results.filter((result) => result === 'written')).toHaveLength(1);
      expect(results.filter((result) => result === 'exists')).toHaveLength(1);
      const winner = firstResult.result === 'written' ? 'first writer\n' : 'second writer\n';
      expect(readFileSync(path, 'utf8')).toBe(winner);
      expect(lstatSync(path).isFile()).toBe(true);
      // Neither writer's temp is left behind: the file that exists is the one that won.
      expect(readdirSync(at.dropDir).filter((name) => name.endsWith('.new'))).toEqual([]);
    } finally {
      at.cleanup();
    }
  });

  test('a temp left by a publisher that died before the link blocks nothing', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);
      const leftover = `${path}.999999.deadbeef.new`;
      writeFileSync(leftover, 'half-written receipt\n', { mode: 0o600 });

      // No shared name was published, so there is nothing to reclaim; the next reader serves the
      // one body and the leftover is left as debris, not treated as a receipt.
      expect(read(at)).toEqual({ ok: true, body: BODY });
      expect(read(at)).toMatchObject({ ok: false, served: 'already-served' });
      expect(readFileSync(leftover, 'utf8')).toBe('half-written receipt\n');
    } finally {
      at.cleanup();
    }
  });

  test('an invalid read receipt is uncertainty: no body, no rewrite, preserved', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);
      const garbage = '{ not a receipt\n';
      writeFileSync(path, garbage, { mode: 0o600 });

      const got = read(at);
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.reason).toContain('does not verify');
        expect(got.served).toBeUndefined();
      }
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(readFileSync(path, 'utf8')).toBe(garbage);
      expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(true);
    } finally {
      at.cleanup();
    }
  });

  test('a read receipt signed for another seat is uncertainty: no body, preserved', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);
      const foreign = signReceiptPayload({
        kind: 'receipt',
        status: 'read',
        id: LEAD_ID,
        to: 'worker',
        root: realpathSync(at.root),
        session: SESSION,
        at: '2026-10-20T11:30:00.000Z',
      }, at.home);
      const written = writeReceipt(at.dropDir, foreign, at.home);
      expect(written.ok).toBe(true);
      const before = readFileSync(path, 'utf8');

      const got = read(at);
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.reason).toContain('does not verify');
        expect(got.served).toBeUndefined();
      }
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      at.cleanup();
    }
  });

  test('a link at the receipt name is refused and preserved', () => {
    const at = place();
    try {
      message(at, 'lead', LEAD_ID, BODY);
      const path = receiptPath(at.dropDir, LEAD_ID);
      const elsewhere = join(at.base, 'elsewhere.read.json');
      writeFileSync(elsewhere, 'not reached\n', { mode: 0o600 });
      symlinkSync(elsewhere, path);

      const got = read(at);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.served).toBeUndefined();
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(elsewhere, 'utf8')).toBe('not reached\n');
    } finally {
      at.cleanup();
    }
  });
});
