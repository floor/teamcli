// A child for test/host/send-host-parity.test.ts. It runs in a temporary HOME (so the modules'
// load-time home is the scene's), builds one team in a git checkout under it, then runs each line
// twice: through the CLI's own `main` in this process (the in-process path), and through the warm
// send host's runner (`runHostedLine`), in the order it is told. Both see the same placement
// sources. It prints one JSON document: each line's two outcomes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { holdGitRoots } from '../../src/file/load.ts';
import { runHostedLine, type HostRequest } from '../../src/host/run.ts';
import type { Io } from '../../src/io.ts';
import { updateState } from '../../src/state.ts';

const order = process.argv[2] === 'hosted-first' ? 'hosted-first' : 'direct-first';
const home = process.env.HOME!;
const root = join(home, 'repo');
mkdirSync(join(root, '.agents'), { recursive: true });
execFileSync('git', ['init', '-q', root]);
mkdirSync(join(home, '.config', 'team'), { recursive: true });
writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: parity
entity: parity
session: parity
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
  state.sessions.parity = { seats: { builder: { stage: 'ready', pane: 'w9:p1' }, coord: { stage: 'ready', pane: 'w8:p1' } }, worktrees: {} } as never;
});

const sources: Io['callerSources'] = () => ({
  ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
  agents: () => [{ name: 'builder', pane: 'w9:p1', agent: 'claude', workspace: 'w9', status: 'idle' as const, cwd: null }],
  paneRootPid: () => 101,
  env: { HERDR_PANE_ID: 'w9:p1' },
  stdinIsTTY: false,
});

const LINES: string[][] = [
  ['send', 'coord', 'hello', '--dry-run'],
  ['send', 'coord', 'hello', '--dry-run', '--json'],
  ['send', 'nobody', 'hello', '--dry-run'],
  ['send', 'builder', 'hello', '--dry-run'],
  ['send', 'coord', '--file', 'missing.txt', '--dry-run'],
  ['reply', '00000000', 'x'],
  ['ack', '00000000'],
];

const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
// Same environment the warm process holds; GIT_* from the parent shell are not the scene's.
for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
const own: Record<string, string | undefined> = { ...env };
const release = holdGitRoots();

async function direct(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: root, env: { ...env }, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, callerSources: sources };
  const prior = process.cwd();
  process.chdir(root);
  try {
    const code = await main([...argv], io);
    return { kind: 'ran', code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.chdir(prior);
  }
}

async function hosted(argv: string[]) {
  const request: HostRequest = { v: 1, build: 'test', argv, cwd: root, env: { ...env }, tty: { stdin: false, stdout: false, stderr: false } };
  const peer = { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid };
  const result = await runHostedLine(request, peer, { main, cliEntry: process.argv[1]!, ownEnv: own, callerSources: sources });
  return result.answer;
}

const results: { argv: string[]; direct: unknown; hosted: unknown }[] = [];
for (const argv of LINES) {
  if (order === 'direct-first') {
    const d = await direct(argv);
    const h = await hosted(argv);
    results.push({ argv, direct: d, hosted: h });
  } else {
    const h = await hosted(argv);
    const d = await direct(argv);
    results.push({ argv, direct: d, hosted: h });
  }
}
// The environment the warm modules cannot honour: a request with another HOME or TMPDIR is
// handed back, and the matching one after it still runs as in-process.
const otherHome = await runHostedLine(
  { v: 1, build: 'test', argv: LINES[0]!, cwd: root, env: { ...env, HOME: join(home, 'elsewhere') }, tty: { stdin: false, stdout: false, stderr: false } },
  { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid },
  { main, cliEntry: process.argv[1]!, ownEnv: own, callerSources: sources },
);
const otherTmp = await runHostedLine(
  { v: 1, build: 'test', argv: LINES[0]!, cwd: root, env: { ...env, TMPDIR: join(home, 'tmp-elsewhere') }, tty: { stdin: false, stdout: false, stderr: false } },
  { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid },
  { main, cliEntry: process.argv[1]!, ownEnv: own, callerSources: sources },
);
const after = { direct: await direct(LINES[0]!), hosted: await hosted(LINES[0]!) };
release();
process.stdout.write(`${JSON.stringify({ results, otherHome: otherHome.answer, otherTmp: otherTmp.answer, after })}\n`);
