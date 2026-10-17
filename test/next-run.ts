// Evidence for `team next` and `team plan`. The scratch session's panes are shells. Recording an
// agent needs `paneRun` of the seat's CLI the way `team up` launches one, and this harness does
// not start a composer. It attempts that recording — two panes, a pane run, the agent list —
// quotes the refusal, and only then plans and claims in process. The scratch session could not
// record an agent: both commands run in the panes and each refuses a caller that is no seat of
// the team, and the in-process section runs them as seats whose panes the state file records —
// the claim, the second seat's "nothing is takeable", the plan that still lists the held record,
// the renewal, and the linked-worktree lease path.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { runNext } from '../src/commands/next.ts';
import { runPlan } from '../src/commands/plan.ts';
import { findRoot } from '../src/file/load.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const SESSION = 'next-evidence';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const LIST = `- id: m1
  title: the task title
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

/** The printed slice between one `--- <name> ---` marker and the next: each pane run echoes a
 *  marker per step, so a needle is proven in its own section and not in the neighbouring one. */
function section(glass: string, marker: string): string {
  const from = glass.indexOf(marker);
  if (from < 0) return '';
  const rest = glass.slice(from + marker.length);
  const to = rest.indexOf('--- ');
  return to < 0 ? rest : rest.slice(0, to);
}

const base = mkdtempSync(join(tmpdir(), 'team-next-run-'));
const root = join(base, 'acme');
const home = join(base, 'home');
mkdirSync(join(root, '.agents'), { recursive: true });
mkdirSync(home);
git(root, 'init', '-q', '-b', 'main');
writeFileSync(join(root, 'README.md'), 'acme\n');
git(root, 'add', 'README.md');
git(root, 'commit', '-q', '-m', 'first');
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
writeFileSync(join(root, '.agents', 'tasks.yaml'), LIST);
const worktree = join(base, 'wt');
git(root, 'worktree', 'add', '-q', worktree, '-b', 'task');
const checkout = findRoot(root);
if (!checkout) throw new Error('the evidence checkout has no root');

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const script = join(base, 'run.sh');
writeFileSync(script, `#!/bin/bash
cd ${JSON.stringify(root)} || exit 9
export HOME=${JSON.stringify(home)}
echo '--- plan ---'
bun ${JSON.stringify(cli)} plan
echo "exit:$?"
echo '--- next ---'
bun ${JSON.stringify(cli)} next
echo "exit:$?"
echo '--- done ---'
`);

let server: ChildProcess | undefined;
try {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  server = spawn('herdr', ['--session', SESSION, 'server'], { stdio: 'ignore' });
  waitReady();
  const panes: { name: string; pane: string; glass: string }[] = [];
  for (const name of ['lead', 'worker']) {
    const created = herdr('workspace', 'create', '--cwd', root, '--label', name, '--no-focus');
    const pane = paneId(created);
    // The recording attempt. A vendor CLI is not started: that would be a composer.
    herdr('pane', 'run', pane, 'true');
    panes.push({ name, pane, glass: '' });
  }
  const agents = herdr('agent', 'list');
  console.log('--- agents ---');
  console.log(agents);
  for (const seat of panes) {
    herdr('pane', 'run', seat.pane, `bash ${JSON.stringify(script)}`);
    const start = Date.now();
    let glass = '';
    while (Date.now() - start < 30_000) {
      glass = herdr('pane', 'read', seat.pane, '--source', 'recent', '--lines', '80');
      if (glass.includes('--- done ---')) break;
      pause(300);
    }
    seat.glass = glass;
    console.log(`--- ${seat.name} ---`);
    console.log(glass);
    // The caller this pane runs as is no seat of the team: both commands refuse it the same way,
    // each in its own echoed section.
    const planned = section(glass, '--- plan ---');
    if (!planned.includes('team plan: only a seat of this team pulls a task')) throw new Error(`${seat.name}: plan did not refuse the caller`);
    if (!planned.includes('exit:1')) throw new Error(`${seat.name}: plan did not exit 1`);
    const nexted = section(glass, '--- next ---');
    if (!nexted.includes('only a seat of this team pulls a task')) throw new Error(`${seat.name}: next did not refuse the caller`);
    if (!nexted.includes('exit:1')) throw new Error(`${seat.name}: next did not exit 1`);
  }
  if (existsSync(join(checkout, '.agents', 'leases'))) throw new Error('the pane wrote a lease');

  updateState(join(checkout, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: panes[0]?.pane ?? '' };
    session.seats.worker = { stage: 'ready', pane: panes[1]?.pane ?? '' };
  });
  const lead = panes[0];
  const other = panes[1];
  if (!lead || !other) throw new Error('the two panes were not created');

  let clock = Date.parse('2026-10-08T09:00:00.000Z');
  const claim = async (name: string, pane: string, cwd: string, argv: string[] = []) => {
    const io = testIo(cwd, { kind: 'seat', name, pane, session: 'acme' });
    const code = await runNext(argv, io, { home, now: () => clock });
    return { code, out: io.out, err: io.err };
  };
  const claimed = await claim('lead', lead.pane, worktree);
  console.log('--- claim ---');
  console.log(JSON.stringify(claimed));
  // The claim's answer: the context line, the record's block, and the closing summary line.
  const claimedOut = 'team acme, session "acme"\nm1  the task title\nteam next: claimed m1\n';
  if (claimed.code !== 0 || claimed.out !== claimedOut) throw new Error(`claim: ${claimed.out}`);
  const leasePath = join(checkout, '.agents', 'leases', 'm1.json');
  const written = JSON.parse(readFileSync(leasePath, 'utf8')) as { seat: string; pane: string; until: string; acquiredAt: string };
  console.log('--- lease ---');
  console.log(JSON.stringify(written));
  if (written.seat !== 'lead' || written.pane !== lead.pane) throw new Error('the lease does not name the seat and pane');
  if (existsSync(join(worktree, '.agents', 'leases', 'm1.json'))) throw new Error('the lease was written in the linked worktree');

  const planOf = async (name: string, pane: string, cwd: string, argv: string[] = []) => {
    const io = testIo(cwd, { kind: 'seat', name, pane, session: 'acme' });
    const code = await runPlan(argv, io, { home, now: () => clock });
    return { code, out: io.out, err: io.err };
  };
  // The record the other seat holds still appears — the plan claims nothing, so the lease bytes
  // and the lease list are the same after it as before it.
  const leaseBefore = readFileSync(leasePath, 'utf8');
  const planned = await planOf('worker', other.pane, checkout);
  console.log('--- plan ---');
  console.log(JSON.stringify(planned));
  const plannedOut = 'team acme, session "acme"\n  STEP  STATE  OWNER  TITLE\n  1     open   -      the task title\n1 task\n';
  if (planned.code !== 0 || planned.out !== plannedOut || planned.err !== '') throw new Error(`plan: ${planned.out}${planned.err}`);
  if (readFileSync(leasePath, 'utf8') !== leaseBefore) throw new Error('the plan wrote the lease');

  const second = await claim('worker', other.pane, checkout);
  console.log('--- second ---');
  console.log(JSON.stringify(second));
  if (second.out !== 'team acme, session "acme"\nteam next: nothing is takeable\n' || second.code !== 0) throw new Error(`second: ${second.out}`);

  clock += 1000;
  const again = await claim('lead', lead.pane, checkout);
  console.log('--- renew ---');
  console.log(JSON.stringify(again));
  const renewed = JSON.parse(readFileSync(leasePath, 'utf8')) as { until: string; acquiredAt: string };
  if (again.out !== 'team acme, session "acme"\nm1  the task title\nteam next: claimed m1\n') throw new Error(`renew: ${again.out}`);
  if (renewed.acquiredAt !== written.acquiredAt) throw new Error('acquiredAt moved');
  if (Date.parse(renewed.until) !== Date.parse(written.until) + 1000) throw new Error('until did not move forward');

  const released = await claim('lead', lead.pane, checkout, ['--release']);
  console.log('--- release ---');
  console.log(JSON.stringify(released));
  if (released.out !== 'team acme, session "acme"\nteam next: released m1\n' || existsSync(leasePath)) throw new Error(`release: ${released.out}`);
  console.log('--- evidence ok ---');
} finally {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* already stopped */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { server?.kill(); } catch { /* the session stop owns the process */ }
  try { execFileSync('/usr/bin/trash', [base], { stdio: 'ignore' }); } catch { /* the dir is left if trash refuses it */ }
}
