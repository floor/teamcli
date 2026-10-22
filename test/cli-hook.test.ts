// The seat's own state signal (src/launch/cli-hook.ts): the per-launch settings file this run
// names on a CLI's launch line, the two command hooks that keep a small state file per seat, and
// the reading src/labels/state.ts makes of it. Every path below is a temp folder; nothing here
// reads or writes any CLI's home. The settings shape and the schema are the design note's probe:
// `--settings` plus a `UserPromptSubmit`/`Stop` command pair, proven against the CLI in a run
// logged in the note, not recalled.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatRegistryRows, type SeatRegistryRow } from '../src/commands/seats.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { listUnread, MESSAGE_ID, receiptPath } from '../src/mcp/inbox.ts';
import type { TeamFile } from '../src/file/types.ts';
import { CLI_HOOK_FRESH_SECONDS, CLI_HOOK_FUTURE_SKEW_SECONDS, observedSeatState, seatState } from '../src/labels/state.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { readHistory } from '../src/send/history.ts';
import { readRecord, signRecord, signReceiptPayload, signedReceiptOf, verifyReceipt, verifyRecord, writeRecord } from '../src/send/record.ts';
import { DEFAULT_STATE_THRESHOLDS } from '../src/settings/inherit.ts';
import { messageKeyState } from '../src/store/keys.ts';
import {
  cliHookSettingsPath, cliHookStatePath, dropReadRunner, installCliHooks, plannedCliHooks, readCliHook, resetCliHookState,
} from '../src/launch/cli-hook.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import type { PresenceSeatsRead } from '../src/labels/presence.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Comparison, Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

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

  test('an unchanged settings file is not rewritten: its mtime stays the seat\'s declaration', () => {
    // `up` installs hooks for every seat, launched or not. A running seat's socket can predate
    // this run; a rewrite of identical bytes would move its `declaredAt` past that socket and
    // make the live receiver read stale. The file is left exactly as it was.
    const landed = installCliHooks(dir, SESSION, [seat('worker')]);
    const path = landed.worker!;
    utimesSync(path, new Date('2026-10-21T06:46:42Z'), new Date('2026-10-21T06:46:42Z'));
    const before = statSync(path).mtimeMs;
    expect(installCliHooks(dir, SESSION, [seat('worker')])).toEqual({ worker: path });
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test('a changed declaration is still written over the unchanged file', () => {
    const landed = installCliHooks(dir, SESSION, [seat('worker')]);
    const path = landed.worker!;
    utimesSync(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const before = statSync(path).mtimeMs;
    // The launch's wrapper now declares an inbound word the old settings file does not hold:
    // the file the seat loads must change, and a rewrite is a declaration of its own.
    const wrapper = join(base, 'launch.sh');
    writeFileSync(wrapper, '#!/bin/sh\nexec claude --settings \'{"crossSessionInbound":"accept"}\' "$@"\n', { mode: 0o700 });
    expect(installCliHooks(dir, SESSION, [seat('worker', 'claude-code', wrapper)])).toEqual({ worker: path });
    expect(statSync(path).mtimeMs).not.toBe(before);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { crossSessionInbound?: string }).crossSessionInbound).toBe('accept');
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
  const HEADER = 'from the owner — admitted by: the owner\n\n';

  let project: string;
  let home: string;

  /** The fixture team file: one Claude Code seat, the session the launch writes into the hook. */
  const teamYaml = (lobby: string, root: string): string => `format: 1
project: acme
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${SEAT}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;

  beforeEach(() => {
    mkdirSync(join(base, 'acme'), { recursive: true });
    project = realpathSync(join(base, 'acme'));
    home = join(base, 'home');
    mkdirSync(join(project, '.agents'), { recursive: true });
    mkdirSync(home);
    mkdirSync(lobbyDir(home), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
    writeFileSync(join(project, '.agents', 'team.yaml'), teamYaml(lobbyDir(home), project));
  });

  const seat = () => ({ name: SEAT, cli: 'claude-code', launch: CLAUDE });
  const install = (session = SESSION): Record<string, string> => installCliHooks(join(project, '.agents'), session, [seat()]);
  const dropsAt = (session = SESSION, name = SEAT): string => join(project, '.agents', 'send-drops', session, name);

  /** The drop-read command the settings file installs, as the CLI would run it. */
  function dropCommand(landed: Record<string, string>, name = SEAT): string {
    const settings = JSON.parse(readFileSync(landed[name]!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    const commands = (settings.hooks.UserPromptSubmit ?? []).flatMap((entry) => entry.hooks.map((one) => one.command));
    const read = commands.find((one) => one.includes('drops --read'));
    if (read === undefined) throw new Error('no drop read in the settings file');
    return read;
  }

  /** Runs one installed hook command the way the CLI does: in the project, with the machine's
   *  own home replaced by the fixture's, so the message key and the files are the test's. */
  function run(command: string): string {
    return execFileSync('sh', ['-c', command], { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } });
  }

  /** The `additionalContext` the hook's stdout carries. Claude Code reads a UserPromptSubmit
   *  hook's stdout as that JSON object (measured on 2.1.296, quoted in the commit); anything else
   *  is not context, so every scene below goes through this door. */
  function landing(out: string): string {
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    return parsed.hookSpecificOutput?.additionalContext ?? '';
  }

  /** The signed read receipt beside a message: parsed, verified against the checkout's message
   *  key, bound to this message, seat, checkout and session, and 0600. */
  function expectReadReceipt(dir: string, id: string): void {
    const at = receiptPath(dir, id);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(at, 'utf8')));
    const key = messageKeyState(home);
    if (receipt === null || key.kind !== 'key') throw new Error('no signed receipt or no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id, to: SEAT, root: project, session: SESSION });
    expect(statSync(at).mode & 0o777).toBe(0o600);
  }

  /** One drop as `team send` writes it: the signed record, through the command's own planter. */
  function plant(id: string, body: string): string {
    return plantRecord(home, project, SESSION, SEAT, id, body, { from: 'the owner', rule: 'the owner' });
  }

  test('the install adds the read to the same turn start, run by this install’s own CLI', () => {
    const landed = install();
    const command = dropCommand(landed);
    expect(command).toContain(dropReadRunner());
    expect(command).toContain(`--seat ${SEAT}`);
    expect(command).toContain(`--session ${SESSION}`);
    // The receipt is the signed status receipt the inbox writes; no shell marker of its own.
    expect(command).not.toContain('drop_read');
    const settings = JSON.parse(readFileSync(landed[SEAT]!, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain('"state":"working"');
  });

  test('a plain send types one trigger, and the turn-start read delivers it: receipt signed before the body', async () => {
    const command = dropCommand(install());
    const io = testIo(project, { kind: 'owner' });
    const typed: { pane: string; text: string }[] = [];
    const host: SendHost = {
      agents: () => [{ name: SEAT, pane: 'w1:p1', cli: 'claude' }],
      processInfo: () => ({ shell: 1, foreground: [2] }),
      socketsDir: join(base, 'sockets'),
      deliver: async () => {
        throw new Error('the inbox leg must not dial: this inbox has no listener');
      },
      native: {
        typeText: (_session, pane, text) => {
          typed.push({ pane, text });
          return true;
        },
        pressEnter: () => true,
        status: () => 'idle',
        wait: async () => {},
        paneText: () => '',
      },
      now: () => NOW,
      home,
    };

    expect(await runSend([SEAT, 'hello'], io, host)).toBe(0);

    // The default walk takes the typed leg: the seat's own drop-read trigger is typed once, and
    // the sender's side has only the unconfirmed ending until the seat's own read writes the
    // receipt. The typed leg wrote the record the trigger reads.
    expect(io.out).toContain('sent (unconfirmed)');
    expect(typed).toEqual([{ pane: 'w1:p1', text: readTriggerLine(SEAT, SESSION, { seat: 'owner', team: 'acme', body: 'hello' }) as string }]);
    const dir = dropsAt();
    const id = readdirSync(dir).find((name) => MESSAGE_ID.test(name));
    if (id === undefined) throw new Error('the send wrote no drop');

    // The end-to-end proof: the installed hook command reads the record, and its body reaches
    // the turn only after a signed read receipt is on disk.
    expect(landing(run(command))).toBe(`${HEADER}hello`);
    expectReadReceipt(dir, id);
    expect(listUnread(dir, { to: SEAT, root: project, session: SESSION }, home)).toEqual([]);
    // The receipt is what says it was handed over: the next turn prints nothing.
    expect(run(command)).toBe('');
  }, 60_000);

  test('a seat the session does not list takes the default walk to the drop leg: signed record, sent (unconfirmed), nothing typed', async () => {
    const io = testIo(project, { kind: 'owner' });
    const typed: { pane: string; text: string }[] = [];
    const host: SendHost = {
      agents: () => [],
      processInfo: () => ({ shell: 1, foreground: [2] }),
      socketsDir: join(base, 'sockets'),
      deliver: async () => {
        throw new Error('the inbox leg must not dial: this inbox has no listener');
      },
      native: {
        typeText: (_session, pane, text) => {
          typed.push({ pane, text });
          return true;
        },
        pressEnter: () => true,
        status: () => 'idle',
        wait: async () => {},
        paneText: () => '',
      },
      now: () => NOW,
      home,
    };

    expect(await runSend([SEAT, 'hello'], io, host)).toBe(0);

    // The typed leg found no live agent, so it typed nothing and handed the send to the drop leg
    // behind it: the file is the channel, and the sender's side knows only the unconfirmed end.
    expect(io.out).toContain('sent (unconfirmed)');
    expect(typed).toEqual([]);
    const dir = dropsAt();
    const id = readdirSync(dir).find((name) => MESSAGE_ID.test(name));
    if (id === undefined) throw new Error('the send wrote no drop');
    // The record is signed and bound to this seat, checkout and session — the seat's own read
    // would verify it and deliver the body.
    const held = readRecord(join(dir, id), id);
    const key = messageKeyState(home);
    if (!held.ok || held.record === null || key.kind !== 'key') throw new Error('the drop record does not read');
    expect(verifyRecord(held.record, key.key)).toBe(true);
    expect(held.record.payload).toMatchObject({ to: SEAT, session: SESSION });
    expect(realpathSync(held.record.payload.root)).toBe(realpathSync(project));
    expect(listUnread(dir, { to: SEAT, root: project, session: SESSION }, home).map((one) => one.id)).toEqual([id]);
    // The drop was not read, and nothing claims it was.
    expect(existsSync(receiptPath(dir, id))).toBe(false);
    // The reason the typed leg passed rides the one history line the drop leg wrote.
    const history = readHistory('acme', project, home);
    if (!history.ok) throw new Error(`the history does not read: ${history.reason}`);
    const entry = history.entries.filter((one) => one.id === id).at(-1);
    if (entry === undefined) throw new Error('the send wrote no history line');
    expect(entry.outcome).toBe('sent (unconfirmed)');
    expect(entry.via).toBe('drop');
    const reason = (entry.failed ?? []).find((one) => one.startsWith('typed: '));
    expect(reason).toBe('typed: no live agent carries that name in the session');
  });

  test('a [typed]-only order with no live agent is unreachable, and no drop is written', async () => {
    const io = testIo(project, { kind: 'owner' });
    const typed: { pane: string; text: string }[] = [];
    const host: SendHost = {
      agents: () => [],
      processInfo: () => ({ shell: 1, foreground: [2] }),
      socketsDir: join(base, 'sockets'),
      delivery: { seat: ['typed'] },
      deliver: async () => {
        throw new Error('the typed leg must not dial a socket');
      },
      native: {
        typeText: (_session, pane, text) => {
          typed.push({ pane, text });
          return true;
        },
        pressEnter: () => true,
        status: () => 'idle',
        wait: async () => {},
        paneText: () => '',
      },
      now: () => NOW,
      home,
    };

    expect(await runSend([SEAT, 'hello'], io, host)).toBe(1);

    // Nothing stands behind the typed leg: no live agent ends the walk unreachable, never typed
    // blind and never quietly downgraded to a drop file.
    expect(io.err).toContain('unreachable: no live agent carries that name in the session');
    expect(typed).toEqual([]);
    expect(existsSync(dropsAt()) ? readdirSync(dropsAt()).filter((name) => MESSAGE_ID.test(name)) : []).toEqual([]);
  });

  test('a waiting record is handed to the turn once, and its receipt is written beside it at 0600', () => {
    const dir = dropsAt();
    plant(ID1, 'hello');
    const command = dropCommand(install());
    expect(landing(run(command))).toBe('hello');
    expectReadReceipt(dir, ID1);
    expect(run(command)).toBe('');
  }, 30_000);

  test('a file an earlier build wrote is no signed record: it is never shown and gets no receipt', () => {
    const dir = dropsAt();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, ID2), `${HEADER}an old raw drop\n`);
    const command = dropCommand(install());
    expect(run(command)).toBe('');
    expect(existsSync(receiptPath(dir, ID2))).toBe(false);
  }, 30_000);

  test('a record bound to another inbox is refused, and no receipt is written for it', () => {
    const dir = dropsAt();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const written = writeRecord(dir, signRecord({
      kind: 'message',
      id: ID3,
      to: 'someone-else',
      to_id: null,
      root: project,
      session: SESSION,
      at: NOW.toISOString(),
      body: 'not this inbox',
      from: 'lead',
      from_id: null,
      rule: 'rule',
      thread: ID3,
    }, home));
    expect(written.ok).toBe(true);
    const command = dropCommand(install());
    expect(run(command)).toBe('');
    expect(existsSync(receiptPath(dir, ID3))).toBe(false);
  }, 30_000);

  test('a record whose signature does not verify is never shown', () => {
    const dir = dropsAt();
    const at = plant(ID1, 'tampered after signing');
    const record = JSON.parse(readFileSync(at, 'utf8')) as { signature: string };
    record.signature = 'not-this-key';
    writeFileSync(at, `${JSON.stringify(record)}\n`);
    const command = dropCommand(install());
    expect(run(command)).toBe('');
    expect(existsSync(receiptPath(dir, ID1))).toBe(false);
  }, 30_000);

  test('the body is handed over literally, shell words and all', () => {
    dropsAt();
    const body = `from the owner\n\n$(touch ${join(base, 'surprise')}) \`whoami\` "quoted"`;
    plant(ID1, body);
    const command = dropCommand(install());
    expect(landing(run(command))).toBe(body);
    expect(existsSync(join(base, 'surprise'))).toBe(false);
  }, 30_000);

  test('a body with quotes, backslashes and control bytes still arrives whole', () => {
    const body = 'a "quoted" line \\ with a backslash\tand a tab\x01 and \x1f\x08\x0c';
    plant(ID1, `${body}\nsecond line`);
    const command = dropCommand(install());
    expect(landing(run(command))).toBe(`${body}\nsecond line`);
  }, 30_000);

  test('two messages land as two paragraphs, newest first', () => {
    const one = plant(ID1, 'first');
    plant(ID2, 'second');
    utimesSync(one, new Date(NOW.getTime() - 2_000), new Date(NOW.getTime() - 2_000));
    utimesSync(join(dropsAt(), ID2), new Date(NOW.getTime() - 1_000), new Date(NOW.getTime() - 1_000));
    const command = dropCommand(install());
    expect(landing(run(command))).toBe('second\n\nfirst');
  }, 30_000);

  test('one turn reads ten messages at most, and the rest wait for the next', () => {
    const dir = dropsAt();
    const ids = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`);
    for (const [index, id] of ids.entries()) {
      const at = plant(id, `message ${String(index)}`);
      const when = new Date(NOW.getTime() + index * 1_000);
      utimesSync(at, when, when);
    }
    const command = dropCommand(install());
    const first = landing(run(command));
    expect(first.split('\n').filter((line) => line.startsWith('message '))).toHaveLength(10);
    expect(readdirSync(dir).filter((name) => name.endsWith('.read.json'))).toHaveLength(10);
    const second = landing(run(command));
    expect(second.split('\n').filter((line) => line.startsWith('message '))).toHaveLength(2);
    expect(readdirSync(dir).filter((name) => name.endsWith('.read.json'))).toHaveLength(12);
  }, 60_000);

  test('a receipt path held by something that is not a file refuses the body', () => {
    const dir = dropsAt();
    plant(ID1, 'a message whose proof cannot land');
    // A folder stands where the signed receipt goes: the read has nowhere to leave its proof, and
    // no body is handed over without one. (A folder's mode cannot hold the write back: the drop
    // writer widens its own folder to 0700 on every write.)
    mkdirSync(receiptPath(dir, ID1));
    const command = dropCommand(install());
    expect(run(command)).toBe('');
    expect(statSync(receiptPath(dir, ID1)).isDirectory()).toBe(true);
  }, 30_000);

  test('a session name with quotes and spaces is shell-quoted into the command', () => {
    const session = `it's a team`;
    const command = dropCommand(install(session));
    expect(command).toContain(`--session 'it'\\''s a team'`);
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

  function row(options: {
    cli?: string;
    stateDir?: string;
    session?: string;
    binding?: string;
    channelHealthy?: boolean;
    presenceSeats?: PresenceSeatsRead;
    screen?: 'idle' | 'permission';
  }): SeatRegistryRow {
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
    if (options.binding !== undefined) state.seats.worker.presence_binding = options.binding;
    const agents = options.screen === undefined
      ? []
      : [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }];
    const screens: Record<string, string> = {};
    if (options.screen === 'idle') screens['w1:p1'] = CLAUDE_IDLE;
    if (options.screen === 'permission') {
      screens['w1:p1'] = readFileSync(
        new URL('./fixtures/claude-code/2.1.289/permission-create-plain.txt', import.meta.url),
        'utf8',
      );
    }
    const live: Live = { running: true, agents, workspaces: [], screens };
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
      ...(options.channelHealthy !== undefined ? { presenceChannelHealthy: options.channelHealthy } : {}),
      ...(options.presenceSeats !== undefined ? { presenceSeats: options.presenceSeats } : {}),
    });
    return rows[0]!;
  }

  function writeState(text: string, session = SESSION): void {
    mkdirSync(join(dir, 'seat-state', session), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'seat-state', session, 'worker.json'), text);
  }

  function writePresence(binding: string, state: 'working' | 'idle'): string {
    const paths = presencePaths(dir, SESSION, 'worker');
    if (paths === null) throw new Error('the scene names no presence folder');
    mkdirSync(paths.root, { recursive: true });
    const since = ago(5);
    const id = `${since}-ab12cd34`;
    writeFileSync(paths.current, JSON.stringify({
      v: 1,
      seq: 1,
      id,
      state,
      source: 'runtime-hook',
      event: state === 'working' ? 'turn-start' : 'turn-end',
      binding,
      since,
      observedAt: since,
    }));
    return id;
  }

  /** The fresh per-seat answer for one serving runtime seat, naming the applied transition it
   *  vouches for. */
  function runtimeSeats(binding: string, appliedEventId: string): PresenceSeatsRead {
    return {
      kind: 'listed',
      seats: new Map([['worker', { healthy: true, source: 'runtime', binding, appliedEventId }]]),
    };
  }

  test('a presence projection under the recorded binding answers; a predecessor’s is invalid', () => {
    const binding = 'prs_0123456789ab';
    const applied = writePresence(binding, 'working');
    // The fresh answer lists the seat as serving this binding and vouches for exactly this
    // projection's transition: only then is the row live.
    expect(row({ stateDir: dir, session: SESSION, binding, channelHealthy: true, presenceSeats: runtimeSeats(binding, applied) }))
      .toMatchObject({
        state: 'working',
        state_source: 'presence',
        blind: false,
        presence: { state: 'working', source: 'runtime-hook', event: 'turn-start', live: true },
      });
    // The same qualified seat names another applied transition: the projection is this
    // incarnation's, but not the transition the answer proved applied. Last known, never live.
    expect(row({
      stateDir: dir, session: SESSION, binding, channelHealthy: true,
      presenceSeats: runtimeSeats(binding, `${ago(4)}-ffffffff`),
    }))
      .toMatchObject({
        state: 'working',
        state_source: 'presence',
        presence: { state: 'working', source: 'runtime-hook', event: 'turn-start', live: false },
      });
    // No fresh channel health yet: the same projection is the runtime's last known word, still
    // answering the row, marked not live. The screen and herdr never replace it.
    expect(row({ stateDir: dir, session: SESSION, binding }))
      .toMatchObject({ state: 'working', state_source: 'presence', presence: { live: false } });
    // A projection a relaunch recorded since is another incarnation's. It is an existing
    // projection, never genuine absence: the row is unknown from presence, and neither the
    // screen nor herdr answers in its place. A qualified answer for the recorded binding does
    // not change that: the fence is checked before any applied transition.
    expect(row({
      stateDir: dir, session: SESSION, binding: 'prs_ba9876543210', channelHealthy: true,
      presenceSeats: runtimeSeats('prs_ba9876543210', applied),
    }))
      .toMatchObject({ state: 'unknown', state_source: 'presence', presence_unreadable: true });
    // The state records no binding at all: there is no fence to open, so the same answer.
    expect(row({ stateDir: dir, session: SESSION }))
      .toMatchObject({ state: 'unknown', state_source: 'presence', presence_unreadable: true });
    // An idle prompt or a permission dialog does not answer in an invalid projection's place.
    expect(row({
      stateDir: dir, session: SESSION, binding: 'prs_ba9876543210', channelHealthy: true,
      presenceSeats: runtimeSeats('prs_ba9876543210', applied), screen: 'idle',
    }))
      .toMatchObject({ state: 'unknown', state_source: 'presence', presence_unreadable: true });
    expect(row({ stateDir: dir, session: SESSION, screen: 'permission' }))
      .toMatchObject({ state: 'unknown', state_source: 'presence', presence_unreadable: true });
  });

  test('with no projection at all, the labelled screen answers as before', () => {
    expect(row({ stateDir: dir, session: SESSION, binding: 'prs_0123456789ab', screen: 'idle' }))
      .toMatchObject({ state: 'idle', state_source: 'cli' });
    expect(row({ stateDir: dir, session: SESSION, screen: 'permission' }))
      .toMatchObject({ state: 'blocked', state_source: 'cli' });
  });

  test('a projection this build cannot read is unknown from presence, never a screen guess', () => {
    const paths = presencePaths(dir, SESSION, 'worker');
    if (paths === null) throw new Error('the scene names no presence folder');
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.current, '{not json');
    expect(row({ stateDir: dir, session: SESSION, binding: 'prs_0123456789ab', channelHealthy: true }))
      .toMatchObject({ state: 'unknown', state_source: 'presence', presence_unreadable: true });
  });

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
