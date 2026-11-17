// A child for test/host/send-host-request-tmpdir.test.ts. It loads the send path's modules with
// one TMPDIR (the host's, set by the parent), then runs a hosted request whose environment names
// another. Inside the request a probe line reads the temp folder the send path would use and
// writes one temporary folder. It also walks every export of the send path's modules for a string
// that still holds the load-time TMPDIR. It prints one JSON document.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sendModule from '../../src/commands/send.ts';
import * as replyModule from '../../src/commands/reply.ts';
import * as ackModule from '../../src/commands/ack.ts';
import * as daemonModule from '../../src/send/daemon.ts';
import { runHostedLine, type HostRequest } from '../../src/host/run.ts';
import type { Io } from '../../src/io.ts';
import { updateState } from '../../src/state.ts';

const vars = process.env;
const home = vars.HOME!;
const loadTmp = tmpdir();
const requestTmp = join(home, 'request-tmp');
mkdirSync(requestTmp, { recursive: true });
const root = join(home, 'repo');
mkdirSync(join(root, '.agents'), { recursive: true });
execFileSync('git', ['init', '-q', root]);
mkdirSync(join(home, '.config', 'team'), { recursive: true });
writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: tmpdir
entity: tmpdir
session: tmpdir
coordinator: coord
operator: coord
workspace:
  mode: shared
seats:
  - role: guide
    name: coord
    label: coord
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
    leads: true
  - role: builder
    name: builder
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
`);
updateState(join(root, '.agents'), (state) => {
  state.sessions.tmpdir = { seats: { builder: { stage: 'ready', pane: 'w9:p1' }, coord: { stage: 'ready', pane: 'w8:p1' } }, worktrees: {} } as never;
});
const sources: Io['callerSources'] = () => ({
  ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
  agents: () => [{ name: 'builder', pane: 'w9:p1', agent: 'claude', workspace: 'w9', status: 'idle' as const, cwd: null }],
  paneRootPid: () => 101,
  env: { HERDR_PANE_ID: 'w9:p1' },
  stdinIsTTY: false,
});

/** Every string reachable from a module's exports (depth-bounded). A getter is skipped: it reads
 *  when it is asked, which is what the probe below checks. */
function strings(value: unknown, depth: number, seen: Set<unknown>, out: string[]): void {
  if (typeof value === 'string') { out.push(value); return; }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || depth === 0 || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value as object)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined || desc.get !== undefined) continue;
    strings(desc.value, depth - 1, seen, out);
  }
}
const held: string[] = [];
for (const [name, mod] of Object.entries({ send: sendModule, reply: replyModule, ack: ackModule, daemon: daemonModule })) {
  const out: string[] = [];
  strings(mod, 4, new Set(), out);
  for (const one of out) if (one.includes(loadTmp)) held.push(`${name}: ${one}`);
}

const env: Record<string, string> = {};
for (const [name, value] of Object.entries(vars)) if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
const own: Record<string, string | undefined> = { ...env };

let seen: { socketsDir: string; daemonSocketsDir: string; tmpdir: string; made: string } | null = null;
const probe = async (): Promise<number> => {
  seen = {
    socketsDir: sendModule.realHost.socketsDir,
    daemonSocketsDir: daemonModule.realDaemonHost.socketsDir,
    tmpdir: tmpdir(),
    made: mkdtempSync(join(tmpdir(), 'hosted-')),
  };
  return 0;
};
const request: HostRequest = { v: 1, build: 'test', argv: ['send', 'coord', 'hello', '--dry-run'], cwd: root, env: { ...env, TMPDIR: requestTmp }, tty: { stdin: false, stdout: false, stderr: false } };
const result = await runHostedLine(
  request,
  { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid },
  { main: probe, cliEntry: process.argv[1]!, ownEnv: own, callerSources: sources },
);
const after = { socketsDir: sendModule.realHost.socketsDir, tmpdir: tmpdir() };
process.stdout.write(`${JSON.stringify({ loadTmp, requestTmp, answer: result.answer, seen, after, held })}\n`);
