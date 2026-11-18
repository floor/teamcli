// E7a evidence (not a test): runs one dark-root scenario against a TeamCLI source tree and prints a normalized transcript of
// every output and every file under the root. Usage: bun dark-equiv.ts <src dir> <work dir> <home template>
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [src, work, homeTemplate] = process.argv.slice(2);
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
const files: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { files.push(`${p}/`); walk(p); } else files.push(`${p} ${readFileSync(p, 'utf8')}`); } };
walk(join(root, '.agents'));
const norm = (t: string) => t.split(root).join('ROOT').split(work).join('WORK')
  .replace(/g[0-9a-f]{16}/g, 'GEN').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'TS')
  .replace(/"signature": ?"[^"]+"/g, '"signature":"SIG"').replace(/\b\d{13}\.[0-9a-f]{12}\b/g, 'MS.NONCE')
  .replace(/"pid": ?\d+/g, "\"pid\":PID").replace(/\.\d+\.[0-9a-f]{12}\.tmp/g, '.TMP');
console.log(norm(JSON.stringify(out, null, 1)));
console.log(norm(files.join('\n')));
