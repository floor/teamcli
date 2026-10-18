// The seat's own state signal (src/launch/cli-hook.ts): the per-launch settings file this run
// names on a CLI's launch line, the two command hooks that keep a small state file per seat, and
// the reading src/labels/state.ts makes of it. Every path below is a temp folder; nothing here
// reads or writes any CLI's home. The settings shape and the schema are the design note's probe:
// `--settings` plus a `UserPromptSubmit`/`Stop` command pair, proven against the CLI in a run
// logged in the note, not recalled.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { seatRegistryRows, type SeatRegistryRow } from '../src/commands/seats.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import type { TeamFile } from '../src/file/types.ts';
import { CLI_HOOK_FRESH_SECONDS, CLI_HOOK_FUTURE_SKEW_SECONDS, observedSeatState, seatState } from '../src/labels/state.ts';
import { DEFAULT_STATE_THRESHOLDS } from '../src/settings/inherit.ts';
import {
  cliHookSettingsPath, cliHookStatePath, installCliHooks, plannedCliHooks, readCliHook, resetCliHookState,
} from '../src/launch/cli-hook.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Comparison, Live } from '../src/status/compare.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();
const CLAUDE = 'claude --model claude-opus-5-5';

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-cli-hook-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the launch line', () => {
  const profile = profileFor('claude-code')!;

  test('a CLI that loads a settings file gets it at the end of its line', () => {
    const command = launchCommand(profile, CLAUDE, 'Rules.', '/work/a/.agents/hooks/worker.json');
    expect(command).toContain('--append-system-prompt Rules.');
    expect(command.endsWith('--settings /work/a/.agents/hooks/worker.json')).toBe(true);
  });

  test('a seat that names its own settings file keeps it: no second flag', () => {
    for (const line of [`${CLAUDE} --settings /own.json`, `${CLAUDE} --settings=/own.json`]) {
      expect(launchCommand(profile, line, 'Rules.', '/work/a/.agents/hooks/worker.json'))
        .not.toContain('/work/a/.agents/hooks/worker.json');
    }
  });

  test('a CLI without a per-launch settings file gets nothing appended', () => {
    const grok = profileFor('grok')!;
    expect(launchCommand(grok, 'grok', 'Rules.', '/work/a/.agents/hooks/worker.json'))
      .not.toContain('--settings');
  });
});

describe('what a run plans and what it installs', () => {
  const seat = (name: string, cli = 'claude-code', launch = CLAUDE) => ({ name, cli, launch });
  const SESSION = 'teamcli';

  test('the plan holds a settings path per supported seat only', () => {
    expect(plannedCliHooks('/work/a/.agents', SESSION, [
      seat('worker'),
      seat('codex-seat', 'codex', 'codex'),
      seat('own', 'claude-code', `${CLAUDE} --settings /own.json`),
      seat('../escape'),
    ])).toEqual({ worker: '/work/a/.agents/hooks/teamcli/worker.json' });
  });

  test('two sessions planning the same seat name plan two different files', () => {
    expect(plannedCliHooks('/work/a/.agents', 'alpha', [seat('worker')]))
      .toEqual({ worker: '/work/a/.agents/hooks/alpha/worker.json' });
    expect(plannedCliHooks('/work/a/.agents', 'beta', [seat('worker')]))
      .toEqual({ worker: '/work/a/.agents/hooks/beta/worker.json' });
  });

  test('the install writes one settings file, 0600 in 0700 folders, aiming two hooks at its state file', () => {
    const landed = installCliHooks(dir, SESSION, [seat('worker')]);
    expect(landed).toEqual({ worker: join(dir, 'hooks', SESSION, 'worker.json') });
    for (const folder of [join(dir, 'hooks'), join(dir, 'seat-state'), join(dir, 'hooks', SESSION), join(dir, 'seat-state', SESSION)]) {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    }
    expect(statSync(landed.worker!).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(landed.worker!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(['Stop', 'UserPromptSubmit']);
    const start = settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? '';
    const stop = settings.hooks.Stop?.[0]?.hooks[0]?.command ?? '';
    expect(start).toContain('"state":"working"');
    expect(stop).toContain('"state":"idle"');
    expect(start).toContain(join(dir, 'seat-state', SESSION, 'worker.json'));
    expect(start).toContain('date -u');
    // The hook's own umask keeps the state file private, and nothing reads the CLI's stdin.
    expect(start).toContain('umask 077');
    expect(start).not.toContain('/dev/stdin');
  });

  test('a link where a settings file would go is refused and its target left alone', () => {
    mkdirSync(join(dir, 'hooks', SESSION), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'seat-state', SESSION), { recursive: true, mode: 0o700 });
    const target = join(base, 'elsewhere.json');
    writeFileSync(target, '{"keep":true}\n');
    symlinkSync(target, join(dir, 'hooks', SESSION, 'worker.json'));
    expect(installCliHooks(dir, SESSION, [seat('worker')])).toEqual({});
    expect(readFileSync(target, 'utf8')).toBe('{"keep":true}\n');
  });

  test('a wider settings folder refuses the install rather than widening or writing into it', () => {
    mkdirSync(join(dir, 'hooks'), { recursive: true, mode: 0o700 });
    chmodSync(join(dir, 'hooks'), 0o755);
    expect(installCliHooks(dir, SESSION, [seat('worker')])).toEqual({});
    expect(existsSync(join(dir, 'hooks', SESSION, 'worker.json'))).toBe(false);
  });

  test('a wider session folder refuses the install rather than widening or writing into it', () => {
    mkdirSync(join(dir, 'hooks'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'hooks', SESSION), { recursive: true, mode: 0o700 });
    chmodSync(join(dir, 'hooks', SESSION), 0o755);
    expect(installCliHooks(dir, SESSION, [seat('worker')])).toEqual({});
    expect(existsSync(join(dir, 'hooks', SESSION, 'worker.json'))).toBe(false);
  });

  test('the install is silent when no seat is served', () => {
    expect(installCliHooks(dir, SESSION, [seat('codex-seat', 'codex', 'codex')])).toEqual({});
    expect(existsSync(join(dir, 'hooks'))).toBe(false);
  });
});

describe('the turn-start folder read', () => {
  const SESSION = 'teamcli';
  const SEAT = 'worker';
  const ID1 = '11111111-2222-3333-4444-555555555555';
  const ID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ID3 = '01234567-89ab-cdef-0123-456789abcdef';

  const seat = (session = SESSION, name = SEAT) => ({ name, cli: 'claude-code', launch: CLAUDE });

  /** The drop-read command the settings file installs, as the CLI would run it. */
  function dropCommand(landed: Record<string, string>, name = SEAT): string {
    const settings = JSON.parse(readFileSync(landed[name]!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    const commands = (settings.hooks.UserPromptSubmit ?? []).flatMap((entry) => entry.hooks.map((one) => one.command));
    const read = commands.find((one) => one.includes('drop_read'));
    if (read === undefined) throw new Error('no drop read in the settings file');
    return read;
  }

  /** The seat's drop folder, made the way a launch would find it. */
  function drops(session = SESSION, name = SEAT): string {
    const at = join(dir, 'send-drops', session, name);
    mkdirSync(at, { recursive: true, mode: 0o700 });
    return at;
  }

  function run(command: string): string {
    return execFileSync('sh', ['-c', command], { encoding: 'utf8' });
  }

  /** The `additionalContext` the hook's stdout carries. Claude Code reads a UserPromptSubmit
   *  hook's stdout as that JSON object (measured on 2.1.296, quoted in the commit); anything else
   *  is not context, so every scene below goes through this door. */
  function landing(out: string): string {
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    return parsed.hookSpecificOutput?.additionalContext ?? '';
  }

  /** The receipt's suffix, taken from the one name every writer uses (`receiptPath`), so these
   *  scenes follow the sidecar rule instead of pinning its spelling. */
  const RECEIPT_SUFFIX = basename(receiptPath('', '0')).slice(1);

  function receiptOf(at: string, id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(receiptPath(at, id), 'utf8')) as Record<string, unknown>;
  }

  test('the install adds the read to the same turn start, aimed at the seat’s own drop folder', () => {
    const landed = installCliHooks(dir, SESSION, [seat()]);
    const command = dropCommand(landed);
    expect(command).toContain(join(dir, 'send-drops', SESSION, SEAT));
    expect(command).toContain('drop_read');
    expect(command).toContain('umask 077');
    // The read is the second command of the same turn start; the state word still comes first.
    const settings = JSON.parse(readFileSync(landed[SEAT]!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain('"state":"working"');
  });

  test('a waiting message is handed to the turn once, and its receipt is written beside it at 0600', () => {
    const at = drops();
    writeFileSync(join(at, ID1), 'from the owner — admitted by: rule\nhello\n');
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    expect(landing(run(command))).toBe('from the owner — admitted by: rule\nhello');
    expect(receiptOf(at, ID1)).toMatchObject({ v: 1, id: ID1, seat: SEAT, session: SESSION, tool: 'drop_read' });
    expect(typeof receiptOf(at, ID1).ts).toBe('string');
    expect(Number.isInteger(receiptOf(at, ID1).pid)).toBe(true);
    expect(statSync(receiptPath(at, ID1)).mode & 0o777).toBe(0o600);
    // The second turn reads nothing: the receipt is what says the message was handed over.
    expect(run(command)).toBe('');
  });

  test('a body the read cannot leave a receipt for is not printed', () => {
    const at = drops();
    writeFileSync(join(at, ID1), 'a message that must not be shown unproven\n');
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    chmodSync(at, 0o555);
    try {
      expect(run(command)).toBe('');
    } finally {
      chmodSync(at, 0o700);
    }
    expect(existsSync(receiptPath(at, ID1))).toBe(false);
    // With the folder writable again the same turn-start reads it and leaves the receipt.
    expect(landing(run(command))).toBe('a message that must not be shown unproven');
    expect(existsSync(receiptPath(at, ID1))).toBe(true);
  });

  test('only a lowercase UUID is a message: links, other names and receipts are skipped', () => {
    const at = drops();
    const outside = join(base, 'outside-body');
    writeFileSync(outside, 'a link target, never a message\n');
    symlinkSync(outside, join(at, ID2));
    writeFileSync(join(at, 'notes.txt'), 'not a message\n');
    writeFileSync(join(at, ID3), 'already read\n');
    writeFileSync(receiptPath(at, ID3), '{"v":1}\n');
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    expect(run(command)).toBe('');
    expect(existsSync(receiptPath(at, ID2))).toBe(false);
    expect(existsSync(receiptPath(at, ID3))).toBe(true);
    expect(readFileSync(receiptPath(at, ID3), 'utf8')).toBe('{"v":1}\n');
  });

  test('one turn reads ten messages at most, and the rest wait for the next', () => {
    const at = drops();
    const ids = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`);
    for (const [index, id] of ids.entries()) writeFileSync(join(at, id), `message ${String(index)}\n`);
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    const first = landing(run(command));
    expect(first.split('\n').filter((line) => line.startsWith('message '))).toHaveLength(10);
    expect(readdirSync(at).filter((name) => name.endsWith(RECEIPT_SUFFIX))).toHaveLength(10);
    const second = landing(run(command));
    expect(second.split('\n').filter((line) => line.startsWith('message '))).toHaveLength(2);
    expect(readdirSync(at).filter((name) => name.endsWith(RECEIPT_SUFFIX))).toHaveLength(12);
  });

  test('the body is handed over literally, shell words and all', () => {
    const at = drops();
    const body = 'from the owner — admitted by: rule\n$(touch ' + join(base, 'surprise') + ') `whoami` "quoted"';
    writeFileSync(join(at, ID1), `${body}\n`);
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    expect(landing(run(command))).toBe(body);
    expect(existsSync(join(base, 'surprise'))).toBe(false);
  });

  test('a body with quotes, backslashes and control bytes still arrives whole', () => {
    const at = drops();
    // A quote, a backslash, a tab, a control byte and a comma all have to survive the JSON the
    // hook writes: the client parses that string, so one unescaped byte would drop the message.
    const body = 'a "quoted" line \\ with a backslash\tand a tab\x01 and \x1f\x08\x0c';
    writeFileSync(join(at, ID1), `${body}\nsecond line\n`);
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    expect(landing(run(command))).toBe(`${body}\nsecond line`);
  });

  test('two messages land as two paragraphs, oldest name first', () => {
    const at = drops();
    writeFileSync(join(at, ID1), 'first\n');
    writeFileSync(join(at, ID2), 'second\n');
    const command = dropCommand(installCliHooks(dir, SESSION, [seat()]));
    expect(landing(run(command))).toBe('first\n\nsecond');
  });

  test('a session name with quotes and spaces still names a folder and a receipt', () => {
    const session = `it's a team`;
    const at = drops(session);
    writeFileSync(join(at, ID1), 'hello across a quoted session\n');
    const landed = installCliHooks(dir, session, [seat(session)]);
    expect(landing(run(dropCommand(landed)))).toBe('hello across a quoted session');
    expect(receiptOf(at, ID1)).toMatchObject({ v: 1, id: ID1, seat: SEAT, session, tool: 'drop_read' });
  });
});

describe('the state file a hook writes', () => {
  const SESSION = 'teamcli';
  const statePath = (session: string, seat: string): string => join(dir, 'seat-state', session, `${seat}.json`);

  test('is read back as the word and the instant it holds', () => {
    mkdirSync(join(dir, 'seat-state', SESSION), { recursive: true, mode: 0o700 });
    writeFileSync(statePath(SESSION, 'worker'), '{"state":"idle","since":"2026-10-17T12:00:00Z"}\n');
    expect(readCliHook(dir, SESSION, 'worker')).toEqual({ state: 'idle', since: '2026-10-17T12:00:00Z' });
  });

  test('two sessions with the same seat name read their own files, never each other’s', () => {
    // The scene of the shared-file fault: one seat name in two sessions must read two words.
    for (const session of ['alpha', 'beta']) mkdirSync(join(dir, 'seat-state', session), { recursive: true, mode: 0o700 });
    writeFileSync(statePath('alpha', 'worker'), '{"state":"working","since":"2026-10-17T12:00:00Z"}\n');
    writeFileSync(statePath('beta', 'worker'), '{"state":"idle","since":"2026-10-17T11:00:00Z"}\n');
    expect(readCliHook(dir, 'alpha', 'worker')).toEqual({ state: 'working', since: '2026-10-17T12:00:00Z' });
    expect(readCliHook(dir, 'beta', 'worker')).toEqual({ state: 'idle', since: '2026-10-17T11:00:00Z' });
  });

  test('a file kept before the session keying answers once, then belongs to the session that read it', () => {
    // `seat-state/<seat>.json` was shared by every session. The first reading moves it into the
    // reading session's folder, so a second session cannot read the same word after it.
    mkdirSync(join(dir, 'seat-state'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'seat-state', 'worker.json'), '{"state":"working","since":"2026-10-17T12:00:00Z"}\n');
    expect(readCliHook(dir, 'alpha', 'worker')).toEqual({ state: 'working', since: '2026-10-17T12:00:00Z' });
    expect(existsSync(join(dir, 'seat-state', 'worker.json'))).toBe(false);
    expect(readFileSync(statePath('alpha', 'worker'), 'utf8')).toContain('"working"');
    expect(readCliHook(dir, 'beta', 'worker')).toBeNull();
  });

  test('anything this version cannot trust reads as nothing', () => {
    mkdirSync(join(dir, 'seat-state', SESSION), { recursive: true, mode: 0o700 });
    const path = statePath(SESSION, 'worker');
    for (const text of ['not json', '{}', '{"state":"busy","since":"2026-10-17T12:00:00Z"}', '{"state":"working"}']) {
      writeFileSync(path, text);
      expect(readCliHook(dir, SESSION, 'worker')).toBeNull();
    }
    // A link is never followed.
    const target = join(base, 'elsewhere.json');
    writeFileSync(target, '{"state":"working","since":"2026-10-17T12:00:00Z"}\n');
    rmSync(path);
    symlinkSync(target, path);
    expect(readCliHook(dir, SESSION, 'worker')).toBeNull();
    // A file of the session's own that does not read is final: the older shared file is never
    // consulted behind it.
    writeFileSync(join(dir, 'seat-state', 'worker.json'), '{"state":"idle","since":"2026-10-17T12:00:00Z"}\n');
    expect(readCliHook(dir, SESSION, 'worker')).toBeNull();
    expect(existsSync(join(dir, 'seat-state', 'worker.json'))).toBe(true);
    // A name that cannot be a file name is no reading either.
    expect(readCliHook(dir, SESSION, '../escape')).toBeNull();
  });

  test('a reset takes the state file and leaves the settings in place', () => {
    const landed = installCliHooks(dir, SESSION, [{ name: 'worker', cli: 'claude-code', launch: CLAUDE }]);
    writeFileSync(statePath(SESSION, 'worker'), '{"state":"working","since":"2026-10-17T12:00:00Z"}\n');
    resetCliHookState(dir, SESSION, ['worker']);
    expect(existsSync(statePath(SESSION, 'worker'))).toBe(false);
    expect(existsSync(landed.worker!)).toBe(true);
  });

  test('a reset takes the shared file kept before the session keying with it', () => {
    mkdirSync(join(dir, 'seat-state'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'seat-state', 'worker.json'), '{"state":"working","since":"2026-10-17T12:00:00Z"}\n');
    resetCliHookState(dir, SESSION, ['worker']);
    expect(existsSync(join(dir, 'seat-state', 'worker.json'))).toBe(false);
  });

  test('the hook replaces a link planted at the state path instead of writing through it', () => {
    mkdirSync(join(dir, 'seat-state', SESSION), { recursive: true, mode: 0o700 });
    const target = join(base, 'elsewhere.json');
    writeFileSync(target, '{"keep":true}\n');
    const path = join(dir, 'seat-state', SESSION, 'worker.json');
    symlinkSync(target, path);
    const landed = installCliHooks(dir, SESSION, [{ name: 'worker', cli: 'claude-code', launch: CLAUDE }]);
    const settings = JSON.parse(readFileSync(landed.worker!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    const start = settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? '';
    execFileSync('/bin/sh', ['-c', start], { stdio: 'ignore' });
    // The word landed as a regular file of the hook's own; the planted link's target never saw
    // it, and no temp file is left behind.
    expect(readFileSync(target, 'utf8')).toBe('{"keep":true}\n');
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readCliHook(dir, SESSION, 'worker')).toMatchObject({ state: 'working' });
    expect(readdirSync(join(dir, 'seat-state', SESSION))).toEqual(['worker.json']);
    // The writer's own umask keeps the state file private.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('the paths are the two this module names', () => {
    expect(cliHookSettingsPath(dir, SESSION, 'worker')).toBe(join(dir, 'hooks', SESSION, 'worker.json'));
    expect(cliHookStatePath(dir, SESSION, 'worker')).toBe(join(dir, 'seat-state', SESSION, 'worker.json'));
    // Two sessions never share a folder, whatever the session name holds: the name is one path
    // segment by construction, its bytes that are not `[A-Za-z0-9_-]` written `%XX`.
    expect(cliHookStatePath(dir, 'alpha', 'worker')).not.toBe(cliHookStatePath(dir, 'beta', 'worker'));
    expect(cliHookStatePath(dir, 'a/b', 'worker')).toBe(join(dir, 'seat-state', 'a%2Fb', 'worker.json'));
    expect(cliHookStatePath(dir, '..', 'worker')).toBe(join(dir, 'seat-state', '%2E%2E', 'worker.json'));
    expect(cliHookStatePath(dir, 'a%2Fb', 'worker')).toBe(join(dir, 'seat-state', 'a%252Fb', 'worker.json'));
    expect(cliHookStatePath(dir, '', 'worker')).toBeNull();
    expect(cliHookSettingsPath(dir, SESSION, 'a/b')).toBeNull();
    expect(cliHookStatePath(dir, SESSION, 'a/b')).toBeNull();
  });
});

describe('the reading the hook feeds', () => {
  test('a screen that waits on someone outranks every clock, the hook included', () => {
    for (const screen of [{ kind: 'permission' } as const, { kind: 'question' } as const, { kind: 'trust' } as const, { kind: 'unsent' } as const]) {
      expect(seatState({ screen, hook: { state: 'working', since: ago(1) }, trace: ago(1) }, NOW))
        .toEqual({ state: 'blocked', source: 'cli', blind: false });
    }
  });

  test('a fresh working hook is working, even over an idle screen', () => {
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(10) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });

  test('past its short window a working hook yields to the prompt on screen', () => {
    // An interrupted turn (an Esc, a crash the CLI survived) never writes its `idle`: the file
    // still says working. The prompt showing again is the fresher word. The boundary counts as
    // inside; one second past it the screen answers.
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(DEFAULT_STATE_THRESHOLDS.hook_working_seconds) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(DEFAULT_STATE_THRESHOLDS.hook_working_seconds + 1) } }, NOW))
      .toEqual({ state: 'idle', source: 'cli', blind: false });
    // The same stale word over a working screen reads working, now from the screen.
    expect(seatState({ screen: { kind: 'working' }, hook: { state: 'working', since: ago(3600) } }, NOW))
      .toEqual({ state: 'working', source: 'cli', blind: false });
    // A trace inside its window still outranks the prompt, as everywhere else.
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(3600) }, trace: ago(30) }, NOW))
      .toEqual({ state: 'working', source: 'trace', blind: false });
  });

  test('a working hook past its short window still answers where no screen was read', () => {
    // Nothing contradicts the hook — no screen, or a screen this version cannot read — so it
    // answers for the rest of its day.
    expect(seatState({ hook: { state: 'working', since: ago(3600) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
    expect(seatState({ screen: { kind: 'unknown' }, hook: { state: 'working', since: ago(3600) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });

  test('the short window is the caller’s to set', () => {
    const limits = { ...DEFAULT_STATE_THRESHOLDS, hook_working_seconds: 30 };
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(60) } }, NOW, limits))
      .toEqual({ state: 'idle', source: 'cli', blind: false });
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(10) } }, NOW, limits))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });

  test('a fresh idle hook is idle, even over a screen still showing the turn', () => {
    expect(seatState({ screen: { kind: 'working' }, hook: { state: 'idle', since: ago(10) } }, NOW))
      .toEqual({ state: 'idle', source: 'cli-hook', blind: false });
  });

  test('an idle hook beside a trace inside the window is still working, by the trace', () => {
    expect(seatState({ hook: { state: 'idle', since: ago(10) }, trace: ago(30) }, NOW))
      .toEqual({ state: 'working', source: 'trace', blind: false });
  });

  test('a hook older than its day says nothing, and the screen answers again', () => {
    expect(seatState({ hook: { state: 'working', since: ago(CLI_HOOK_FRESH_SECONDS) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
    expect(seatState({ hook: { state: 'working', since: ago(CLI_HOOK_FRESH_SECONDS + 1) } }, NOW))
      .toEqual({ state: 'unknown', source: 'none', blind: true });
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ago(CLI_HOOK_FRESH_SECONDS + 1) } }, NOW))
      .toEqual({ state: 'idle', source: 'cli', blind: false });
  });

  test('an instant ahead of the clock answers only within a small skew', () => {
    const ahead = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();
    // A writer whose clock runs a little fast is not a writer from the future.
    expect(seatState({ hook: { state: 'working', since: ahead(CLI_HOOK_FUTURE_SKEW_SECONDS) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
    expect(seatState({ hook: { state: 'idle', since: ahead(CLI_HOOK_FUTURE_SKEW_SECONDS) } }, NOW))
      .toEqual({ state: 'idle', source: 'cli-hook', blind: false });
    // Further ahead the file says nothing: with no screen the seat is unknown, never held fresh
    // until the wall clock reaches a timestamp the reader cannot trust.
    expect(seatState({ hook: { state: 'working', since: ahead(CLI_HOOK_FUTURE_SKEW_SECONDS + 1) } }, NOW))
      .toEqual({ state: 'unknown', source: 'none', blind: true });
    expect(seatState({ hook: { state: 'idle', since: ahead(CLI_HOOK_FRESH_SECONDS) } }, NOW))
      .toEqual({ state: 'unknown', source: 'none', blind: true });
    expect(seatState({ screen: { kind: 'idle' }, hook: { state: 'working', since: ahead(CLI_HOOK_FUTURE_SKEW_SECONDS + 1) } }, NOW))
      .toEqual({ state: 'idle', source: 'cli', blind: false });
  });

  test('an unreadable instant falls through, and the certainties still answer first', () => {
    expect(seatState({ hook: { state: 'working', since: 'not-a-date' }, herdr: 'idle' }, NOW))
      .toEqual({ state: 'idle', source: 'herdr', blind: false });
    expect(seatState({ present: false, hook: { state: 'working', since: ago(1) } }, NOW))
      .toEqual({ state: 'done', source: 'process', blind: false });
    expect(seatState({ held: true, hook: { state: 'working', since: ago(1) } }, NOW))
      .toEqual({ state: 'held', source: 'hold', blind: false });
  });

  test('observedSeatState carries the hook through beside the screen', () => {
    expect(observedSeatState({ cli: 'claude-code', hook: { state: 'working', since: ago(5) }, now: NOW }))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });
});

describe('a registry row reads the state file', () => {
  const SESSION = 'teamcli';

  function row(options: { cli?: string; stateDir?: string; session?: string }): SeatRegistryRow {
    const team = {
      project: 'acme',
      seats: [{ role: 'implementer', name: 'worker', cli: options.cli ?? 'claude-code', model: 'Claude Opus', version: '5.5', launch: CLAUDE, cwd: '.' }],
    } as unknown as TeamFile;
    const state: SessionState = emptySession();
    state.seats.worker = {
      stage: 'ready',
      pane: 'w1:p1',
      workspace: 'w1',
      cli: options.cli ?? 'claude-code',
      launched: { shell: 1, cli: [2] },
      model: 'Claude Opus',
      version: '5.5',
      launch_line: CLAUDE,
    };
    const live: Live = { running: true, agents: [], workspaces: [], screens: {} };
    const comparison: Comparison = {
      rows: [{ name: 'worker', state: 'idle', model: 'Claude Opus', pane: 'w1:p1' }],
      differences: [],
      notes: [],
    };
    const rows = seatRegistryRows(team, state, live, comparison, NOW, true, false, {
      project: 'acme',
      root: base,
      ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
      ...(options.session !== undefined ? { session: options.session } : {}),
    });
    return rows[0]!;
  }

  function writeState(text: string, session = SESSION): void {
    mkdirSync(join(dir, 'seat-state', session), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'seat-state', session, 'worker.json'), text);
  }

  test('a fresh hook answers when the screen and herdr have nothing', () => {
    writeState(`{"state":"working","since":"${ago(5)}"}\n`);
    expect(row({ stateDir: dir, session: SESSION })).toMatchObject({ state: 'working', state_source: 'cli-hook', blind: false });
  });

  test('a working reading carries LAST ACTIVE now, whatever source answered', () => {
    // No agent, no herdr word, no trace: only the hook says the seat works. The row's last
    // activity is this run's instant — the reading, not herdr alone, is what counts.
    writeState(`{"state":"working","since":"${ago(5)}"}\n`);
    expect(row({ stateDir: dir, session: SESSION })).toMatchObject({
      state: 'working',
      state_source: 'cli-hook',
      last_active: NOW.toISOString(),
      last_active_display: 'now',
    });
  });

  test('another session’s file for a seat of the same name is never read', () => {
    writeState(`{"state":"working","since":"${ago(5)}"}\n`, 'other');
    expect(row({ stateDir: dir, session: SESSION })).toMatchObject({ state: 'unknown', state_source: 'none' });
  });

  test('a stale hook falls through to the reading without it', () => {
    writeState(`{"state":"working","since":"${ago(CLI_HOOK_FRESH_SECONDS + 1)}"}\n`);
    expect(row({ stateDir: dir, session: SESSION })).toMatchObject({ state: 'unknown', state_source: 'none' });
  });

  test('a CLI that takes no per-launch settings file is never read', () => {
    writeState(`{"state":"working","since":"${ago(5)}"}\n`);
    expect(row({ cli: 'codex', stateDir: dir, session: SESSION })).toMatchObject({ state: 'unknown', state_source: 'none' });
  });

  test('no state folder given: the hook is not read', () => {
    writeState(`{"state":"working","since":"${ago(5)}"}\n`);
    expect(row({ session: SESSION })).toMatchObject({ state: 'unknown', state_source: 'none' });
  });

  test('no session given: the hook is not read', () => {
    writeState(`{"state":"working","since":"${ago(5)}"}\n`);
    expect(row({ stateDir: dir })).toMatchObject({ state: 'unknown', state_source: 'none' });
  });
});
