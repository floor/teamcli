// Independent coverage of drop-retention slice 2 at 9be58a8f4: stamp caches on the hot readers.
// One mixed folder holds an unread record, a read record, a replied record, a pending marker,
// a general brief, and a client record. The listing readers and the reconcile drop scan must
// name the same rows on a cold pass and a warm pass, skip bodies a receipt already covers,
// and re-read a file whose mtime or size changed.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReconcileState, reconcilePass, type ReconcileResult, type ReconcileState } from '../src/bus/reconcile.ts';
import { CLIENT_RULE } from '../src/client/send.ts';
import { listDrops } from '../src/commands/drops.ts';
import { listUnackedMessages, plantRecord, recordDir } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../src/launch/general-brief.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { markPending } from '../src/send/pending.ts';
import { receiptFile, recordFile, signReceiptPayload, signRecord, writeReceipt } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const TEAM_YAML = `format: 1
entity: floor
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: worker
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const UNREAD = '019a4f50-1000-7000-8000-000000000001';
const READ = '019a4f50-1000-7000-8000-000000000002';
const REPLIED = '019a4f50-1000-7000-8000-000000000003';
const BRIEF = '019a4f50-1000-7000-8000-000000000004';
const CLIENT = '019a4f50-1000-7000-8000-000000000005';
const CLIENT_ID = 'synthetic-client';

const UNREAD_AT = '2026-11-03T13:00:00.000Z';
const READ_AT = '2026-11-03T12:00:00.000Z';
const REPLIED_AT = '2026-11-03T12:30:00.000Z';
const BRIEF_AT = '2026-11-03T11:00:00.000Z';
const CLIENT_AT = '2026-11-03T14:00:00.000Z';
const NOW = new Date('2026-11-04T12:00:00.000Z');

let base = '';
let root = '';
let home = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drop-s2-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme',
    root,
    roster: [
      { agent: 'agt_lead00000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_worker000000', seat: 'worker', role: 'builder', leads: false },
    ],
    lifecycle: 'running',
  });
});

afterEach(() => {
  discardFixtures([base], { roots: [tmpdir()] });
  base = '';
});

function seatDir(): string {
  return recordDir(root, 'acme', 'worker');
}

function stamp(path: string, atIso: string): void {
  const at = new Date(atIso);
  utimesSync(path, at, at);
}

function plantOrdinary(id: string, atIso: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  const path = plantRecord(home, root, 'acme', 'worker', id, `body for ${id}\n`, {
    at: atIso,
    from: 'lead',
    ...fields,
  });
  stamp(path, atIso);
  return path;
}

function plantClient(): string {
  const path = recordFile(seatDir(), CLIENT);
  const record = signRecord(
    {
      kind: 'message',
      id: CLIENT,
      to: 'worker',
      to_id: null,
      root,
      session: 'acme',
      at: CLIENT_AT,
      body: `body for ${CLIENT}\n`,
      from: `client:${CLIENT_ID}`,
      from_id: null,
      rule: CLIENT_RULE,
      thread: CLIENT,
      from_client: { client_id: CLIENT_ID, grant_id: 'grant-synthetic' },
    },
    home,
  );
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  stamp(path, CLIENT_AT);
  return path;
}

function mark(id: string, status: 'read' | 'replied', atIso: string): void {
  const dir = seatDir();
  const receipt = signReceiptPayload(
    { kind: 'receipt', status, id, to: 'worker', root, session: 'acme', at: atIso },
    home,
  );
  const wrote = writeReceipt(dir, receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
  stamp(receiptFile(dir, id, status), atIso);
}

/** The mixed folder: unread, read, replied, pending, general brief, client record. */
function plantMixed(): { unread: string; read: string; replied: string; brief: string; client: string; pending: string } {
  const unread = plantOrdinary(UNREAD, UNREAD_AT);
  const read = plantOrdinary(READ, READ_AT);
  const replied = plantOrdinary(REPLIED, REPLIED_AT);
  const brief = plantOrdinary(BRIEF, BRIEF_AT, { from: GENERAL_BRIEF_FROM, rule: GENERAL_BRIEF_RULE });
  const client = plantClient();
  mark(READ, 'read', READ_AT);
  mark(REPLIED, 'replied', REPLIED_AT);
  const dir = seatDir();
  markPending(dir, {
    id: UNREAD,
    from: 'lead',
    to: 'worker',
    body: 'held unread',
    ts: UNREAD_AT,
    leg: 'drop',
  });
  return { unread, read, replied, brief, client, pending: join(dir, `${UNREAD}.pending`) };
}

function isBody(path: string): boolean {
  return !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

function withReads<T>(fn: () => T): { result: T; reads: string[] } {
  const prefix = join(root, '.agents', 'send-drops');
  const reads: string[] = [];
  const realRead = fs.readFileSync;
  const realOpen = fs.openSync;
  const note = (target: unknown): void => {
    if (typeof target === 'string' && target.startsWith(prefix)) reads.push(target);
  };
  const spyRead = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    note(path);
    return Reflect.apply(realRead, fs, [path, ...rest]);
  }) as typeof fs.readFileSync);
  const spyOpen = spyOn(fs, 'openSync').mockImplementation(((path: unknown, flags: unknown, ...rest: unknown[]) => {
    if (typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) === 0) {
      note(path);
    }
    return Reflect.apply(realOpen, fs, [path, flags, ...rest]);
  }) as typeof fs.openSync);
  try {
    return { result: fn(), reads };
  } finally {
    spyRead.mockRestore();
    spyOpen.mockRestore();
  }
}

function times(reads: readonly string[], path: string): number {
  return reads.filter((item) => item === path).length;
}

function arrivalIds(result: ReconcileResult): string[] {
  if (!result.ok) return [];
  const ids: string[] = [];
  for (const record of result.raised) {
    if (record.payload.kind === 'message.arrived' && typeof record.payload.record_id === 'string') {
      ids.push(record.payload.record_id);
    }
  }
  return ids.sort();
}

type Rows = {
  unread: ReturnType<typeof listUnread>;
  messages: ReturnType<typeof listUnackedMessages>;
  drops: ReturnType<typeof listDrops>;
};

function readRows(state: ReconcileState): {
  rows: Rows;
  reads: string[];
  arrivals: string[];
  filesRead: number;
  filesReused: number;
} {
  const context = { to: 'worker', root, session: 'acme' };
  const dir = seatDir();
  const reads: string[] = [];
  const unread = withReads(() => listUnread(dir, context, home));
  const messages = withReads(() => listUnackedMessages(root, 'acme', home));
  const drops = withReads(() => listDrops(dir, messageKeyOf(home), context));
  const scan = withReads(() => reconcilePass({ project: 'acme', root, session: 'acme', home, state, now: NOW }));
  reads.push(...unread.reads, ...messages.reads, ...drops.reads, ...scan.reads);
  if (drops.result.kind !== 'ok') throw new Error('team drops could not read the folder');
  if (!scan.result.ok) throw new Error(scan.result.reason);
  return {
    rows: { unread: unread.result, messages: messages.result, drops: drops.result },
    reads,
    arrivals: arrivalIds(scan.result),
    filesRead: state.stats.filesRead,
    filesReused: state.stats.filesReused,
  };
}

describe('drop-retention slice 2 stamp cache', () => {
  test('a mixed folder lists the same rows once the stamps are cached, and a receipt keeps its body unread', () => {
    const planted = plantMixed();
    const state = createReconcileState();
    const cold = readRows(state);
    const warm = readRows(state);

    expect(cold.rows.unread.map((row) => row.id)).toEqual([UNREAD, CLIENT]);
    expect(cold.rows.messages.map((row) => row.id).sort()).toEqual([UNREAD, BRIEF, CLIENT].sort());
    expect(cold.rows.drops.kind).toBe('ok');
    if (cold.rows.drops.kind === 'ok') {
      expect(cold.rows.drops.rows.map((row) => row.id)).toEqual([UNREAD, CLIENT]);
    }
    expect(cold.arrivals).toEqual([UNREAD, READ, REPLIED, BRIEF, CLIENT].sort());
    // A warm scan appends nothing new: the cold arrivals are already the log's rows, and the
    // stamp cache is what lets that pass read no file.
    expect(warm.arrivals).toEqual([]);

    expect(warm.rows).toEqual(cold.rows);
    expect(warm.filesRead).toBe(0);
    expect(warm.filesReused).toBeGreaterThan(0);

    for (const path of [planted.read, planted.replied]) {
      expect(times(cold.reads, path)).toBe(0);
      expect(times(warm.reads, path)).toBe(0);
    }
    for (const path of [planted.unread, planted.brief, planted.client]) {
      expect(times(cold.reads, path)).toBeGreaterThan(0);
      expect(times(warm.reads, path)).toBe(0);
    }
    expect(times(cold.reads, planted.pending)).toBeGreaterThan(0);
    expect(times(warm.reads, planted.pending)).toBe(0);
  });

  test('a new mtime re-reads that body, and a new size re-reads the pending marker, while read bodies stay unread', () => {
    const planted = plantMixed();
    const state = createReconcileState();
    const cold = readRows(state);
    const later = '2026-11-03T18:00:00.000Z';
    stamp(planted.unread, later);
    const pendingText = readFileSync(planted.pending, 'utf8');
    writeFileSync(planted.pending, pendingText.replace('held unread', 'held unread, still waiting'));

    const again = readRows(state);

    expect(again.rows.unread).toEqual(cold.rows.unread);
    expect(again.rows.messages).toEqual(cold.rows.messages);
    expect(times(again.reads, planted.unread)).toBeGreaterThan(0);
    expect(times(again.reads, planted.pending)).toBeGreaterThan(0);
    expect(times(again.reads, planted.read)).toBe(0);
    expect(times(again.reads, planted.replied)).toBe(0);
    expect(times(again.reads, planted.brief)).toBe(0);
    expect(times(again.reads, planted.client)).toBe(0);
    expect(again.filesRead).toBe(1);
  });
});
