// Synthetic dev receipt schemas against the release reader and its publication paths.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { runMessages } from '../src/commands/messages.ts';
import type { Io } from '../src/io.ts';
import { updateState } from '../src/state.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { isRead, signedReceiptOf, verifyReceipt } from '../src/send/record.ts';
import { messageKeyOf, MESSAGE_DOMAIN, RECEIPT_DOMAIN, signDomain, verifyDomain, type Json } from '../src/store/keys.ts';
import { version } from '../src/version.ts';

const ID = 'ec4dcb69-352b-484f-a44c-7b537176d410';
const GOOD = 'b16f0c6b-6a96-42b4-9e8b-260bad2f5110';
const EPOCH = 'run_123456abcdef';
const bases: string[] = [];
afterEach(() => { for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true }); });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-release-receipts-independent-')));
  bases.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'ready' as const, pane: 'pane-lead' } },
    } as never;
  });
  const key = messageKeyOf(home);
  const target = { root, dropDir, seat: 'lead', session: 'acme' };
  const context = { root, to: 'lead', session: 'acme' };
  const receiptPath = join(dropDir, ID + '.read.json');
  function message(id = ID, subject = true, at = '2026-10-27T08:31:00.000Z', body = 'Synthetic spent body.') {
    const payload = {
      kind: 'message', id, to: 'lead', to_id: null, root, session: 'acme', at, body,
      from: 'worker', from_id: null, rule: 'a synthetic worker to its lead', thread: id,
      ...(subject ? { subject: 'Synthetic subject' } : {}),
    };
    writeFileSync(join(dropDir, id), JSON.stringify({ payload, signature: signDomain(MESSAGE_DOMAIN, payload, key) }), { mode: 0o600 });
  }
  function receipt(extra: Record<string, Json> = {}) {
    const payload = { kind: 'receipt', status: 'read', id: ID, to: 'lead', root, session: 'acme', at: '2026-10-23T08:00:00.000Z', ...extra };
    const raw = { payload, signature: signDomain(RECEIPT_DOMAIN, payload, key) };
    writeFileSync(receiptPath, JSON.stringify(raw), { mode: 0o600 });
    return raw;
  }
  function io() {
    let out = '', err = '';
    const value: Io = { cwd: root, env: {}, stdinIsTTY: false, caller: { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' }, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } };
    return { value, out: () => out, err: () => err };
  }
  const publication = { dropDir, id: ID, to: 'lead', root, session: 'acme', home, key, at: '2026-10-27T08:32:00.000Z' };
  return { root, home, dropDir, key, target, context, receiptPath, message, receipt, io, publication };
}

describe('independent release reader compatibility with dev writer receipts', () => {
  for (const writerVersion of ['0.5.5-dev.workflow.55560ecb0', '0.5.5-dev.workflow.5ed2950eb']) {
    for (const subject of [false, true]) {
      for (const epoch of [undefined, EPOCH]) {
        test(`${writerVersion}, subject=${subject}, epoch=${epoch !== undefined}: valid spent receipt is accepted unchanged`, () => {
          const at = fixture();
          at.message(ID, subject);
          const raw = at.receipt({ writer: { version: writerVersion, pid: 12345, ...(epoch === undefined ? {} : { epoch }) } });
          const before = readFileSync(at.receiptPath, 'utf8');
          expect(verifyDomain(RECEIPT_DOMAIN, raw.payload, raw.signature, at.key)).toBe(true);
          const projected = signedReceiptOf(raw);
          expect(projected).not.toBeNull();
          if (projected === null) throw new Error('synthetic dev receipt did not parse');
          expect(verifyReceipt(projected, at.key)).toBe(true);
          expect(isRead(at.dropDir, ID, at.context, at.key)).toBe(true);
          expect(listUnread(at.dropDir, at.context, at.home).some((row) => row.id === ID)).toBe(false);
          expect(readMessage(at.target, ID, at.home)).toMatchObject({ ok: false, served: 'already-served' });
          expect(publishRecordRead(at.publication)).toEqual({ kind: 'served' });
          expect(readFileSync(at.receiptPath, 'utf8')).toBe(before);
        });
      }
    }
  }

  test('release publication signs its process provenance and explicit runtime epoch', () => {
    const at = fixture();
    at.message();
    const input = { ...at.publication, epoch: EPOCH };
    expect(publishRecordRead(input)).toEqual({ kind: 'published' });
    const raw = JSON.parse(readFileSync(at.receiptPath, 'utf8'));
    expect(raw.payload.writer).toEqual({ version: version(), pid: process.pid, epoch: EPOCH });
    const parsed = signedReceiptOf(raw);
    expect(parsed !== null && verifyReceipt(parsed, at.key)).toBe(true);
    const before = readFileSync(at.receiptPath, 'utf8');
    expect(publishRecordRead(input)).toEqual({ kind: 'served' });
    expect(readFileSync(at.receiptPath, 'utf8')).toBe(before);
  });
});

describe('independent release manual batch boundaries', () => {
  for (const fresh of [false, true]) {
    test(`drops preserves a wrong-binding receipt and ${fresh ? 'continues to fresh mail' : 'refuses when nothing is serveable'}`, async () => {
      const at = fixture();
      at.message();
      at.receipt({ to: 'synthetic-other-recipient' });
      if (fresh) at.message(GOOD, true, '2026-10-27T08:30:00.000Z', 'Synthetic fresh body.');
      const before = readFileSync(at.receiptPath, 'utf8');
      const io = at.io();
      const result = await runDrops(['--read', '--seat', 'lead', '--session', 'acme'], io.value, { home: at.home, poll: async () => false });
      expect(result).toBe(fresh ? 0 : 1);
      expect(io.out()).not.toContain('Synthetic spent body.');
      if (fresh) expect(io.out()).toContain('Synthetic fresh body.');
      else expect(io.err()).toContain('read receipt name is held');
      expect(readFileSync(at.receiptPath, 'utf8')).toBe(before);
    });
  }

  test('messages reports the refused item alongside a serveable item', async () => {
    const at = fixture();
    at.message();
    at.receipt({ to: 'synthetic-other-recipient' });
    at.message(GOOD, true, '2026-10-27T08:30:00.000Z', 'Synthetic fresh body.');
    const before = readFileSync(at.receiptPath, 'utf8');
    const io = at.io();
    const result = await runMessages(['--json'], io.value, { home: at.home, now: () => new Date('2026-10-27T09:00:00.000Z') });
    expect(result).toBe(1);
    const doc = JSON.parse(io.out());
    expect(doc.counts).toMatchObject({ shown: 1, refused: 1 });
    expect(io.out()).not.toContain('Synthetic spent body.');
    expect(io.out()).toContain('Synthetic fresh body.');
    expect(readFileSync(at.receiptPath, 'utf8')).toBe(before);
  });
});
