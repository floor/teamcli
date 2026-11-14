// The owner helper's program on a machine whose accounts share one owner: one spend on stdin, one
// verdict on stdout (src/client/owner-spend.ts). `team owner-seat install` bundles this file into
// the administrator's own folder, and the system's privilege rule starts it as the helper's user.
import { readFileSync } from 'node:fs';
import { passwdNameOf, runOwnerSpend, verdictLine } from './owner-spend.ts';

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {}
const verdict = runOwnerSpend({ stdin, env: process.env, uid: process.getuid?.() ?? -1, now: new Date(), nameOf: (uid) => passwdNameOf(uid) });
process.stdout.write(verdictLine(verdict));
process.exitCode = verdict.ok ? 0 : 1;
