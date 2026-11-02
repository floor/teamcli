// The session leg: a receiving CLI whose profile declares `session_cli` takes the whole body —
// rules, sender header and brief — as ONE argument of its own session-creating call, run in the
// seat's own folder. Delivered is the session line the CLI prints with an id; every other ending
// is a route that did not take the send and the walk moves to the leg behind it. Fixtures only:
// a synthetic team, a fake `jules` executable FIRST on PATH (asserted by every test), and a jules
// profile read from the shipped YAML. No real CLI is run and no pane is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { senderHeader } from '../src/send/admit.ts';
import { readHistory } from '../src/send/history.ts';
import {
  createSession,
  pullSession,
  sessionLineOf,
  type SessionCliSpec,
} from '../src/send/session-cli.ts';
import { cleanupFakeJules, fakeJulesOnPath, type FakeJules, type FakeJulesAnswer } from './helpers/fake-jules.ts';
import { fake, owner, type World } from './send-native-fixtures.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { recordBody } from './helpers.ts';

const SESSION = 'acme';
const SEAT = 'jules-seat';
const SEND_ID = 'aaaaaaaa-0000-4000-8000-000000000301';
const CREATED_LINE = 'Session created: https://jules.google.com/session/abc123\n';
const JULES: SessionCliSpec = {
  argv: ['jules', 'new'],
  repoFlag: '--repo',
  created: 'Session created: ',
  pull: ['jules', 'remote', 'pull'],
};

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  cleanupFakeJules();
});

/** A fake `jules` FIRST on PATH, answering with the scene's script, and the assertion that it is
 *  the binary a spawn by name reaches. Every test in this file makes that call before it runs
 *  anything: the machine may have a real `jules` installed, and no scene may ever reach it. */
function julesFirstOnPath(answer: FakeJulesAnswer = {}): FakeJules {
  const fakeJules = fakeJulesOnPath(answer);
  expect(fakeJules.firstOnPath()).toBe(fakeJules.binary);
  return fakeJules;
}

/** A real folder for a call that must actually spawn, with the fake that call will reach inside
 *  it: one cleanup removes the folder and the fake together. */
function scratchWithJules(answer: FakeJulesAnswer = {}): { dir: string; jules: FakeJules } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-session-cwd-')));
  const prior = cleanup;
  cleanup = () => {
    prior();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, jules: julesFirstOnPath(answer) };
}

/** The team a session-leg scene sends into: acme's lead, and a jules seat declaring no order of
 *  its own. A CLI with no installed watcher takes the seat's shape word — the inbox and the typed
 *  wake — and the session call stands where that retired typed word stands. */
function julesWorld(opts: { order?: readonly string[] | null; origin?: string; julesFields?: string } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-session-cli-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  if (opts.origin !== undefined) execFileSync('git', ['remote', 'add', 'origin', opts.origin], { cwd: root, stdio: 'ignore' });
  const order = opts.order ?? null;
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    inbound: accept
  - role: implementer
    name: ${SEAT}
    cli: jules
    vendor: google
    model: Jules
    version: "0.1.42"
    launch: jules
${opts.julesFields ?? ''}${order === null ? '' : `delivery_order: [${order.join(', ')}]\n`}`);
  const made: World = {
    root,
    dir: join(root, '.agents'),
    sockets,
    home,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  cleanup = made.cleanup;
  return made;
}

/** Synthetic private lists under the scene's own base folder: one entry a body can name, and a
 *  phrases path that does not exist. A public-only send reads the paths the host hands it, so no
 *  scene ever touches the machine's own lists. */
function privateLists(made: World, entries: readonly string[] = ['Zephyrine Quillfeather']): { names: string; phrases: string } {
  const folder = join(dirname(made.root), 'private');
  mkdirSync(folder, { recursive: true });
  const names = join(folder, 'names.txt');
  writeFileSync(names, entries.map((entry) => `${entry}\n`).join(''), { mode: 0o600 });
  return { names, phrases: join(folder, 'phrases.txt') };
}

/** The scene's host with those lists: every send in this file goes through one. */
function host(made: World, patch: Parameters<typeof fake>[1] = {}): ReturnType<typeof fake> {
  return fake(made, { privateLists: privateLists(made), ...patch });
}

function entries(made: World): Record<string, unknown>[] {
  const history = readHistory(SESSION, made.root, made.home);
  if (!history.ok) throw new Error('the history could not be read');
  return history.entries as unknown as Record<string, unknown>[];
}

function lastEntry(made: World): Record<string, unknown> {
  const entry = entries(made).at(-1);
  if (entry === undefined) throw new Error('no history entry');
  return entry;
}

function seatDropDir(made: World): string {
  return join(made.dir, 'send-drops', SESSION, SEAT);
}

describe('the session line the CLI prints', () => {
  test('a URL line yields the last /session/ segment; a bare id yields the rest', () => {
    expect(julesFirstOnPath({}).firstOnPath()).not.toBeNull();
    expect(sessionLineOf('Session created: https://jules.google.com/session/1234567890\n', 'Session created: '))
      .toEqual({ session: '1234567890', line: 'Session created: https://jules.google.com/session/1234567890' });
    expect(sessionLineOf('Session created: abc-123\nPress any key to go back to the session table\n', 'Session created: '))
      .toEqual({ session: 'abc-123', line: 'Session created: abc-123' });
  });

  test('trailing punctuation and quotes are not part of the id; anything else is no session', () => {
    expect(julesFirstOnPath({}).firstOnPath()).not.toBeNull();
    expect(sessionLineOf('Session created: https://jules.google.com/session/abc.', 'Session created: '))
      .toEqual({ session: 'abc', line: 'Session created: https://jules.google.com/session/abc.' });
    expect(sessionLineOf('Session created: "https://jules.google.com/session/abc"', 'Session created: '))
      .toEqual({ session: 'abc', line: 'Session created: "https://jules.google.com/session/abc"' });
    expect(sessionLineOf('Session created: \n', 'Session created: ')).toBeNull();
    expect(sessionLineOf('Session created: <abc>', 'Session created: ')).toBeNull();
    expect(sessionLineOf('nothing here', 'Session created: ')).toBeNull();
  });
});

describe('the session-creating call', () => {
  test('the CLI is spawned from PATH, and the whole body arrives as ONE argument after the repo flag', async () => {
    const { dir, jules } = scratchWithJules({ status: 0, stdout: CREATED_LINE });
    const attempt = await createSession({ spec: JULES, cwd: dir, repo: 'owner/repo', body: 'line one\nline two' });

    expect(attempt).toEqual({
      outcome: 'created',
      session: 'abc123',
      line: 'Session created: https://jules.google.com/session/abc123',
    });
    expect(jules.calls()).toEqual([{ argv: ['new', '--repo', 'owner/repo', 'line one\nline two'], cwd: dir }]);
  });

  test('the session line on the error stream is the same delivery', async () => {
    const { dir, jules } = scratchWithJules({ status: 0, stdout: '', stderr: CREATED_LINE });
    const attempt = await createSession({ spec: JULES, cwd: dir, repo: null, body: 'hello' });

    expect(attempt).toEqual({ outcome: 'created', session: 'abc123', line: 'Session created: https://jules.google.com/session/abc123' });
    expect(jules.calls()).toEqual([{ argv: ['new', 'hello'], cwd: dir }]);
  });

  test('no repo means no flag; exit 0 without the line is not a delivery', async () => {
    const { dir, jules } = scratchWithJules({ status: 0, stdout: 'working...\n' });
    const attempt = await createSession({ spec: JULES, cwd: dir, repo: null, body: 'hello' });

    expect(attempt).toEqual({ outcome: 'refused', reason: 'the jules CLI exited 0 without printing its session line' });
    expect(jules.calls()[0]?.argv).toEqual(['new', 'hello']);
  });

  test('a non-zero exit names the last error line; a call that cannot run says so; a line already printed still stands', async () => {
    const { dir } = scratchWithJules({ status: 2, stderr: 'first\nError: no account\n' });
    const failed = await createSession({ spec: JULES, cwd: dir, repo: null, body: 'hello' });
    expect(failed).toEqual({ outcome: 'refused', reason: 'the jules CLI exited 2 (Error: no account)' });

    const missing = await createSession({
      spec: JULES, cwd: dir, repo: null, body: 'hello',
      spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn jules ENOENT') }),
    });
    expect(missing).toEqual({ outcome: 'refused', reason: 'the jules CLI could not be run (spawn jules ENOENT)' });

    const stillCreated = await createSession({
      spec: JULES, cwd: dir, repo: null, body: 'hello',
      spawn: () => ({ status: null, stdout: 'Session created: abc123\n', stderr: '', error: new Error('killed') }),
    });
    expect(stillCreated).toEqual({ outcome: 'created', session: 'abc123', line: 'Session created: abc123' });
  });
});

describe('pulling a session into a worktree', () => {
  test('the profile pull call is run with --session <id> --apply in the named folder', async () => {
    const { dir, jules } = scratchWithJules({ status: 0, stdout: 'applied\n' });
    const result = await pullSession({ spec: JULES, session: '123456', cwd: dir });

    expect(result).toEqual({ outcome: 'pulled', stdout: 'applied\n', stderr: '' });
    expect(jules.calls()).toEqual([{ argv: ['remote', 'pull', '--session', '123456', '--apply'], cwd: dir }]);
  });

  test('a non-zero exit refuses with the CLI\'s last line; a profile with no pull call runs nothing', async () => {
    const { dir, jules } = scratchWithJules({ status: 1, stderr: 'error: session not found\n' });
    const failed = await pullSession({ spec: JULES, session: '1', cwd: dir });
    expect(failed).toEqual({
      outcome: 'refused',
      reason: 'the jules CLI exited 1 (error: session not found)',
      stdout: '',
      stderr: 'error: session not found\n',
    });

    const missing = await pullSession({ spec: { ...JULES, pull: [] }, session: '1', cwd: dir });
    expect(missing.outcome).toBe('refused');
    expect(jules.calls()).toHaveLength(1);
  });
});

describe('a send to a seat whose CLI creates its own session', () => {
  test('the walk spawns the fake jules from PATH and records the id it printed', async () => {
    const made = julesWorld();
    const jules = julesFirstOnPath({ status: 0, stdout: CREATED_LINE });
    const io = owner(made.root);

    const code = await runSend([SEAT, 'hello'], io, host(made));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain(`${SEAT}: delivered (session abc123)`);
    const calls = jules.calls();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('the session call was not made');
    expect(call.argv).toHaveLength(2);
    expect(call.argv[0]).toBe('new');
    const body = call.argv[1] ?? '';
    // The seat is public-only (its profile declares it): no rules are prepended, and the
    // sender header and the message are the whole body.
    expect(body).not.toContain('Never delete a Jules session.');
    expect(body).not.toContain('Rules for this session');
    expect(body).toContain(senderHeader('owner', 'the owner'));
    expect(body.endsWith('hello')).toBe(true);
    expect(realpathSync(call.cwd)).toBe(realpathSync(made.root));
    expect(lastEntry(made)).toMatchObject({
      to: SEAT,
      outcome: 'delivered',
      via: 'session',
      session: 'abc123',
    });
  });

  test('a folder whose origin names a repository passes it as --repo owner/repo', async () => {
    const made = julesWorld({ origin: 'git@github.com:owner/repo.git' });
    const jules = julesFirstOnPath({ status: 0, stdout: CREATED_LINE });

    expect(await runSend([SEAT, 'hello'], owner(made.root), host(made))).toBe(0);

    const argv = jules.calls()[0]?.argv ?? [];
    expect(argv).toHaveLength(4);
    expect(argv.slice(0, 3)).toEqual(['new', '--repo', 'owner/repo']);
    expect(argv[3]).toContain('hello');
  });

  test('a call that prints no session line is a failed route: the walk falls through and the drop keeps the message', async () => {
    const made = julesWorld();
    const jules = julesFirstOnPath({ status: 1, stderr: 'Error: no account\n' });
    const io = owner(made.root);

    const code = await runSend([SEAT, 'hello'], io, host(made, { sendId: () => SEND_ID }));

    expect(code).toBe(0);
    expect(io.out).toContain(`${SEAT}: sent (unconfirmed) (drop`);
    expect(io.err).toContain('the message waits in its bus inbox');
    expect(existsSync(join(seatDropDir(made), SEND_ID))).toBe(true);
    expect(recordBody(join(seatDropDir(made), SEND_ID))).toContain('hello');
    expect(jules.calls()).toHaveLength(1);
    const entry = lastEntry(made);
    expect(entry).toMatchObject({ outcome: 'sent (unconfirmed)', via: 'drop' });
    expect(entry.failed).toEqual(expect.arrayContaining([
      `session: the jules CLI exited 1 (Error: no account)`,
    ]));
  });

  test('a body that names a private entry never reaches the CLI: the rule is named, the text is not, and the drop keeps it', async () => {
    const made = julesWorld();
    const jules = julesFirstOnPath({ status: 0, stdout: CREATED_LINE });
    const io = owner(made.root);

    const code = await runSend([SEAT, 'notes for Zephyrine Quillfeather'], io, host(made, { sendId: () => SEND_ID }));

    expect(code).toBe(0);
    expect(jules.calls()).toEqual([]);
    expect(io.out).toContain(`${SEAT}: sent (unconfirmed) (drop`);
    // The local copy keeps the body: the message is not lost, it is not handed to a public
    // service. The refusal names the rule it matched and never repeats the text.
    expect(recordBody(join(seatDropDir(made), SEND_ID))).toContain('Zephyrine Quillfeather');
    const entry = lastEntry(made);
    expect(entry).toMatchObject({ outcome: 'sent (unconfirmed)', via: 'drop' });
    const failed = (entry.failed as string[] | undefined) ?? [];
    expect(failed).toEqual(expect.arrayContaining([
      'session: the body matches a private rule (names entry 1); no session was created',
    ]));
    expect(failed.join('\n')).not.toContain('Zephyrine');
    expect(io.err).not.toContain('Zephyrine');
    expect(io.out).not.toContain('Zephyrine');
  });

  test('a seat the team file marks public_only keeps the guard on', async () => {
    const made = julesWorld({ julesFields: '    public_only: true\n' });
    const jules = julesFirstOnPath({ status: 0, stdout: CREATED_LINE });
    const io = owner(made.root);

    const code = await runSend([SEAT, 'notes for Zephyrine Quillfeather'], io, host(made, { sendId: () => SEND_ID }));

    expect(code).toBe(0);
    expect(jules.calls()).toEqual([]);
    expect(lastEntry(made)).toMatchObject({ outcome: 'sent (unconfirmed)', via: 'drop' });
  });

  test('a declared order keeps its words; the retired typed wake stands where the session call can', async () => {
    const made = julesWorld({ order: ['mcp-inbox', 'typed'] });
    const jules = julesFirstOnPath({ status: 0, stdout: CREATED_LINE });

    expect(await runSend([SEAT, 'hello'], owner(made.root), host(made))).toBe(0);

    expect(jules.calls()).toHaveLength(1);
    expect(lastEntry(made)).toMatchObject({ via: 'session', session: 'abc123' });
  });

  test('a seat whose CLI declares no session call records the leg unavailable when an order names it', async () => {
    const made = julesWorld({ order: ['session', 'drop'] });
    const jules = julesFirstOnPath();
    const io = owner(made.root);

    // The lead is a Claude Code seat: its profile declares no session call, so the named leg is
    // skipped with the reason and the drop leg behind it still takes the message.
    const code = await runSend(['lead', 'hello'], io, host(made));

    expect(code).toBe(0);
    expect(jules.calls()).toEqual([]);
    const entry = lastEntry(made);
    expect(entry).toMatchObject({ to: 'lead', via: 'drop' });
    expect(entry.failed).toEqual(expect.arrayContaining([
      'session: claude-code has no session-creating command in this build',
    ]));
  });

  test('a dry run names the session call and spawns nothing', async () => {
    const made = julesWorld();
    const jules = julesFirstOnPath();
    const io = owner(made.root);

    expect(await runSend([SEAT, 'hello', '--dry-run'], io, host(made))).toBe(0);

    expect(jules.calls()).toEqual([]);
    expect(io.out).toContain("the CLI's own session call, with the brief as one argument");
    expect(io.out).toContain('nothing was written');
  });

  test('--json reports the delivery on the session channel and the session leg in the plan', async () => {
    const made = julesWorld();
    const jules = julesFirstOnPath();
    const io = owner(made.root);

    expect(await runSend([SEAT, 'hello', '--dry-run', '--json'], io, host(made))).toBe(0);

    expect(jules.calls()).toEqual([]);
    const doc = assertMatchesOutputSchema<{
      status: string;
      dry_run: boolean;
      channel: string | null;
      delivery: { leg: string; state: string; eligible?: boolean }[];
    }>(io.out, SEND_OUTPUT_SCHEMA);
    expect(doc.status).toBe('dry-run');
    expect(doc.dry_run).toBe(true);
    expect(doc.delivery.map((one) => one.leg)).toContain('session');
    expect(doc.delivery.find((one) => one.leg === 'session')).toEqual({ leg: 'session', state: 'candidate', eligible: true });
    // Nothing was written: the drop folder a real send would leave the record in does not exist.
    expect(existsSync(seatDropDir(made))).toBe(false);
  });
});
