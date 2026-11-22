// A terminal on a machine whose owner seat is pinned from another machine is not the owner, in any
// mode: the placement reads it as unplaced, dev mode lifts nothing on that machine for any caller,
// and an owner-only command refuses it. A machine with a local owner places the terminal as the
// owner, exactly as before. Process sources are fakes; homes are temporary (the suite's preload
// keeps each scene's owner state in the home it passes); no terminal host is started.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPinnedTerminal, PINNED_TERMINAL_REASON, placeCaller, walkCaller, type Caller, type CallerSources } from '../src/caller.ts';
import { machineFile, ownerMachinePinned, ownerSeatPinFile, ownerStateOf } from '../src/client/owner-pin-path.ts';
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

/** A home whose machine counts as pinned: something stands at the pin's path. */
function pinnedHome(label: string): string {
  const home = tempHome(label);
  writeFileSync(ownerSeatPinFile(home), 'pinned');
  return home;
}

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

  test('dev mode lifts nothing on a pinned machine, decided by the machine and not the caller', () => {
    const env = { TEAMCLI_DEV_MODE: '1' };
    const pinned = pinnedHome('dev');
    const local = tempHome('dev-local');
    for (const command of ['init', 'up', 'add', 'remove'] as const) {
      const run = resolveDevMode(command, { env }, { home: pinned });
      expect(run.on, command).toBe(false);
      expect(run.pinnedMachine).toBe(true);
      expect(resolveDevMode(command, { env }, { home: local }).on, command).toBe(true);
    }
    expect(devModeState({ env }, { home: pinned }).on).toBe(false);
    expect(devModeState({ env }, { home: local }).on).toBe(true);
  });

  test('on a pinned machine, team init in dev mode is refused for every caller: the terminal, an agent outside herdr, an unattended run, a placed lead', async () => {
    const callers: Caller[] = [
      PINNED,
      { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' },
      { kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' },
      LEAD,
    ];
    for (const caller of callers) {
      const home = pinnedHome('init');
      const root = join(home, 'code', 'fresh');
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      const io = testIo(root, caller);
      io.env = { TEAMCLI_DEV_MODE: '1', AGENT_UNATTENDED: '1' };
      expect(await runInit([], io, home, undefined, { loggedIn: () => true, now: () => NOW }), JSON.stringify(caller)).toBe(1);
      expect(io.err + io.out).toContain('only the owner runs this');
      expect(io.err + io.out).not.toContain('dev mode continues');
      expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
    }
    // The same agent on a machine that is not pinned: dev mode folds the gate, as before.
    const home = tempHome('init-local');
    const root = join(home, 'code', 'fresh');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const io = testIo(root, { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    await runInit([], io, home, undefined, { loggedIn: () => true, now: () => NOW });
    expect(io.err + io.out).toContain('dev mode continues');
  });
});

describe('what counts as a pinned machine', () => {
  test('anything at the pin\'s, the machine record\'s or the ledger\'s path counts, and a parent that is not a folder fails closed', () => {
    const home = tempHome('present');
    expect(ownerMachinePinned(home)).toBe(false);
    writeFileSync(ownerSeatPinFile(home), 'not a pin at all');
    expect(ownerMachinePinned(home)).toBe(true);
    rmSync(ownerSeatPinFile(home));
    mkdirSync(ownerSeatPinFile(home));
    expect(ownerMachinePinned(home)).toBe(true);
    // The pin gone, the machine record left: pinned once, so still pinned.
    const once = tempHome('once');
    writeFileSync(machineFile(once), '{}');
    expect(ownerMachinePinned(once)).toBe(true);
    const ledger = tempHome('ledger');
    mkdirSync(join(ledger, '.config', 'team', 'owner-ledger'));
    expect(ownerMachinePinned(ledger)).toBe(true);
    // The config folder replaced by a file: the state cannot be read, so the machine is pinned.
    const broken = tempHome('broken');
    rmSync(join(broken, '.config', 'team'), { recursive: true });
    writeFileSync(join(broken, '.config', 'team'), 'a file');
    expect(ownerStateOf(broken).kind).toBe('refused');
    expect(ownerMachinePinned(broken)).toBe(true);
    // A home with no config folder at all was never pinned.
    expect(ownerMachinePinned(join(home, 'missing'))).toBe(false);
  });
});
