// A terminal on a machine whose owner seat is pinned from another machine is not the owner, in any
// mode: the placement reads it as unplaced, dev mode lifts nothing for it, and an owner-only
// command refuses it. A machine with a local owner (macOS with its own signer today) places the
// terminal as the owner, exactly as before. Process sources are fakes; homes are temporary; no
// terminal host is started.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPinnedTerminal, PINNED_TERMINAL_REASON, placeCaller, walkCaller, type Caller, type CallerSources } from '../src/caller.ts';
import { ownerPinPresent, ownerSeatPinFile } from '../src/client/owner-pin-path.ts';
import { runInit } from '../src/commands/init.ts';
import { devModeState, resolveDevMode } from '../src/dev_mode.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

function tempHome(label: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `pinned-terminal-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  return home;
}

const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'p1', session: 'acme' };
const PINNED: Caller = { kind: 'unplaced', reason: PINNED_TERMINAL_REASON, pinned: true };

/** A terminal's process sources outside herdr: a shell under the remote login, no agent CLI. */
function terminalSources(overrides: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => [{ pid: 400, name: 'zsh' }, { pid: 300, name: 'sshd' }],
    agents: () => [],
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: true,
    ...overrides,
  };
}

describe('a terminal on a pinned machine is not the owner', () => {
  test('placement: unplaced with a terminal or without one; a machine with a local owner is unchanged', () => {
    const pinned = placeCaller(terminalSources({ ownerSignsElsewhere: () => true }));
    expect(pinned).toEqual({ kind: 'unplaced', reason: PINNED_TERMINAL_REASON, pinned: true });
    expect(isPinnedTerminal(pinned)).toBe(true);
    expect(placeCaller(terminalSources({ ownerSignsElsewhere: () => true, stdinIsTTY: false }))).toMatchObject({ kind: 'unplaced', pinned: true });
    // The same terminal where the owner's signer is local: the owner, and the no-terminal owner, as before.
    expect(placeCaller(terminalSources())).toEqual({ kind: 'owner' });
    expect(placeCaller(terminalSources({ ownerSignsElsewhere: () => false }))).toEqual({ kind: 'owner' });
    expect(placeCaller(terminalSources({ stdinIsTTY: false }))).toEqual({ kind: 'owner-no-tty' });
    expect(isPinnedTerminal({ kind: 'unplaced', reason: PINNED_TERMINAL_REASON })).toBe(false);
    // The walk without a session reads the same.
    expect(walkCaller({ env: {}, stdinIsTTY: true, callerSources: () => terminalSources({ ownerSignsElsewhere: () => true }) })).toMatchObject({ kind: 'unplaced', pinned: true });
    expect(walkCaller({ env: {}, stdinIsTTY: true, callerSources: () => terminalSources() })).toEqual({ kind: 'owner' });
    // An agent outside herdr stays the agent it was: the pin changes no other reading.
    expect(placeCaller(terminalSources({ ownerSignsElsewhere: () => true, ancestors: () => [{ pid: 500, name: 'claude' }, { pid: 400, name: 'zsh' }] }))).toMatchObject({ kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' });
  });

  test('no environment variable makes the pinned terminal the owner', () => {
    for (const env of [{ TEAMCLI_DEV_MODE: '1' }, { HOME: '/nowhere' }, { HERDR_PANE_ID: '' }, { TEAM_CONFIG_SOURCE: 'file' }]) {
      expect(placeCaller(terminalSources({ env, ownerSignsElsewhere: () => true }))).toMatchObject({ kind: 'unplaced', pinned: true });
    }
  });

  test('dev mode lifts nothing for the pinned terminal; a placed seat and a local owner keep it', () => {
    const env = { TEAMCLI_DEV_MODE: '1' };
    const pinnedRun = resolveDevMode('init', { env, stdinIsTTY: true, caller: PINNED });
    expect(pinnedRun.on).toBe(false);
    expect(pinnedRun.pinnedTerminal).toBe(true);
    expect(devModeState({ env, stdinIsTTY: true, caller: PINNED }).on).toBe(false);
    // The pinned terminal placed by its own sources, not handed in: the same answer.
    expect(resolveDevMode('up', { env, stdinIsTTY: true, callerSources: () => terminalSources({ ownerSignsElsewhere: () => true }) }).on).toBe(false);
    expect(resolveDevMode('init', { env, stdinIsTTY: true, caller: LEAD }).on).toBe(true);
    expect(resolveDevMode('init', { env, stdinIsTTY: true, caller: OWNER }).on).toBe(true);
    expect(resolveDevMode('up', { env, stdinIsTTY: true, callerSources: () => terminalSources() }).on).toBe(true);
    expect(devModeState({ env, stdinIsTTY: true, caller: LEAD }).on).toBe(true);
  });

  test('team init from the pinned terminal is refused in dev mode, with the owner line, and writes nothing', async () => {
    const home = tempHome('init');
    const root = join(home, 'code', 'fresh');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const io = testIo(root, PINNED);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runInit([], io, home, undefined, { loggedIn: () => true, now: () => NOW })).toBe(1);
    expect(io.err + io.out).toContain('only the owner runs this');
    expect(io.err + io.out).toContain(PINNED_TERMINAL_REASON);
    expect(io.err + io.out).not.toContain('dev mode continues');
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
  });
});

describe('what counts as a pin', () => {
  test('anything at the pin\'s path counts, so damaging it never turns a terminal back into the owner', () => {
    const home = tempHome('present');
    expect(ownerPinPresent(home)).toBe(false);
    writeFileSync(ownerSeatPinFile(home), 'not a pin at all');
    expect(ownerPinPresent(home)).toBe(true);
    rmSync(ownerSeatPinFile(home));
    mkdirSync(ownerSeatPinFile(home));
    expect(ownerPinPresent(home)).toBe(true);
    // A home with no config folder at all has no pin.
    expect(ownerPinPresent(join(home, 'missing'))).toBe(false);
  });
});
