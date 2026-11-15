// The older `.agents/messages/<seat>` store's archive (src/send/legacy-inbox-retention.ts): a
// runtime notice with a signed read receipt older than seven days moves to archive/<YYYY-MM>/,
// unread notices move only for a seat at rest, the owner's mailbox is never touched, nothing is
// deleted, a once-written notice is not written again once archived, and the daily pass and
// `team drops archive` both reach the store.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntimeMailboxRecord } from '../src/bus/owner.ts';
import { inboxArchivePass } from '../src/daemon/chores/inbox-archive.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { runInboxRetention } from '../src/send/inbox-retention.ts';
import {
  archiveLegacySeat,
  legacyArchivedRecordExists,
  legacySeatDir,
  planLegacySeatArchive,
} from '../src/send/legacy-inbox-retention.ts';
import { RECEIPT_DOMAIN, messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';

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
  - name: resting
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    stopped: true
`;

function localAt(hour: number, day = 15): Date {
  return new Date(2026, 10, day, hour, 0, 0, 0);
}
const NOW = localAt(4);
const DAY_MS = 86_400_000;
const OLD_ISO = new Date(NOW.getTime() - 20 * DAY_MS).toISOString();
const RECENT_ISO = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();
const OLD_MONTH = OLD_ISO.slice(0, 7);

let base: string;
let root: string;
let home: string;
let team: TeamFile;

function notice(seat: string, id: string, at: string, session = 'acme'): void {
  const wrote = writeRuntimeMailboxRecord({ root, home, to: seat, id, text: `notice ${id}`, session, at });
  if (!wrote.ok) throw new Error(wrote.error);
}

function read(seat: string, id: string, at: string): void {
  const payload = { kind: 'receipt', id, to: seat, root, session: 'acme', at };
  const signature = signDomain(RECEIPT_DOMAIN, payload as Json, messageKeyOf(home));
  writeFileSync(join(legacySeatDir(root, seat), `${id}.read.json`), `${JSON.stringify({ payload, signature })}\n`);
}

function live(seat: string): string[] {
  const dir = legacySeatDir(root, seat);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'archive').sort() : [];
}

function archived(seat: string, ...below: string[]): string[] {
  const dir = join(legacySeatDir(root, seat), 'archive', OLD_MONTH, ...below);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'unread').sort() : [];
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-legacy-archive-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents', 'send-drops'), { recursive: true });
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

describe('the older messages store archive', () => {
  test('moves old read notices, keeps fresh reads, unread mail of a running seat, and other sessions', () => {
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', OLD_ISO);
    notice('lead', 'evt-work-b', OLD_ISO);
    read('lead', 'evt-work-b', RECENT_ISO);
    notice('lead', 'evt-fallback-c', OLD_ISO);
    notice('lead', 'evt-other', OLD_ISO, 'elsewhere');
    writeFileSync(join(legacySeatDir(root, 'lead'), 'junk.json'), '{}\n');
    const key = messageKeyOf(home);
    const dry = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: true, options: { unreadKeepMs: null } });
    expect(dry.plan.move.map((item) => item.id)).toEqual(['evt-work-a']);
    expect(dry.plan.stays).toMatchObject({ unread: 1, 'too-recent': 1, 'other-session': 1, 'record-does-not-verify': 1 });
    expect(live('lead')).toContain('evt-work-a.json');

    const real = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(real.refused).toBeNull();
    expect(archived('lead')).toEqual(['evt-work-a.json', 'evt-work-a.read.json']);
    expect(live('lead')).toEqual(['evt-fallback-c.json', 'evt-other.json', 'evt-work-b.json', 'evt-work-b.read.json', 'junk.json']);
    expect(legacyArchivedRecordExists(root, 'lead', 'evt-work-a')).toBe(true);
  });

  test('unread notices move to unread/ only for a seat at rest, past the window', () => {
    notice('resting', 'unread-old', OLD_ISO);
    notice('resting', 'unread-new', RECENT_ISO);
    const key = messageKeyOf(home);
    const report = archiveLegacySeat({ root, session: 'acme', seat: 'resting', key, now: NOW, dryRun: false, options: { unreadKeepMs: 14 * DAY_MS } });
    expect(report.moved).toEqual([{ seat: 'resting', id: 'unread-old', month: OLD_MONTH, unread: true }]);
    expect(archived('resting', 'unread')).toEqual(['unread-old.json']);
    expect(live('resting')).toEqual(['unread-new.json']);
  });

  test("the owner's mailbox is never planned", () => {
    notice('owner', 'evt-1-abc', OLD_ISO);
    read('owner', 'evt-1-abc', OLD_ISO);
    const plan = planLegacySeatArchive({ root, session: 'acme', seat: 'owner', key: messageKeyOf(home), nowMs: NOW.getTime(), options: { unreadKeepMs: 1 } });
    expect(plan.move).toEqual([]);
    expect(plan.scanned).toBe(0);
  });

  test('a move stopped after the record left is finished by the next pass', () => {
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    const dest = join(dir, 'archive', OLD_MONTH);
    mkdirSync(dest, { recursive: true });
    // The record reached the archive and left the live folder; the receipt was not moved yet.
    linkSync(join(dir, 'evt-work-a.json'), join(dest, 'evt-work-a.json'));
    unlinkSync(join(dir, 'evt-work-a.json'));
    const report = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(report.finished).toBe(1);
    expect(live('lead')).toEqual([]);
    expect(archived('lead')).toEqual(['evt-work-a.json', 'evt-work-a.read.json']);
  });

  test('a notice written once is not written again after it was archived', () => {
    notice('lead', 'evt-fallback-x', OLD_ISO);
    read('lead', 'evt-fallback-x', OLD_ISO);
    archiveLegacySeat({ root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    const again = writeRuntimeMailboxRecord({ root, home, to: 'lead', id: 'evt-fallback-x', text: 'again', session: 'acme', once: true });
    expect(again).toMatchObject({ ok: true, existing: true });
    expect(live('lead')).toEqual([]);
  });

  test('team drops archive reaches the store with no drop tree at all', () => {
    rmSync(join(root, '.agents', 'send-drops'), { recursive: true, force: true });
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', new Date(Date.now() - 9 * DAY_MS).toISOString());
    expect(runInboxRetention(root, { now: new Date(), home, dryRun: true, seats: ['lead'], session: 'acme' }).move).toEqual(['evt-work-a']);
  });

  test('team drops archive reaches the store for the team session, read records only', () => {
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', new Date(Date.now() - 9 * DAY_MS).toISOString());
    notice('resting', 'unread-old', new Date(Date.now() - 30 * DAY_MS).toISOString());
    const dry = runInboxRetention(root, { now: new Date(), home, dryRun: true, seats: ['lead', 'resting'], session: 'acme' });
    expect(dry.move).toEqual(['evt-work-a']);
    expect(live('lead')).toContain('evt-work-a.json');
    const withoutSession = runInboxRetention(root, { now: new Date(), home, dryRun: true, seats: ['lead'] });
    expect(withoutSession.move).toEqual([]);
  });

  test('the daily pass moves the store after the drop folders, inside the pass limit', async () => {
    for (let n = 0; n < 5; n += 1) {
      notice('lead', `evt-work-${String(n)}`, OLD_ISO);
      read('lead', `evt-work-${String(n)}`, OLD_ISO);
    }
    notice('resting', 'unread-old', OLD_ISO);
    const first = await inboxArchivePass({ root, home, team, now: NOW, limit: 3, deps: { loadPerCore: () => 0.5, notify: async () => ({ ok: true, text: '' }) } });
    expect(first).toMatchObject({ kind: 'ran', moved: 3, done: false });
    const second = await inboxArchivePass({ root, home, team, now: localAt(5), deps: { loadPerCore: () => 0.5, notify: async () => ({ ok: true, text: '' }) } });
    expect(second).toMatchObject({ kind: 'ran', moved: 2, unread: 1, done: true });
    expect(live('lead')).toEqual([]);
    expect(archived('lead')).toHaveLength(10);
    expect(archived('resting', 'unread')).toEqual(['unread-old.json']);
  });
});
