// One watch pass reads each drop folder once and each message record once.
//
// A pass asks three readers the same question about the same drops: `mailboxWaiting` lists the
// unacked records and, per seat with one, that seat's unread drops; `wakeUnreadDrops` lists every
// seat's unread drops; `reportUnreadDrops` lists them again. Before the shared reading, a 47k-drop
// tree was scanned three times a pass and every waiting record was read two or three times. The
// counts here are the proof: the fs is wrapped to record every open and read under one folder, and
// each scene states the number of times the record may be opened. The receipt is checked before
// the record is read, so a message already read is not opened at all; a waiting record is opened
// once, and the 50,000-file folder is opened once per record rather than twice.
//
// bun binds a module's named imports as it loads, so the mock is registered before any module that
// reads records is imported: every module here is imported dynamically in the beforeAll below, and
// every static import above loads no product module. The recording wrapper delegates everything to
// the real fs, and the real functions are put back when this file ends — bun's module mocks are
// process-wide, and every test file of a run shares one process.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';

const realFs = await import('node:fs');
// Captured by value before the wrapper stands: the restore below must name the module's own
// functions even where the live namespace answers the wrapper.
const realFsCalls = {
  openSync: realFs.openSync,
  readFileSync: realFs.readFileSync,
};
const opened: string[] = [];
const readFiles: string[] = [];
let watching: string | undefined;
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  for (const name of ['openSync', 'readFileSync'] as const) {
    const real = realFs[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, {
      [name]: (...args: unknown[]) => {
        if (watching !== undefined && String(args[0]).startsWith(watching)) {
          (name === 'openSync' ? opened : readFiles).push(String(args[0]));
        }
        return real(...args);
      },
    });
  }
  return wrapped as typeof realFs;
});
afterAll(() => { mock.module('node:fs', () => ({ ...realFs, ...realFsCalls })); });

let listUnackedMessages: (typeof import('../src/commands/messages.ts'))['listUnackedMessages'];
let runWatch: (typeof import('../src/commands/watch.ts'))['runWatch'];
let messageKeyOf: (typeof import('../src/store/keys.ts'))['messageKeyOf'];
let listUnread: (typeof import('../src/mcp/inbox.ts'))['listUnread'];
let signRecord: (typeof import('../src/send/record.ts'))['signRecord'];
let signReceiptPayload: (typeof import('../src/send/record.ts'))['signReceiptPayload'];
let writeReceipt: (typeof import('../src/send/record.ts'))['writeReceipt'];
let testIo: (typeof import('./helpers.ts'))['testIo'];
beforeAll(async () => {
  ({ messageKeyOf } = await import('../src/store/keys.ts'));
  ({ signRecord, signReceiptPayload, writeReceipt } = await import('../src/send/record.ts'));
  ({ listUnread } = await import('../src/mcp/inbox.ts'));
  ({ listUnackedMessages } = await import('../src/commands/messages.ts'));
  ({ runWatch } = await import('../src/commands/watch.ts'));
  ({ testIo } = await import('./helpers.ts'));
});

const SESSION = 'acme';
const UNREAD = '11111111-1111-4111-8111-111111111111';
const READ = '22222222-2222-4222-8222-222222222222';
const PLAIN = '33333333-3333-4333-8333-333333333333';
const AT = '2026-11-05T09:00:00.000Z';

type World = { base: string; root: string; dir: string; home: string };
let bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  watching = undefined;
  opened.length = 0;
  readFiles.length = 0;
});

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-mail-scan-')));
  bases.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, root, dir, home };
}

function dropsOf(w: World, session = SESSION): string {
  return join(w.dir, 'send-drops', session);
}

function dropOf(w: World, seat: string, session = SESSION): string {
  return join(dropsOf(w, session), seat);
}

/** A signed record dropped into `seat`'s folder, signed by `home`'s message key. */
function seed(
  w: World,
  seat: string,
  id: string,
  at: Date,
  options: { session?: string; home?: string; from?: string } = {},
): string {
  const session = options.session ?? SESSION;
  const dropDir = dropOf(w, seat, session);
  mkdirSync(dropDir, { recursive: true });
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(w.root),
    session,
    at: at.toISOString(),
    body: `a message to ${seat}`,
    from: options.from ?? 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, options.home ?? w.home);
  const path = join(dropDir, id);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** The signed read receipt the inbox writes beside a message once its seat read it. */
function markRead(w: World, seat: string, id: string, at: Date, session = SESSION, home = w.home): void {
  const receipt = signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id,
    to: seat,
    root: realpathSync(w.root),
    session,
    at: at.toISOString(),
  }, home);
  const written = writeReceipt(dropOf(w, seat, session), receipt, home);
  if (!written.ok) throw new Error(written.reason);
}

function watchingNow(dir: string): void {
  watching = dir;
  opened.length = 0;
  readFiles.length = 0;
}

const opensOf = (path: string): number => opened.filter((one) => one === path).length;
const readsOf = (path: string): number => readFiles.filter((one) => one === path).length;

describe('the record is read after the receipt, once', () => {
  test('listUnread opens a waiting record once and a read one not at all', () => {
    const w = world();
    const waiting = seed(w, 'helper', UNREAD, new Date(AT));
    const read = seed(w, 'helper', READ, new Date(AT));
    markRead(w, 'helper', READ, new Date(AT));
    watchingNow(dropOf(w, 'helper'));

    const listed = listUnread(dropOf(w, 'helper'), { to: 'helper', root: w.root, session: SESSION }, w.home);

    // The list itself is unchanged: the waiting message, dated by its signed `at`.
    expect(listed.map((one) => one.id)).toEqual([UNREAD]);
    expect(listed[0]?.ts).toBe(AT);
    expect(opensOf(waiting)).toBe(1);
    expect(readsOf(waiting)).toBe(0);
    expect(opensOf(read)).toBe(0);
    expect(readsOf(read)).toBe(0);
  });

  test('listUnackedMessages reads each waiting record once, after the receipt check', () => {
    const w = world();
    const waiting = seed(w, 'helper', UNREAD, new Date(AT));
    const read = seed(w, 'helper', READ, new Date(AT));
    markRead(w, 'helper', READ, new Date(AT));
    // A body file from before the record spine is still not a message: it is read once and no
    // more, and it never reaches the list.
    writeFileSync(join(dropOf(w, 'helper'), PLAIN), 'plain text from an earlier build\n');
    watchingNow(dropOf(w, 'helper'));

    const unacked = listUnackedMessages(w.root, SESSION, w.home);

    expect(unacked.map((one) => one.id)).toEqual([UNREAD]);
    expect(unacked[0]?.from).toBe('owner');
    expect(opensOf(waiting)).toBe(1);
    expect(readsOf(waiting)).toBe(0);
    expect(opensOf(read)).toBe(0);
    expect(readsOf(read)).toBe(0);
  });
});

describe('one watch pass reads the mail once', () => {
  test('the pass scans the seat folder once and opens the record once', async () => {
    const w = world();
    execFileSync('git', ['init', '-q'], { cwd: w.root });
    writeFileSync(join(w.dir, 'team.yaml'), readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
    const clock = Date.parse(AT);
    // The fixture's team is `acme-web`; the message is fresh, so neither the N wake nor the 2N
    // report is due: the pass lists the folder for each of its three readers and nothing more.
    const message = seed(w, 'deepseek-acme', UNREAD, new Date(clock), { session: 'acme-web', home: w.root });
    watchingNow(dropOf(w, 'deepseek-acme', 'acme-web'));

    const code = await runWatch(['--file', join(w.dir, 'team.yaml')], testIo(w.root, { kind: 'owner' }), {
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => null,
      status: () => 'idle',
      foreground: () => [],
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.root,
    });

    expect(code).toBe(0);
    expect(opensOf(message)).toBe(1);
    expect(readsOf(message)).toBe(0);
  });

  test('the registry is read once however many records a pass rings', async () => {
    const w = world();
    execFileSync('git', ['init', '-q'], { cwd: w.root });
    writeFileSync(join(w.dir, 'team.yaml'), readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
    const clock = Date.parse(AT);
    const at = new Date(clock);
    seed(w, 'deepseek-acme', UNREAD, at, { session: 'acme-web', home: w.root });
    const teams = join(w.root, '.config', 'team', 'teams.yaml');
    const sources = (): WatchSources => ({
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => null,
      status: () => 'idle',
      foreground: () => [],
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.root,
    });
    watchingNow(teams);

    expect(await runWatch(['--file', join(w.dir, 'team.yaml')], testIo(w.root, { kind: 'owner' }), sources())).toBe(0);
    const one = readsOf(teams);
    // Two more records from the same writer: the ring's words are the pass's, not the record's.
    seed(w, 'deepseek-acme', '44444444-4444-4444-8444-444444444444', at, { session: 'acme-web', home: w.root });
    seed(w, 'deepseek-acme', '55555555-5555-4555-8555-555555555555', at, { session: 'acme-web', home: w.root });
    // Count only the second pass: the seeds write records, not the registry, but the counter is
    // the pass's, so it starts empty.
    watchingNow(teams);
    expect(await runWatch(['--file', join(w.dir, 'team.yaml')], testIo(w.root, { kind: 'owner' }), sources())).toBe(0);
    const three = readsOf(teams);

    expect(one).toBeGreaterThan(0);
    expect(three).toBe(one);
  });
});

describe('the folder is scanned once per record, not twice', () => {
  test('a 50,000-file drop folder is opened once per waiting record', () => {
    const w = world();
    const dropDir = dropOf(w, 'helper');
    mkdirSync(dropDir, { recursive: true });
    // A key exists: a record cannot be verified without one, and an unsigned folder is never
    // read. Each name is a message id; each file is a record this key cannot verify, which is
    // still waiting mail — so every one of them is opened exactly once.
    messageKeyOf(w.home);
    const count = 50_000;
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(dropDir, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`), '{}\n');
    }
    watchingNow(dropDir);

    const listed = listUnread(dropDir, { to: 'helper', root: w.root, session: SESSION }, w.home);

    expect(listed).toHaveLength(count);
    expect(opened).toHaveLength(count);
    expect(new Set(opened).size).toBe(count);

    // Removing 50,000 files outlasts a test hook's few seconds, and the hook would fail the test
    // after it passed: the base goes here, inside the test's own budget.
    const held = bases.indexOf(w.base);
    if (held !== -1) bases.splice(held, 1);
    rmSync(w.base, { recursive: true, force: true });
  }, 180_000);
});
