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
import { readEvents } from '../src/bus/log.ts';
import type { Caller } from '../src/caller.ts';
import { listDrops, runDrops, senderOf, USAGE, type DropsSources } from '../src/commands/drops.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { generalBriefRecord, GENERAL_BRIEF_SHA256, currentBriefClaim } from '../src/launch/general-brief.ts';
import { DROPS_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, signedReceiptOf, signReceiptPayload, verifyReceipt, writeReceipt, writeRecord, type ReceiptPayload, type RecordPayload } from '../src/send/record.ts';
import { listUnread, readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { readState, updateState } from '../src/state.ts';
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
/** The form a build before readable names wrote: the registry id, the name and the address. A
 *  drop written then is still read the same way. */
const AGENT_HEADER = 'from agt_000000000001 (orchestrator, orchestrator@acme) — admitted by: an orchestrator or operator to a seat of its own team';
const FILE_SEAT_HEADER = "from the file's seat worker (no registry record yet) — admitted by: the file's seat";
/** The form this build writes: the readable name the project's `sender_name` word chose. */
const READABLE_HEADER = "from orchestrator@acme — admitted by: a seat to its own team's orchestrator";
const NICKNAME_HEADER = "from Bea — admitted by: a seat to its own team's orchestrator";

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

/** The seat's current claim and the signed launch record it names, as `team up` leaves them: the
 *  record lands at the id the claim expects. */
function plantCurrentBrief(seat = 'lead'): RecordPayload {
  mkdirSync(dropDir, { recursive: true });
  const incarnation = 'inc_000000000012';
  const record = generalBriefRecord({
    to: seat,
    root,
    session: 'acme',
    at: '2026-10-19T09:00:00.000Z',
    incarnation,
  });
  const wrote = writeRecord(dropDir, signRecord(record, home));
  if (!wrote.ok) throw new Error(wrote.reason);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      ...state.sessions.acme,
      briefs: {
        [seat]: {
          id: record.id,
          at: record.at,
          incarnation,
          epoch: 'run_000000000012',
          sha256: GENERAL_BRIEF_SHA256,
          attempt: 0,
          stage: 'ready' as const,
          superseded: [],
        },
      },
    } as never;
  });
  return record;
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
      from_id: 'agt_000000000001',
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

  test('a listing omits the deliveries the current claim replaced or does not name', () => {
    // The seat's current claim: this build's brief, and the id an earlier delivery held.
    const claimId = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    updateState(join(root, '.agents'), (state) => {
      state.sessions.acme = {
        ...state.sessions.acme,
        briefs: {
          lead: {
            id: claimId,
            at: '2026-10-04T09:00:00.000Z',
            incarnation: 'inc_000000000010',
            epoch: 'run_000000000010',
            sha256: GENERAL_BRIEF_SHA256,
            attempt: 0,
            stage: 'ready' as const,
            superseded: [D_OWNER],
          },
        },
      } as never;
    });
    // A file at an id the claim replaced: never read, never listed.
    drop(D_OWNER, 'an earlier delivery, replaced');
    // A launch record under its own delivery lifetime, which the claim does not name: an earlier
    // brief the read could only refuse, so the listing does not offer it.
    const old = generalBriefRecord({
      to: 'lead',
      root,
      session: 'acme',
      at: '2026-10-04T08:00:00.000Z',
      incarnation: 'inc_000000000011',
    });
    const wrote = writeRecord(dropDir, signRecord(old, home));
    expect(wrote.ok).toBe(true);
    const key = messageKeyState(home);
    if (key.kind !== 'key') throw new Error('the fixture wrote no key');
    const listing = listDrops(dropDir, key.key, { to: 'lead', root, session: 'acme' });
    if (listing.kind !== 'ok') throw new Error(listing.reason);
    expect(listing.rows).toEqual([]);
    // The inbox listing skips the replaced id by name; the earlier brief is not named by the claim.
    const unread = listUnread(dropDir, { to: 'lead', root, session: 'acme' }, home);
    expect(unread.map((message) => message.id)).not.toContain(D_OWNER);
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

  test('a record reads by the name the project’s word chooses, while the record keeps the registry id', async () => {
    // The team file's `sender_name: nickname`, and the roster line the record's id resolves to.
    teamYaml(`${TEAM}sender_name: nickname\n`);
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      roster: [{ agent: 'agt_000000000001', seat: 'orchestrator', role: 'orchestrator', nickname: 'Ada' }],
      at: '2026-10-04T09:00:00.000Z',
    });
    const recordPath = plantRecord(home, root, 'acme', 'lead', D_RECORD, 'the record body', {
      from: 'orchestrator',
      from_id: 'agt_000000000001',
      rule: "a seat to its own team's orchestrator",
    });
    // The signed record on disk still carries the registry id; only the headline a person reads
    // changes.
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { payload: { from: string; from_id: string } };
    expect(record.payload.from).toBe('orchestrator');
    expect(record.payload.from_id).toBe('agt_000000000001');
    const table = await run();
    expect(table.code).toBe(0);
    expect(table.out).toContain('Ada');
    expect(table.out).not.toContain('orchestrator');
    expect(table.out).not.toContain('agt_');
    // `--json` stays the record's own reading: the registry id rides the payload, and the display
    // word never reaches the machine shape.
    const json = await run(['--json']);
    const parsed = assertMatchesOutputSchema<{ drops: { from: string | null; path: string }[] }>(json.out, DROPS_OUTPUT_SCHEMA);
    expect(parsed.drops.map((row) => ({ from: row.from, path: row.path }))).toEqual([{ from: 'orchestrator', path: recordPath }]);
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

  test('senderOf reads every sender header an older or this build wrote, and refuses to guess at anything else', () => {
    expect(senderOf(OWNER_HEADER)).toBe('the owner');
    expect(senderOf(FILE_SEAT_HEADER)).toBe('worker');
    expect(senderOf(AGENT_HEADER)).toBe('orchestrator');
    expect(senderOf(READABLE_HEADER)).toBe('orchestrator@acme');
    expect(senderOf(NICKNAME_HEADER)).toBe('Bea');
    expect(senderOf('a body with no header')).toBeNull();
    expect(senderOf('from  — admitted by: the owner')).toBeNull();
  });
});

describe('team drops in a folder that is not a git repository', () => {
  // A team whose `.agents/team.yaml` lives at its entity root: the root is not a checkout, and
  // the shared team-file resolution still reads it. The three modes resolve it the same way.
  function plainRoot(): void {
    rmSync(join(root, '.git'), { recursive: true, force: true });
  }

  test('the listing reads the plain team root', async () => {
    plainRoot();
    const path = drop(D_OWNER, `${OWNER_HEADER}\n\nthe owner's words\n`);
    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: `team acme, session "acme"\n  FROM       PATH\n  the owner  ${path}\n\n1 drop\n`,
      err: '',
    });
  });

  test('--follow watches the plain team root', async () => {
    plainRoot();
    drop(D_OWNER, `${OWNER_HEADER}\n\nalready waiting\n`);
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
    expect(result).toEqual({
      code: 0,
      out: `from orchestrator — ${join(dropDir, D_AGENT)}\n`,
      err: '',
    });
    expect(polls).toBe(2);
  });

  test('--read hands a record over and receipts it against the plain root', async () => {
    plainRoot();
    plantRecord(home, root, 'acme', 'lead', D_RECORD, 'hello from the root');
    const result = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(result).toEqual({ code: 0, out: 'hello from the root\n', err: '' });
    const at = receiptPath(dropDir, D_RECORD);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(at, 'utf8')));
    const key = messageKeyState(home);
    if (receipt === null || key.kind !== 'key') throw new Error('no signed receipt or no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: D_RECORD, to: 'lead', root, session: 'acme' });
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

  test('a receipt that does not bind the current claim does not hide the brief’s delivery', async () => {
    const record = plantCurrentBrief();
    // A signed read receipt for the message that does not bind the claim: an ordinary read of the
    // file, not of this delivery. It proves the file was seen, never that this brief was served.
    const occupying = writeReceipt(dropDir, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: record.id,
      to: 'lead',
      root,
      session: 'acme',
      at: '2026-10-19T09:05:00.000Z',
    }, home), home);
    expect(occupying.ok).toBe(true);
    const at = receiptPath(dropDir, record.id);
    const before = readFileSync(at, 'utf8');
    // The listing still offers the delivery the claim names, and the read refuses the occupied
    // name with no body. The receipt and the drop are left exactly as they were.
    const context = { to: 'lead', root, session: 'acme' };
    expect(listUnread(dropDir, context, home).map((message) => message.id)).toEqual([record.id]);
    const result = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(result).toEqual({
      code: 1,
      out: '',
      err: 'team drops: the read receipt name is held by a file that does not verify for this brief\n',
    });
    expect(readFileSync(at, 'utf8')).toBe(before);
    expect(existsSync(join(dropDir, record.id))).toBe(true);
  });

  test('a receipt bound to the current claim still marks the brief read', async () => {
    const record = plantCurrentBrief();
    const claimOf = () => currentBriefClaim(readState(join(root, '.agents')).sessions.acme?.briefs?.lead);
    const read = readMessage({ dropDir, root, seat: 'lead', session: 'acme' }, record.id, home, { claim: claimOf });
    expect(read.ok).toBe(true);
    const context = { to: 'lead', root, session: 'acme' };
    expect(listUnread(dropDir, context, home)).toEqual([]);
    const result = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(result).toEqual({ code: 0, out: '', err: '' });
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

  test('a turn reads the ten newest records first, and leaves the rest waiting', async () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    for (const [index, id] of ids.entries()) {
      plantRecord(home, root, 'acme', 'lead', id, `message ${String(index)}`, {
        at: new Date(Date.parse('2026-10-04T09:00:00.000Z') + index * 1_000).toISOString(),
      });
    }
    const first = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(first.code).toBe(0);
    // Newest first: the ten newest are handed over, and the two that wait are the oldest.
    expect(first.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(
      Array.from({ length: 10 }, (_, index) => `message ${String(11 - index)}`),
    );
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(10);
    const second = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(second.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(['message 1', 'message 0']);
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(12);
    // The receipts are what leave nothing behind: a third read has no body at all.
    const third = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(third).toEqual({ code: 0, out: '', err: '' });
  });

  test('a plain-text drop an earlier build wrote is skipped and reported, and the signed record behind it is read', async () => {
    // The old file is the newest, so a newest-first read meets it first: it must not use a batch
    // slot, stop the walk, or put its text in front of the turn.
    const legacy = drop(D_RECORD, `${OWNER_HEADER}\n\nan old raw drop\n`);
    utimesSync(legacy, new Date('2026-10-04T10:00:00.000Z'), new Date('2026-10-04T10:00:00.000Z'));
    plantRecord(home, root, 'acme', 'lead', D_RECORD_READ, 'a signed body', { at: '2026-10-04T09:00:00.000Z' });

    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });

    expect(result.code).toBe(0);
    expect(result.out).toBe('a signed body\n');
    expect(result.err).toBe('team drops: 1 drop(s) are not signed records and are not served\n');
    expect(result.out).not.toContain('an old raw drop');
    expect(result.err).not.toContain('an old raw drop');
    // The old file is never receipted — nothing about it was verified — while the record that was
    // served is, and the next turn hands over no body and reports the old file again.
    expect(existsSync(receiptPath(dropDir, D_RECORD))).toBe(false);
    expectReceipt(D_RECORD_READ);
    const again = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(again).toEqual({
      code: 0,
      out: '',
      err: 'team drops: 1 drop(s) are not signed records and are not served\n',
    });
    // Old mail is not an integrity refusal: it is reported by count, never as record.invalid.
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.events.filter((event) => event.payload.kind === 'record.invalid')).toEqual([]);
  });

  test('a legacy drop in the newest slot uses no batch slot: the ten newest signed records are read', async () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    for (const [index, id] of ids.entries()) {
      plantRecord(home, root, 'acme', 'lead', id, `message ${String(index)}`, {
        at: new Date(Date.parse('2026-10-04T09:00:00.000Z') + index * 1_000).toISOString(),
      });
    }
    const legacy = drop('0f0e0d0c-0b0a-4908-8706-050403020100', `${OWNER_HEADER}\n\nan old raw drop\n`);
    utimesSync(legacy, new Date('2026-10-04T09:00:30.000Z'), new Date('2026-10-04T09:00:30.000Z'));

    const first = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(first.code).toBe(0);
    expect(first.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(
      Array.from({ length: 10 }, (_, index) => `message ${String(11 - index)}`),
    );
    expect(first.err).toBe('team drops: 1 drop(s) are not signed records and are not served\n');
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(10);
    // The two oldest signed records are what waited, not the old file: it is skipped every turn.
    const second = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    expect(second.out.split('\n').filter((line) => line.startsWith('message '))).toEqual(['message 1', 'message 0']);
    expect(second.err).toBe('team drops: 1 drop(s) are not signed records and are not served\n');
    expect(readdirSync(dropDir).filter((name) => name.endsWith('.read.json'))).toHaveLength(12);
  });

  test('a signed runtime report an earlier build named `unread-<uuid>` is served and receipted like any record', async () => {
    // The report a build before 0.5.3 left in the lead's folder: the source message's own UUID
    // under `unread-`, a signed message record like any other. The listing offered it while the
    // read never touched it, so it stayed listed forever; both agree now.
    const legacyId = `unread-${D_RECORD}`;
    const reportPath = plantRecord(
      home,
      root,
      'acme',
      'lead',
      legacyId,
      'writer-01: a message from architect has been unread for 4 min',
      {
        from: 'runtime',
        from_id: null,
        rule: "the team's unread-message report",
        thread: legacyId,
        at: '2026-10-21T07:02:00.000Z',
      },
    );
    const context = { to: 'lead', root, session: 'acme' };
    // Before the read the two agree: the report is waiting mail in the listing and in the inbox.
    const listing = listDrops(dropDir);
    if (listing.kind !== 'ok') throw new Error(listing.reason);
    expect(listing.rows.map((row) => row.path)).toEqual([reportPath]);
    expect(listUnread(dropDir, context, home).map((message) => message.id)).toEqual([legacyId]);

    const result = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(result).toEqual({
      code: 0,
      out: 'writer-01: a message from architect has been unread for 4 min\n',
      err: '',
    });
    // Its receipt is the signed read receipt every record gets, at the name its id derives.
    expectReceipt(legacyId);
    // The receipt takes the report out of both listings, and a second turn hands over nothing.
    const key = messageKeyState(home);
    if (key.kind !== 'key') throw new Error('the fixture wrote no key');
    expect(listDrops(dropDir, key.key, context)).toEqual({ kind: 'ok', rows: [] });
    expect(listUnread(dropDir, context, home)).toEqual([]);
    const again = await run(['--read', '--seat', 'lead', '--session', 'acme'], { kind: 'owner' });
    expect(again).toEqual({ code: 0, out: '', err: '' });
  });

  test('a file an earlier build wrote is never handed over and gets no receipt', async () => {
    drop(D_RECORD, `${OWNER_HEADER}\n\nan old raw drop\n`);
    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });
    // Old unsigned mail is not an integrity refusal: the folder was read, the file is reported by
    // count, and no body and no receipt come of it.
    expect(result).toEqual({
      code: 0,
      out: '',
      err: 'team drops: 1 drop(s) are not signed records and are not served\n',
    });
    expect(existsSync(receiptPath(dropDir, D_RECORD))).toBe(false);

    // Its text never reaches the output, and it is not raised as a record refusal: an old drop is
    // expected mail, not a broken record, and a folder full of them must not flood the log.
    expect(result.out).not.toContain('an old raw drop');
    expect(result.err).not.toContain('an old raw drop');
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.events.filter((event) => event.payload.kind === 'record.invalid')).toEqual([]);
  });

  test('a record whose signature does not verify is still refused when it is the folder\'s only mail', async () => {
    const at = plantRecord(home, root, 'acme', 'lead', D_RECORD, 'tampered after signing');
    const record = JSON.parse(readFileSync(at, 'utf8')) as { signature: string };
    record.signature = 'not-this-key';
    writeFileSync(at, `${JSON.stringify(record)}\n`);

    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe(`team drops: message ${JSON.stringify(D_RECORD)} does not verify against this message key\n`);
    expect(existsSync(receiptPath(dropDir, D_RECORD))).toBe(false);
    // The owner hears the refusal as its rule and object — never the record's content.
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      session: 'acme',
      rule: 'signature',
      seat: 'lead',
      subject: D_RECORD,
      reason: join(dropDir, D_RECORD),
    });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain('tampered after signing');
  });

  test('a bad signature uses no batch slot either: the signed record behind it is still served and reported', async () => {
    const at = plantRecord(home, root, 'acme', 'lead', D_RECORD, 'tampered after signing', {
      at: '2026-10-04T10:00:00.000Z',
    });
    const record = JSON.parse(readFileSync(at, 'utf8')) as { signature: string };
    record.signature = 'not-this-key';
    writeFileSync(at, `${JSON.stringify(record)}\n`);
    plantRecord(home, root, 'acme', 'lead', D_RECORD_READ, 'a signed body', { at: '2026-10-04T09:00:00.000Z' });

    const result = await run(['--read', '--seat', 'lead'], { kind: 'owner' });

    expect(result.code).toBe(0);
    expect(result.out).toBe('a signed body\n');
    expect(result.err).toBe('');
    // The record that verified is receipted; the one that did not never is.
    expectReceipt(D_RECORD_READ);
    expect(existsSync(receiptPath(dropDir, D_RECORD))).toBe(false);
    // The refusal is still reported to the owner, as the rule and the object and never the body.
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({ rule: 'signature', seat: 'lead', subject: D_RECORD });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain('tampered after signing');
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
