// Evidence for the broker boundary, the `test/next-run.ts` shape. Its own herdr session
// (`broker-evidence` — created, stopped, deleted in `finally`; never the team's session or the
// floor's), a scratch clone with a linear source and a policy, and the recorded seat panes in the
// state. It never reads the Keychain — the one keychain read is an injected literal — and never
// opens a network connection: the tracker is an answer map, the release world's shape. Five
// proofs, in order: the broker with `team next` as the state-recorded seat (the policy-filtered
// take, the local lease, the key in no file and no output); the authorization refusals over the
// real socket; the real `team broker` child in a scratch pane refused at the owner gate before
// the Keychain and before any bind — a pane is never the owner's terminal, fail-closed; the real
// child broker SIGKILLed — the socket file stays, the next start clears it
// and binds — then SIGTERMed to a clean stop; and `team next` in a pane as that pane's own
// process, refused at the seat gate with nothing claimed (the agent-recording attempt is quoted
// either way). The stale-socket pin is `test/broker.test.ts`'s: a clean close removes the file, a
// SIGKILL leaves it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { askBroker } from '../src/broker/client.ts';
import { brokerSocket } from '../src/broker/protocol.ts';
import { anotherPaneRefusal, noPaneRefusal } from '../src/caller.ts';
import { runBroker } from '../src/commands/broker.ts';
import { runNext } from '../src/commands/next.ts';
import { LINEAR_URL } from '../src/release/checks.ts';
import type { Fetch, RequestOptions } from '../src/release/http.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const SESSION = 'broker-evidence';
const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const KEY = 'test-key-not-real-evidence';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: linear
  linear:
    project: ${PROJECT}
    keychainService: team.linear.acme
  policy:
    allow: [id, title, priority]
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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "1"
    launch: codex
  - role: implementer
    name: spare
    label: spare
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "1"
    launch: codex
`;

/** The tracker's one issue: `id`, `title` and `priority` cross the policy; the assignee,
 *  milestone, deadline and description are the fields the policy must drop in the bytes. */
const NODE = {
  identifier: 'ACME-1',
  title: 'a task',
  priority: 1,
  assignee: { displayName: 'assignee-elsewhere' },
  projectMilestone: { name: 'milestone-forgotten' },
  targetDate: '2026-12-31',
  description: 'the body the owner typed',
};
const ANSWER = JSON.stringify({ data: { project: { id: PROJECT, issues: { nodes: [NODE], pageInfo: { hasNextPage: false } } } } });
const CHILD_ANSWER = JSON.stringify({ data: { project: { id: PROJECT, issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
const FILTERED_AWAY = ['assignee-elsewhere', 'milestone-forgotten', '2026-12-31', 'the body the owner typed'];

const base = mkdtempSync(join(tmpdir(), 'team-broker-run-'));
const root = join(base, 'acme');
const home = join(base, 'home');
mkdirSync(join(root, '.agents'), { recursive: true });
mkdirSync(home);

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' });
}

function herdr(...args: string[]): string {
  return execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' }).trim();
}

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(check: () => boolean, what: string, tries = 1200): Promise<void> {
  for (let tick = 0; tick < tries; tick++) {
    if (check()) return;
    await pause(10);
  }
  throw new Error(`${what} never held`);
}

function waitReady(): void {
  const start = Date.now();
  for (;;) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'workspace', 'list'], { stdio: 'ignore' });
      return;
    } catch {
      if (Date.now() - start > 20_000) throw new Error('the scratch server did not answer');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
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

async function readPane(pane: string, marker: string): Promise<string> {
  let glass = '';
  for (let tick = 0; tick < 100; tick++) {
    glass = herdr('pane', 'read', pane, '--source', 'recent', '--lines', '200');
    if (glass.includes(marker)) return glass;
    await pause(300);
  }
  return glass;
}

/** One raw request line to the clone's socket, with the answer line back — the wire read the way
 *  a foreign caller reads it, without the client's parsers. */
function rawAnswer(request: { op: 'read'; seat: string; pane: string }): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(brokerSocket(root));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => {
      socket.destroy();
      fail(new Error('the broker did not answer'));
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      socket.destroy();
      done(buffer.slice(0, at));
    });
    socket.once('error', fail);
  });
}

/** Every regular file under a directory (the socket file is not one, so the walk skips it). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function capture(child: ChildProcess): { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number> } {
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    out += text;
  });
  child.stderr?.on('data', (text: string) => {
    err += text;
  });
  const exited = new Promise<number>((done) => child.once('close', (code) => done(code ?? 1)));
  return { child, out: () => out, err: () => err, exited };
}

/** The child broker: the real `runBroker` with the released world's injected seams (a literal
 *  key, an answer map) — the one way a child can bind and be SIGKILLed without ever reading the
 *  Keychain. The io hands in the owner's caller: the child runs under this harness's own seat,
 *  and the start is the owner's. Written into the scratch dir, next to the clone, not into the
 *  repo. */
const CHILD = `import { runBroker } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '..', 'src', 'commands', 'broker.ts')).href)};
const io = {
  cwd: process.argv[2],
  env: {},
  stdinIsTTY: false,
  stdoutIsTTY: false,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  caller: { kind: 'owner' },
};
const code = await runBroker([], io, {
  home: process.argv[3],
  keyReader: async () => ({ ok: true, key: ${JSON.stringify(KEY)} }),
  fetch: async () => ({ kind: 'http', status: 200, body: ${JSON.stringify(CHILD_ANSWER)} }),
});
process.exit(code);
`;

git('init', '-q', '-b', 'main');
writeFileSync(join(root, 'README.md'), 'acme\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'first');
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);

writeFileSync(join(base, 'nofacility.sh'), `#!/bin/bash
cd ${JSON.stringify(root)} || exit 9
export HOME=${JSON.stringify(home)}
echo '--- broker without a terminal ---'
bun ${JSON.stringify(cli)} broker < /dev/null
echo "exit:$?"
echo '--- nofacility done ---'
`);
writeFileSync(join(base, 'pane-next.sh'), `#!/bin/bash
cd ${JSON.stringify(root)} || exit 9
export HOME=${JSON.stringify(home)}
echo '--- next in the pane process ---'
bun ${JSON.stringify(cli)} next
echo "exit:$?"
echo '--- pane-next done ---'
`);
const childScript = join(base, 'broker-child.ts');
writeFileSync(childScript, CHILD);

let server: ChildProcess | undefined;
let firstChild: ChildProcess | undefined;
let secondChild: ChildProcess | undefined;
try {
  try {
    execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' });
  } catch {
    /* none yet */
  }
  try {
    execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' });
  } catch {
    /* none yet */
  }
  server = spawn('herdr', ['--session', SESSION, 'server'], { stdio: 'ignore' });
  waitReady();
  const leadPane = paneId(herdr('workspace', 'create', '--cwd', root, '--label', 'lead', '--no-focus'));
  const workerPane = paneId(herdr('workspace', 'create', '--cwd', root, '--label', 'worker', '--no-focus'));
  console.log('--- panes ---');
  console.log(JSON.stringify({ leadPane, workerPane }));
  // The recording attempt, the S2 harness's own: a pane run of a shell command, then the agent
  // list. A vendor CLI is not started — that would be a composer.
  herdr('pane', 'run', workerPane, 'true');
  console.log('--- agents (the recording attempt: a pane run of a shell, not a seat CLI) ---');
  console.log(herdr('agent', 'list'));

  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: leadPane };
    session.seats.worker = { stage: 'ready', pane: workerPane };
  });

  // Proof 1: the broker served through the real command, with the one keychain read injected as
  // a literal and the tracker as an answer map; `team next` as the seat the state records.
  const keyReads: string[] = [];
  const requests: { url: string; options?: RequestOptions }[] = [];
  const fetch: Fetch = async (url, options) => {
    requests.push({ url, ...(options ? { options } : {}) });
    return { kind: 'http', status: 200, body: ANSWER };
  };
  // A call, not a read: the count must never be narrowed into a comparison's type error.
  const tracked = (): number => requests.length;
  let finish: (() => void) | undefined;
  const brokerIo = testIo(root, { kind: 'owner' });
  const served = runBroker([], brokerIo, {
    home,
    keyReader: async (service) => {
      keyReads.push(service);
      return { ok: true, key: KEY };
    },
    fetch,
    stop: (end) => {
      finish = end;
      return () => {
        finish = undefined;
      };
    },
  });
  await waitFor(() => brokerIo.err.includes('team broker: answering on .agents/broker.sock\n'), 'the broker to answer');
  const io = testIo(root, { kind: 'seat', name: 'lead', pane: leadPane, session: 'acme' });
  const take = await runNext([], io, { home });
  console.log('--- take (the state-recorded seat, the real client) ---');
  console.log(JSON.stringify({ code: take, out: io.out, err: io.err }));
  if (take !== 0 || io.out !== 'team acme, session "acme"\nACME-1  a task\n  priority: 1\nteam next: claimed ACME-1\n' || io.err !== '') throw new Error(`the take was not the filtered record: ${take} ${io.out} ${io.err}`);
  if (JSON.stringify(keyReads) !== JSON.stringify(['team.linear.acme'])) throw new Error(`the keychain reads were ${JSON.stringify(keyReads)}`);
  const leasePath = join(root, '.agents', 'leases', 'ACME-1.json');
  const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as { seat: string; pane: string };
  console.log('--- lease (local, beside the state) ---');
  console.log(JSON.stringify(lease));
  if (lease.seat !== 'lead' || lease.pane !== leadPane) throw new Error('the lease does not name the seat and pane');
  if (tracked() !== 1) throw new Error(`the take made ${tracked()} tracker requests`);
  const first = requests[0];
  const headers = first?.options?.headers ?? {};
  if (!first || first.url !== LINEAR_URL || first.options?.method !== 'POST') throw new Error('the tracker request is not the one POST');
  if (Object.keys(headers).join(',') !== 'Content-Type,Authorization' || headers.Authorization !== KEY) throw new Error('the headers are not the pinned two');
  console.log('--- tracker request (header names only) ---');
  console.log(JSON.stringify({ url: first.url, method: first.options?.method, headerNames: Object.keys(headers), credentialInHeader: true, bodyBytes: first.options?.body.length ?? 0 }));

  // Proof 1, the bytes: one raw answer line off the socket, and the key — and every field the
  // policy drops — in neither it nor the run's outputs.
  const wire = await rawAnswer({ op: 'read', seat: 'lead', pane: leadPane });
  console.log('--- answer line (the wire, byte for byte) ---');
  console.log(wire);
  if (tracked() !== 2) throw new Error('the raw request did not reach the tracker');
  for (const text of [...FILTERED_AWAY, KEY]) {
    if (wire.includes(text)) throw new Error(`the answer line holds ${JSON.stringify(text)}`);
  }
  const files = walk(root);
  const hits = files.filter((file) => readFileSync(file).includes(KEY));
  const outputs = brokerIo.out + brokerIo.err + io.out + io.err + wire;
  if (outputs.includes(KEY)) throw new Error('an output holds the key');
  if (hits.length) throw new Error(`the key string is in ${hits.join(', ')}`);
  console.log(`--- key scan: ${files.length} files under the clone hold no key string; no output of the run does ---`);

  // The release half of the lease, and the tracker untouched by it: `--release` unlinks the
  // lease and never reaches the broker.
  const io2 = testIo(root, { kind: 'seat', name: 'lead', pane: leadPane, session: 'acme' });
  const release = await runNext(['--release'], io2, { home });
  console.log('--- release (local, the broker untouched) ---');
  console.log(JSON.stringify({ code: release, out: io2.out, err: io2.err }));
  if (release !== 0 || io2.out !== 'team acme, session "acme"\nteam next: released ACME-1\n' || io2.err !== '') throw new Error(`the release was ${release} ${io2.out}`);
  if (existsSync(leasePath)) throw new Error('the release did not unlink the lease');
  if (tracked() !== 2) throw new Error('the release reached the tracker');

  // Proof 3: every request is held to the recorded state — the S2 sentences, byte for byte.
  console.log('--- authorization (over the real socket) ---');
  for (const [label, request, message] of [
    ['a non-seat', { op: 'read' as const, seat: 'mallory', pane: leadPane }, 'only a seat of this team pulls a task; this request names mallory'],
    ['a declared seat with no recorded pane', { op: 'read' as const, seat: 'spare', pane: workerPane }, noPaneRefusal('spare')],
    ['the wrong pane', { op: 'read' as const, seat: 'lead', pane: workerPane }, anotherPaneRefusal('lead', leadPane)],
  ] as const) {
    const outcome = await askBroker(root, request);
    console.log(JSON.stringify({ label, outcome }));
    if (outcome.kind !== 'refused' || outcome.at !== 'caller' || outcome.message !== message) throw new Error(`${label} was not refused with its sentence`);
  }
  if (tracked() !== 2) throw new Error('a refused request reached the tracker');

  // The clean stop: Ctrl-C's path through the injected seam; the close that removes the file.
  finish?.();
  const stopped = await served;
  console.log('--- broker (the command\'s own lines) ---');
  console.log(brokerIo.err);
  if (stopped !== 0 || !brokerIo.err.includes('team broker: answering on .agents/broker.sock\n') || !brokerIo.err.endsWith('team broker: stopped\n')) throw new Error('the broker did not stop cleanly');
  if (brokerIo.out !== '') throw new Error('the broker wrote to stdout');
  if (existsSync(brokerSocket(root))) throw new Error('the clean close left the socket file');

  // Proof 2: the real command in a pane — a pane is never the owner's terminal, so the owner
  // gate refuses before the Keychain, before any request and before any bind. Strictly earlier
  // and stronger than the facility's own `the run is not interactive`, which a terminal-less
  // owner still reads (pinned in test/broker.test.ts).
  herdr('pane', 'run', leadPane, `bash ${JSON.stringify(join(base, 'nofacility.sh'))}`);
  const nofacilityGlass = await readPane(leadPane, '--- nofacility done ---');
  const nofacilityAt = nofacilityGlass.indexOf('--- broker without a terminal ---');
  const nofacility = nofacilityAt < 0 ? nofacilityGlass : nofacilityGlass.slice(nofacilityAt);
  console.log('--- proof 2: `team broker` without a terminal, in a pane ---');
  console.log(nofacility);
  // The pane glass wraps at its own (narrow) width, mid-word included — this run wrapped
  // "ter/minal" at 53 columns — so the sentence is pinned whitespace-free: the words, the
  // backticks and the exit are still what is checked, and the keychain sentence's absence too.
  const squeezed = nofacility.replace(/\s+/g, '');
  const gateSentence = 'team broker: only the owner runs `broker`, from a terminal outside herdr; this call is '.replace(/\s+/g, '');
  if (!squeezed.includes(gateSentence) || !nofacility.includes('exit:1')) throw new Error('the pane run did not refuse at the owner gate as pinned');
  if (squeezed.includes('therunisnotinteractive')) throw new Error('the pane run was refused by the keychain, not the owner gate');
  if (existsSync(brokerSocket(root))) throw new Error('the refused run bound the socket');

  // Proof 4: the real child broker bound and SIGKILLed — the socket file stays — then started
  // again: cleared, bound, served, and SIGTERMed to the clean stop.
  console.log('--- proof 4: the stale socket ---');
  const firstRun = capture(spawn('bun', [childScript, root, home], { stdio: ['ignore', 'pipe', 'pipe'] }));
  firstChild = firstRun.child;
  await waitFor(() => firstRun.err().includes('team broker: answering on .agents/broker.sock\n'), 'the child broker to answer');
  if (firstRun.err().includes('cleared a stale socket file')) throw new Error('a fresh clone had a stale socket');
  const childServed = await askBroker(root, { op: 'read', seat: 'lead', pane: leadPane });
  if (childServed.kind !== 'read' || childServed.read.kind !== 'records' || childServed.read.records.length !== 0) throw new Error('the child broker did not serve');
  firstRun.child.kill('SIGKILL');
  await firstRun.exited;
  if (!existsSync(brokerSocket(root))) throw new Error('the SIGKILL did not leave the socket file');
  console.log('--- SIGKILL: the socket file stays ---');
  const secondRun = capture(spawn('bun', [childScript, root, home], { stdio: ['ignore', 'pipe', 'pipe'] }));
  secondChild = secondRun.child;
  await waitFor(() => secondRun.err().includes('team broker: answering on .agents/broker.sock\n'), 'the restarted broker to answer');
  if (!secondRun.err().includes('team broker: cleared a stale socket file\n')) throw new Error('the restart did not clear the stale file');
  console.log(secondRun.err());
  secondRun.child.kill('SIGTERM');
  const secondCode = await secondRun.exited;
  if (secondCode !== 0 || !secondRun.err().endsWith('team broker: stopped\n')) throw new Error('the SIGTERM stop was not clean');
  if (secondRun.out() !== '' || existsSync(brokerSocket(root))) throw new Error('the stop left the socket file');
  console.log('--- SIGTERM: stopped, the file removed ---');

  // Proof 5: `team next` in a pane as that pane's own process, through the real placement walk.
  herdr('pane', 'run', workerPane, `bash ${JSON.stringify(join(base, 'pane-next.sh'))}`);
  const paneGlass = await readPane(workerPane, '--- pane-next done ---');
  const paneAt = paneGlass.indexOf('--- next in the pane process ---');
  const pane = paneAt < 0 ? paneGlass : paneGlass.slice(paneAt);
  console.log('--- proof 5: `team next` in the pane process ---');
  console.log(pane);
  if (!pane.includes('only a seat of this team pulls a task') || !pane.includes('exit:1')) throw new Error('the pane run was not refused at the gate');
  if (existsSync(leasePath)) throw new Error('the pane run claimed something');
  console.log('--- evidence ok ---');
} finally {
  for (const child of [firstChild, secondChild]) {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  try {
    execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' });
  } catch {
    /* already stopped */
  }
  try {
    execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  try {
    server?.kill();
  } catch {
    /* the session stop owns the process */
  }
  try {
    execFileSync('/usr/bin/trash', [base], { stdio: 'ignore' });
  } catch {
    /* the dir is left if trash refuses it */
  }
}
