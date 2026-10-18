// `team drops`: the calling seat's own drop folder. A drop is a message file `team send` left
// under `.agents/send-drops/<session>/<seat>/`; the folder is the mailbox, and these scenes read
// it with the caller placed as the seat the state records, an owner, another seat, and a seat on
// another pane.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { listDrops, runDrops, senderOf, USAGE, type DropsSources } from '../src/commands/drops.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { DROPS_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { signedReceiptOf, signReceiptPayload, verifyReceipt, writeReceipt, type ReceiptPayload } from '../src/send/record.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

// The ids sort in the order the scenes write them, so a reading is the same whether two files
// land in the same millisecond or a later one: the sort falls back to the id on a tie.
const D_OWNER = '0a5b7c1d-8e2f-4a6b-9c3d-1e2f3a4b5c6d';
const D_AGENT = '1b6c8d2e-9f30-4b7c-8d4e-2f3a4b5c6d7e';
const D_READ = '2c7d9e3f-a041-4c8d-9e5f-3a4b5c6d7e8f';
const D_HEADLESS = '3d8e0f4a-b152-4d9e-8f60-4b5c6d7e8f9a';
const D_RECORD = '4e9f1a5b-b263-4ea0-9a71-5c6d7e8f9a0b';
const D_RECORD_READ = '5fa02b6c-c374-4fb1-0b82-6d7e8f9a0b1c';

const OWNER_HEADER = 'from the owner — admitted by: the owner';
const AGENT_HEADER = 'from agt_d18cddafed22 (orchestrator, orchestrator@acme) — admitted by: an orchestrator or operator to a seat of its own team';
const FILE_SEAT_HEADER = "from the file's seat worker (no registry record yet) — admitted by: the file's seat";

let base: string;
let root: string;
let home: string;
let dropDir: string;

function seatCaller(name: string, pane: string): Caller {
  return { kind: 'seat', name, pane, session: 'acme' };
}

function teamYaml(text = TEAM): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

/** The state record a placed seat is judged by: the pane the fixture's caller runs on. */
function placeLead(pane = 'w1:p1'): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        lead: { stage: 'ready' as const, pane },
      },
    } as never;
  });
}

function drop(name: string, text: string): string {
  mkdirSync(dropDir, { recursive: true });
  const path = join(dropDir, name);
  writeFileSync(path, text);
  return path;
}

async function run(
  argv: string[] = [],
  caller: Caller = seatCaller('lead', 'w1:p1'),
  sources: DropsSources = { home },
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runDrops(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

beforeEach(() => {
  // The listing reports real paths: a temporary directory is a symlink under /var on macOS, and
  // the scene compares the path the command printed with the one it wrote.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drops-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  teamYaml();
  placeLead();
  dropDir = join(root, '.agents', 'send-drops', 'acme', 'lead');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team drops', () => {
  test('a seat with no folder reads zero drops, and no folder is created', async () => {
    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  FROM  PATH\n\n0 drops\n',
      err: '',
    });
    expect(listDrops(dropDir)).toEqual({ kind: 'ok', rows: [] });
  });

  test('the table lists drops oldest first, skips sidecars and read drops, and names each sender', async () => {
    const ownerPath = drop(D_OWNER, `${OWNER_HEADER}\n\nthe owner's words\n`);
    const agentPath = drop(D_AGENT, `${AGENT_HEADER}\n\nthe orchestrator's words\n`);
    // Sidecars live beside a drop and are never listed.
    drop(`${D_OWNER}.pending`, JSON.stringify({ id: D_OWNER, from: 'owner', to: 'lead', body: '', ts: '2026-10-04T09:00:00.000Z', tries: 0 }));
    drop(`${D_OWNER}.taken`, JSON.stringify({ id: D_OWNER }));
    drop(`${D_OWNER}.deadbeef.tmp`, 'partial');
    // A drop with a signed receipt beside it was handed over: it is read, and is not listed. The
    // receipt is the signed status receipt the inbox and `team messages` write; a bare file at
    // that name proves nothing.
    drop(D_READ, `${FILE_SEAT_HEADER}\n\nread already\n`);
    const handedOver = writeReceipt(dropDir, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: D_READ,
      to: 'lead',
      root,
      session: 'acme',
      at: '2026-10-04T09:00:00.000Z',
    }, home), home);
    expect(handedOver.ok).toBe(true);
    // A file whose first line is no sender header is still a drop, and its sender is unknown.
    const headlessPath = drop(D_HEADLESS, 'a body with no sender line\n');
    // A send of this version leaves one signed record: the payload names the sender, and the
    // read receipt the inbox writes carries its status in the name (`<id>.read.json`).
    const recordPath = plantRecord(home, root, 'acme', 'lead', D_RECORD, 'the record body', {
      from: 'orchestrator',
      from_id: 'agt_d18cddafed22',
      rule: 'an orchestrator or operator to a seat of its own team',
    });
    const readRecorded = plantRecord(home, root, 'acme', 'lead', D_RECORD_READ, 'already read');
    const receipt: ReceiptPayload = {
      kind: 'receipt',
      status: 'read',
      id: D_RECORD_READ,
      to: 'lead',
      root,
      session: 'acme',
      at: '2026-10-04T09:00:00.000Z',
    };
    const written = writeReceipt(dropDir, signReceiptPayload(receipt, home), home);
    expect(written.ok).toBe(true);
    expect(readRecorded.endsWith(D_RECORD_READ)).toBe(true);

    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: [
        'team acme, session "acme"',
        '  FROM          PATH',
        `  the owner     ${ownerPath}`,
        `  orchestrator  ${agentPath}`,
        `  unknown       ${headlessPath}`,
        `  orchestrator  ${recordPath}`,
        '',
        '4 drops',
        '',
      ].join('\n'),
      err: '',
    });
  });

  test('a record the message key does not verify leaves its sender unknown', () => {
    const path = plantRecord(home, root, 'acme', 'lead', D_RECORD, 'tampered after signing');
    const record = JSON.parse(readFileSync(path, 'utf8')) as { signature: string };
    record.signature = 'not-this-key';
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    const state = messageKeyState(home);
    if (state.kind !== 'key') throw new Error('the fixture wrote no key');
    const listing = listDrops(dropDir, state.key);
    if (listing.kind !== 'ok') throw new Error(listing.reason);
    expect(listing.rows.map((row) => [row.id, row.from])).toEqual([[D_RECORD, null]]);
  });

  test('--json is the same reading as one team.drops document', async () => {
    const ownerPath = drop(D_OWNER, `${OWNER_HEADER}\n\nwords\n`);
    const headlessPath = drop(D_HEADLESS, 'no header here\n');
    const result = await run(['--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const parsed = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      session: string;
      seat: string;
      drops: { from: string | null; received: string; path: string }[];
      counts: { drops: number };
    }>(result.out, DROPS_OUTPUT_SCHEMA);
    expect(parsed.schema).toEqual({ name: 'team.drops', version: 1 });
    expect(parsed.format).toBe(1);
    expect(parsed.project).toBe('acme');
    expect(parsed.session).toBe('acme');
    expect(parsed.seat).toBe('lead');
    expect(parsed.drops.map((row) => ({ from: row.from, path: row.path }))).toEqual([
      { from: 'the owner', path: ownerPath },
      { from: null, path: headlessPath },
    ]);
    expect(parsed.counts).toEqual({ drops: 2 });
    expect(Number.isFinite(Date.parse(parsed.drops[0]!.received))).toBe(true);
  });

  test('--follow prints only the drops that appear while it runs, one line each, and exits 0', async () => {
    const before = drop(D_OWNER, `${OWNER_HEADER}\n\nalready waiting\n`);
    let polls = 0;
    const sources: DropsSources = {
      home,
      poll: async () => {
        polls += 1;
        if (polls === 1) {
          drop(D_AGENT, `${AGENT_HEADER}\n\nfresh\n`);
          return true;
        }
        return false;
      },
    };
    const result = await run(['--follow'], seatCaller('lead', 'w1:p1'), sources);
    const after = join(dropDir, D_AGENT);
    expect(result).toEqual({
      code: 0,
      out: `from orchestrator — ${after}\n`,
      err: '',
    });
    // The drop already on disk is not a new one.
    expect(result.out).not.toContain(before);
    expect(polls).toBe(2);
  });

  test('only the seat itself, on its recorded pane, reads the folder', async () => {
    drop(D_OWNER, `${OWNER_HEADER}\n\nwords\n`);

    const owner = await run([], { kind: 'owner' });
    expect(owner.code).toBe(1);
    expect(owner.err).toBe('team drops: only a seat of this team reads its own drops; this call is owner\n');

    const other = await run([], seatCaller('other', 'w1:p3'));
    expect(other.code).toBe(1);
    expect(other.err).toBe('team drops: only a seat of this team reads its own drops; this call is other\n');

    const worker = await run([], seatCaller('worker', 'w1:p2'));
    expect(worker.code).toBe(1);
    expect(worker.err).toBe(
      'team drops: no pane is recorded for seat worker in this session: a lead stops that seat and runs `team up`\n',
    );

    const moved = await run([], seatCaller('lead', 'w9:p9'));
    expect(moved.code).toBe(1);
    expect(moved.err).toBe(
      'team drops: the state records pane w1:p1 for seat lead in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`)\n',
    );

    const json = await run(['--json'], { kind: 'owner' });
    expect(json.code).toBe(1);
    assertJsonErrorShape(json.out, { id: 'drops.refused', messageContains: 'only a seat of this team' });
  });

  test('the invocation and the checkout are read before any folder is', async () => {
    const extra = await run(['extra']);
    expect(extra.code).toBe(2);
    expect(extra.err).toBe('team drops: unexpected "extra"\n' + USAGE);

    const both = await run(['--follow', '--json']);
    expect(both.code).toBe(2);
    assertJsonErrorShape(both.out, { id: 'drops.invocation', messageContains: "--follow and --json can't be used together" });

    const unknown = await run(['--nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toStartWith('team drops: unknown option --nope\nUsage: team drops');

    const outside = mkdtempSync(join(tmpdir(), 'team-drops-outside-'));
    try {
      const io = testIo(outside, seatCaller('lead', 'w1:p1'));
      expect(await runDrops([], io, { home })).toBe(2);
      expect(io.err).toBe('team drops: not inside a git repository: run team from a project\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a team file that cannot be read ends the reading', async () => {
    rmSync(join(root, '.agents', 'team.yaml'));
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err).toStartWith('team drops: ');
  });

  test('senderOf reads the three sender headers and refuses to guess at anything else', () => {
    expect(senderOf(OWNER_HEADER)).toBe('the owner');
    expect(senderOf(FILE_SEAT_HEADER)).toBe('worker');
    expect(senderOf(AGENT_HEADER)).toBe('orchestrator');
    expect(senderOf('a body with no header')).toBeNull();
    expect(senderOf('from  — admitted by: the owner')).toBeNull();
  });
});

describe('team drops --read', () => {
  /** The signed read receipt beside a message: verified against the checkout's message key,
   *  bound to this message, seat, checkout and session, and 0600. */
  function expectReceipt(id: string, seat = 'lead'): void {
    const at = receiptPath(dropDir, id);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(at, 'utf8')));
    const key = messageKeyState(home);
    if (receipt === null || key.kind !== 'key') throw new Error('no signed receipt or no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id, to: seat, root, session: 'acme' });
    expect(statSync(at).mode & 0o777).toBe(0o600);
  }

  test('the launch read serves the seat with no placed caller, receipting each record before its body', async () => {
    plantRecord(home, root, 'acme', 'lead', D_RECORD, 'hello');
    const first = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(first).toEqual({ code: 0, out: 'hello\n', err: '' });
    expectReceipt(D_RECORD);
    // The receipt is what says it was handed over: the next turn finds nothing waiting.
    const second = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(second).toEqual({ code: 0, out: '', err: '' });
  });

  test('--read is an invocation of the launch line, never a placed caller', async () => {
    const noSeat = await run(['--read']);
    expect(noSeat).toEqual({ code: 2, out: '', err: 'team drops: --read needs --seat <seat>\n' + USAGE });

    const follow = await run(['--read', '--follow']);
    expect(follow.code).toBe(2);
    expect(follow.err).toBe('team drops: --read and --follow cannot be used together\n' + USAGE);

    const json = await run(['--read', '--json']);
    expect(json.code).toBe(2);
    assertJsonErrorShape(json.out, { id: 'drops.invocation', messageContains: '--read and --json cannot be used together' });

    // A launch option without the read that serves it is a mistake, not a silent no-op.
    const seat = await run(['--seat', 'lead']);
    expect(seat.code).toBe(2);
    expect(seat.err).toStartWith('team drops: unknown option --seat\n');
    const session = await run(['--session', 'acme']);
    expect(session.code).toBe(2);
    expect(session.err).toStartWith('team drops: unknown option --session\n');
  });

  test('a session or seat the launch line does not carry is refused', async () => {
    const session = await run(['--read', '--seat', 'lead', '--session', 'other'], { kind: 'owner' });
    expect(session).toEqual({ code: 1, out: '', err: 'team drops: the team\'s session is "acme", not "other"\n' });

    const seat = await run(['--read', '--seat', 'helper'], { kind: 'owner' });
    expect(seat).toEqual({ code: 1, out: '', err: 'team drops: the team file declares no seat "helper"\n' });
  });

  test('a turn reads ten records at most, oldest first, and leaves the rest waiting', async () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    for (const [index, id] of ids.entries()) {
      const at = plantRecord(home, root, 'acme', 'lead', id, `message ${String(index)}`);
      const when = new Date(Date.parse('2026-10-04T09:00:00.000Z') + index * 1_000);
      utimesSync(at, when, when);
    }
    const first = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(first.code).toBe(0);
    expect(first.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(
      Array.from({ length: 10 }, (_, index) => `message ${String(index)}`),
    );
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(10);
    const second = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(second.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(['message 10', 'message 11']);
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(12);
  });

  test('a file an earlier build wrote is never handed over and gets no receipt', async () => {
    drop(D_RECORD, `${OWNER_HEADER}\n\nan old raw drop\n`);
    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toStartWith(`team drops: message ${JSON.stringify(D_RECORD)} is not a signed record: `);
    expect(existsSync(receiptPath(dropDir, D_RECORD))).toBe(false);
  });

  test('a link standing where the seat folder should be refuses the read', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, '.agents', 'send-drops'));
    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(result).toEqual({
      code: 1,
      out: '',
      err: 'team drops: the drop folder is not a real folder: a link or a file stands in its path\n',
    });
  });
});
