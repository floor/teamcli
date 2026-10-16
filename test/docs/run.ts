// Runs one command reference page's examples. The commands are the real ones, in process: the
// world, the home and the caller are handed in, so no example reaches herdr, a CLI, or the owner's
// home. A `$ ` line is run, the lines under it must match byte for byte — so a fixture value
// derived from a path's length (a size, a count, a width) must canonicalize the path first: the
// temp home differs in length macOS vs Linux (TMPDIR=<short dir> reproduces ubuntu locally).
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdd } from '../../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../../src/commands/answer.ts';
import { runAskShow } from '../../src/commands/ask-show.ts';
import { runApprove, type Waiting } from '../../src/approve/command.ts';
import { runBroker } from '../../src/commands/broker.ts';
import { check, loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { pr } from '../../src/commands/pr.ts';
import { runDoctor } from '../../src/commands/doctor.ts';
import { runDown } from '../../src/commands/down.ts';
import { runFeed } from '../../src/commands/feed.ts';
import { runHold } from '../../src/commands/hold.ts';
import { runInit } from '../../src/commands/init.ts';
import { runMcp } from '../../src/commands/mcp.ts';
import { runRegister } from '../../src/commands/register.ts';
import { runRemove } from '../../src/commands/remove.ts';
import { runRestart } from '../../src/commands/restart.ts';
import { runRelease } from '../../src/commands/release.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { runList } from '../../src/commands/list.ts';
import { runSeats } from '../../src/commands/seats.ts';
import { runStatus } from '../../src/commands/status.ts';
import { runUp } from '../../src/commands/up.ts';
import { runMessages } from '../../src/commands/messages.ts';
import { runIssues } from '../../src/commands/issues.ts';
import { runNext } from '../../src/commands/next.ts';
import { runPlan } from '../../src/commands/plan.ts';
import { runProc } from '../../src/commands/proc.ts';
import { runProjects } from '../../src/commands/projects.ts';
import { runUsage } from '../../src/commands/usage.ts';
import { runLock } from '../../src/commands/lock.ts';
import { runUnlock } from '../../src/commands/unlock.ts';
import { runTempo } from '../../src/commands/tempo.ts';
import { runWatch } from '../../src/commands/watch.ts';
import { runWorktree } from '../../src/commands/worktree.ts';
import type { Caller } from '../../src/caller.ts';
import type { TeamFile } from '../../src/file/types.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { installKey } from '../../src/store/keys.ts';
import { storePath } from '../../src/store/store.ts';
import type { Io } from '../../src/io.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { blocksOf, EXIT_SUFFIX, transcript, type Block } from './blocks.ts';
import { createFixture, type Fixture } from './fixture.ts';
import { DEFAULT_SPEC, specOf, type ScreenKind, type Spec, type ToolState } from './spec.ts';
import { createWorld, projectsAt, RUN_WATCH_PID, WATCH_PID, type World } from './world.ts';

export type Failure = { page: string; line: number; message: string };

type Page = {
  name: string;
  fixture: Fixture;
  spec: Spec;
  world: World | null;
  team: TeamFile | null;
  session: string;
  ready: boolean;
};

const words = (line: string): string[] => {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) out.push(match[1] ?? match[2] ?? (match[3] as string));
  return out;
};

// A page's caller is a real placement: the seat's pane is the world's own, and its session is the
// team's, so the commands judge it as they judge a seat of the fixture's session.
function callerOf(name: string, team: TeamFile | null, world: World, session: string): Caller {
  if (name === 'owner') return { kind: 'owner' };
  if (name === 'agent') return { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' };
  const seat = team?.seats.find((candidate) => candidate.name === name);
  if (!seat) throw new Error(`caller=${name} names no seat of the file`);
  const pane = world.paneOf(name) ?? '<pane of ' + name + '>';
  return { kind: 'seat', name, pane, session };
}

/**
 * The three values no page can print: the fixture's own path, read as `.`; the home, read as `~`;
 * the store's folder ends in a hash of the project's path; and commit hashes, read as `<sha>`.
 * One line is the exception: the migration note prints the project's absolute path, and the
 * fixture's root sits under its home, so that line reads as `~/Code/<project>`, the entry a
 * reader would write.
 */
function normalize(text: string, page: { fixture: Fixture }): string {
  return text
    .replaceAll(`  - ${page.fixture.root}`, `  - ~/Code/${basename(page.fixture.root)}`)
    .replaceAll(page.fixture.root, '.')
    .replaceAll(page.fixture.home, '~')
    .replace(/(team\/[A-Za-z0-9._-]+)-[0-9a-f]{12}\b/g, '$1-<hash>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b[0-9a-f]{10}\b/g, '<sha>')
    .replace(/^(\s+)[0-9a-f]{7,40} /gm, '$1<sha> ');
}

async function setup(page: Page): Promise<void> {
  const { fixture } = page;
  const loaded = loadTeamFile(fixture.root, { home: fixture.home });
  if (loaded.ok) {
    page.team = loaded.team;
    page.session = loaded.team.session;
  }
  const world = createWorld({ team: page.team, spec: page.spec, root: fixture.root, home: fixture.home });
  page.world = world;

  const dir = join(fixture.root, '.agents');
  mkdirSync(dir, { recursive: true });
  const session = emptySession() as unknown as Record<string, unknown>;
  if (page.spec.agents === 'all' && page.team) {
    const seats: Record<string, unknown> = {};
    // The state records the pane the seat actually runs in — a command run by that seat in a
    // transcript judges it against this record, as it does for a real launch — and the process
    // identity this version writes, so no page shows the doctor's "launched before team recorded
    // its process" note unless it says so on purpose (`state:` dropping a seat's `launched`).
    page.team.seats.forEach((seat, index) => {
      const launched = { shell: 4000 + index, cli: [4100 + index] };
      const pane = world.paneOf(seat.name);
      seats[seat.name] = pane === undefined ? { stage: 'ready', launched } : { stage: 'ready', pane, launched };
    });
    session.seats = seats;
  }
  if (page.spec.watch === 'alive' || page.spec.watch === 'stale') {
    const interval = page.team?.watch.interval ?? 120;
    const ago = page.spec.watch === 'stale' ? 3 * interval : 0;
    session.watch = { pid: WATCH_PID, heartbeat: new Date(Date.parse(page.spec.now) - ago * 1000).toISOString() };
  }
  for (const [key, value] of Object.entries(page.spec.state)) {
    const current = (session[key] ?? {}) as Record<string, unknown>;
    session[key] = typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...current, ...value } : value;
  }
  updateState(dir, (state) => {
    state.sessions[page.session] = session as never;
  });

  // A check the page names is the repo's own file, linked in: approve resolves and hashes the
  // real script, and a fence's write cannot carry an executable bit.
  for (const path of page.spec.checks) {
    const target = join(fixture.root, path);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), target);
  }

  // Every approval a page records signs with one fixed key, so the fingerprint the commands
  // print is the same on every run: the fixture key, in before the first approve.
  installKey(fixture.home, JSON.parse(readFileSync(new URL('../fixtures/key.json', import.meta.url), 'utf8')));

  if (page.spec.approved && page.team) {
    const parts: string[] = [];
    const io: Io = {
      stdout: (text) => parts.push(text),
      stderr: (text) => parts.push(text),
      cwd: fixture.root,
      env: {},
      stdinIsTTY: false,
      caller: { kind: 'owner' },
    };
    const seats = page.team.seats.length;
    const code = await runApprove([], io, {
      ask: async () => page.spec.answer ?? String(seats),
      waiting: () => 'empty',
      now: () => new Date(page.spec.now),
      home: fixture.home,
    });
    if (code !== 0) throw new Error(`the fixture could not approve its team file: ${parts.join('')}`);
  }
  page.ready = true;
}

/** The one pid the fixture's `team proc` records call running; every other number is a process
 *  that is gone. A page records this one, or a number that is clearly not running. */
const PROC_PID = 4243;

async function command(page: Page, line: string, io: Io, answer?: string, waiting: Waiting = 'empty', reply?: string): Promise<number> {
  const [first, ...argv] = words(line);
  if (first !== 'team') throw new Error(`a console line runs \`team …\`, not "${first ?? ''}"`);
  const name = argv[0];
  const rest = argv.slice(1);
  const spec = page.spec;
  const world = page.world as World;
  const fixture = page.fixture;
  switch (name) {
    case 'add':
      return runAdd(rest, io, world.addSources());
    case 'answer':
      return runAnswer(rest, io, answerHost(fixture.home));
    case 'ask-show':
      return runAskShow(rest, io, new Date(spec.now));
    // The broker page's one runnable line is the file-source refusal, which precedes the
    // credential read — no keychain, no socket, no peer on the page's fixture. The command's own
    // refusals that need a broker source are shown as text on the page instead: their sentences
    // differ by platform, and the docs suite runs on macOS and Linux.
    case 'broker':
      return runBroker(rest, io, { home: fixture.home });
    case 'approve':
      return runApprove(rest, io, {
        ask: async (question) => {
          // The question goes to the terminal, and the answer is what the terminal echoes back.
          const typed = answer ?? spec.answer ?? String(page.team?.seats.length ?? 0);
          io.stdout(`${question}${typed}\n`);
          return typed;
        },
        // A page that shows an input refusal says which one on its fence — `waiting="1"` for a
        // line queued on the terminal, `waiting="unreadable"` for a terminal the check cannot
        // read; every other page's terminal is empty.
        waiting: () => waiting,
        now: () => new Date(spec.now),
        home: fixture.home,
      });
    case 'check':
      return check(rest, io, (cwd, file) => loadConfig(cwd, file, fixture.home), world.checkSources());
    case 'commits':
      return commits(rest, io, (cwd, file) => loadConfig(cwd, file, fixture.home));
    case 'doctor':
      return runDoctor(rest, io, world.doctorSources());
    case 'down':
      return runDown(rest, io, world.downSources());
    case 'feed':
      return runFeed(rest, io, { home: fixture.home, poll: async () => false });
    case 'hold':
      return runHold(rest, io, { home: fixture.home, now: () => new Date(spec.now) });
    case 'messages':
      return runMessages(rest, io, { home: fixture.home, now: () => new Date(spec.now) });
    case 'issues':
      return runIssues(rest, io, { home: fixture.home });
    case 'next':
      return runNext(rest, io, { home: fixture.home, now: () => Date.parse(spec.now) });
    case 'plan':
      return runPlan(rest, io, { home: fixture.home, now: () => Date.parse(spec.now) });
    case 'init':
      // No login is probed in a doc run: the skeleton's seat is claude-code's, deterministically.
      return runInit(rest, io, fixture.home, undefined, { loggedIn: () => false });
    case 'mcp':
      return runMcp(rest, io, world.mcpSources());
    case 'register':
      return runRegister(rest, io, world.registerSources());
    case 'remove':
      return runRemove(rest, io, world.removeSources());
    case 'restart':
      return runRestart(rest, io, world.restartSources());
    case 'send': {
      // Every seat of the page's file is a live agent, so a native-CLI example resolves.
      // `reply="…"` on the fence is the fake seat's answer: with it, a `--wait` example has a
      // reply to print; without it, the seat stays silent and the wait times out.
      const seats = page.team?.seats.map((seat) => seat.name) ?? ['claude-keeper'];
      return runSend(rest, io, sendHost(fixture, seats, spec.now, reply));
    }
    case 'pr':
      return pr(rest, io, (cwd, file) => loadConfig(cwd, file, fixture.home));
    case 'release':
      return runRelease(rest, io, world.releaseFetch(), world.releaseKeyReader());
    case 'seats':
      return runSeats(rest, io, { ...world.statusSources(), wait: async () => false });
    case 'status':
      return runStatus(rest, io, world.statusSources());
    case 'list':
      return runList(rest, io, world.listSources());
    case 'up':
      return runUp(rest, io, world.upSources());
    case 'lock':
      return runLock(rest, io, {
        home: fixture.home,
        now: () => new Date(spec.now),
        // The page's clock is pinned. A sleep that left it there would spin, so a wait ends
        // after one look — the same refusal, and the lock is not broken.
        sleep: () => {},
      });
    case 'proc':
      return runProc(rest, io, {
        home: fixture.home,
        now: () => new Date(spec.now),
        // The page's pids are the fixture's own: `PROC_PID` names the one process that is
        // running, and every other number is one that is gone, so no example depends on a pid
        // the machine running the suite happens to have.
        alive: (pid) => pid === PROC_PID,
      });
    case 'projects':
      // The page's registry is its own fence, `~/.config/team/projects.yaml` under the
      // fixture's home: the reads are the registry module's, pointed at that home.
      return runProjects(rest, io, projectsAt(fixture.home));
    case 'tempo':
      return runTempo(rest, io, { home: fixture.home });
    case 'unlock':
      return runUnlock(rest, io, { home: fixture.home });
    case 'usage':
      return runUsage(rest, io, { home: fixture.home, now: () => new Date(spec.now) });
    case 'watch':
      return runWatch(rest, io, world.watchSources());
    case 'worktree':
      return runWorktree(rest, io, { home: fixture.home, now: () => new Date(spec.now) });
    default:
      throw new Error(`no such command: ${name ?? ''}`);
  }
}

/** The docs page's only `answer` example fails before any pane is read. */
function answerHost(home: string): AnswerHost {
  const unused = (): never => { throw new Error('the docs example does not read a pane'); };
  return {
    version: unused,
    agents: unused,
    pane: unused,
    sendKey: unused,
    rename: unused,
    foreground: unused,
    foregroundCwd: unused,
    list: unused,
    status: unused,
    type: unused,
    enter: unused,
    now: () => new Date(0),
    sleep: async () => {},
    home,
    standing: unused,
  };
}

/** The docs page's send: a fake seat whose pane reports one process with a file at the socket's
 *  measured name, and a deliver that accepts. With `reply`, the delivery answers too: a
 *  connection back to the sender's own measured `cc-socks/<pid>.sock` — the frame a replying
 *  session writes — so a `--wait` example has a reply to print. No session is read and no pane
 *  is touched. */
const SEND_PID = 4200;

function sendHost(fixture: Fixture, seats: string[], now: string, reply?: string): SendHost {
  const sockets = join(fixture.home, 'cc-socks');
  mkdirSync(sockets, { recursive: true });
  writeFileSync(join(sockets, `${String(SEND_PID)}.sock`), '');
  // The seat's own evidence for this line: idle until the Enter, working after it.
  let working = false;
  return {
    agents: () => seats.map((name, index) => ({ name, pane: `w1:p${String(index + 1)}` })),
    processInfo: () => ({ shell: SEND_PID, foreground: [] }),
    socketsDir: sockets,
    native: {
      typeText: () => true,
      pressEnter: () => {
        working = true;
        return true;
      },
      status: () => (working ? 'working' : 'idle'),
      wait: async () => {},
    },
    deliver: async () => {
      if (reply !== undefined) {
        await new Promise<void>((resolve) => {
          const back = createConnection(join(sockets, `${String(process.pid)}.sock`));
          back.on('connect', () => {
            // The measured shape: the harness stamps its attribution wrapper around the body
            // (see src/send/reply.ts), so the page's example exercises the peel.
            const wrapped = `<cross-session-message from="uds:/tmp/cc-socks/${String(SEND_PID)}.sock" from-name="${seats[0] ?? 'seat'}" from-mode="bypass">\n${reply}\n</cross-session-message>`;
            const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: wrapped }, msg_id: 'reply-1' });
            back.end(`${frame}\n`, resolve);
          });
          // Without a listener at the sender's address the seat's answer has nowhere to go; the
          // delivery itself still lands, exactly as the socket channel reports it.
          back.on('error', () => resolve());
        });
      }
      return { ok: true };
    },
    now: () => new Date(now),
    home: fixture.home,
    // The roster's project column reads the fixture's own registry: a page that seeds
    // `~/.config/team/projects.yaml` shows the registry's grouping, one that does not shows
    // each team's own `project:` line.
    projects: projectsAt(fixture.home),
  };
}

function diff(expected: string, produced: string): string {
  const want = expected.split('\n');
  const got = produced.split('\n');
  const at = want.findIndex((line, index) => line !== got[index]);
  const from = Math.max(0, (at < 0 ? Math.max(want.length, got.length) : at) - 2);
  const show = (lines: string[]) => lines.slice(from, from + 6).map((line) => `      ${line}`).join('\n');
  return `expected:\n${show(want)}\n    produced:\n${show(got)}`;
}

/**
 * `screens="claude-beacon=question"`, `machine="tight"`, `tools="codex=logged-out"` and
 * `herdr=stopped` on a `console` fence: the world that block's commands run in. Each lasts for
 * the block alone — the fixture's own world is back for the next one.
 */
function blockWorld(page: Page, block: Block): void {
  const world = page.world as World;
  const screens = block.attrs.screens;
  if (screens) {
    for (const entry of screens.split(',')) {
      const [seat, kind] = entry.split('=');
      if (!seat?.trim() || !kind?.trim()) throw new Error(`screens="${screens}": each entry is <seat>=<screen>`);
      world.setScreen(seat.trim(), kind.trim() as ScreenKind);
    }
  }
  if (block.attrs.machine) {
    const kind = block.attrs.machine;
    if (kind !== 'calm' && kind !== 'tight' && kind !== 'small-swap') throw new Error(`machine="${kind}": it is calm, tight or small-swap`);
    world.setMachine(kind);
  }
  const tools = block.attrs.tools;
  if (tools) {
    const state: Record<string, ToolState> = {};
    for (const entry of tools.split(',')) {
      const [cli, kind] = entry.split('=');
      if (!cli?.trim() || !kind?.trim()) throw new Error(`tools="${tools}": each entry is <cli>=<state>`);
      state[cli.trim()] = kind.trim() as ToolState;
    }
    world.setTools(state);
  }
  const herdr = block.attrs.herdr;
  if (herdr) {
    if (herdr !== 'running' && herdr !== 'absent' && herdr !== 'stopped' && herdr !== 'none') {
      throw new Error(`herdr="${herdr}": it is running, absent, stopped or none`);
    }
    world.setHerdr(herdr);
  }
}

function restoreWorld(page: Page, block: Block): void {
  const world = page.world as World;
  for (const entry of (block.attrs.screens ?? '').split(',')) {
    const seat = entry.split('=')[0]?.trim();
    // The block itself may have renamed the seat out of its name — a lifecycle removal does — or
    // closed it: the fixture's world is put back where the seat is still there to put back.
    if (seat && world.paneOf(seat)) world.setScreen(seat, page.spec.screens[seat] ?? 'idle');
  }
  if (block.attrs.machine) world.setMachine(page.spec.machine);
  if (block.attrs.tools) world.setTools(page.spec.tools);
  if (block.attrs.herdr) world.setHerdr(page.spec.herdr);
}

async function consoleBlock(page: Page, block: Block, failures: Failure[]): Promise<void> {
  if (!page.ready) await setup(page);
  try {
    blockWorld(page, block);
  } catch (error) {
    failures.push({ page: page.name, line: block.line, message: (error as Error).message });
    return;
  }
  const caller = callerOf(block.attrs.caller ?? page.spec.caller, page.team, page.world as World, page.session);
  try {
    for (const step of transcript(block.text, block.line)) {
      const parts: string[] = [];
      const io: Io = {
        stdout: (text) => parts.push(text),
        stderr: (text) => parts.push(text),
        cwd: page.fixture.root,
        env: {},
        stdinIsTTY: false,
        caller,
      };
      let code: number;
      const waiting: Waiting =
        block.attrs.waiting === '1' ? 'waiting' : block.attrs.waiting === 'unreadable' ? 'unreadable' : 'empty';
      try {
        code = await command(page, step.command, io, block.attrs.answer, waiting, block.attrs.reply);
      } catch (error) {
        failures.push({ page: page.name, line: step.line, message: (error as Error).message });
        continue;
      }
      if (step.showsExit) parts.push(`exit ${code}\n`);
      const produced = normalize(parts.join(''), page);
      const expected = normalize(step.expected, page);
      if (produced !== expected) {
        failures.push({
          page: page.name,
          line: step.line,
          message: `$ ${step.command}${step.showsExit ? ` ${EXIT_SUFFIX}` : ''}\n    ${diff(expected, produced)}`,
        });
      }
    }
  } finally {
    restoreWorld(page, block);
  }
}

/** `file=overrides.yaml` is the approval store's file, not a path in the project. */
function writeOverrides(page: Page, text: string, line: number): void {
  const loaded = loadTeamFile(page.fixture.root, { home: page.fixture.home });
  if (!loaded.ok) throw new Error(`overrides.yaml at line ${line} needs a team file`);
  const path = join(storePath(loaded.team.project, loaded.root, page.fixture.home), 'overrides.yaml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Every example of one page, run in order; the failures are the test's own. */
export async function runPage(name: string, markdown: string, project = 'beacon'): Promise<Failure[]> {
  const failures: Failure[] = [];
  const page: Page = {
    name,
    fixture: createFixture(project, { at: Date.parse(DEFAULT_SPEC.now) / 1000 }),
    spec: { ...DEFAULT_SPEC },
    world: null,
    team: null,
    session: project,
    ready: false,
  };
  try {
    const blocks = blocksOf(markdown);
    const declared = blocks.find((block) => block.kind === 'fixture');
    page.spec = specOf(declared);
    for (const block of blocks) {
      try {
        if (block.kind === 'yaml' || block.kind === 'file') {
          if (!block.attrs.file) throw new Error(`the ${block.kind} fence at line ${block.line} needs file=<path>`);
          const text = block.text.endsWith('\n') ? block.text : `${block.text}\n`;
          if (block.attrs.file === 'overrides.yaml') writeOverrides(page, text, block.line);
          else page.fixture.write(block.attrs.file, text, block.kind === 'file' && block.attrs.exec === '1');
        } else if (block.kind === 'commit') {
          const message = block.text.endsWith('\n') ? block.text : `${block.text}\n`;
          page.fixture.commit(message, block.attrs.email ?? undefined);
        } else if (block.kind === 'git') {
          for (const line of block.text.split('\n')) {
            if (line.trim() === '') continue;
            const ran = page.fixture.git(...words(line));
            if (ran.code !== 0) throw new Error(`git ${line}: ${ran.stderr || ran.stdout}`);
          }
        } else if (block.kind === 'console') {
          await consoleBlock(page, block, failures);
        }
      } catch (error) {
        failures.push({ page: name, line: block.line, message: (error as Error).message });
      }
    }
  } finally {
    page.fixture.remove();
  }
  return failures;
}
