// The mailbox router child. It answers a tick with a heartbeat and then waits.
// It holds no key and signs nothing: an ask is carried as a record the asking
// principal already signed.
import { readFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

const token = process.argv[2];
if (token === undefined || token === '') process.exit(1);
try {
  readFileSync(token);
  unlinkSync(token);
} catch {
  process.exit(1);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const frame = parsed as { type?: unknown; at?: unknown };
  if (frame.type === 'tick' && typeof frame.at === 'string') {
    process.stdout.write(`${JSON.stringify({ type: 'heartbeat', at: frame.at })}\n`);
  }
});
