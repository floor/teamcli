// The stopped-seat rule for `team send`: a seat the team file marks `stopped: true` is
// unreachable. The file is the truth about who can be sent to, in three places:
//
//   1. a dry run and a real send to a stopped seat both print the seat's name with `unreachable`
//      and say it is stopped, and both exit with a distinct non-zero code — never the usage exit;
//   2. neither writes anything: no drop file under `.agents/send-drops`, nothing typed into any
//      pane, no send record (the message history) and no log line claiming delivery;
//   3. `team send --list` shows the seat as stopped, and the same seat without `stopped:` plans
//      and delivers normally — the stopped mark is what changes the outcome, nothing else.
//
// Every scene is a temporary home and checkout with a fake herdr: the live agents, the pane
// processes, the pane itself and the sockets folder are all injected, so no real session is
// read and nothing is typed anywhere. The caller is pinned to the owner. The names are
// synthetic, the panes neutral, and only the file's `stopped:` mark differs between the scenes
// that must be refused and the control that must not.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readAllHistories } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { LOG_FILE } from '../src/state.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-10-17T13:00:00.000Z');
const SESSION = 'alpha';
const LIVE = 'lead';
const STOPPED = 'clerk';
const LIVE_PANE = 'w1:p1';
const STOPPED_PANE = 'w1:p2';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; sockets: string };

/** One machine: a checkout whose file names the two seats, a temporary home with the machine
 *  lobby, and a sockets folder nothing listens in. The stopped seat carries the file's own mark
 *  only when `stopped` is true, so the control differs from the refused scenes by that line. */
function world(stopped: boolean): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ss-accept-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamText(home, root, stopped));
  return { base, root, dir, home, sockets };
}

function teamText(home: string, root: string, stopped: boolean): string {
  return `format: 1
project: acme
coordinator: ${LIVE}
operator: ${LIVE}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: ${LIVE}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${STOPPED}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${stopped ? '    stopped: true\n' : ''}`;
}

type Fake = SendHost & { typed: string[]; enters: () => number };

/** The host a send reads: both declared seats live on their panes, a pane process list, a
 *  sockets folder nothing answers in, and a native pane that counts every keystroke and reports
 *  the seat working once it has been typed to. On this build delivered is reachable for either
 *  seat, so a stopped send that reports anything but the refusal is a real violation, not a
 *  limitation of the fixture. */
function fake(w: World): Fake {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const samples = ['idle', 'working'];
  const native: NativePane = {
    typeText: (_session, _pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(reads++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
  return {
    typed,
    enters: () => enters,
    agents: () => [
      { name: LIVE, pane: LIVE_PANE },
      { name: STOPPED, pane: STOPPED_PANE },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
  };
}

function io(w: World): TestIo {
  return testIo(w.root, { kind: 'owner' });
}

function said(on: TestIo): string {
  return `${on.out}${on.err}`;
}

/** Every file under the checkout's `send-drops` tree: the drop the rule says a stopped send never
 *  writes. Missing folders are no files. */
function dropFiles(w: World): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(join(w.dir, 'send-drops'));
  return found;
}

/** The team log, as written so far: missing is empty. */
function logOf(w: World): string {
  try {
    return readFileSync(join(w.dir, LOG_FILE), 'utf8');
  } catch {
    return '';
  }
}

/** The message records a send left behind, by outcome. Missing history is no records. */
function sendRecords(w: World): string[] {
  const read = readAllHistories(w.home);
  return read.ok ? read.entries.map((entry) => entry.outcome) : [`unreadable: ${read.reason}`];
}

/** The refusal the rule promises: the seat's name with `unreachable`, the word stopped, and a
 *  non-zero exit that is not the usage exit. */
function expectRefused(code: number, text: string): void {
  expect(code, text).not.toBe(0);
  expect(code, text).not.toBe(2);
  expect(text, text).toContain(`${STOPPED}: unreachable:`);
  expect(text, text).toMatch(/stopped/);
}

/** Nothing was written and nothing was typed: the rule's whole write-nothing list but the log,
 *  which may carry the refusal's own line but never a delivery claim. */
function expectNothingWritten(w: World, host: Fake): void {
  expect(dropFiles(w)).toEqual([]);
  expect(host.typed).toEqual([]);
  expect(host.enters()).toBe(0);
  expect(sendRecords(w)).toEqual([]);
  expect(logOf(w)).not.toMatch(/delivered|not-submitted|held|answered|timeout/);
}

describe('a stopped seat is unreachable, in a dry run and in a real send', () => {
  test('the dry run names it and writes nothing', async () => {
    const w = world(true);
    const host = fake(w);
    const on = io(w);

    const code = await runSend([STOPPED, 'hello', 'there', '--dry-run'], on, host);

    expectRefused(code, said(on));
    expectNothingWritten(w, host);
  });

  test('the real send names it and writes nothing', async () => {
    const w = world(true);
    const host = fake(w);
    const on = io(w);

    const code = await runSend([STOPPED, 'hello', 'there'], on, host);

    expectRefused(code, said(on));
    expectNothingWritten(w, host);
  });
});

describe('send --list names the stopped seat', () => {
  test('the stopped seat is shown as stopped, and the live one is not', async () => {
    const w = world(true);
    const host = fake(w);
    const on = io(w);

    const code = await runSend(['--list'], on, host);

    expect(code, said(on)).toBe(0);
    const rows = on.out.split('\n');
    const stoppedRow = rows.find((row) => row.startsWith(`${STOPPED}  `));
    expect(stoppedRow, on.out).toBeDefined();
    expect(stoppedRow, on.out).toContain('(stopped)');
    const liveRow = rows.find((row) => row.startsWith(`${LIVE}  `));
    expect(liveRow, on.out).toBeDefined();
    expect(liveRow, on.out).not.toContain('(stopped)');
  });
});

describe('the same seat without the stopped mark plans and delivers normally', () => {
  test('a dry run plans it, and a real send delivers it', async () => {
    const w = world(false);
    const host = fake(w);
    // Each run reads its own streams: two calls sharing one TestIo append, and the second run's
    // whole output would then carry the first's lines.
    const planned = io(w);

    const plannedCode = await runSend([STOPPED, 'hello', 'there', '--dry-run'], planned, host);
    expect(plannedCode, said(planned)).toBe(0);
    expect(planned.err, said(planned)).toBe('');
    expect(planned.out, said(planned)).toContain(`${STOPPED}: dry-run:`);
    expect(said(planned), said(planned)).not.toContain('unreachable');

    const delivered = io(w);
    const deliveredCode = await runSend([STOPPED, 'hello', 'there'], delivered, host);
    expect(deliveredCode, said(delivered)).toBe(0);
    expect(delivered.out, said(delivered)).toBe(`${STOPPED}: delivered\n`);
    expect(host.typed.length).toBe(1);
    expect(dropFiles(w).length).toBe(1);
    expect(sendRecords(w)).toEqual(['delivered']);
  });
});
