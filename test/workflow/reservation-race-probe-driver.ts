// A test-only driver that proves the reservation race harness: it loads, says ready, waits for
// the parent's go, appends one line, and answers in the one-JSON-line protocol. It imports no
// product module, so it stands at the pin and can be run before the reservation slices exist.
//
// Run as: bun reservation-race-probe-driver.ts <go> <ready> <command> <json-args>

import { appendFileSync } from 'node:fs';
import { reply, waitAtBarrier } from './reservation-race-fixtures.ts';

const [go, ready, command, rawArgs] = process.argv.slice(2);
if (go === undefined || ready === undefined || command === undefined) {
  reply({ ok: false, error: 'usage: <go> <ready> <command> <json-args>' });
  process.exit(2);
}

let args: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(rawArgs ?? '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
} catch {
  reply({ ok: false, error: 'the arguments are not JSON' });
  process.exit(2);
}

waitAtBarrier(go, ready);

if (command !== 'append' || typeof args.path !== 'string' || typeof args.text !== 'string') {
  reply({ ok: false, error: `unknown command ${command}` });
  process.exit(2);
}
appendFileSync(args.path, `${args.text}\n`);
reply({ ok: true, result: { text: args.text } });
