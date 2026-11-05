// Independent coverage for S1: one caller walk and one terminal-host read per send.
//
// Every send runs inside a per-run snapshot: the terminal host's agent list and pane process
// tables, and the caller sources, are read into it once and discarded when the run ends. The
// placement the run judges is the one its first read produced, so a source that changes while
// the run is still going does not change that run's verdict; the next run has a new snapshot
// and sees the change. Outside a run the same reads are never memoised.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anotherPaneRefusal,
  callerOf,
  callerVerdict,
  describeCaller,
  judgeCallerIn,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../src/caller.ts';
import type { Caller, CallerSources, Process } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { agentList, beginHerdrSnapshot, endHerdrSnapshot, paneProcessInfo, setHerdrRun } from '../src/herdr.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: anchor
operator: anchor
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: anchor
    label: anchor
    human: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: runner
    label: runner
    cli: codex
    vendor: openai
    model: GPT
    version: "5"
    launch: codex
`;

const agent = (name: string | null, pane: string): HerdrAgent => ({ name, agent: 'claude', pane, workspace: 'ws', status: 'idle', cwd: null });

function sources(ancestors: Process[] | null, over: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => ancestors,
    agents: () => [agent('anchor', 'pane-a'), agent('runner', 'pane-b')],
    paneRootPid: (pane) => ({ 'pane-a': 100, 'pane-b': 200, 'pane-z': 900 })[pane] ?? null,
    env: {},
    stdinIsTTY: true,
    ...over,
  };
}

/** The runner's own tool run in its pane, as the process walk sees it. */
const runnerChain: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'codex' }, { pid: 10, name: 'herdr' }];

type Team = NonNullable<Extract<ReturnType<typeof readTeamConfig>, { ok: true }>['team']>;
type World = { root: string; agentsDir: string; home: string; team: Team };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  setHerdrRun(null);
});

/** A synthetic team at `acme`, with the state recording each named seat's pane (or none). */
function world(seats: Record<string, { pane?: string }> = { anchor: { pane: 'pane-a' }, runner: { pane: 'pane-b' } }): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-s1-independent-')));
  made.push(base);
  const root = join(base, 'acme');
  const agentsDir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(agentsDir, 'team.yaml'), TEAM);
  const hooksDir = join(agentsDir, 'hooks', 'acme');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'anchor.json');
  writeFileSync(hook, `${JSON.stringify({ crossSessionInbound: 'accept' })}\n`, { mode: 0o600 });
  const past = new Date(Date.now() - 60_000);
  utimesSync(hook, past, past);
  updateState(agentsDir, (state) => {
    state.sessions.acme = { seats } as never;
  });
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
  return { root, agentsDir, home, team: loaded.team };
}

function sendHost(home: string, over: Partial<SendHost> = {}): SendHost {
  const socks = join(home, 'socks');
  mkdirSync(socks, { recursive: true });
  writeFileSync(join(socks, '101.sock'), '');
  // Every run mints its own id: two sends in one process must not stage one record twice.
  let minted = 0;
  const id = () => `1a2b3c4d-5e6f-4a4b-8c8d-${String(++minted).padStart(12, '0')}`;
  return {
    home,
    now: () => new Date('2026-11-05T12:00:00.000Z'),
    newId: id,
    sendId: id,
    agents: () => [
      { name: 'anchor', pane: 'pane-a', cli: 'claude' },
      { name: 'runner', pane: 'pane-b', cli: 'claude' },
    ],
    processInfo: (_session, pane) => {
      if (pane === 'pane-a') return { shell: 100, foreground: [101] };
      if (pane === 'pane-b') return { shell: 200, foreground: [201] };
      return null;
    },
    socketsDir: socks,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
      foregroundCwd: () => null,
    },
    ...over,
  };
}

function ioWith(at: World, build: () => CallerSources, env: Record<string, string | undefined> = {}) {
  const io = testIo(at.root);
  delete io.caller;
  io.callerSources = () => build();
  io.env = env;
  return io;
}

function idOf(text: string): string {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const match = / \(id ([0-9a-f-]{36})\)$/.exec(last);
  if (match === null) throw new Error(`the closing line names no id: ${last}`);
  return match[1]!;
}

/** The refusal a send prints for the placement `judgeCallerIn` reports, from the same pure
 *  functions the command itself calls. */
/** An unplaced caller carries its reason; checking the kind first narrows the union without
 *  `toMatchObject`, whose string matcher would overwrite the reason it matched on. */
function expectUnplaced(caller: Caller, text: string): void {
  expect(caller.kind).toBe('unplaced');
  expect(caller.kind === 'unplaced' ? caller.reason : '').toContain(text);
}

function placementRefusal(judged: ReturnType<typeof judgeCallerIn>, dir: string): string {
  const { caller } = judged;
  if (caller.kind === 'unplaced') return caller.reason;
  if (caller.kind === 'seat') {
    const verdict = callerVerdict(caller, caller.name, standingOf(dir, judged.session, caller));
    if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
    if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  }
  return describeCaller(caller);
}

describe('S1: the judge and the send agree on every placement', () => {
  test('a seat on its recorded pane is placed, judged ok, and admitted', async () => {
    const at = world();
    const io = ioWith(at, () => sources(runnerChain));
    const judged = judgeCallerIn(io, at.agentsDir, at.team);
    expect(judged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    expect(callerVerdict(judged.caller, 'runner', standingOf(at.agentsDir, judged.session, judged.caller))).toEqual({ kind: 'ok' });

    const code = await runSend(['anchor', 'from the runner pane'], io, sendHost(at.home));
    expect(code, io.err).toBe(0);
    expect(io.err).toBe('');
  });

  test('a moved pane and an unrecorded pane print the same repair the judge names', async () => {
    // The state records pane-b for runner, and the caller now stands on pane-z.
    const moved = world();
    const movedIo = ioWith(moved, () => sources(
      [{ pid: 910, name: 'zsh' }, { pid: 900, name: 'codex' }, { pid: 10, name: 'herdr' }],
      { agents: () => [agent('anchor', 'pane-a'), agent('runner', 'pane-z')] },
    ));
    const movedJudged = judgeCallerIn(movedIo, moved.agentsDir, moved.team);
    expect(movedJudged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-z', session: 'acme' });
    const movedText = placementRefusal(movedJudged, moved.agentsDir);
    expect(movedText).toBe(anotherPaneRefusal('runner', 'pane-b'));
    const movedCode = await runSend(['anchor', 'from the moved pane'], movedIo, sendHost(moved.home));
    expect(movedCode).toBe(1);
    expect(movedIo.err).toContain(movedText);

    // The state records no pane for runner at all.
    const unrecorded = world({ anchor: { pane: 'pane-a' }, runner: {} });
    const unrecordedIo = ioWith(unrecorded, () => sources(runnerChain));
    const unrecordedJudged = judgeCallerIn(unrecordedIo, unrecorded.agentsDir, unrecorded.team);
    expect(unrecordedJudged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    const unrecordedText = placementRefusal(unrecordedJudged, unrecorded.agentsDir);
    expect(unrecordedText).toBe(noPaneRefusal('runner'));
    const unrecordedCode = await runSend(['anchor', 'from the unrecorded pane'], unrecordedIo, sendHost(unrecorded.home));
    expect(unrecordedCode).toBe(1);
    expect(unrecordedIo.err).toContain(unrecordedText);
  });

  test('a non-seat pane and an unplaced caller print the same reason the judge gives', async () => {
    const at = world();

    // An agentless pane the hint's root vouches for is a pane caller, and no grant lists it.
    const paneIo = ioWith(
      at,
      () => sources([{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }], {
        agents: () => [agent('anchor', 'pane-a')],
        env: { HERDR_PANE_ID: 'pane-z' },
        paneRootPid: (pane) => ({ 'pane-a': 100, 'pane-z': 900 })[pane] ?? null,
      }),
      { HERDR_PANE_ID: 'pane-z' },
    );
    const paneJudged = judgeCallerIn(paneIo, at.agentsDir, at.team);
    expect(paneJudged.caller).toEqual({ kind: 'pane', pane: 'pane-z', session: 'acme' });
    const paneText = placementRefusal(paneJudged, at.agentsDir);
    expect(paneText).toBe('it runs in pane acme/pane-z, which no grant lists');
    const paneCode = await runSend(['anchor', 'from the agentless pane'], paneIo, sendHost(at.home));
    expect(paneCode).toBe(1);
    expect(paneIo.err).toContain(paneText);

    // A walk that stops before the top is unplaced with its own reason.
    const partialIo = ioWith(at, () => sources(runnerChain, { ancestors: () => null }));
    const partialJudged = judgeCallerIn(partialIo, at.agentsDir, at.team);
    expectUnplaced(partialJudged.caller, "its parent processes can't be read to the top");
    const partialText = placementRefusal(partialJudged, at.agentsDir);
    const partialCode = await runSend(['anchor', 'from the partial walk'], partialIo, sendHost(at.home));
    expect(partialCode).toBe(1);
    expect(partialIo.err).toContain(partialText);

    // A CLI whose environment still names a pane, with no terminal host among its parents.
    const detachedIo = ioWith(
      at,
      () => sources([{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }, { pid: 40, name: 'zsh' }], {
        env: { HERDR_PANE_ID: 'pane-a' },
      }),
      { HERDR_PANE_ID: 'pane-a' },
    );
    const detachedJudged = judgeCallerIn(detachedIo, at.agentsDir, at.team);
    expectUnplaced(detachedJudged.caller, 'detached from that pane');
    const detachedText = placementRefusal(detachedJudged, at.agentsDir);
    const detachedCode = await runSend(['anchor', 'from the detached cli'], detachedIo, sendHost(at.home));
    expect(detachedCode).toBe(1);
    expect(detachedIo.err).toContain(detachedText);
  });

  test('an impostor chain never borrows the pane its environment names', async () => {
    // The state records pane-z for runner; the caller's chain is runner in pane-b, while the
    // environment claims pane-a (anchor's pane, whose root pid is not among the callers).
    const at = world({ anchor: { pane: 'pane-a' }, runner: { pane: 'pane-z' } });
    const io = ioWith(
      at,
      () => sources(runnerChain, {
        agents: () => [agent('anchor', 'pane-a'), agent('runner', 'pane-b')],
        env: { HERDR_PANE_ID: 'pane-a' },
        paneRootPid: (pane) => ({ 'pane-a': 100, 'pane-b': 200 })[pane] ?? null,
      }),
      { HERDR_PANE_ID: 'pane-a' },
    );
    const judged = judgeCallerIn(io, at.agentsDir, at.team);
    // The pids decide: runner's recorded root (200) is in the chain, anchor's (100) is not.
    expect(judged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    const text = placementRefusal(judged, at.agentsDir);
    expect(text).toBe(anotherPaneRefusal('runner', 'pane-z'));
    const code = await runSend(['anchor', 'impostor claiming the anchor pane'], io, sendHost(at.home));
    expect(code).toBe(1);
    expect(io.err).toContain(text);

    // An agentless shell forging the anchor pane is unplaced: its root is not an ancestor.
    const shellIo = ioWith(
      at,
      () => sources([{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }], {
        agents: () => [agent('anchor', 'pane-a'), agent('runner', 'pane-b')],
        env: { HERDR_PANE_ID: 'pane-a' },
        paneRootPid: (pane) => ({ 'pane-a': 100, 'pane-b': 200, 'pane-z': 900 })[pane] ?? null,
      }),
      { HERDR_PANE_ID: 'pane-a' },
    );
    const shellJudged = judgeCallerIn(shellIo, at.agentsDir, at.team);
    expectUnplaced(shellJudged.caller, 'pane without an agent');
    const shellText = placementRefusal(shellJudged, at.agentsDir);
    const shellCode = await runSend(['anchor', 'impostor shell claiming the anchor pane'], shellIo, sendHost(at.home));
    expect(shellCode).toBe(1);
    expect(shellIo.err).toContain(shellText);
  });
});

describe('S1: each send in one process gets its own placement', () => {
  test('admitted, moved, agentless and admitted again in one process', async () => {
    const at = world();
    let chain: Process[] = runnerChain;
    let listed: HerdrAgent[] = [agent('anchor', 'pane-a'), agent('runner', 'pane-b')];
    let env: Record<string, string | undefined> = {};
    const io = ioWith(at, () => sources(chain, { agents: () => listed, env }));
    const host = sendHost(at.home);

    // 1: runner on its recorded pane.
    let judged = judgeCallerIn(io, at.agentsDir, at.team);
    expect(judged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    expect(await runSend(['anchor', 'first: recorded pane'], io, host)).toBe(0);
    const first = idOf(io.out);

    // 2: the same process, the caller now standing on pane-z.
    io.out = '';
    io.err = '';
    chain = [{ pid: 910, name: 'zsh' }, { pid: 900, name: 'codex' }, { pid: 10, name: 'herdr' }];
    listed = [agent('anchor', 'pane-a'), agent('runner', 'pane-z')];
    judged = judgeCallerIn(io, at.agentsDir, at.team);
    expect(judged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-z', session: 'acme' });
    expect(await runSend(['anchor', 'second: moved pane'], io, host)).toBe(1);
    expect(io.err).toContain(placementRefusal(judged, at.agentsDir));

    // 3: the same process, an agentless shell the hint vouches for.
    io.out = '';
    io.err = '';
    chain = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    listed = [agent('anchor', 'pane-a')];
    env = { HERDR_PANE_ID: 'pane-z' };
    judged = judgeCallerIn(io, at.agentsDir, at.team);
    expect(judged.caller).toEqual({ kind: 'pane', pane: 'pane-z', session: 'acme' });
    expect(await runSend(['anchor', 'third: agentless pane'], io, host)).toBe(1);
    expect(io.err).toContain(placementRefusal(judged, at.agentsDir));

    // 4: the same process, the runner back on its recorded pane: the earlier refusals left
    // nothing behind that refuses this one.
    io.out = '';
    io.err = '';
    chain = runnerChain;
    listed = [agent('anchor', 'pane-a'), agent('runner', 'pane-b')];
    env = {};
    judged = judgeCallerIn(io, at.agentsDir, at.team);
    expect(judged.caller).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    expect(await runSend(['anchor', 'fourth: recorded pane again'], io, host)).toBe(0);
    const fourth = idOf(io.out);
    expect(fourth).not.toBe(first);
  });
});

describe('S1: nothing is memoised outside a send snapshot', () => {
  test('a caller placed twice outside a send is walked twice', () => {
    const at = world();
    let reads = 0;
    let chain = runnerChain;
    let pane = 'pane-b';
    const io = ioWith(at, () => sources(chain, {
      ancestors: () => {
        reads += 1;
        return chain;
      },
      agents: () => [agent('anchor', 'pane-a'), agent('runner', pane)],
    }));

    const first = callerOf(io, 'acme');
    expect(first).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-b', session: 'acme' });
    // The whole caller moved: the walk now reaches pane-z's root, and the host names it there.
    chain = [{ pid: 910, name: 'zsh' }, { pid: 900, name: 'codex' }, { pid: 10, name: 'herdr' }];
    pane = 'pane-z';
    const second = callerOf(io, 'acme');
    expect(second).toEqual({ kind: 'seat', name: 'runner', pane: 'pane-z', session: 'acme' });
    expect(reads).toBe(2);
  });

  test('the terminal host is asked afresh outside a snapshot and once inside it', () => {
    const calls: string[] = [];
    setHerdrRun((args, session) => {
      calls.push(`${args.join(' ')} @${session ?? ''}`);
      if (args[0] === 'agent') {
        return { agents: [{ name: 'runner', agent: 'claude', pane_id: 'pane-b', workspace_id: 'ws', agent_status: 'idle', cwd: null }] };
      }
      if (args[0] === 'pane') return { process_info: { shell_pid: 200 } };
      return {};
    });

    // Outside a snapshot: every read reaches the host.
    agentList('acme');
    agentList('acme');
    paneProcessInfo('pane-b', 'acme');
    paneProcessInfo('pane-b', 'acme');
    expect(calls.filter((one) => one === 'agent list @acme').length).toBe(2);
    expect(calls.filter((one) => one === 'pane process-info --pane pane-b @acme').length).toBe(2);

    // Inside one snapshot: each read is answered once, for the whole run.
    calls.length = 0;
    const snapshotId = beginHerdrSnapshot();
    try {
      agentList('acme');
      agentList('acme');
      paneProcessInfo('pane-b', 'acme');
      paneProcessInfo('pane-b', 'acme');
      expect(calls.filter((one) => one === 'agent list @acme').length).toBe(1);
      expect(calls.filter((one) => one === 'pane process-info --pane pane-b @acme').length).toBe(1);
      // Sessions and panes stay distinct inside the snapshot.
      agentList('other');
      paneProcessInfo('pane-z', 'acme');
      expect(calls.filter((one) => one === 'agent list @other').length).toBe(1);
      expect(calls.filter((one) => one === 'pane process-info --pane pane-z @acme').length).toBe(1);
    } finally {
      endHerdrSnapshot(snapshotId);
    }
  });

  test('a source that changes during a send does not change that send, and the next send sees it', async () => {
    const at = world();
    let runnerPane = 'pane-b';
    let changed = false;
    let agentsReads = 0;
    const io = ioWith(at, () => sources(runnerChain, {
      agents: () => {
        agentsReads += 1;
        const list = [agent('anchor', 'pane-a'), agent('runner', runnerPane)];
        // The source moves the runner the moment its first list is handed out: a run that kept
        // reading the source would judge the second value, not the one it started with.
        if (!changed) {
          changed = true;
          runnerPane = 'pane-z';
        }
        return list;
      },
      paneRootPid: (pane) => ({ 'pane-a': 100, 'pane-b': 200, 'pane-z': 200 })[pane] ?? null,
    }));
    const host = sendHost(at.home);

    const first = await runSend(['anchor', 'one source at the start'], io, host);
    expect(first, io.err).toBe(0);
    io.out = '';
    io.err = '';

    const second = await runSend(['anchor', 'the changed source'], io, host);
    expect(second).toBe(1);
    expect(io.err).toContain(anotherPaneRefusal('runner', 'pane-b'));
    expect(agentsReads).toBe(2);
  });

  test('judgeCallerOf reads the caller once when no session is named', () => {
    const at = world();
    let reads = 0;
    const io = ioWith(at, () => sources(null, {
      ancestors: () => {
        reads += 1;
        return null;
      },
    }));
    const judged = judgeCallerOf(io);
    expectUnplaced(judged.caller, "its parent processes can't be read to the top");
    // The caller it shows is the one it judged: no second walk for the sessionless description.
    expect(judged.shown).toEqual(judged.caller);
    expect(reads).toBe(1);
  });
});
