// The older `.agents/messages/<seat>` store's archive (src/send/legacy-inbox-retention.ts): a
// record with a signed read receipt older than seven days moves to archive/<YYYY-MM>/, an unread
// runtime notice moves to unread/ after fourteen days for any seat, unread mail from a real
// sender moves only for a seat at rest, the owner's mailbox is never touched, nothing is
// deleted, a once-written notice is not written again once archived, and the daily pass and
// `team drops archive` both reach the store.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_RECORD_FROM, writeRuntimeMailboxRecord } from '../src/bus/owner.ts';
import { runDrops } from '../src/commands/drops.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { inboxArchivePass } from '../src/daemon/chores/inbox-archive.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { runInboxRetention } from '../src/send/inbox-retention.ts';
import {
  archiveLegacySeat,
  legacyArchivedRecordExists,
  legacySeatDir,
  LEGACY_ARCHIVER_LOCK,
  planLegacySeatArchive,
  realLockDeps,
  RUNTIME_SENDER,
  takeArchiverLock,
} from '../src/send/legacy-inbox-retention.ts';
import { MESSAGE_DOMAIN, RECEIPT_DOMAIN, messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';
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

/** A record from a real sender, signed as the older store's writer signs it. */
function letter(seat: string, id: string, at: string): void {
  const payload = { kind: 'message', id, to: seat, root, session: 'acme', at, body: `letter ${id}`, from: 'lead' };
  const signature = signDomain(MESSAGE_DOMAIN, payload as Json, messageKeyOf(home));
  mkdirSync(legacySeatDir(root, seat), { recursive: true });
  writeFileSync(join(legacySeatDir(root, seat), `${id}.json`), `${JSON.stringify({ payload, signature })}\n`);
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
    expect(dry.plan.move.map((item) => item.id)).toEqual(['evt-fallback-c', 'evt-work-a']);
    expect(dry.plan.move[0]?.unread).toBe(true);
    expect(dry.plan.stays).toMatchObject({ unread: 0, 'too-recent': 1, 'other-session': 1, 'record-does-not-verify': 1 });
    expect(live('lead')).toContain('evt-work-a.json');

    const real = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(real.refused).toBeNull();
    expect(archived('lead')).toEqual(['evt-work-a.json', 'evt-work-a.read.json']);
    expect(archived('lead', 'unread')).toEqual(['evt-fallback-c.json']);
    expect(live('lead')).toEqual(['evt-other.json', 'evt-work-b.json', 'evt-work-b.read.json', 'junk.json']);
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

  test('an unread runtime notice ages out after 14 days for a running seat; a real sender keeps the rule', () => {
    expect(RUNTIME_SENDER).toBe(OWNER_RECORD_FROM);
    notice('lead', 'evt-fallback-old', OLD_ISO);
    notice('lead', 'evt-fallback-new', RECENT_ISO);
    letter('lead', 'mail-old', OLD_ISO);
    const report = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(report.moved).toEqual([{ seat: 'lead', id: 'evt-fallback-old', month: OLD_MONTH, unread: true }]);
    expect(report.plan.stays.unread).toBe(2);
    expect(archived('lead', 'unread')).toEqual(['evt-fallback-old.json']);
    expect(live('lead')).toEqual(['evt-fallback-new.json', 'mail-old.json']);
    // The same real letter to a seat at rest moves by the caller's window.
    letter('resting', 'mail-old', OLD_ISO);
    const resting = archiveLegacySeat({ root, session: 'acme', seat: 'resting', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: 14 * DAY_MS } });
    expect(resting.moved.map((item) => item.id)).toEqual(['mail-old']);
  });

  test("the owner's mailbox is never planned", () => {
    notice('owner', 'evt-1-abc', OLD_ISO);
    read('owner', 'evt-1-abc', OLD_ISO);
    const plan = planLegacySeatArchive({ root, session: 'acme', seat: 'owner', key: messageKeyOf(home), nowMs: NOW.getTime(), options: { unreadKeepMs: 1 } });
    expect(plan.move).toEqual([]);
    expect(plan.scanned).toBe(0);
  });

  test('a writer that replaces the live record after the claim keeps its record live; the claimed one moves', () => {
    notice('lead', 'evt-fallback-r', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    const report = archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null },
      hooks: { afterClaim: () => notice('lead', 'evt-fallback-r', RECENT_ISO) },
    });
    expect(report.refused).toBeNull();
    expect(report.moved.map((item) => item.id)).toEqual(['evt-fallback-r']);
    // The replacement is live, untouched; the judged record is in the archive. Nothing was lost.
    expect(JSON.parse(readFileSync(join(dir, 'evt-fallback-r.json'), 'utf8')).payload.at).toBe(RECENT_ISO);
    expect(JSON.parse(readFileSync(join(dir, 'archive', OLD_MONTH, 'unread', 'evt-fallback-r.json'), 'utf8')).payload.at).toBe(OLD_ISO);
    expect(live('lead')).toEqual(['evt-fallback-r.json']);
  });

  test('a replacement that lands before the claim is judged itself, and stays', () => {
    notice('lead', 'evt-fallback-r', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    const report = archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null },
      hooks: { beforeClaim: () => notice('lead', 'evt-fallback-r', RECENT_ISO) },
    });
    expect(report.plan.move.map((item) => item.id)).toEqual(['evt-fallback-r']);
    expect(report.moved).toEqual([]);
    expect(report.kept).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'evt-fallback-r.json'), 'utf8')).payload.at).toBe(RECENT_ISO);
    expect(existsSync(join(dir, 'archive'))).toBe(false);
  });

  test('a claimed record judged to stay, replaced meanwhile, goes to superseded/; the newest stays live', () => {
    notice('lead', 'evt-fallback-r', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    const newest = new Date(NOW.getTime() - DAY_MS).toISOString();
    const report = archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null },
      hooks: {
        beforeClaim: () => notice('lead', 'evt-fallback-r', RECENT_ISO),
        afterClaim: () => notice('lead', 'evt-fallback-r', newest),
      },
    });
    expect(report.refused).toBeNull();
    expect(report.kept).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'evt-fallback-r.json'), 'utf8')).payload.at).toBe(newest);
    const superseded = join(dir, 'archive', RECENT_ISO.slice(0, 7), 'superseded');
    expect(readdirSync(superseded)).toEqual(['evt-fallback-r.json']);
    expect(JSON.parse(readFileSync(join(superseded, 'evt-fallback-r.json'), 'utf8')).payload.at).toBe(RECENT_ISO);
    expect(live('lead')).toEqual(['evt-fallback-r.json']);
  });

  test('a once-writer that looks while the record is claimed finds it and writes nothing', () => {
    notice('lead', 'evt-fallback-o', OLD_ISO);
    let seen: unknown;
    archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key: messageKeyOf(home), now: NOW, dryRun: false, options: { unreadKeepMs: null },
      hooks: {
        afterClaim: () => {
          seen = writeRuntimeMailboxRecord({ root, home, to: 'lead', id: 'evt-fallback-o', text: 'again', session: 'acme', once: true });
        },
      },
    });
    expect(seen).toMatchObject({ ok: true, existing: true });
    expect(live('lead')).toEqual([]);
    expect(archived('lead', 'unread')).toEqual(['evt-fallback-o.json']);
  });

  test('stray receipts are recovered inside the limit, and more is left set while some remain', () => {
    const dir = legacySeatDir(root, 'lead');
    const dest = join(dir, 'archive', OLD_MONTH);
    mkdirSync(dest, { recursive: true });
    for (let n = 0; n < 5; n += 1) {
      const id = `evt-work-s${String(n)}`;
      notice('lead', id, OLD_ISO);
      read('lead', id, OLD_ISO);
      linkSync(join(dir, `${id}.json`), join(dest, `${id}.json`));
      unlinkSync(join(dir, `${id}.json`));
    }
    const key = messageKeyOf(home);
    const first = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null, limit: 3 } });
    expect(first.finished).toBe(3);
    expect(first.plan.more).toBe(true);
    expect(first.plan.scanned).toBe(3);
    expect(live('lead')).toHaveLength(2);
    const second = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null, limit: 3 } });
    expect(second.finished).toBe(2);
    expect(second.plan.more).toBe(false);
    expect(live('lead')).toEqual([]);
    expect(archived('lead')).toHaveLength(10);
  });

  test('the daily pass charges recovery to its budget and keeps the day open while some is left', async () => {
    const dir = legacySeatDir(root, 'lead');
    const dest = join(dir, 'archive', OLD_MONTH);
    mkdirSync(dest, { recursive: true });
    for (let n = 0; n < 5; n += 1) {
      const id = `evt-work-s${String(n)}`;
      notice('lead', id, OLD_ISO);
      read('lead', id, OLD_ISO);
      linkSync(join(dir, `${id}.json`), join(dest, `${id}.json`));
      unlinkSync(join(dir, `${id}.json`));
    }
    const deps = { loadPerCore: () => 0.5, notify: async () => ({ ok: true, text: '' }) };
    const first = await inboxArchivePass({ root, home, team, now: NOW, limit: 3, deps });
    expect(first).toMatchObject({ kind: 'ran', moved: 3, done: false });
    expect(live('lead')).toHaveLength(2);
    const second = await inboxArchivePass({ root, home, team, now: localAt(5), deps });
    expect(second).toMatchObject({ kind: 'ran', moved: 2, done: true });
    expect(live('lead')).toEqual([]);
  });

  test('`team drops archive --unread` lists the older store unread archive, dotted ids included', async () => {
    letter('resting', 'mail.with.dots', OLD_ISO);
    notice('lead', 'evt-fallback.v2', OLD_ISO);
    await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: () => 0.5, notify: async () => ({ ok: true, text: '' }) } });
    expect(archived('resting', 'unread')).toEqual(['mail.with.dots.json']);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDrops(['archive', '--unread'], io, { home });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out.split('\n').filter(Boolean).sort()).toEqual([`lead ${OLD_MONTH} evt-fallback.v2`, `resting ${OLD_MONTH} mail.with.dots`]);
    const jsonIo = testIo(root, { kind: 'owner' });
    expect(await runDrops(['archive', '--unread', '--json'], jsonIo, { home })).toBe(0);
    const rows = (JSON.parse(jsonIo.out) as { data?: { unread: unknown[] }; unread?: unknown[] });
    const unread = (rows.data?.unread ?? rows.unread ?? []) as Array<{ store: string; session: string; seat: string; id: string }>;
    expect(unread.map((row) => [row.store, row.session, row.seat, row.id]).sort()).toEqual([
      ['messages', 'acme', 'lead', 'evt-fallback.v2'],
      ['messages', 'acme', 'resting', 'mail.with.dots'],
    ]);
  });

  test('two archivers and a writer: the second archiver finds the mailbox busy, nothing is lost', () => {
    notice('lead', 'evt-fallback-r', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    const key = messageKeyOf(home);
    let second: ReturnType<typeof archiveLegacySeat> | undefined;
    let manual: ReturnType<typeof runInboxRetention> | undefined;
    const first = archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null },
      hooks: {
        afterClaim: () => {
          // A writer replaces the live record, then a second archiver and a manual run start.
          notice('lead', 'evt-fallback-r', OLD_ISO);
          second = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null } });
          manual = runInboxRetention(root, { now: NOW, home, seats: ['lead'], session: 'acme' });
        },
      },
    });
    // Same process: the in-process mutex answers before the lock file is ever tried.
    expect(second?.busy).toBe('this process is archiving it');
    expect(second?.moved).toEqual([]);
    expect(second?.refused).toBeNull();
    expect(second?.plan.more).toBe(true);
    expect(manual?.busy).toEqual(['lead']);
    expect(manual?.refused).toBeNull();
    expect(first.refused).toBeNull();
    expect(first.moved.map((item) => item.id)).toEqual(['evt-fallback-r']);
    // The first record is archived, the writer's replacement is live, the lock is gone.
    expect(archived('lead', 'unread')).toEqual(['evt-fallback-r.json']);
    expect(existsSync(join(dir, 'evt-fallback-r.json'))).toBe(true);
    expect(existsSync(join(dir, LEGACY_ARCHIVER_LOCK))).toBe(false);
    // The replacement is old too: the next run, alone, archives it beside the first under a free
    // name check, which refuses rather than overwrite.
    const next = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(next.refused).toContain('is already in the archive');
    expect(existsSync(join(dir, 'evt-fallback-r.json'))).toBe(true);
  });

  test('a manual run while the daemon serves the root moves nothing in the older store, and lists what is due', async () => {
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', OLD_ISO);
    notice('lead', 'evt-fallback-b', RECENT_ISO);
    writeDaemonState(home, {
      format: 1, pid: process.pid, uid: process.getuid?.() ?? -1, since: NOW.toISOString(), startedBy: 'synthetic', version: 'test',
      heartbeatAt: NOW.toISOString(), socket: join(home, 'daemon.sock'), features: { broker: 'absent' }, stuck: [],
      roots: [{ root, team: 'acme', send: 'serving', bus: 'serving', why: null }],
    });
    const report = runInboxRetention(root, { now: NOW, home, seats: ['lead'], session: 'acme' });
    expect(report.move).toEqual([]);
    expect(report.daemon).toEqual({ due: ['evt-work-a'], stay: 1 });
    expect(live('lead')).toEqual(['evt-fallback-b.json', 'evt-work-a.json', 'evt-work-a.read.json']);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDrops(['archive'], io, { home })).toBe(0);
    expect(io.out).toContain('daemon will move evt-work-a');
    expect(io.out).toContain('the daemon serves this checkout and moves them at its nightly pass');
    expect(live('lead')).toEqual(['evt-fallback-b.json', 'evt-work-a.json', 'evt-work-a.read.json']);
    // The daemon's own pass is the archiver: it moves the record.
    const pass = await inboxArchivePass({ root, home, team, now: NOW, deps: { loadPerCore: () => 0.5, notify: async () => ({ ok: true, text: '' }) } });
    expect(pass).toMatchObject({ kind: 'ran', moved: 1 });
    expect(archived('lead')).toEqual(['evt-work-a.json', 'evt-work-a.read.json']);
  });

  test('a lock is broken only when its pid is dead on this host or the boot differs, never on age', () => {
    const dir = legacySeatDir(root, 'lead');
    mkdirSync(dir, { recursive: true });
    const deps = realLockDeps();
    const lockPath = join(dir, LEGACY_ARCHIVER_LOCK);
    const plantLock = (holder: Record<string, unknown>) => writeFileSync(lockPath, `${JSON.stringify({ token: 'other', ...holder })}\n`);
    // A live pid of this boot, started a year ago: busy.
    plantLock({ pid: process.pid, host: deps.host, started: '2025-11-15T00:00:00.000Z', boot: deps.boot });
    expect(takeArchiverLock(dir, deps).kind).toBe('busy');
    expect(existsSync(lockPath)).toBe(true);
    // Another host: never judged, busy.
    plantLock({ pid: 1, host: 'elsewhere', started: NOW.toISOString(), boot: deps.boot });
    expect(takeArchiverLock(dir, { ...deps, alive: () => false }).kind).toBe('busy');
    // A dead pid on this host: broken and taken.
    plantLock({ pid: 999_999, host: deps.host, started: NOW.toISOString(), boot: deps.boot });
    const taken = takeArchiverLock(dir, { ...deps, alive: () => false });
    expect(taken.kind).toBe('held');
    if (taken.kind === 'held') taken.release();
    // A live pid from an earlier boot: broken and taken.
    plantLock({ pid: process.pid, host: deps.host, started: NOW.toISOString(), boot: '2026-01-01T00:00:00.000Z' });
    const reboot = takeArchiverLock(dir, deps);
    expect(reboot.kind).toBe('held');
    if (reboot.kind === 'held') {
      expect(reboot.still()).toBe(true);
      reboot.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a leftover claim is recovered only by the lock's holder, never beside a live mover", () => {
    notice('lead', 'evt-work-c', OLD_ISO);
    read('lead', 'evt-work-c', OLD_ISO);
    const dir = legacySeatDir(root, 'lead');
    // A mover renamed the record to its claim name and is still working (its lock is live).
    renameSync(join(dir, 'evt-work-c.json'), join(dir, '.evt-work-c.json.claim'));
    const deps = realLockDeps();
    writeFileSync(join(dir, LEGACY_ARCHIVER_LOCK), `${JSON.stringify({ pid: process.pid, host: deps.host, started: NOW.toISOString(), boot: deps.boot, token: 'mover' })}\n`);
    const key = messageKeyOf(home);
    const busy = archiveLegacySeat({ root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null } });
    expect(busy.busy).not.toBeNull();
    expect(busy.finished).toBe(0);
    expect(existsSync(join(dir, '.evt-work-c.json.claim'))).toBe(true);
    // The mover died: its lock is stale, and the claim is finished.
    const done = archiveLegacySeat({
      root, session: 'acme', seat: 'lead', key, now: NOW, dryRun: false, options: { unreadKeepMs: null },
      lockDeps: { ...deps, alive: (pid) => pid !== process.pid },
    });
    expect(done.busy).toBeNull();
    expect(done.finished).toBe(1);
    expect(archived('lead')).toEqual(['evt-work-c.json', 'evt-work-c.read.json']);
    expect(live('lead')).toEqual([]);
  });

  test('recovery discovery charges every archive probe to the scan limit and resumes from its cursor', () => {
    const dir = legacySeatDir(root, 'lead');
    mkdirSync(dir, { recursive: true });
    // Four receipts with no record anywhere: each is a probe that finds nothing.
    for (let n = 0; n < 4; n += 1) {
      notice('lead', `evt-work-p${String(n)}`, OLD_ISO);
      read('lead', `evt-work-p${String(n)}`, OLD_ISO);
      renameSync(join(dir, `evt-work-p${String(n)}.json`), join(base, `gone-${String(n)}.json`));
    }
    const key = messageKeyOf(home);
    const plan = (recoveryAfter?: string) =>
      planLegacySeatArchive({ root, session: 'acme', seat: 'lead', key, nowMs: NOW.getTime(), options: { unreadKeepMs: null, scanLimit: 2, ...(recoveryAfter === undefined ? {} : { recoveryAfter }) } });
    const first = plan();
    expect(first.scanned).toBe(2);
    expect(first.recovery).toEqual([]);
    expect(first.more).toBe(true);
    expect(first.recoveryDone).toBe(false);
    expect(first.recoveryLast).toBe('evt-work-p1.read.json');
    const second = plan(first.recoveryLast ?? undefined);
    // The last two probes fit the limit exactly; discovery reaches the end and is done.
    expect(second.scanned).toBe(2);
    expect(second.recoveryDone).toBe(true);
    expect(second.recoveryLast).toBeNull();
    expect(second.more).toBe(false);
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

  test('team drops archive reaches the store for the team session', () => {
    notice('lead', 'evt-work-a', OLD_ISO);
    read('lead', 'evt-work-a', new Date(Date.now() - 9 * DAY_MS).toISOString());
    notice('resting', 'unread-old', new Date(Date.now() - 30 * DAY_MS).toISOString());
    letter('resting', 'mail-old', new Date(Date.now() - 30 * DAY_MS).toISOString());
    const dry = runInboxRetention(root, { now: new Date(), home, dryRun: true, seats: ['lead', 'resting'], session: 'acme' });
    // The runtime notice ages out; the real sender's unread letter stays (a manual run knows no rest).
    expect(dry.move).toEqual(['evt-work-a', 'unread-old']);
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
