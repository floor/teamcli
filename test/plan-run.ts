// Evidence for `team plan` and `team next --wait`: the one run in this cut that reads the real
// clock and really waits. The scratch session is this file's own — created, stopped and deleted
// in the finally, never `team` or `floor` — and its pane is renamed to the seat's name and
// recorded in the state file, so the seat gate places the CLI by the pane's own pid. The rename
// is what makes the pane an agent at all; probed on this machine in a scratch session
// (2026-10-09): `agent list` on a fresh workspace answers `{"agents":[]}`, `herdr agent rename
// <pane> lead` answers an agent_info naming the pane and `"name":"lead"`, and the next
// `agent list` lists that pane with that name. The scripts below leave HOME alone on purpose:
// herdr places a named session's socket under $HOME, and probed on the same day, a pane with
// HOME set to this harness's temp dir made every named read die with `Error: Custom { kind:
// InvalidInput, error: "local socket name length exceeds capacity of sun_path of sockaddr_un"
// }` and rc 1 — a seat's own placement has a real HOME, so the harness keeps the pane's. The
// stop's shape is probed the same way: a pane
// running `bash sig.sh` whose script runs a bun child that catches SIGINT shows `^C` in the
// glass, the child's own line, `exit:0`, and the script's next line — bash continues after the
// signal, so the exit code the harness reads is the CLI's own.
// What it proves, in order: the real CLI's bytes (`plan`'s overdue mark against the real clock;
// `--help` listing `plan`); that `plan` claims nothing — the clone's file list, byte for byte,
// before and after — where `next` on the same clone writes its lease; the release of that lease
// (a live lease whose record is missing is `kept` — no second id is taken until release, so the
// wait's clone needs a seat that holds nothing); the real wait once (an
// empty list, the one answer and the waiting line, a record written after the first cadence,
// then the take); and the stop (a second wait, Ctrl-C, `stopped waiting`, exit 0). File source
// only; no network, no Keychain, no suite runs; the temp dirs go to the trash.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { emptySession, updateState } from '../src/state.ts';

const SESSION = 'plan-evidence';

const TEAM = `format: 1
project: acme
session: ${SESSION}
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
  cadence: 2s
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const TASKS = `- id: t1
  title: the urgent title
  priority: 1
  deadline: 2020-01-01T00:00:00Z
- id: t2
  title: the later title
`;

const WAITED = `- id: t2
  title: the later title
`;

function herdr(...args: string[]): string {
  return execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' }).trim();
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitReady(): void {
  const start = Date.now();
  for (;;) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'workspace', 'list'], { stdio: 'ignore' });
      return;
    } catch {
      if (Date.now() - start > 20_000) throw new Error('the scratch server did not answer');
      pause(200);
    }
  }
}

function paneId(created: string): string {
  const match = created.match(/(?:pane\s+)?(%\d+|\w+:p\d+)/);
  if (match?.[1]) return match[1];
  const listed = herdr('pane', 'list');
  const ids = [...listed.matchAll(/(?:^|\s)(%\d+|[A-Za-z0-9_-]+:p\d+)\b/g)].map((item) => item[1] as string);
  const id = ids.at(-1);
  if (!id) throw new Error(`no pane id in:\n${created}\n${listed}`);
  return id;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** The printed slice between one `--- <name> ---` marker and the next: each script echoes a
 *  marker per step, so a needle is proven in its own section and not in the neighbouring one. */
function section(glass: string, marker: string): string {
  const from = glass.indexOf(marker);
  if (from < 0) return '';
  const rest = glass.slice(from + marker.length);
  const to = rest.indexOf('--- ');
  return to < 0 ? rest : rest.slice(0, to);
}

/** The glass from the last `marker` on, '' before it has printed: the wait sections key off it
 *  so an earlier phase's identical waiting line cannot answer for this one. */
function sinceLast(glass: string, marker: string): string {
  const from = glass.lastIndexOf(marker);
  return from < 0 ? '' : glass.slice(from);
}

/** The clone's files, relative sorted paths: plan must leave this list byte for byte. */
function listing(dir: string): string {
  return execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort()
    .join('\n');
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const base = mkdtempSync(join(tmpdir(), 'team-plan-run-'));
const root = join(base, 'acme');
mkdirSync(join(root, '.agents'), { recursive: true });
git(root, 'init', '-q', '-b', 'main');
writeFileSync(join(root, 'README.md'), 'acme\n');
git(root, 'add', 'README.md');
git(root, 'commit', '-q', '-m', 'first');
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
writeFileSync(join(root, '.agents', 'tasks.yaml'), TASKS);

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
function script(name: string, lines: string[]): string {
  const path = join(base, `${name}.sh`);
  writeFileSync(path, ['#!/bin/bash', `cd ${JSON.stringify(root)} || exit 9`, ...lines].join('\n') + '\n');
  return path;
}
const aScript = script('a', [
  "echo '--- plan ---'",
  `bun ${JSON.stringify(cli)} plan`,
  'echo "exit:$?"',
  "echo '--- help ---'",
  `bun ${JSON.stringify(cli)} --help`,
  'echo "exit:$?"',
  "echo '--- a done ---'",
]);
const nScript = script('n', ["echo '--- next ---'", `bun ${JSON.stringify(cli)} next`, 'echo "exit:$?"', "echo '--- n done ---'"]);
const rScript = script('r', ["echo '--- release ---'", `bun ${JSON.stringify(cli)} next --release`, 'echo "exit:$?"', "echo '--- r done ---'"]);
const w1Script = script('w1', ["echo '--- wait ---'", `bun ${JSON.stringify(cli)} next --wait`, 'echo "exit:$?"', "echo '--- w1 done ---'"]);
const w2Script = script('w2', ["echo '--- wait2 ---'", `bun ${JSON.stringify(cli)} next --wait`, 'echo "exit:$?"', "echo '--- w2 done ---'"]);

let server: ChildProcess | undefined;
try {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  server = spawn('herdr', ['--session', SESSION, 'server'], { stdio: 'ignore' });
  waitReady();
  const pane = paneId(herdr('workspace', 'create', '--cwd', root, '--label', 'lead', '--no-focus'));
  herdr('agent', 'rename', pane, 'lead');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = { stage: 'ready', pane };
  });

  const until = (needle: string, bound: number): string => {
    const start = Date.now();
    for (;;) {
      const glass = herdr('pane', 'read', pane, '--source', 'recent', '--lines', '200');
      if (glass.includes(needle)) return glass;
      if (Date.now() - start > bound) throw new Error(`no "${needle}" within ${bound} ms in:\n${glass}`);
      pause(250);
    }
  };
  // The same poll, scoped past a marker: a later phase's identical waiting line cannot answer
  // for this one, and the marker has to have printed at all.
  const untilOwn = (marker: string, needle: string, bound: number): string => {
    const start = Date.now();
    for (;;) {
      const glass = herdr('pane', 'read', pane, '--source', 'recent', '--lines', '200');
      if (sinceLast(glass, marker).includes(needle)) return glass;
      if (Date.now() - start > bound) throw new Error(`no "${needle}" after ${marker} within ${bound} ms in:\n${glass}`);
      pause(250);
    }
  };
  const run = (path: string, done: string): string => {
    herdr('pane', 'run', pane, `bash ${JSON.stringify(path)}`);
    return until(done, 30_000);
  };

  // 1. The real CLI's bytes, on the pane whose pid the state records: plan's queue with the
  // overdue mark the real clock puts on t1, and the usage listing the command.
  const before = listing(root);
  const glassA = run(aScript, '--- a done ---');
  console.log('--- plan glass ---');
  console.log(glassA);
  const planSec = section(glassA, '--- plan ---');
  const helpSec = section(glassA, '--- help ---');
  check(planSec.includes('  1     overdue  -      the urgent title\n'), `plan did not mark t1 overdue:\n${planSec}`);
  check(planSec.includes('  2     open     -      the later title\n'), `plan did not list t2:\n${planSec}`);
  check(planSec.indexOf('the urgent title') < planSec.indexOf('the later title'), 'plan did not put the prioritised record first');
  check(planSec.includes('exit:0'), `plan did not exit 0:\n${planSec}`);
  check(/\bplan\b/.test(helpSec), `--help did not list plan:\n${helpSec}`);
  check(helpSec.includes('exit:0'), `--help did not exit 0:\n${helpSec}`);

  // plan claims nothing: the clone's files, byte for byte, are the same after it.
  const after = listing(root);
  console.log('--- claims-nothing ---');
  console.log(after);
  check(before === after, `plan changed the clone's files:\nbefore:\n${before}\nafter:\n${after}`);
  check(!existsSync(join(root, '.agents', 'leases')), 'plan wrote a leases directory');

  // 2. The contrast: next on the same clone writes its lease and prints the queue's first record,
  // its deadline unmarked — the reads are plan's, the claim is next's own.
  const glassN = run(nScript, '--- n done ---');
  console.log('--- next glass ---');
  console.log(glassN);
  const nextSec = section(glassN, '--- next ---');
  check(nextSec.includes('team acme, session "plan-evidence"\n'), `next printed no context line:\n${nextSec}`);
  check(nextSec.includes('t1  the urgent title\n  priority: 1\n  deadline: 2020-01-01T00:00:00Z\n'), `next did not print t1 with its unmarked deadline:\n${nextSec}`);
  check(nextSec.includes('team next: claimed t1\n'), `next printed no closing summary line:\n${nextSec}`);
  check(!nextSec.includes('(overdue)'), `next's bytes gained the plan mark:\n${nextSec}`);
  check(nextSec.includes('exit:0'), `next did not exit 0:\n${nextSec}`);
  check(existsSync(join(root, '.agents', 'leases', 't1.json')), 'next wrote no lease');

  // 3. The seat frees itself first: a live lease whose record is missing is `kept` — the seat
  // takes no second id until release (src/tasks/lease.ts), and phase 2 left exactly such a
  // lease. Released, the seat holds nothing, and the wait below starts clean.
  const glassR = run(rScript, '--- r done ---');
  console.log('--- release glass ---');
  console.log(glassR);
  const rSec = section(glassR, '--- release ---');
  check(rSec.includes('team next: released t1'), `the release did not name t1:\n${rSec}`);
  check(rSec.includes('exit:0'), `the release did not exit 0:\n${rSec}`);
  check(!existsSync(join(root, '.agents', 'leases', 't1.json')), 'the release left t1\'s lease');

  // 4. The real wait, once, in real time: an empty list, the one answer, the waiting line; the
  // probe writes a record after the first cadence has elapsed; the next poll takes it.
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '[]\n');
  herdr('pane', 'run', pane, `bash ${JSON.stringify(w1Script)}`);
  const opened = untilOwn('--- wait ---', 'team next: waiting every 2s', 15_000);
  check(sinceLast(opened, '--- wait ---').includes('team next: nothing is takeable'), `the wait's first answer was not the shipped one:\n${opened}`);
  pause(2_300);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), WAITED);
  const glassW1 = until('--- w1 done ---', 30_000);
  console.log('--- wait glass ---');
  console.log(glassW1);
  const w1Sec = section(glassW1, '--- wait ---');
  const w1Count = (w1Sec.match(/team next: nothing is takeable/g) ?? []).length;
  check(w1Count === 1, `the empty answer printed ${w1Count} times, not once:\n${w1Sec}`);
  const w1Answer = w1Sec.indexOf('nothing is takeable');
  const w1Line = w1Sec.indexOf('waiting every 2s');
  const w1Take = w1Sec.indexOf('t2  the later title');
  check(w1Answer < w1Line && w1Line < w1Take, `the wait's bytes are out of order:\n${w1Sec}`);
  check(w1Sec.includes('team next: claimed t2\n'), `the wait's take printed no closing summary line:\n${w1Sec}`);
  // The context line opens the run once, with the wait's first answer, and never again.
  const w1Context = (w1Sec.match(/team acme, session "plan-evidence"/g) ?? []).length;
  check(w1Context === 1, `the context line printed ${w1Context} times, not once:\n${w1Sec}`);
  check(w1Sec.includes('exit:0'), `the wait did not exit 0 after the take:\n${w1Sec}`);
  check(existsSync(join(root, '.agents', 'leases', 't2.json')), 'the wait took no lease');

  // 5. The stop: a second wait on an empty list, Ctrl-C to the pane, `stopped waiting`, exit 0.
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '[]\n');
  herdr('pane', 'run', pane, `bash ${JSON.stringify(w2Script)}`);
  untilOwn('--- wait2 ---', 'team next: waiting every 2s', 15_000);
  pause(700);
  herdr('pane', 'send-keys', pane, 'c-c');
  const glassW2 = until('--- w2 done ---', 30_000);
  console.log('--- stop glass ---');
  console.log(glassW2);
  const w2Sec = section(glassW2, '--- wait2 ---');
  const w2Count = (w2Sec.match(/team next: nothing is takeable/g) ?? []).length;
  check(w2Count === 1, `the second wait's answer printed ${w2Count} times, not once:\n${w2Sec}`);
  check(w2Sec.includes('team next: waiting every 2s'), `the second wait printed no waiting line:\n${w2Sec}`);
  check(w2Sec.includes('team next: stopped waiting'), `the stop line did not print:\n${w2Sec}`);
  check(w2Sec.includes('exit:0'), `the stop did not exit 0:\n${w2Sec}`);
  console.log('--- evidence ok ---');
} finally {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* already stopped */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { server?.kill(); } catch { /* the session stop owns the process */ }
  try { execFileSync('/usr/bin/trash', [base], { stdio: 'ignore' }); } catch { /* the dir is left if trash refuses it */ }
}
