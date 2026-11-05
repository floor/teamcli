import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anotherPaneRefusal,
  callerLabel,
  callerStanding,
  callerVerdict,
  describeCaller,
  isOwner,
  judgeCallerIn,
  mayChangeTeam,
  mayLaunchSeats,
  noPaneRefusal,
  parsePsSnapshot,
  parseStat,
  placeCaller,
  processReader,
  readAncestors,
  recordedPaneOf,
  readWithProc,
  readWithPs,
  standingOf,
} from '../src/caller.ts';
import type { Caller, CallerSources, Process } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const agent = (name: string | null, pane: string): HerdrAgent => ({ name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null });

function sources(ancestors: Process[], over: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => ancestors,
    agents: () => [agent('claude-coordinator', 'pane1'), agent('codex-acme', 'pane2'), agent(null, 'pane3')],
    paneRootPid: (pane) => ({ 'pane1': 100, 'pane2': 200, 'pane3': 300 })[pane] ?? null,
    env: {},
    stdinIsTTY: true,
    ...over,
  };
}

const terminal: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }, { pid: 30, name: 'Terminal' }];
const seat: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'codex' }, { pid: 10, name: 'herdr' }];

describe('the caller is placed by its parent processes', () => {
  test('a seat\'s tool run under its managed Codex app-server is that seat, while herdr lists it', () => {
    // The app-server is started outside the pane, so no herdr server is among the parents.
    const underEndpoint: Process[] = [{ pid: 910, name: 'zsh' }, { pid: 900, name: 'codex' }, { pid: 1, name: 'launchd' }];
    const served = (pid: number) => (pid === 900 ? { session: 'main', seat: 'codex-acme', pane: 'pane2' } : null);
    const env = { HERDR_PANE_ID: 'pane2' };
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: served }), 'main'))
      .toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'main' });
    // Another session, or a pane herdr lists under another name, places nobody.
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: served }), 'other'))
      .toMatchObject({ kind: 'unplaced' });
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: () => ({ session: 'main', seat: 'codex-acme', pane: 'pane1' }) }), 'main'))
      .toMatchObject({ kind: 'unplaced' });
    // A Codex process that is no recorded endpoint stays the detached refusal.
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: () => null }), 'main'))
      .toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
  });

  test('a terminal outside herdr, with no agent above it, is the owner', () => {
    expect(placeCaller(sources(terminal))).toEqual({ kind: 'owner' });
  });

  test('a command run by an agent in a herdr pane is that seat', () => {
    expect(placeCaller(sources(seat))).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2' });
  });

  test('a herdr pane without an agent is neither the owner nor a seat', () => {
    const plain: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(plain))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/pane without an agent/) });
  });

  test('an agentless pane whose root vouches is that pane, and the session is recorded only when asked', () => {
    const shell: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    const vouched = sources(shell, {
      agents: () => [],
      env: { HERDR_PANE_ID: 'pane9' },
      paneRootPid: (pane) => (pane === 'pane9' ? 900 : null),
    });
    expect(placeCaller(vouched, 'main')).toEqual({ kind: 'pane', pane: 'pane9', session: 'main' });
    expect(placeCaller(vouched)).toEqual({ kind: 'pane', pane: 'pane9' });
  });

  test('a hint without a vouched pid, or with no hint, stays the agentless refusal', () => {
    const shell: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    const unplaced = { kind: 'unplaced' as const, reason: 'it runs in a herdr pane without an agent' };
    expect(placeCaller(sources(shell, {
      agents: () => [],
      env: { HERDR_PANE_ID: 'pane9' },
      paneRootPid: () => null,
    }))).toEqual(unplaced);
    expect(placeCaller(sources(shell, {
      agents: () => [],
      env: { HERDR_PANE_ID: 'pane9' },
      paneRootPid: () => 1,
    }))).toEqual(unplaced);
    expect(placeCaller(sources(shell, { agents: () => [], env: {} }))).toEqual(unplaced);
  });

  test('herdr silence and an unnamed agent still refuse, hint or not', () => {
    const shell: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(shell, {
      agents: () => null,
      env: { HERDR_PANE_ID: 'pane9' },
      paneRootPid: () => 900,
    }))).toEqual({ kind: 'unplaced', reason: 'it runs under herdr, and herdr doesn\'t answer' });
    const unnamed: Process[] = [{ pid: 300, name: 'claude' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(unnamed, { env: { HERDR_PANE_ID: 'pane3' } }))).toEqual({
      kind: 'unplaced',
      reason: 'it runs in pane pane3, whose agent has no herdr name',
    });
  });

  test('an agent whose pane has no herdr name can\'t be placed', () => {
    const unnamed: Process[] = [{ pid: 300, name: 'claude' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(unnamed))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/no herdr name/) });
  });

  test('an agent outside herdr is not the owner', () => {
    const loose: Process[] = [{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }, { pid: 40, name: 'zsh' }];
    expect(placeCaller(sources(loose))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/agent \(claude\)/) });
  });

  test('unsetting variables never makes an owner: the processes decide', () => {
    expect(placeCaller(sources(seat, { env: {} })).kind).toBe('seat');
  });

  test('a pane named in HERDR_PANE_ID is not believed without its process', () => {
    expect(placeCaller(sources(seat, { env: { HERDR_PANE_ID: 'pane1' } }))).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2' });
  });

  test('AGENT_UNATTENDED only ever adds a refusal', () => {
    expect(placeCaller(sources(terminal, { env: { AGENT_UNATTENDED: '1' } })).kind).toBe('unplaced');
  });

  test('a verified owner outside herdr without a terminal is owner-no-tty, not unplaced', () => {
    expect(placeCaller(sources(terminal, { stdinIsTTY: false }))).toEqual({ kind: 'owner-no-tty' });
  });

  test('no terminal only changes the owner case: every other refusal stands', () => {
    expect(placeCaller(sources(seat, { stdinIsTTY: false })).kind).toBe('seat');
    const loose: Process[] = [{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }, { pid: 40, name: 'zsh' }];
    expect(placeCaller(sources(loose, { stdinIsTTY: false })).kind).toBe('unplaced');
    expect(placeCaller(sources(terminal, { stdinIsTTY: false, env: { AGENT_UNATTENDED: '1' } })).kind).toBe('unplaced');
  });

  test('under herdr, a herdr that doesn\'t answer places nobody', () => {
    expect(placeCaller(sources(seat, { agents: () => null })).kind).toBe('unplaced');
  });

  test('unreadable parents place nobody', () => {
    expect(placeCaller(sources([])).kind).toBe('unplaced');
  });

  test('a walk that stopped before the top places nobody, even on a terminal', () => {
    expect(placeCaller(sources(terminal, { ancestors: () => null }))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/to the top/) });
  });
});

describe('a live handoff re-parents the pane root, and the server still vouches for it', () => {
  // After a live handoff every pane's root process is re-parented to the system's first process,
  // so the herdr server is no longer among a seat's ancestors while the pane's own root still is.
  // The current server's record for the pane the environment names is the other way to the same
  // proof: the hint names the pane, the root pid it reports decides.
  const handed: Process[] = [{ pid: 901, name: 'claude' }, { pid: 900, name: 'zsh' }, { pid: 1, name: 'launchd' }];
  const handoff = (over: Partial<CallerSources> = {}): CallerSources => sources(handed, {
    agents: () => [agent('codex-acme', 'pane2')],
    paneRootPid: (pane) => (pane === 'pane2' ? 900 : null),
    env: { HERDR_PANE_ID: 'pane2' },
    stdinIsTTY: false,
    ...over,
  });

  test('(a) the server vouches for the hinted pane root: the caller is that seat', () => {
    expect(placeCaller(handoff(), 'main')).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'main' });
    expect(placeCaller(handoff())).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2' });
  });

  test('(a) an agentless pane the server vouches for is that pane', () => {
    expect(placeCaller(handoff({ agents: () => [] }), 'main')).toEqual({ kind: 'pane', pane: 'pane2', session: 'main' });
  });

  test('(b) a pane id the server does not know is still the detached refusal', () => {
    const unknown = handoff({ agents: () => [], paneRootPid: () => null });
    expect(placeCaller(unknown, 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
  });

  test('(c) a root pid that is not an ancestor is still the detached refusal', () => {
    const elsewhere = handoff({ paneRootPid: () => 4242 });
    expect(placeCaller(elsewhere, 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
  });

  test('(d) a server read that fails is still the detached refusal', () => {
    const silent = handoff({ agents: () => null, paneRootPid: () => null });
    expect(placeCaller(silent, 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
    // The pane root vouched, and the agent list then went silent: still the refusal the caller
    // got before the fix, not a new one.
    expect(placeCaller(handoff({ agents: () => null }), 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
  });

  test('(e) the classic path with a herdr ancestor is unchanged, and reads the hint only to order the agents', () => {
    const reads: string[] = [];
    const classic = sources(seat, {
      paneRootPid: (pane) => {
        reads.push(pane);
        return ({ pane1: 100, pane2: 200, pane3: 300 } as Record<string, number>)[pane] ?? null;
      },
      env: { HERDR_PANE_ID: 'pane2' },
    });
    expect(placeCaller(classic, 'main')).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'main' });
    expect(reads).toEqual(['pane2']);
  });
});

describe('the classes read apart', () => {
  test('isOwner and mayLaunchSeats are the owner at a terminal', () => {
    expect(isOwner({ kind: 'owner' })).toBe(true);
    expect(isOwner({ kind: 'owner-no-tty' })).toBe(false);
    expect(mayLaunchSeats({ kind: 'owner' })).toBe(true);
    expect(mayLaunchSeats({ kind: 'owner-no-tty' })).toBe(false);
    expect(mayLaunchSeats({ kind: 'unplaced', reason: 'x' })).toBe(false);
    expect(isOwner({ kind: 'pane', pane: 'pane9', session: 'main' })).toBe(false);
    expect(mayLaunchSeats({ kind: 'pane', pane: 'pane9', session: 'main' })).toBe(false);
  });

  test('the log bracket is owner for both; a refusal reads as main\'s unplaced line', () => {
    expect(callerLabel({ kind: 'owner' })).toBe('owner');
    expect(callerLabel({ kind: 'owner-no-tty' })).toBe('owner');
    expect(describeCaller({ kind: 'owner-no-tty' })).toBe('unplaced (it doesn\'t run on a terminal)');
    expect(describeCaller({ kind: 'pane', pane: 'pane9', session: 'main' })).toBe('it runs in pane main/pane9, which no grant lists');
    expect(describeCaller({ kind: 'pane', pane: 'pane9' })).toBe('it runs in pane pane9');
    expect(callerLabel({ kind: 'pane', pane: 'pane9', session: 'main' })).toBe('main/pane9');
  });
});

describe('who may change a running team', () => {
  const team = { orchestrator: 'claude-coordinator', operator: 'claude-operator' };
  const at = { session: 's', recordedPane: 'pane1' };
  const other = { session: 's', recordedPane: 'pane4' };
  test('the owner, the coordinator and the operator', () => {
    expect(mayChangeTeam({ kind: 'owner' }, team, at)).toBe(true);
    expect(mayChangeTeam({ kind: 'seat', name: 'claude-coordinator', pane: 'pane1', session: 's' }, team, at)).toBe(true);
    expect(mayChangeTeam({ kind: 'seat', name: 'claude-operator', pane: 'pane4', session: 's' }, team, other)).toBe(true);
  });
  test('no other seat, and no unplaced caller', () => {
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 's' }, team, at)).toBe(false);
    expect(mayChangeTeam({ kind: 'unplaced', reason: 'x' }, team, at)).toBe(false);
    expect(mayChangeTeam({ kind: 'pane', pane: 'pane9', session: 'main' }, team, at)).toBe(false);
    expect(callerVerdict({ kind: 'pane', pane: 'pane9', session: 'main' }, 'claude-coordinator', at)).toEqual({ kind: 'refused' });
  });
});

describe('a caller is judged against the session and the pane it was placed in', () => {
  test('placement records the session it was made in, and nothing when none was asked about', () => {
    expect(placeCaller(sources(seat), 'b')).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'b' });
    expect(placeCaller(sources(seat))).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2' });
  });

  const team = { orchestrator: 'codex-acme', operator: 'codex-acme' };
  const where = { session: 'a', recordedPane: 'pane2' };

  test('a seat of another session is not the coordinator of this one', () => {
    // Placed in session b under the coordinator's name: today's caller shape, still true.
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'b' }, team, where)).toBe(false);
    // The caller main's placement produced (no session at all) is refused once a standing is
    // asked for: nothing in it shows it stood in the session judged. The one this session's
    // placement produces is the same seat, allowed.
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2' }, team, where)).toBe(false);
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'a' }, team, where)).toBe(true);
  });

  test('a pane merely renamed is not the seat: the state records another pane', () => {
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane9', session: 'a' }, team, where)).toBe(false);
    expect(callerStanding({ kind: 'seat', name: 'codex-acme', pane: 'pane9', session: 'a' }, 'codex-acme', where)).toBe(false);
    expect(callerStanding({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'a' }, 'codex-acme', where)).toBe(true);
  });

  test('a state that records no pane refuses the seat: the check fails closed', () => {
    const none = { session: 'a' };
    // The pane matches nothing, because nothing is recorded — a renamed shell and a hand-started
    // seat are the same shape here, so neither may pass.
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane9', session: 'a' }, team, none)).toBe(false);
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'a' }, team, none)).toBe(false);
    const verdict = callerVerdict({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'a' }, 'codex-acme', none);
    expect(verdict).toEqual({ kind: 'no-pane', name: 'codex-acme' });
    expect(noPaneRefusal('codex-acme')).toBe(
      'no pane is recorded for seat codex-acme in this session: a lead stops that seat and runs `team up`',
    );
    // Another session is refused before the missing pane is even consulted.
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane9', session: 'b' }, team, none)).toBe(false);
  });

  test('the placement is mandatory: a caller with no session is refused against a standing', () => {
    // The name alone proves no placement, so no caller is admitted by it: every judgement asks
    // for a standing, and a caller main's placement produced (no session) is refused.
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'pane2' }, team, where)).toBe(false);
    expect(callerStanding({ kind: 'seat', name: 'codex-acme', pane: 'pane2' }, 'codex-acme', where)).toBe(false);
  });

  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('the recorded pane comes from the state: unreadable, another session or another name records none', () => {
    // The folder `readState` reads: the `.agents` directory.
    const dir = mkdtempSync(join(tmpdir(), 'team-caller-'));
    made.push(dir);
    const state = join(dir, 'team.state.json');
    writeFileSync(state, JSON.stringify({ format: 1, sessions: { a: { seats: { lead: { stage: 'ready', pane: 'pane1' } }, worktrees: {} } } }));
    expect(recordedPaneOf(dir, 'a', 'lead')).toBe('pane1');
    expect(recordedPaneOf(dir, 'a', 'worker')).toBeUndefined();
    expect(recordedPaneOf(dir, 'b', 'lead')).toBeUndefined();
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'pane1', session: 'a' };
    expect(standingOf(dir, 'a', caller)).toEqual({ session: 'a', recordedPane: 'pane1', stage: 'ready' });
    expect(standingOf(dir, 'a', { kind: 'owner' })).toEqual({ session: 'a', recordedPane: undefined });
    // A state that can't be read records none: the caller check must never become a stack trace.
    writeFileSync(state, '{ not a state');
    expect(recordedPaneOf(dir, 'a', 'lead')).toBeUndefined();
  });
});

describe('reading the process table', () => {
  test('the test runner\'s parents are read by name, nearest first, to the top', () => {
    const ancestors = readAncestors(process.pid);
    if (!ancestors) throw new Error('the walk did not reach the top');
    expect(ancestors[0]?.pid).toBe(process.pid);
    expect(ancestors.length).toBeGreaterThan(1);
    for (const one of ancestors) expect(one.name).not.toContain('/');
  });

  const table: Record<number, { ppid: number; name: string }> = {
    210: { ppid: 200, name: 'zsh' },
    200: { ppid: 10, name: 'claude' },
    10: { ppid: 1, name: 'herdr' },
  };

  test('a complete walk ends at the system\'s first process', () => {
    expect(readAncestors(210, (pid) => table[pid] ?? null)?.map((one) => one.name)).toEqual(['zsh', 'claude', 'herdr']);
  });

  test('a process that can\'t be read makes the walk incomplete, not shorter', () => {
    // Cut below the herdr server: a shorter list would look like a plain terminal.
    expect(readAncestors(210, (pid) => (pid === 10 ? null : table[pid] ?? null))).toBeNull();
  });

  test('a chain that never ends is incomplete', () => {
    expect(readAncestors(5, () => ({ ppid: 5, name: 'loop' }))).toBeNull();
  });

  // A captured /proc tree, as Linux writes one: the same ancestors the table above names.
  const linuxProc = new URL('./fixtures/linux/proc', import.meta.url).pathname;

  test('Linux walks /proc and answers what the table above answers', () => {
    expect(readAncestors(210, (pid) => readWithProc(pid, linuxProc))).toEqual([
      { pid: 210, name: 'zsh' },
      { pid: 200, name: 'claude' },
      { pid: 10, name: 'herdr' },
    ]);
  });

  test('a line of /proc/<pid>/stat: the name may hold a space or a parenthesis', () => {
    const line = '210 (zsh) S 200 210 210 34816 210 4194304 1185 0 0 0 12 5 0 0 20 0 1 0 1234567 12345678 1234 18446744073709551615 0 0 0';
    expect(parseStat(line)).toEqual({ ppid: 200, name: 'zsh' });
    // The last parenthesis closes the name, whatever the name holds.
    expect(parseStat(line.replace('(zsh)', '(tmux: server (2))'))).toEqual({ ppid: 200, name: 'tmux: server (2)' });
  });

  test('a line of /proc that holds no parent places nobody, and so does one that can\'t be read', () => {
    expect(parseStat('')).toBeNull();
    expect(parseStat('210 (zsh) S')).toBeNull();
    expect(parseStat('nonsense')).toBeNull();
    expect(readWithProc(999_999, linuxProc)).toBeNull();
  });

  test('the platform picks the table: /proc on Linux, ps everywhere else', () => {
    expect(processReader('linux')).toBe(readWithProc);
    expect(processReader('darwin')).toBe(readWithPs);
  });
});

describe('caller verdict parity across placement and send (S1)', () => {
  const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    human: true
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
    model: GPT
    version: "5"
    launch: codex
`;

  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setupTeam(seats: Record<string, { stage: 'ready'; pane?: string }>): {
    root: string;
    agentsDir: string;
    home: string;
    team: NonNullable<Extract<ReturnType<typeof readTeamConfig>, { ok: true }>['team']>;
  } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-s1-parity-')));
    made.push(base);
    const root = join(base, 'acme');
    const agentsDir = join(root, '.agents');
    const home = join(base, 'home');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(agentsDir, 'team.yaml'), TEAM);
    const hooksDir = join(agentsDir, 'hooks', 'acme');
    mkdirSync(hooksDir, { recursive: true });
    const hookSettings = join(hooksDir, 'lead.json');
    writeFileSync(hookSettings, `${JSON.stringify({ crossSessionInbound: 'accept' })}\n`, { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    utimesSync(hookSettings, past, past);
    updateState(agentsDir, (state) => {
      state.sessions.acme = { seats } as never;
    });
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) throw new Error(loaded.error);
    return { root, agentsDir, home, team: loaded.team };
  }

  function sendHost(home: string): SendHost {
    const socks = join(home, 'socks');
    mkdirSync(socks, { recursive: true });
    writeFileSync(join(socks, '101.sock'), '');
    return {
      home,
      now: () => new Date('2026-11-05T12:00:00.000Z'),
      newId: () => '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
      agents: () => [
        { name: 'lead', pane: 'pane1', cli: 'claude' },
        { name: 'worker', pane: 'pane2', cli: 'claude' },
      ],
      processInfo: (_session, pane) => {
        if (pane === 'pane1') return { shell: 100, foreground: [101] };
        if (pane === 'pane2') return { shell: 200, foreground: [201] };
        return null;
      },
      socketsDir: socks,
      deliver: async () => ({ outcome: 'delivered' }),
      native: {
        stage: () => false,
        deliver: () => true,
        paneText: () => '',
        foregroundCwd: () => null,
        status: () => 'idle',
      },
      sleep: async () => {},
    };
  }

  test('a seat pane: ancestor chain in the recorded pane places the seat and admits send', async () => {
    const { root, agentsDir, home, team } = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane2' },
    });
    const workerChain: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }];
    const io = testIo(root);
    delete io.caller;
    io.callerSources = () => sources(workerChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane2')],
      paneRootPid: (pane) => ({ pane1: 100, pane2: 200 })[pane] ?? null,
    });

    const judged = judgeCallerIn(io, agentsDir, team);
    expect(judged.caller).toEqual({ kind: 'seat', name: 'worker', pane: 'pane2', session: 'acme' });
    expect(callerVerdict(judged.caller, 'worker', standingOf(agentsDir, judged.session, judged.caller))).toEqual({ kind: 'ok' });

    const code = await runSend(['lead', 'hello from worker'], io, sendHost(home));
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('lead: queued, not woken (drop');
  });

  test('a non-seat pane: agentless pane whose root pid vouches is placed as a pane and refused by send', async () => {
    const { root, agentsDir, home, team } = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane2' },
    });
    const shellChain: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    const io = testIo(root, undefined, { HERDR_PANE_ID: 'pane9' });
    delete io.caller;
    io.callerSources = () => sources(shellChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane2')],
      env: { HERDR_PANE_ID: 'pane9' },
      paneRootPid: (pane) => ({ pane1: 100, pane2: 200, pane9: 900 })[pane] ?? null,
    });

    const judged = judgeCallerIn(io, agentsDir, team);
    expect(judged.caller).toEqual({ kind: 'pane', pane: 'pane9', session: 'acme' });
    expect(judged.verdict).toEqual({ kind: 'refused' });
    expect(describeCaller(judged.shown)).toBe('it runs in pane acme/pane9, which no grant lists');

    const code = await runSend(['lead', 'from non-seat pane'], io, sendHost(home));
    expect(code).toBe(1);
    expect(io.err).toContain('it runs in pane acme/pane9, which no grant lists');
  });

  test('an unplaced caller: incomplete walk, unnamed pane, detached CLI, and unattended flag each refuse with their exact reason', async () => {
    const { root, agentsDir, home, team } = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane2' },
    });

    const cases: Array<{ label: string; makeSources: () => CallerSources; expectedReason: RegExp }> = [
      {
        label: 'incomplete ancestor walk',
        makeSources: () => sources(terminal, { ancestors: () => null }),
        expectedReason: /parent processes can't be read to the top/,
      },
      {
        label: 'pane without an agent and no vouched root pid',
        makeSources: () => sources([{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }], {
          agents: () => [agent('lead', 'pane1')],
          paneRootPid: (pane) => (pane === 'pane1' ? 100 : null),
        }),
        expectedReason: /pane without an agent/,
      },
      {
        label: 'unnamed agent in pane',
        makeSources: () => sources([{ pid: 300, name: 'claude' }, { pid: 10, name: 'herdr' }]),
        expectedReason: /runs in pane pane3, whose agent has no .* name/,
      },
      {
        label: 'detached CLI outside the terminal host',
        makeSources: () => sources([{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }, { pid: 40, name: 'zsh' }], {
          env: { HERDR_PANE_ID: 'pane1' },
        }),
        expectedReason: /detached from that pane/,
      },
      {
        label: 'AGENT_UNATTENDED set in environment',
        makeSources: () => sources(terminal, { env: { AGENT_UNATTENDED: '1' } }),
        expectedReason: /AGENT_UNATTENDED is set/,
      },
    ];

    for (const one of cases) {
      const io = testIo(root);
      delete io.caller;
      io.callerSources = () => one.makeSources();

      const judged = judgeCallerIn(io, agentsDir, team);
      expect(judged.caller.kind).toBe('unplaced');
      expect(judged.verdict).toEqual({ kind: 'refused' });
      expect(describeCaller(judged.shown)).toMatch(one.expectedReason);

      const code = await runSend(['lead', `attempt: ${one.label}`], io, sendHost(home));
      expect(code).toBe(1);
      expect(io.err).toMatch(one.expectedReason);
    }
  });

  test('a caller whose pane changed: another-pane and no-pane verdicts match state and refuse send', async () => {
    // 1. State records pane2 for worker, but worker's ancestor chain is now in pane9.
    const moved = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane2' },
    });
    const movedChain: Process[] = [{ pid: 910, name: 'zsh' }, { pid: 900, name: 'claude' }, { pid: 10, name: 'herdr' }];
    const movedIo = testIo(moved.root);
    delete movedIo.caller;
    movedIo.callerSources = () => sources(movedChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane9')],
      paneRootPid: (pane) => ({ pane1: 100, pane9: 900 })[pane] ?? null,
    });

    const movedJudged = judgeCallerIn(movedIo, moved.agentsDir, moved.team);
    expect(movedJudged.caller).toEqual({ kind: 'seat', name: 'worker', pane: 'pane9', session: 'acme' });
    expect(callerVerdict(movedJudged.caller, 'worker', standingOf(moved.agentsDir, movedJudged.session, movedJudged.caller))).toEqual({
      kind: 'another-pane',
      name: 'worker',
      recordedPane: 'pane2',
    });

    const movedCode = await runSend(['lead', 'from moved pane'], movedIo, sendHost(moved.home));
    expect(movedCode).toBe(1);
    expect(movedIo.err).toContain(anotherPaneRefusal('worker', 'pane2'));

    // 2. State records no pane for worker.
    const unrecorded = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready' },
    });
    const workerChain: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }];
    const unrecordedIo = testIo(unrecorded.root);
    delete unrecordedIo.caller;
    unrecordedIo.callerSources = () => sources(workerChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane2')],
      paneRootPid: (pane) => ({ pane1: 100, pane2: 200 })[pane] ?? null,
    });

    const unrecordedJudged = judgeCallerIn(unrecordedIo, unrecorded.agentsDir, unrecorded.team);
    expect(unrecordedJudged.caller).toEqual({ kind: 'seat', name: 'worker', pane: 'pane2', session: 'acme' });
    expect(callerVerdict(unrecordedJudged.caller, 'worker', standingOf(unrecorded.agentsDir, unrecordedJudged.session, unrecordedJudged.caller))).toEqual({
      kind: 'no-pane',
      name: 'worker',
    });

    const unrecordedCode = await runSend(['lead', 'from unrecorded pane'], unrecordedIo, sendHost(unrecorded.home));
    expect(unrecordedCode).toBe(1);
    expect(unrecordedIo.err).toContain(noPaneRefusal('worker'));
  });

  test('an impostor ancestor chain: forged HERDR_PANE_ID or non-ancestor pane root never grants another seat\'s identity', async () => {
    const { root, agentsDir, home, team } = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane99' },
    });

    // Impostor 1: caller's ancestor chain is in pane2 (root pid 200, named worker), while env claims
    // HERDR_PANE_ID=pane1 (lead's recorded pane, root pid 100). Placement follows the ancestor pids
    // (200 -> worker on pane2), never the forged environment variable, and refuses because worker's
    // recorded pane is pane99.
    const impostorSeatChain: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }];
    const ioSeat = testIo(root, undefined, { HERDR_PANE_ID: 'pane1', HERDR_SESSION: 'acme' });
    delete ioSeat.caller;
    ioSeat.callerSources = () => sources(impostorSeatChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane2')],
      env: { HERDR_PANE_ID: 'pane1', HERDR_SESSION: 'acme' },
      paneRootPid: (pane) => ({ pane1: 100, pane2: 200 })[pane] ?? null,
    });

    const judgedSeat = judgeCallerIn(ioSeat, agentsDir, team);
    expect(judgedSeat.caller).toEqual({ kind: 'seat', name: 'worker', pane: 'pane2', session: 'acme' });
    expect(callerVerdict(judgedSeat.caller, 'worker', standingOf(agentsDir, judgedSeat.session, judgedSeat.caller))).toEqual({
      kind: 'another-pane',
      name: 'worker',
      recordedPane: 'pane99',
    });

    const seatCode = await runSend(['worker', 'impostor claiming lead pane'], ioSeat, sendHost(home));
    expect(seatCode).toBe(1);
    expect(ioSeat.err).toContain(anotherPaneRefusal('worker', 'pane99'));

    // Impostor 2: agentless shell in pane9 (root pid 900) forges HERDR_PANE_ID=pane1 (lead's pane,
    // root pid 100). Because pid 100 is not in the caller's ancestor chain [900, 10], placement
    // refuses to vouch pane1 and returns unplaced.
    const impostorShellChain: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    const ioShell = testIo(root, undefined, { HERDR_PANE_ID: 'pane1' });
    delete ioShell.caller;
    ioShell.callerSources = () => sources(impostorShellChain, {
      agents: () => [agent('lead', 'pane1'), agent('worker', 'pane2')],
      env: { HERDR_PANE_ID: 'pane1' },
      paneRootPid: (pane) => ({ pane1: 100, pane2: 200, pane9: 900 })[pane] ?? null,
    });

    const judgedShell = judgeCallerIn(ioShell, agentsDir, team);
    expect(judgedShell.caller).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/pane without an agent/) });
    expect(judgedShell.verdict).toEqual({ kind: 'refused' });

    const shellCode = await runSend(['lead', 'impostor shell claiming lead pane'], ioShell, sendHost(home));
    expect(shellCode).toBe(1);
    expect(ioShell.err).toMatch(/pane without an agent/);
  });

  test('parsePsSnapshot reads pid, ppid, and command name from one process snapshot', () => {
    const raw = [
      '    1     0 /sbin/launchd',
      '   10     1 /opt/homebrew/bin/herdr',
      '  200    10 -zsh',
      '  210   200 /Applications/Claude.app/Contents/MacOS/claude',
      'nonsense line',
      '',
    ].join('\n');
    const snapshot = parsePsSnapshot(raw);
    expect(snapshot.get(1)).toEqual({ ppid: 0, name: 'launchd' });
    expect(snapshot.get(10)).toEqual({ ppid: 1, name: 'herdr' });
    expect(snapshot.get(200)).toEqual({ ppid: 10, name: 'zsh' });
    expect(snapshot.get(210)).toEqual({ ppid: 200, name: 'claude' });
  });

  test('runSend computes caller ancestry and terminal-host snapshots once across gate, prologue, and preflights', async () => {
    const { root, home } = setupTeam({
      lead: { stage: 'ready', pane: 'pane1' },
      worker: { stage: 'ready', pane: 'pane2' },
    });
    const workerChain: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'codex' }, { pid: 10, name: 'herdr' }];

    let ancestorsCalls = 0;
    let callerAgentsCalls = 0;
    const callerPaneRootCalls = new Map<string, number>();

    const io = testIo(root);
    delete io.caller;
    io.callerSources = () => ({
      ancestors: () => {
        ancestorsCalls += 1;
        return workerChain;
      },
      agents: () => {
        callerAgentsCalls += 1;
        return [agent('lead', 'pane1'), agent('worker', 'pane2')];
      },
      paneRootPid: (pane) => {
        callerPaneRootCalls.set(pane, (callerPaneRootCalls.get(pane) ?? 0) + 1);
        return ({ pane1: 100, pane2: 200 })[pane] ?? null;
      },
      env: {},
      stdinIsTTY: true,
    });

    let hostAgentsCalls = 0;
    let paneTextCalls = 0;
    const baseHost = sendHost(home);
    const countingHost: SendHost = {
      ...baseHost,
      agents: (session) => {
        hostAgentsCalls += 1;
        return baseHost.agents(session);
      },
      native: {
        ...baseHost.native,
        paneText: (session, pane) => {
          paneTextCalls += 1;
          return baseHost.native.paneText?.(session, pane) ?? '';
        },
      },
    };

    const code = await runSend(['lead', 'single-snapshot check'], io, countingHost);
    expect(code).toBe(0);
    expect(ancestorsCalls).toBe(1);
    expect(callerAgentsCalls).toBe(1);
    expect(callerPaneRootCalls.get('pane1') ?? 0).toBeLessThanOrEqual(1);
    expect(callerPaneRootCalls.get('pane2') ?? 0).toBeLessThanOrEqual(1);
    expect(hostAgentsCalls).toBeLessThanOrEqual(1);
    expect(paneTextCalls).toBeLessThanOrEqual(1);
  });
});
