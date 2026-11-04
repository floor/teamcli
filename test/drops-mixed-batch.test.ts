// `team drops --read` over a mixed batch: a waiting record whose receipt name an unverifying
// file holds, beside records this run can serve. The valid records must still be served and
// receipted, the occupied entry and its receipt must be left exactly as they were, the refused
// body must never be printed — and the turn must be told, per message, which waiting record it
// could not read. `team messages` reports the same item as a refused row with a repair line; the
// launch read reports record refusals to the owner as bus events, but an occupied receipt name is
// neither: at this pin it is dropped with no line, no event and no non-success exit whenever
// another body was served, and on a folder with nothing servable only the newest refusal is said.
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { listUnread, receiptPath } from '../src/mcp/inbox.ts';
import { signReceiptPayload, writeReceipt, type ReceiptPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const OCCUPIED = '0a5b7c1d-8e2f-4a6b-9c3d-1e2f3a4b5c6d';
const SECOND_OCCUPIED = '2c7d9e3f-a041-4c8d-9e5f-3a4b5c6d7e8f';
const SERVED = '1b6c8d2e-9f30-4b7c-8d4e-2f3a4b5c6d7e';

let base: string;
let root: string;
let home: string;
let dropDir: string;

function world(): void {
  base = mkdtempSync(join(tmpdir(), 'team-drops-mixed-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  dropDir = join(root, '.agents', 'send-drops', 'acme', 'lead');
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runDrops(argv, io, { home });
  return { code, out: io.out, err: io.err };
}

function read(): Promise<{ code: number; out: string; err: string }> {
  return run(['--read', '--seat', 'lead', '--session', 'acme']);
}

function receiptOf(id: string): string {
  return receiptPath(dropDir, id);
}

/** A receipt signed by another message key: an earlier build's receipt, which this checkout's key
 *  cannot verify. The payload binds this message, so the only thing wrong with it is the key. */
function oldKeyReceipt(id: string): string {
  const oldHome = join(base, 'old-home');
  mkdirSync(oldHome, { recursive: true });
  messageKeyOf(oldHome);
  const payload: ReceiptPayload = {
    kind: 'receipt', status: 'read', id, to: 'lead', root, session: 'acme', at: '2026-10-04T09:30:00.000Z',
  };
  const written = writeReceipt(dropDir, signReceiptPayload(payload, oldHome), home);
  if (!written.ok) throw new Error(written.reason);
  return receiptOf(id);
}

function snapshot(path: string): string {
  return readFileSync(path, 'utf8');
}

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team drops --read over a mixed valid and unverifiable batch', () => {
  test('a mixed batch serves the valid record, leaves the occupied receipt and drop as they were, and names the message it could not read', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the occupied body', { at: '2026-10-04T09:00:00.000Z' });
    plantRecord(home, root, 'acme', 'lead', SERVED, 'the served body', { at: '2026-10-04T10:00:00.000Z' });
    const at = receiptOf(OCCUPIED);
    writeFileSync(at, 'a file that is not a receipt\n');
    const before = snapshot(at);

    const result = await read();

    // Existing contract, kept: a batch with a body in it serves the turn and exits 0.
    expect(result.code).toBe(0);
    expect(result.out).toBe('[attributed sender: lead]\n\nthe served body\n');
    // Invariants first: no body reaches the turn, and the uncertain entry is never rewritten.
    expect(result.out + result.err).not.toContain('the occupied body');
    expect(snapshot(at)).toBe(before);
    expect(existsSync(join(dropDir, OCCUPIED))).toBe(true);
    // The record that verified is receipted; the occupied one still waits for the next turn.
    expect(existsSync(receiptOf(SERVED))).toBe(true);
    expect(listUnread(dropDir, { to: 'lead', root, session: 'acme' }, home).map((message) => message.id)).toEqual([
      OCCUPIED,
    ]);
    // The turn is told which waiting message it could not read, in the inbox's own words and
    // never the record's content.
    expect(result.err).toContain(OCCUPIED);
    expect(result.err).toMatch(/read receipt name is held by a file that does not verify/);
  });

  test('an occupied replied receipt is named per item in a mixed batch too', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the occupied body', { at: '2026-10-04T09:00:00.000Z' });
    plantRecord(home, root, 'acme', 'lead', SERVED, 'the served body', { at: '2026-10-04T10:00:00.000Z' });
    const at = join(dropDir, `${OCCUPIED}.replied.json`);
    writeFileSync(at, 'a file that is not a receipt\n');
    const before = snapshot(at);

    const result = await read();

    expect(result.code).toBe(0);
    expect(result.out).toBe('[attributed sender: lead]\n\nthe served body\n');
    expect(result.out + result.err).not.toContain('the occupied body');
    expect(snapshot(at)).toBe(before);
    expect(existsSync(join(dropDir, OCCUPIED))).toBe(true);
    expect(result.err).toContain(OCCUPIED);
    expect(result.err).toMatch(/replied receipt name is held by a file that does not verify/);
  });

  test('a receipt signed under a previous message key is reported per item, kept, and never served', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the occupied body', { at: '2026-10-04T09:00:00.000Z' });
    plantRecord(home, root, 'acme', 'lead', SERVED, 'the served body', { at: '2026-10-04T10:00:00.000Z' });
    const at = oldKeyReceipt(OCCUPIED);
    const before = snapshot(at);

    const result = await read();

    expect(result.code).toBe(0);
    expect(result.out).toBe('[attributed sender: lead]\n\nthe served body\n');
    expect(result.out + result.err).not.toContain('the occupied body');
    expect(snapshot(at)).toBe(before);
    expect(result.err).toContain(OCCUPIED);
    expect(result.err).toMatch(/read receipt name is held by a file that does not verify/);
  });

  test('a batch with no servable record reports every refused message, not only the newest', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the first occupied body', { at: '2026-10-04T09:00:00.000Z' });
    plantRecord(home, root, 'acme', 'lead', SECOND_OCCUPIED, 'the second occupied body', { at: '2026-10-04T10:00:00.000Z' });
    const first = receiptOf(OCCUPIED);
    const second = receiptOf(SECOND_OCCUPIED);
    writeFileSync(first, 'not a receipt either\n');
    writeFileSync(second, 'not a receipt at all\n');
    const beforeFirst = snapshot(first);
    const beforeSecond = snapshot(second);

    const result = await read();

    // Existing contract, kept: nothing was served, so the read is a refusal, and no body leaks.
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.out + result.err).not.toContain('the first occupied body');
    expect(result.out + result.err).not.toContain('the second occupied body');
    expect(snapshot(first)).toBe(beforeFirst);
    expect(snapshot(second)).toBe(beforeSecond);
    // Both waiting messages are the turn's business: each is named, not just the newest.
    expect(result.err).toContain(OCCUPIED);
    expect(result.err).toContain(SECOND_OCCUPIED);
  });

  test('the order does not matter: an occupied newest record beside an older valid one is named too', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the occupied body', { at: '2026-10-04T10:00:00.000Z' });
    plantRecord(home, root, 'acme', 'lead', SERVED, 'the served body', { at: '2026-10-04T09:00:00.000Z' });
    const at = receiptOf(OCCUPIED);
    writeFileSync(at, 'not a receipt\n');
    const before = snapshot(at);

    const result = await read();

    expect(result.code).toBe(0);
    expect(result.out).toBe('[attributed sender: lead]\n\nthe served body\n');
    expect(result.out + result.err).not.toContain('the occupied body');
    expect(snapshot(at)).toBe(before);
    expect(existsSync(receiptOf(SERVED))).toBe(true);
    expect(result.err).toContain(OCCUPIED);
    expect(result.err).toMatch(/read receipt name is held by a file that does not verify/);
  });

  test('a lone refused message keeps the read’s single refusal line, exit 1', async () => {
    world();
    plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'the occupied body', { at: '2026-10-04T09:00:00.000Z' });
    writeFileSync(receiptOf(OCCUPIED), 'not a receipt\n');

    const result = await read();

    expect(result).toEqual({
      code: 1,
      out: '',
      err: `team drops: the read receipt name is held by a file that does not verify for message ${JSON.stringify(OCCUPIED)}\n`,
    });
  });

  test('a bad signature beside a valid record keeps its existing report: owner event, no turn line, exit 0', async () => {
    world();
    const at = plantRecord(home, root, 'acme', 'lead', OCCUPIED, 'tampered after signing', {
      at: '2026-10-04T10:00:00.000Z',
    });
    const record = JSON.parse(readFileSync(at, 'utf8')) as { signature: string };
    record.signature = 'not-this-key';
    writeFileSync(at, `${JSON.stringify(record)}\n`);
    plantRecord(home, root, 'acme', 'lead', SERVED, 'the served body', { at: '2026-10-04T09:00:00.000Z' });

    const result = await read();

    expect(result.code).toBe(0);
    expect(result.out).toBe('[attributed sender: lead]\n\nthe served body\n');
    expect(result.err).toBe('');
    expect(existsSync(receiptOf(OCCUPIED))).toBe(false);
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({ rule: 'signature', seat: 'lead', subject: OCCUPIED });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain('tampered after signing');
  });
});
