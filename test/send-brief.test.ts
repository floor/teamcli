// `team send --brief <file>`: the whole draft brief is read into the body, exactly as --file
// does, and a body that is only a path to a brief file is warned about (never refused). The
// scenes use a human seat, whose walk is the drop leg alone, so every run writes one signed
// record and types nothing; the record's body is what the seat would read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID, receiptPath, writeListener } from '../src/mcp/inbox.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { readHistory } from '../src/send/history.ts';
import { signedReceiptOf, verifyReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { NativePane } from '../src/send/native.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-10-19T20:00:00.000Z');
const SESSION = 'briefs';
const SEAT = 'reader';
const HEADER = 'from the owner — admitted by: the owner';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; sockets: string };

function world(input: { human?: boolean; cli?: string } = {}): World {
  const cli = input.cli ?? 'claude-code';
  const human = input.human ?? true;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-brief-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: ${SEAT}
    cli: ${cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${cli === 'claude-code' ? 'claude' : cli}
${human ? '    human: true\n' : ''}`);
  return { base, root, dir, home, sockets };
}

function fake(w: World): SendHost {
  const native: NativePane = {
    typeText: () => {
      throw new Error('a human seat is never typed into');
    },
    pressEnter: () => {
      throw new Error('a human seat is never typed into');
    },
    status: () => 'idle',
    wait: async () => {},
  };
  return {
    agents: () => [{ name: SEAT, pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
    inboxGraceMs: 0,
  };
}

function io(w: World): TestIo {
  return testIo(w.root, { kind: 'owner' });
}

/** The one drop record the send wrote, parsed. The inbox listener's dotfile and the `.pending`
 *  marker beside the record are not records. */
function record(w: World): { id: string; body: string } {
  const dropDir = join(w.dir, 'send-drops', SESSION, SEAT);
  const names = readdirSync(dropDir).filter((name) => MESSAGE_ID.test(name));
  expect(names).toHaveLength(1);
  const parsed = JSON.parse(readFileSync(join(dropDir, names[0]!), 'utf8')) as { payload: { id: string; body: string } };
  return parsed.payload;
}

function brief(w: World, name: string, text: string): string {
  const dir = join(w.root, 'briefs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('team send --brief reads the whole draft into the body', () => {
  test('the record carries the file verbatim under the sender header', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'First line.\nSecond line: do the thing.\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(record(w).body).toBe(`${HEADER}\n\nFirst line.\nSecond line: do the thing.\n`);
    expect(on.err).toBe('');
  });

  test('--brief and --file together are a usage refusal naming both', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path, '--file', path], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('a brief and --file cannot both be given');
  });

  test('--brief and an inline message together are a usage refusal', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path, 'and', 'this'], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('a message and --brief cannot both be given');
  });

  test('a brief file that cannot be read is a configuration refusal', async () => {
    const w = world();
    const on = io(w);

    const code = await runSend([SEAT, '--brief', join(w.root, 'briefs', 'missing.md')], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('the message file cannot be read');
  });

  test('an empty brief file is refused as an empty message', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', '\n\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('the message is empty');
  });
});

describe('a body that only points at a brief is warned about', () => {
  test('an inline body that is one path to an existing brief warns and still sends', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'the whole brief\n');
    const on = io(w);

    const code = await runSend([SEAT, path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toContain(`${SEAT}: the body only points at a brief (${path}); send the brief itself`);
    expect(record(w).body).toBe(`${HEADER}\n\n${path}`);
  });

  test('a --brief file whose own text is only another brief path is warned about too', async () => {
    const w = world();
    const inner = brief(w, 'inner.md', 'the whole brief\n');
    const outer = brief(w, 'outer.md', `${inner}\n`);
    const on = io(w);

    const code = await runSend([SEAT, '--brief', outer], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toContain('the body only points at a brief');
    expect(record(w).body).toBe(`${HEADER}\n\n${inner}\n`);
  });

  test('a prose body that mentions a brief path is not a pointer and draws no warning', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'the whole brief\n');
    const on = io(w);

    const code = await runSend([SEAT, `read this and do that: ${path}`], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toBe('');
  });

  test('a path to a file that is not under briefs/ draws no warning', async () => {
    const w = world();
    const notes = join(w.root, 'notes');
    mkdirSync(notes, { recursive: true });
    const path = join(notes, 'task.md');
    writeFileSync(path, 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toBe('');
  });

  // `brief-transport` governs how a brief travels, and `--brief` is the explicit brief form. A
  // `memory` team refuses it before the draft is read or any durable write is made: no fallback
  // to `file`, so no drop, state line, history line or log line exists after the refusal.
  test('a memory brief-transport refuses --brief with nothing written', async () => {
    const w = world();
    const wrote = writePolicySet(
      w.home,
      { level: 'team', target: w.root, teamRoot: w.root, name: 'brief-transport', value: 'memory' },
      { now: NOW },
    );
    expect(wrote.ok).toBe(true);
    const path = brief(w, 'lead-to-reader.md', 'First line.\nSecond line.\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code, on.err).toBe(1);
    expect(on.err).toContain('refused: brief-transport is memory');
    expect(existsSync(join(w.dir, 'send-drops'))).toBe(false);
    expect(existsSync(join(w.dir, 'team.state.json'))).toBe(false);
    expect(existsSync(join(w.dir, 'team.log'))).toBe(false);
    const history = readHistory('acme', w.root, w.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries).toEqual([]);
  });
});

// OD50 end to end: under `brief-transport: message` a full brief sent by the ordinary
// `team send --brief` command travels the seat's own delivery walk, not a special channel. The
// synthetic runtime boundary is a live inbox listener marker naming this test's pid — no real
// pane or floor session — so the mcp-inbox leg takes the record. The seat's receipt-writing
// `team drops --read` then hands the whole body over once and signs the receipt; the sender's
// history line names the leg and the outcome.
describe('a message-transport full brief sent end to end', () => {
  test('the whole brief is delivered, read once, receipted and in the history', async () => {
    const w = world({ human: false, cli: 'codex' });
    const wrote = writePolicySet(
      w.home,
      { level: 'team', target: w.root, teamRoot: w.root, name: 'brief-transport', value: 'message' },
      { now: NOW },
    );
    expect(wrote.ok).toBe(true);
    const text = 'First line of the brief.\nSecond line: the whole body, not a pointer.\n';
    const path = brief(w, 'lead-to-reader.md', text);
    const dropDir = join(w.dir, 'send-drops', SESSION, SEAT);
    mkdirSync(dropDir, { recursive: true });
    writeListener(dropDir, {
      v: 1,
      seat: SEAT,
      session: SESSION,
      root: w.root,
      cli: 'codex',
      pid: process.pid,
      ts: NOW.toISOString(),
    });
    const on = io(w);

    // The ordinary send: the whole file becomes the body, and the mcp-inbox leg takes it.
    const code = await runSend([SEAT, '--brief', path], on, fake(w));
    expect(code, on.err).toBe(0);
    expect(on.out).toBe(`team acme, session "briefs"\n${SEAT}: sent (unconfirmed) (mcp-inbox, 0 ms)\n`);
    const rec = record(w);
    expect(rec.body).toBe(`${HEADER}\n\n${text}`);

    // The sender's history names the leg, the id and the outcome.
    const history = readHistory('acme', w.root, w.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries.at(-1)).toMatchObject({
        to: SEAT,
        id: rec.id,
        via: 'mcp-inbox',
        outcome: 'sent (unconfirmed)',
      });
    }

    // The seat's own read hands the full body over and signs the receipt against the record.
    const readIo = testIo(w.root, { kind: 'owner' });
    const read = await runDrops(['--read', '--seat', SEAT, '--session', SESSION], readIo, { home: w.home });
    expect(read, readIo.err).toBe(0);
    expect(readIo.out).toBe(`${HEADER}\n\n${text}\n`);
    expect(readIo.err).toBe('');
    const at = receiptPath(dropDir, rec.id);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(at, 'utf8')));
    const key = messageKeyState(w.home);
    if (receipt === null) throw new Error('the seat wrote no signed receipt');
    if (key.kind !== 'key') throw new Error('the fixture left no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(receipt.payload).toMatchObject({
      kind: 'receipt',
      status: 'read',
      id: rec.id,
      to: SEAT,
      root: w.root,
      session: SESSION,
    });

    // Write-once: the next turn finds nothing waiting, so the full body is not served twice.
    const againIo = testIo(w.root, { kind: 'owner' });
    const again = await runDrops(['--read', '--seat', SEAT, '--session', SESSION], againIo, { home: w.home });
    expect(again, againIo.err).toBe(0);
    expect(againIo.out).toBe('');
  });
});
