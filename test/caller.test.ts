import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callerLabel,
  callerStanding,
  callerVerdict,
  describeCaller,
  isOwner,
  mayChangeTeam,
  mayLaunchSeats,
  noPaneRefusal,
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
import type { HerdrAgent } from '../src/herdr.ts';

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
    // At launch (before `rename` runs) or right after a restore, herdr lists the pane with `name: null`,
    // or has not listed the agent yet while `paneRootPid` vouches that the pane exists in the session.
    expect(placeCaller(sources(underEndpoint, {
      env: { HERDR_PANE_ID: 'pane3' },
      managedEndpointSeat: (pid) => (pid === 900 ? { session: 'main', seat: 'codex-acme', pane: 'pane3' } : null),
    }), 'main')).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane3', session: 'main' });
    expect(placeCaller(sources(underEndpoint, {
      agents: () => [],
      paneRootPid: (pane) => (pane === 'pane2' ? 200 : null),
      env,
      managedEndpointSeat: served,
    }), 'main')).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'pane2', session: 'main' });
    // Another session, a pane herdr lists under another name, a pane herdr does not know, or a silent herdr places nobody.
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: served }), 'other'))
      .toMatchObject({ kind: 'unplaced' });
    expect(placeCaller(sources(underEndpoint, { env, managedEndpointSeat: () => ({ session: 'main', seat: 'codex-acme', pane: 'pane1' }) }), 'main'))
      .toMatchObject({ kind: 'unplaced' });
    expect(placeCaller(sources(underEndpoint, {
      agents: () => [],
      paneRootPid: () => null,
      env,
      managedEndpointSeat: served,
    }), 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
    expect(placeCaller(sources(underEndpoint, {
      agents: () => null,
      env,
      managedEndpointSeat: served,
    }), 'main')).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/detached from that pane/) });
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
