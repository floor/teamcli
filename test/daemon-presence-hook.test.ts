// The Claude adapter for presence (src/launch/cli-hook.ts, src/daemon/presence/hook.ts): the
// settings file a fresh launch loads names one hidden command at turn start and one at turn end,
// each staging one record under the launch's binding. The binding is minted when the launch is
// planned and kept in the state file; a running seat reuses the binding its process loaded, and a
// seat with no recorded binding gets no presence entry at all. Every path below is a temp folder;
// nothing here reads or writes any CLI's home, and no prompt bytes pass through the hook — every
// field is in argv, and the command reads no stdin.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPresenceBinding } from '../src/daemon/presence/contract.ts';
import run from '../src/daemon/presence/hook.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { cliHookSettings, cliHookSettingsPath, cliHookStatePath, installCliHooks, type CliHookSeat } from '../src/launch/cli-hook.ts';
import { readState, STATE_FILE } from '../src/state.ts';

const SESSION = 'teamcli';
const CLAUDE = 'claude --model claude-opus-5-5';
const BINDING = 'prs_0123456789ab';

type Entry = { hooks: { type: string; command: string }[] };
type Settings = { hooks: Record<string, Entry[]> };

const seat = (name: string, fresh?: boolean): CliHookSeat => ({
  name,
  cli: 'claude-code',
  launch: CLAUDE,
  ...(fresh === undefined ? {} : { fresh }),
});

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-presence-hook-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const readSettings = (path: string): Settings => JSON.parse(readFileSync(path, 'utf8')) as Settings;
const commandsOf = (settings: Settings, event: string): string[] =>
  (settings.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
// The word is written unquoted when it is shell-safe (`prs_0123456789ab` is) and quoted otherwise.
const bindingOf = (command: string): string | null => {
  const match = /--binding (?:'([^']*)'|(\S+))/.exec(command);
  return match?.[1] ?? match?.[2] ?? null;
};

describe('the settings entries a launch installs', () => {
  test('turn start runs the working word, then the presence hook; turn end runs idle, then the hook', () => {
    const text = cliHookSettings('/s/worker.json', undefined, undefined, undefined, {
      dir: '/p/.agents',
      session: SESSION,
      seat: 'worker',
      binding: BINDING,
    });
    const settings = JSON.parse(text) as Settings;
    const start = commandsOf(settings, 'UserPromptSubmit');
    const stop = commandsOf(settings, 'Stop');
    expect(start).toHaveLength(2);
    expect(stop).toHaveLength(2);
    expect(start[0]).toContain('"state":"working"');
    expect(start[1]).toContain(' presence-hook ');
    expect(start[1]).toContain('--event turn-start');
    expect(stop[0]).toContain('"state":"idle"');
    expect(stop[1]).toContain('--event turn-end');
    for (const command of [start[1]!, stop[1]!]) {
      expect(command).toContain(`--session ${SESSION}`);
      expect(command).toContain('--seat worker');
      expect(command).toContain(BINDING);
      expect(command).toContain('/p/.agents');
      // Output is discarded and the exit is ignored: a presence fault never breaks the turn.
      expect(command).toContain('>/dev/null 2>&1 || true');
      // Every field is in argv; the CLI's stdin never reaches the hook.
      expect(command).not.toContain('/dev/stdin');
    }
  });

  test('the drop read stays after the presence hook, so the turn still starts reading the folder', () => {
    const text = cliHookSettings('/s/worker.json', { seat: 'worker', session: SESSION }, undefined, null, {
      dir: '/p/.agents',
      session: SESSION,
      seat: 'worker',
      binding: BINDING,
    });
    const start = commandsOf(JSON.parse(text) as Settings, 'UserPromptSubmit');
    expect(start).toHaveLength(3);
    expect(start[1]).toContain(' presence-hook ');
    expect(start[2]).toContain('drops --read');
  });

  test('no presence object, no presence entry: the legacy two-hook file is unchanged', () => {
    const settings = JSON.parse(cliHookSettings('/s/worker.json')) as Settings;
    expect(commandsOf(settings, 'UserPromptSubmit')).toHaveLength(1);
    expect(commandsOf(settings, 'Stop')).toHaveLength(1);
  });
});

describe('which seats get a binding', () => {
  const writeState = (): void => writeFileSync(join(dir, STATE_FILE), '{"format":1,"sessions":{}}\n');

  test('a fresh launch mints a binding, records it, and writes it into the settings argv', () => {
    writeState();
    const landed = installCliHooks(dir, SESSION, [seat('worker', true)]);
    const settings = readSettings(landed.worker!);
    const start = commandsOf(settings, 'UserPromptSubmit')[1] ?? '';
    const recorded = readState(dir).sessions[SESSION]?.seats.worker?.presence_binding;
    expect(isPresenceBinding(recorded)).toBe(true);
    expect(bindingOf(start)).toBe(recorded!);
    expect(bindingOf(commandsOf(settings, 'Stop')[1] ?? '')).toBe(recorded!);
  });

  test('a fresh relaunch rotates the binding, so a predecessor hook is set aside', () => {
    writeState();
    installCliHooks(dir, SESSION, [seat('worker', true)]);
    const first = readState(dir).sessions[SESSION]?.seats.worker?.presence_binding ?? '';
    const landed = installCliHooks(dir, SESSION, [seat('worker', true)]);
    const second = readState(dir).sessions[SESSION]?.seats.worker?.presence_binding ?? '';
    expect(isPresenceBinding(first)).toBe(true);
    expect(isPresenceBinding(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(bindingOf(commandsOf(readSettings(landed.worker!), 'Stop')[1] ?? '')).toBe(second);
  });

  test('a running seat keeps the binding its process loaded; it is never rotated', () => {
    writeState();
    installCliHooks(dir, SESSION, [seat('worker', true)]);
    const minted = readState(dir).sessions[SESSION]?.seats.worker?.presence_binding ?? '';
    const landed = installCliHooks(dir, SESSION, [seat('worker')]);
    const kept = readState(dir).sessions[SESSION]?.seats.worker?.presence_binding ?? '';
    expect(kept).toBe(minted);
    expect(bindingOf(commandsOf(readSettings(landed.worker!), 'UserPromptSubmit')[1] ?? '')).toBe(minted);
  });

  test('a running seat with no recorded binding gets no presence entry and mints nothing', () => {
    writeState();
    const landed = installCliHooks(dir, SESSION, [seat('worker')]);
    const settings = readSettings(landed.worker!);
    // Two entries: the working word and the drop read. Neither is a presence hook.
    expect(commandsOf(settings, 'UserPromptSubmit')).toHaveLength(2);
    expect(commandsOf(settings, 'UserPromptSubmit').some((command) => command.includes(' presence-hook '))).toBe(false);
    expect(commandsOf(settings, 'Stop')).toHaveLength(1);
    expect(readState(dir).sessions[SESSION]?.seats.worker?.presence_binding).toBeUndefined();
  });

  test('a fresh launch with no state file lands the legacy settings and mints nothing', () => {
    const landed = installCliHooks(dir, SESSION, [seat('worker', true)]);
    const settings = readSettings(landed.worker!);
    // Two entries: the working word and the drop read. Neither is a presence hook.
    expect(commandsOf(settings, 'UserPromptSubmit')).toHaveLength(2);
    expect(commandsOf(settings, 'UserPromptSubmit').some((command) => command.includes(' presence-hook '))).toBe(false);
    expect(commandsOf(settings, 'Stop')).toHaveLength(1);
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
  });

  test('an unreadable state file falls back to the legacy settings, never to a phantom binding', () => {
    writeFileSync(join(dir, STATE_FILE), 'not json\n');
    const landed = installCliHooks(dir, SESSION, [seat('worker', true)]);
    const settings = readSettings(landed.worker!);
    // Two entries: the working word and the drop read. Neither is a presence hook.
    expect(commandsOf(settings, 'UserPromptSubmit')).toHaveLength(2);
    expect(commandsOf(settings, 'UserPromptSubmit').some((command) => command.includes(' presence-hook '))).toBe(false);
    expect(commandsOf(settings, 'Stop')).toHaveLength(1);
  });

  test('a seat whose launch sets its own settings is not touched, fresh or not', () => {
    writeState();
    const own = { name: 'own', cli: 'claude-code', launch: `${CLAUDE} --settings /own.json`, fresh: true };
    expect(installCliHooks(dir, SESSION, [own])).toEqual({});
    expect(readState(dir).sessions[SESSION]).toBeUndefined();
    expect(cliHookSettingsPath(dir, SESSION, 'own')).not.toBeNull();
    expect(existsSync(cliHookStatePath(dir, SESSION, 'own')!)).toBe(false);
  });
});

describe('the hidden presence-hook command', () => {
  const argv = (over: Partial<Record<'dir' | 'session' | 'seat' | 'binding' | 'event', string>> = {}): string[] => {
    const fields = { dir, session: SESSION, seat: 'worker', binding: BINDING, event: 'turn-start', ...over };
    return ['--dir', fields.dir, '--session', fields.session, '--seat', fields.seat,
      '--binding', fields.binding, '--event', fields.event];
  };
  const spool = (): string => presencePaths(dir, SESSION, 'worker')!.spool;

  test('a valid turn stages one record under the launch binding and exits 0', () => {
    expect(run(argv())).toBe(0);
    const files = readdirSync(spool()).sort();
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(spool(), files[0]!), 'utf8')) as Record<string, unknown>;
    expect(record.source).toBe('runtime-hook');
    expect(record.event).toBe('turn-start');
    expect(record.session).toBe(SESSION);
    expect(record.seat).toBe('worker');
    expect(record.binding).toBe(BINDING);
    expect(String(record.id).slice(0, -9)).toBe(record.ts as string);
    expect(files[0]).toBe(`${record.id as string}.json`);
  });

  test('a turn end stages a second record beside the start: the state is the ingester\'s mapping', () => {
    expect(run(argv())).toBe(0);
    expect(run(argv({ event: 'turn-end' }))).toBe(0);
    const records = readdirSync(spool()).map((file) => JSON.parse(readFileSync(join(spool(), file), 'utf8')) as {
      event: string;
    });
    expect(records.map((record) => record.event).sort()).toEqual(['turn-end', 'turn-start']);
  });

  test('every malformed argv is refused before anything is staged', () => {
    const cases: string[][] = [
      [],
      ['--dir', dir],
      [...argv(), '--extra', 'x'],
      [...argv(), '--seat', 'other'],
      argv({ binding: 'prs_XYZ' }),
      argv({ binding: 'prs_0123456789abc' }),
      argv({ event: 'prompt' }),
      argv({ session: '' }),
      argv({ seat: '' }),
      ['--dir', '', '--session', SESSION, '--seat', 'worker', '--binding', BINDING, '--event', 'turn-start'],
    ];
    for (const args of cases) expect(run(args)).toBe(1);
    expect(existsSync(spool())).toBe(false);
  });
});
