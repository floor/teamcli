// A CLI that sandboxes its shell commands (Claude Code's Bash sandbox runs a chained or looped
// command inside a Seatbelt profile, and a lone `team …` outside it) leaves a `team` command it
// sandboxed unable to read its parents: `ps` is refused and the kernel reader is off under any
// profile. Such a caller stays unplaced, exactly as before. The refusal now says why and what
// works (the command on its own), and the reader's failures are not repeated on stderr.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  noteAncestorFailure,
  placeCaller,
  SANDBOXED_WALK_REASON,
  UNREAD_WALK_REASON,
  walkCaller,
  type CallerSources,
} from '../src/caller.ts';

const base = (over: Partial<CallerSources>): CallerSources => ({
  ancestors: () => null,
  agents: () => null,
  paneRootPid: () => null,
  env: { HERDR_PANE_ID: 'pane-k' },
  stdinIsTTY: false,
  ...over,
});

describe('an unreadable walk inside a sandbox', () => {
  test('stays unplaced, with the sandbox reason', () => {
    const caller = placeCaller(base({ sandboxed: () => true, confinedSeat: () => null }), 's');
    expect(caller).toEqual({ kind: 'unplaced', reason: SANDBOXED_WALK_REASON });
  });

  test('the reason names the remedy: the command on its own', () => {
    expect(SANDBOXED_WALK_REASON).toContain('as a command of its own');
  });

  test('outside a sandbox the reason is unchanged', () => {
    expect(placeCaller(base({ sandboxed: () => false }), 's')).toEqual({ kind: 'unplaced', reason: UNREAD_WALK_REASON });
    expect(placeCaller(base({}), 's')).toEqual({ kind: 'unplaced', reason: UNREAD_WALK_REASON });
  });

  test('a proved confinement still places the seat; the flag never decides placement', () => {
    const proved = () => ({ name: 'keeper', session: 's', dir: '/x' });
    expect(placeCaller(base({ sandboxed: () => true, confinedSeat: proved }), 's'))
      .toEqual({ kind: 'seat', name: 'keeper', pane: 'pane-k', session: 's', confined: true });
    expect(placeCaller(base({ sandboxed: () => false, confinedSeat: proved }), 's'))
      .toEqual({ kind: 'seat', name: 'keeper', pane: 'pane-k', session: 's', confined: true });
  });

  test('a readable walk is placed the same whatever the flag says', () => {
    const ancestors = () => [{ pid: 40, name: 'zsh' }, { pid: 30, name: 'login' }, { pid: 1, name: 'launchd' }];
    const off = placeCaller(base({ ancestors, env: {}, sandboxed: () => false }), 's');
    const on = placeCaller(base({ ancestors, env: {}, sandboxed: () => true }), 's');
    expect(on).toEqual(off);
  });

  test('walkCaller words its refusal the same way', () => {
    const io = { env: {}, stdinIsTTY: false, callerSources: () => base({ sandboxed: () => true }) };
    expect(walkCaller(io)).toEqual({ kind: 'unplaced', reason: SANDBOXED_WALK_REASON });
    const plain = { env: {}, stdinIsTTY: false, callerSources: () => base({}) };
    expect(walkCaller(plain)).toEqual({ kind: 'unplaced', reason: UNREAD_WALK_REASON });
  });
});

describe('the reader failure note', () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { spy?.mockRestore(); spy = undefined; });

  test('one line per cause per process', () => {
    spy = spyOn(console, 'error').mockImplementation(() => {});
    const cause = `snapshot unread (reader failed) ${Math.random()}`;
    for (let i = 0; i < 6; i += 1) noteAncestorFailure(cause);
    noteAncestorFailure(`${cause} other`);
    const lines: string[] = spy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.filter((line) => line === `team caller: ${cause}`)).toHaveLength(1);
    expect(lines.filter((line) => line === `team caller: ${cause} other`)).toHaveLength(1);
  });
});

const seatbelt = process.platform === 'darwin' && process.versions.bun !== undefined && existsSync('/usr/bin/sandbox-exec');

describe.skipIf(!seatbelt)('inside a real Seatbelt profile (macOS)', () => {
  const src = resolve(import.meta.dir, '..', 'src');
  const dir = mkdtempSync(join(tmpdir(), 'sandboxed-walk-'));
  const script = join(dir, 'walk.ts');
  writeFileSync(script, [
    `import { walkCaller, noteAncestorFailure } from ${JSON.stringify(join(src, 'caller.ts'))};`,
    `import { runsInSeatbelt } from ${JSON.stringify(join(src, 'process-kernel.ts'))};`,
    'const caller = walkCaller({ env: {}, stdinIsTTY: false });',
    'noteAncestorFailure("probe");',
    'console.log(JSON.stringify({ sandboxed: runsInSeatbelt(), caller }));',
  ].join('\n'));
  test('outside any profile the process is not sandboxed', () => {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(out.trim().split('\n').pop()!).sandboxed).toBe(false);
  });

  test('a profile that refuses ps: sandboxed, unplaced with the sandbox reason, no note lines', () => {
    const profile = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))';
    const args = ['-p', profile, process.execPath, script];
    const result = execFileSync('/bin/sh', ['-c', '"$0" "$@" 2>&1', '/usr/bin/sandbox-exec', ...args], { encoding: 'utf8' });
    const lines = result.trim().split('\n');
    const seen = JSON.parse(lines.pop()!);
    expect(seen.sandboxed).toBe(true);
    expect(seen.caller).toEqual({ kind: 'unplaced', reason: SANDBOXED_WALK_REASON });
    expect(lines.filter((line) => line.startsWith('team caller:'))).toEqual([]);
  });
});
