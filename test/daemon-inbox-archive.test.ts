// The daemon's daily inbox archive (src/daemon/chores/inbox-archive.ts): it runs inside the
// local window only, skips while the load per core is above 3, moves at most the pass limit,
// moves unread mail older than 14 days only for a stopped or retired seat, never a running
// seat's, deletes nothing, and tells the lead once when the day's run ends.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import type { ChoresSlices } from '../src/daemon/chores/child.ts';
import { createFallbackPass } from '../src/daemon/chores/fallback.ts';
import type { ChoresChildConfig } from '../src/daemon/chores/protocol.ts';
import { FALLBACK_STORE_PASS_MS } from '../src/daemon/fallback-sweep.ts';
import { INBOX_ARCHIVE_PASS_LIMIT, inboxArchivePass, seatAtRest } from '../src/daemon/chores/inbox-archive.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { folderOfDrop } from '../src/send/drop-folder.ts';
import { listArchivedUnread } from '../src/send/inbox-retention.ts';
import { receiptFile, recordFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

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
  - name: busy
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: resting
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    stopped: true
`;

// 04:00 local time: inside the window whatever the machine's zone.
function localAt(hour: number, day = 15): Date {
  return new Date(2026, 10, day, hour, 0, 0, 0);
}
const NOW = localAt(4);
const DAY_MS = 86_400_000;
const OLD_ISO = new Date(NOW.getTime() - 20 * DAY_MS).toISOString();
const RECENT_ISO = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();

let base: string;
let root: string;
let home: string;
let team: TeamFile;

function id(n: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
}

function plant(seat: string, msg: string, atIso: string, session = 'acme'): void {
  plantRecord(home, root, session, seat, msg, `body for ${msg}\n`, { at: atIso, from: 'lead' });
}

function markRead(seat: string, msg: string, atIso: string): void {
  const dir = recordDir(root, 'acme', seat);
  const receipt = signReceiptPayload({ kind: 'receipt', status: 'read', id: msg, to: seat, root, session: 'acme', at: atIso }, home);
  const wrote = writeReceipt(dir, receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
}

function liveNames(seat: string, session = 'acme'): string[] {
  const dir = recordDir(root, session, seat);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'archive' && !name.startsWith('.')) : [];
}

const calm = () => 0.5;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-archive-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  team = validated.team;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the daily inbox archive', () => {
  test('outside the window and under load it moves nothing', async () => {
    plant('busy', id(1), OLD_ISO);
    markRead('busy', id(1), OLD_ISO);
    const outside = await inboxArchivePass({ root, home, team, now: localAt(14), deps: { loadPerCore: calm } });
    expect(outside.kind).toBe('outside');
    const loaded = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: () => 3.5 } });
    expect(loaded).toEqual({ kind: 'load', perCore: 3.5, first: true });
    const again = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: () => 4 } });
    expect(again.kind === 'load' && again.first).toBe(false);
    expect(liveNames('busy')).toContain(id(1));
  });

  test('moves read mail, and unread mail only for a stopped or retired seat, and tells the lead once', async () => {
    // busy: running (declared, not stopped). Its old unread stays; its old read moves.
    plant('busy', id(1), OLD_ISO);
    markRead('busy', id(1), OLD_ISO);
    plant('busy', id(2), OLD_ISO);
    // resting: stopped in the team file. Old unread moves to unread/; recent unread stays.
    plant('resting', id(3), OLD_ISO);
    plant('resting', id(4), RECENT_ISO);
    // gone: no longer declared, so retired.
    plant('gone', id(5), OLD_ISO);
    const lines: Array<{ lead: string; body: string; id: string }> = [];
    const notify = async (input: { lead: string; body: string; id: string }) => {
      lines.push(input);
      return { ok: true, text: '' };
    };
    const pass = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: calm, notify } });
    expect(pass).toMatchObject({ kind: 'ran', moved: 1, unread: 2, done: true, notice: 'sent' });

    expect(liveNames('busy')).toEqual([id(2)]);
    expect(folderOfDrop(recordDir(root, 'acme', 'busy'), id(1))).toEndWith(join('archive', OLD_ISO.slice(0, 7)));
    expect(liveNames('resting')).toEqual([id(4)]);
    const restingDir = recordDir(root, 'acme', 'resting');
    expect(listArchivedUnread(restingDir).map((item) => item.id)).toEqual([id(3)]);
    expect(recordFile(restingDir, id(3))).toEndWith(join('archive', OLD_ISO.slice(0, 7), 'unread', id(3)));
    expect(listArchivedUnread(recordDir(root, 'acme', 'gone')).map((item) => item.id)).toEqual([id(5)]);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.lead).toBe('lead');
    expect(lines[0]?.body).toContain('moved 1 read or acknowledged');
    expect(lines[0]?.body).toContain('2 message(s) unread for over 14 days');
    expect(lines[0]?.body).toContain('gone 1, resting 1');

    // The day is done: a later pass in the window does nothing and sends nothing more.
    const later = await inboxArchivePass({ root, home, team, now: localAt(5), deps: { loadPerCore: calm, notify } });
    expect(later.kind).toBe('done');
    expect(lines).toHaveLength(1);
  });

  test('a seat the registry records as running is never at rest, whatever the team file says', () => {
    expect(seatAtRest(home, teamIdOf(root), team, 'acme', 'resting')).toBe(true);
    registerAgent(home, {
      name: 'resting',
      signing: { model: 'Claude Opus', version: '5.5', role: 'builder' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(root), seat: 'resting', session: 'acme', pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
    expect(seatAtRest(home, teamIdOf(root), team, 'acme', 'resting')).toBe(false);
    expect(seatAtRest(home, teamIdOf(root), team, 'acme', 'busy')).toBe(false);
    expect(seatAtRest(home, teamIdOf(root), team, 'acme', 'gone')).toBe(true);
  });

  test('one pass moves at most the limit; the next pass goes on, and the lead hears once at the end', async () => {
    for (let n = 1; n <= 5; n += 1) {
      plant('busy', id(n), OLD_ISO);
      markRead('busy', id(n), OLD_ISO);
    }
    const lines: string[] = [];
    const notify = async (input: { body: string }) => {
      lines.push(input.body);
      return { ok: true, text: '' };
    };
    const first = await inboxArchivePass({ root, home, team, now: NOW, limit: 3, deps: { loadPerCore: calm, notify } });
    expect(first).toMatchObject({ kind: 'ran', moved: 3, done: false, notice: 'none' });
    expect(liveNames('busy').filter((name) => !name.includes('.'))).toHaveLength(2);
    const second = await inboxArchivePass({ root, home, team, now: NOW, limit: 3, deps: { loadPerCore: calm, notify } });
    expect(second).toMatchObject({ kind: 'ran', moved: 2, done: true, notice: 'sent' });
    expect(liveNames('busy')).toEqual([]);
    expect(lines).toEqual([expect.stringContaining('moved 5 read or acknowledged')]);
    expect(INBOX_ARCHIVE_PASS_LIMIT).toBe(256);
  });

  test('a line that did not go is tried again on a later pass, under the same id', async () => {
    plant('busy', id(1), OLD_ISO);
    markRead('busy', id(1), OLD_ISO);
    const ids: string[] = [];
    let ok = false;
    const notify = async (input: { id: string }) => {
      ids.push(input.id);
      return { ok, text: ok ? '' : 'unreachable' };
    };
    const first = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: calm, notify } });
    expect(first).toMatchObject({ kind: 'ran', notice: 'failed' });
    ok = true;
    const retry = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: calm, notify } });
    expect(retry).toMatchObject({ kind: 'ran', notice: 'sent' });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test('a message moved unread is still found by id, and a later receipt joins it on the next run', async () => {
    plant('resting', id(3), OLD_ISO);
    await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: calm } });
    const dir = recordDir(root, 'acme', 'resting');
    const unreadDir = join(dir, 'archive', OLD_ISO.slice(0, 7), 'unread');
    expect(folderOfDrop(dir, id(3))).toBe(unreadDir);
    const receipt = signReceiptPayload({ kind: 'receipt', status: 'read', id: id(3), to: 'resting', root, session: 'acme', at: NOW.toISOString() }, home);
    expect(writeReceipt(dir, receipt, home).ok).toBe(true);
    // The receipt is written in the live folder, as for any archived message; the next day's run
    // places it beside its record.
    await inboxArchivePass({ root, home, team, now: localAt(4, 16), deps: { loadPerCore: calm } });
    expect(existsSync(join(dir, `${id(3)}.read.json`))).toBe(false);
    expect(receiptFile(dir, id(3), 'read')).toBe(join(unreadDir, `${id(3)}.read.json`));
    expect(existsSync(join(unreadDir, `${id(3)}.read.json`))).toBe(true);
  });

  test('`team drops archive --unread` lists what was moved unread, for the owner', async () => {
    plant('resting', id(3), OLD_ISO);
    plant('gone', id(5), OLD_ISO);
    await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: calm } });
    const month = OLD_ISO.slice(0, 7);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDrops(['archive', '--unread'], io, { home });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out.split('\n').filter(Boolean).sort()).toEqual([`gone ${month} ${id(5)}`, `resting ${month} ${id(3)}`]);
  });

  test('--unread outside archive is an unknown option', async () => {
    const io = testIo(root, { kind: 'owner' });
    const code = await runDrops(['--unread'], io, { home });
    expect(code).toBe(2);
    expect(io.err).toContain('unknown option --unread');
  });

  test('the chores housekeeping pass runs it, never on the first pass, and says what moved', async () => {
    plant('resting', id(3), OLD_ISO);
    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 5_000,
      sliceMs: 1,
      since: OLD_ISO,
      routes: [{ root, team: 'acme', session: 'acme', teamFile: team }],
    };
    const told: string[] = [];
    const pass = createFallbackPass(config, {
      loadPerCore: calm,
      notify: async (input) => {
        told.push(input.lead);
        return { ok: true, text: '' };
      },
    });
    const route = config.routes[0]!;
    const slices: ChoresSlices = { sliceMs: 1, stopping: () => false, yield: async () => true };
    await pass({ route, at: new Date(NOW.getTime() - FALLBACK_STORE_PASS_MS), slices });
    expect(liveNames('resting')).toEqual([id(3)]);
    const notes = await pass({ route, at: NOW, slices });
    expect(notes).toContain('drops archive: moved 0 read, 1 unread to seats at rest');
    expect(liveNames('resting')).toEqual([]);
    expect(told).toEqual(['lead']);
  });
});
