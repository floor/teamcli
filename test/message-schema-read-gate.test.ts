// The read gate, end to end: authentication covers the complete raw payload before any body or
// receipt, and a signed field this version does not read is refused on its own ground.
//
// This file deliberately uses only the calls a reader had before the schema lane (`readMessage`,
// `signRecord`, `signDomain`), so the same file can be replayed against the earlier source: there
// an unsigned `future_authority` inserted after signing was served with its body and a read
// receipt, and a signed `future_display` was reported as a signature failure. Both are counted
// here: the body is checked absent, the receipt name is checked absent, and the folder's entry
// count is checked unchanged.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { signRecord } from '../src/send/record.ts';
import { MESSAGE_DOMAIN, messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';

const SESSION = 'acme';
const SEAT = 'lead';
const ID = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e45';
const BODY = 'the body only a verified record may expose';

type Place = { base: string; root: string; home: string; dropDir: string; cleanup(): void };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-read-gate-')));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  const dropDir = join(root, '.agents', 'send-drops', SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  return { base, root, home, dropDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function payload(at: Place, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'message',
    id: ID,
    to: SEAT,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-23T09:00:00.000Z',
    body: BODY,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: ID,
    ...extra,
  };
}

function write(at: Place, value: unknown): void {
  writeFileSync(join(at.dropDir, ID), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function read(at: Place): ReturnType<typeof readMessage> {
  return readMessage({ dropDir: at.dropDir, root: at.root, seat: SEAT, session: SESSION }, ID, at.home);
}

/** The read, with what it left behind: the rule it refused by, whether a body came back, whether
 *  a receipt was written, and how many files the drop folder gained. */
function gate(at: Place): { rule: string | undefined; body: boolean; receipt: boolean; wrote: number } {
  const before = readdirSync(at.dropDir).length;
  const got = read(at);
  return {
    rule: got.ok ? undefined : got.refusal?.rule,
    body: got.ok,
    receipt: existsSync(receiptPath(at.dropDir, ID)),
    wrote: readdirSync(at.dropDir).length - before,
  };
}

describe('the read gate authenticates the raw payload first', () => {
  test('a signed record is served, and its read receipt is published', () => {
    const at = place();
    try {
      write(at, signRecord(payload(at) as never, at.home));
      const got = read(at);
      expect(got.ok).toBe(true);
      expect(got.ok ? got.body : '').toBe(BODY);
      expect(existsSync(receiptPath(at.dropDir, ID))).toBe(true);
    } finally {
      at.cleanup();
    }
  });

  test('a field inserted after signing is refused: no body, no receipt, nothing written', () => {
    const at = place();
    try {
      const signed = JSON.parse(JSON.stringify(signRecord(payload(at) as never, at.home))) as {
        payload: Record<string, unknown>;
        signature: string;
      };
      signed.payload.future_authority = { grant: 'anything' };
      write(at, signed);
      expect(gate(at)).toEqual({ rule: 'signature', body: false, receipt: false, wrote: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('a signed future field is refused as unsupported, never as a signature failure', () => {
    const at = place();
    try {
      const future = payload(at, { future_display: { colour: 'amber' } });
      write(at, { payload: future, signature: signDomain(MESSAGE_DOMAIN, future as unknown as Json, messageKeyOf(at.home)) });
      const got = gate(at);
      expect(got).toEqual({ rule: 'unsupported', body: false, receipt: false, wrote: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('a second read after a refusal still serves the untouched record once it is restored', () => {
    const at = place();
    try {
      const signed = signRecord(payload(at) as never, at.home);
      const tampered = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      tampered.payload.body = 'rewritten';
      write(at, tampered);
      expect(gate(at)).toEqual({ rule: 'signature', body: false, receipt: false, wrote: 0 });
      // The refusal wrote nothing, so the name is still the sender's record: restoring it leaves
      // the message servable rather than spent.
      write(at, signed);
      const got = read(at);
      expect(got.ok).toBe(true);
      expect(existsSync(receiptPath(at.dropDir, ID))).toBe(true);
    } finally {
      at.cleanup();
    }
  });
});
