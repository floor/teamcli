// Command modules load only after this process was started with the synthetic HOME.
// Bun keeps the HOME from process start, so a parent that sets it later is not this home.
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import type { Caller } from '../../src/caller.ts';

const [expectedHome, root, callerKind, encodedArgv] = process.argv.slice(2);
if (expectedHome === undefined || root === undefined || callerKind === undefined || encodedArgv === undefined) {
  throw new Error('child-start synthetic HOME required');
}
if (homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');

const { main } = await import('../../src/cli.ts');
const argv = JSON.parse(encodedArgv) as string[];
const caller: Caller = callerKind === 'owner'
  ? { kind: 'owner' }
  : { kind: 'seat', name: 'holder', pane: 'p1' };
let out = '';
let err = '';
const code = await main(argv, {
  stdout: (text) => { out += text; },
  stderr: (text) => { err += text; },
  cwd: realpathSync(root),
  env: { HOME: homedir() },
  stdinIsTTY: caller.kind === 'owner',
  caller,
});
console.log(JSON.stringify({ code, out, err }));
