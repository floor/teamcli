// The three names every object inherits cannot be a session, and the team file's session field
// is not the only door a name reaches the state by: a command line's `--session` replaces the
// file's own name after the file validated (`runWatch`, `up`), so the flag itself is refused —
// at the parse, before the command reads a file, a state record or a host, and before the watch's
// beat can write through the name. These scenes are that door on every command that takes one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../src/args.ts';
import { main } from '../src/cli.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { INHERITED_SESSION_NAMES, sessionNameRefusal } from '../src/session-names.ts';
import { STATE_FILE, emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { gitEnv, testIo } from './helpers.ts';

const NAMES = ['__proto__', 'constructor', 'prototype'] as const;

// Every command whose line takes `--session` (the flag list each `readArgs` names, and `check`,
// which parses its own line). A command added to that set without a scene here is still refused:
// the rule is in the parser both lines reach.
const SESSION_COMMANDS = [
  'add', 'answer', 'archive', 'brief', 'check', 'doctor', 'down', 'drops', 'mcp',
  'register', 'remove', 'rename', 'restart', 'seat', 'seats', 'status', 'up', 'watch', 'worktree',
] as const;

const TEAM_YAML = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ROOT
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
`;

let base: string;
let root: string;
let home: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'session-override-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM_YAML.replace('ROOT', root));
});

afterEach(() => {
  // A red run of the watch scene can leave the probe on the shared prototype; the scene removes
  // it in its own finally, and this is the belt behind that.
  delete (Object.prototype as { watch?: unknown }).watch;
  rmSync(base, { recursive: true, force: true });
});

const quiet: Live = { running: false, agents: [], workspaces: [], screens: {} };
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

/** A source set that runs one pass and stops, so a run that is not refused ends on its own. */
function onePass(seen: string[]): WatchSources {
  const note = (name: string) => {
    seen.push(name);
  };
  return {
    live: () => {
      note('live');
      return quiet;
    },
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => {
      note('screen');
      return null;
    },
    status: () => {
      note('status');
      return null;
    },
    foreground: () => {
      note('foreground');
      return null;
    },
    typeText: () => {
      note('typeText');
      return false;
    },
    pressEnter: () => {
      note('pressEnter');
      return false;
    },
    sleep: async () => {},
    notify: () => {
      note('notify');
    },
    now: () => new Date('2026-11-01T09:00:00Z'),
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
  };
}

describe('the runWatch override', () => {
  test('an inherited name is refused before the file loads, a host is called or a beat is written', async () => {
    const seen: string[] = [];
    const io = testIo(root, { kind: 'owner' });
    let code: number | undefined;
    let thrown: unknown;
    let inherited: unknown;
    try {
      code = await runWatch(['--file', '.agents/team.yaml', '--session', '__proto__'], io, onePass(seen));
    } catch (error) {
      thrown = error;
    } finally {
      // The beat writes through `state.sessions[session]`; a run that reached it leaves the
      // record on the shared prototype, which is exactly what this scene must never see.
      inherited = (Object.prototype as { watch?: unknown }).watch;
      delete (Object.prototype as { watch?: unknown }).watch;
    }
    expect(thrown).toBeUndefined();
    expect(code).toBe(2);
    expect(io.err).toContain(sessionNameRefusal('__proto__') as string);
    // Nothing was read from a host and nothing was written beside the file: the refusal is the
    // parse's, which runs before `currentTeam`, `readState` and the first pass.
    expect(seen).toEqual([]);
    expect(inherited).toBeUndefined();
    expect(existsSync(join(root, '.agents', STATE_FILE))).toBe(false);
  });
});

describe('every command that takes a session', () => {
  for (const name of NAMES) {
    test(`--session ${name} is refused on every line, before any read or write`, async () => {
      const statePath = join(root, '.agents', STATE_FILE);
      const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
      for (const command of SESSION_COMMANDS) {
        const io = testIo(root, { kind: 'owner' });
        const code = await main([command, '--session', name], io);
        expect(code, `team ${command} --session ${name}`).toBe(2);
        expect(io.err, `team ${command} --session ${name}`).toContain(sessionNameRefusal(name) as string);
      }
      // The parse answers every one of the runs above; none reached the file, the caller walk or
      // a state write, so the record beside the file stands exactly as it stood.
      expect(existsSync(statePath) ? readFileSync(statePath, 'utf8') : null).toBe(before);
    });
  }

  test('the inline spelling is refused the same way', async () => {
    for (const command of SESSION_COMMANDS) {
      const io = testIo(root, { kind: 'owner' });
      const code = await main([command, '--session=__proto__'], io);
      expect(code, `team ${command} --session=__proto__`).toBe(2);
      expect(io.err, `team ${command} --session=__proto__`).toContain(sessionNameRefusal('__proto__') as string);
    }
  });
});

describe('the session rule leaves ordinary names alone', () => {
  test('the three inherited names are the whole set', () => {
    expect([...INHERITED_SESSION_NAMES].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
    for (const name of ['acme', 'acme-web', 'default', 'my-team-2', '__proto__x']) {
      expect(sessionNameRefusal(name), name).toBeNull();
    }
  });

  test('a command line with an ordinary session still parses', () => {
    expect(readArgs(['--session', 'acme'], ['session'], [])).toEqual({ values: { session: 'acme' }, flags: new Set(), rest: [] });
    expect(readArgs(['--session=acme'], ['session'], [])).toEqual({ values: { session: 'acme' }, flags: new Set(), rest: [] });
    // A valued option that is not the session is untouched by the rule.
    expect(readArgs(['--file', '__proto__'], ['file'], [])).toEqual({ values: { file: '__proto__' }, flags: new Set(), rest: [] });
    expect(emptySession()).toEqual({ seats: {}, worktrees: {} });
  });
});
