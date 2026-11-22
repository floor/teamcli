// E7a evidence (not a test): runs one dark-root scenario against a TeamCLI source tree and prints a normalized transcript of
// every output and every file under the root. Usage: bun dark-equiv.ts <src dir> <work dir> <home template> [contention]
// `contention` (E7b R6 gate) adds a held queue lock, a pending marker, its reuse by a second
// contention, a poisoned journal and the drain that follows, all on the dark root.
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [src, work, homeTemplate, mode] = process.argv.slice(2);
if (src === undefined || work === undefined || homeTemplate === undefined) throw new Error('usage: bun scripts/e7a-dark-equivalence.ts <src dir> <work dir> <home template>');
const root = join(work, 'project'); const home = join(work, 'home');
mkdirSync(join(root, '.agents'), { recursive: true }); cpSync(homeTemplate, home, { recursive: true });
const { signRecord } = await import(`${src}/send/record.ts`);
const { appendDeliverySync } = await import(`${src}/queue/append.ts`);
const { listUnread, readMessage } = await import(`${src}/mcp/inbox.ts`);
const { exposeBody } = await import(`${src}/queue/exposure.ts`);
const { shadowQueueReceipt, drainPendingReceipts } = await import(`${src}/queue/receipt-store.ts`);
const { floorState } = await import(`${src}/queue/floor.ts`);
const S = 'acme'; const dropDir = join(root, '.agents', 'send-drops', S, 'lead'); mkdirSync(dropDir, { recursive: true, mode: 0o700 });
const out: unknown[] = [];
const ids = ['7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e01', '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e02', '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e03'];
const ats = ['2026-11-18T00:00:03.000Z', '2026-11-18T00:00:01.000Z', '2026-11-18T00:00:02.000Z'];
ids.forEach((id, i) => {
  const record = signRecord({ kind: 'message', id, to: 'lead', to_id: null, root, session: S, at: ats[i], body: `body ${i}`, from: 'worker', from_id: null, rule: 'the owner', thread: id }, home);
  out.push(['append', appendDeliverySync({ dropDir, record }, () => { writeFileSync(join(dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); return { ok: true, value: true }; }, { home }).queue.kind]);
});
const ctx = { to: 'lead', root, session: S, lead: 'lead' };
out.push(['floor', floorState(root, home).kind]);
out.push(['listUnread', listUnread(dropDir, ctx, home)]);
out.push(['exposeBody', exposeBody({ dropDir, root, session: S, seat: 'lead', msgId: ids[0] }, 'channel', home).kind]);
const read = readMessage({ dropDir, root, seat: 'lead', session: S }, ids[1], home);
out.push(['readMessage', read.ok, read.ok ? read.body : read]);
out.push(['shadow', shadowQueueReceipt({ dropDir, root, session: S, seat: 'lead', msgId: ids[1], kind: 'read', actor: { kind: 'recipient', name: 'lead' }, home })]);
out.push(['drain', drainPendingReceipts(dropDir, home)]);
out.push(['listUnread2', listUnread(dropDir, ctx, home)]);
if (mode === 'contention') {
  const { acquireLockAt } = await import(`${src}/launch/seat-lock.ts`);
  const { queueBaseOf } = await import(`${src}/queue/append.ts`);
  const base = queueBaseOf(dropDir) as string;
  const receipt = { dropDir, root, session: S, seat: 'lead', msgId: ids[2], kind: 'read', actor: { kind: 'recipient', name: 'lead' }, home };
  const lock = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
  out.push(['held-lock', 'release' in lock]);
  out.push(['held-shadow', shadowQueueReceipt(receipt)]);
  out.push(['held-shadow-reuse', shadowQueueReceipt(receipt)]);
  if ('release' in lock) lock.release();
  const generation = readdirSync(base).find((name) => /^g[0-9a-f]{16}$/.test(name));
  if (generation !== undefined) writeFileSync(join(base, generation, 'poisoned'), 'TS\n', { mode: 0o600 });
  out.push(['poisoned-append', appendDeliverySync({ dropDir, record: signRecord({ kind: 'message', id: '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e04', to: 'lead', to_id: null, root, session: S, at: '2026-11-18T00:00:04.000Z', body: 'body 4', from: 'worker', from_id: null, rule: 'the owner', thread: '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e04' }, home) }, () => ({ ok: true, value: true }), { home }).queue.kind]);
  out.push(['drain-after', drainPendingReceipts(dropDir, home)]);
  out.push(['listUnread3', listUnread(dropDir, ctx, home)]);
}
const files: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { files.push(`${p}/`); walk(p); } else files.push(`${p} ${readFileSync(p, 'utf8')}`); } };
walk(join(root, '.agents'));
const norm = (t: string) => t.split(root).join('ROOT').split(work).join('WORK')
  .replace(/g[0-9a-f]{16}/g, 'GEN').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'TS')
  .replace(/"signature": ?"[^"]+"/g, '"signature":"SIG"').replace(/"record_digest": ?"[0-9a-f]{64}"/g, '"record_digest":"DIGEST"').replace(/\b\d{13}\.[0-9a-f]{12}\b/g, 'MS.NONCE')
  .replace(/"pid": ?\d+/g, "\"pid\":PID").replace(/\.\d+\.[0-9a-f]{12}\.tmp/g, '.TMP');
console.log(norm(JSON.stringify(out, null, 1)));
console.log(norm(files.join('\n')));
