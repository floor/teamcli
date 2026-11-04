// Slice 1 of automatic drop retention:
// 1. Archives retired drops and their receipts into `<root>/.agents/send-drops/.archive/<date>/<session>/<seat>/`
//    with a signed manifest record naming what moved; never deletes.
// 2. Never follows a symbolic link, never leaves `<root>/.agents/send-drops`, and refuses the whole
//    pass on any unexpected file type or name before moving anything.
// 3. Runs only in the chores child, sliced, never on the daemon loop.
// 4. Keeps `.unread.json` consistent and proves an unread drop is never moved.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { listDrops, runDrops } from '../src/commands/drops.ts';
import { listUnackedMessages, plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { createFallbackPass } from '../src/daemon/chores/fallback.ts';
import type { ChoresSlices } from '../src/daemon/chores/child.ts';
import type { ChoresChildConfig, ChoresChildRoute } from '../src/daemon/chores/protocol.ts';
import { spawnChoresChild } from '../src/daemon/chores/spawn.ts';
import { FALLBACK_STORE_PASS_MS, sweepFallbackEscalationsSliced } from '../src/daemon/fallback-sweep.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../src/launch/general-brief.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  DROP_ARCHIVE_DIR,
  getRelativeDirOps,
  retireDropsSliced,
  verifyDropArchive,
} from '../src/send/drop-retention.ts';
import { markPending } from '../src/send/pending.ts';
import { receiptFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

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

const NOW = new Date('2026-11-04T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DATE = NOW_ISO.slice(0, 10);
const OLD = new Date(NOW.getTime() - 35 * 24 * 60 * 60 * 1000);
const OLD_ISO = OLD.toISOString();

const READ_ID_1 = '11111111-2222-4333-8444-555555555551';
const READ_ID_2 = '11111111-2222-4333-8444-555555555552';
const UNREAD_ID = '22222222-3333-4444-8555-666666666666';
const BRIEF_ID = '33333333-4444-4555-8666-777777777777';
const PENDING_ID = '44444444-5555-4666-8777-888888888888';
const FALLBACK_ID = '55555555-6666-4777-8888-999999999999';
const RECENT_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

let base: string;
let root: string;
let home: string;
let team: TeamFile;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drop-retention-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  team = validated.team;
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
  rmSync(base, { recursive: true, force: true });
});

function plant(
  seat: string,
  id: string,
  atIso = OLD_ISO,
  fields: Parameters<typeof plantRecord>[6] = {},
): string {
  const path = plantRecord(home, root, 'acme', seat, id, `body for ${id}\n`, {
    at: atIso,
    from: 'lead',
    ...fields,
  });
  const stamp = new Date(atIso);
  utimesSync(path, stamp, stamp);
  return path;
}

function markRead(seat: string, id: string, atIso = OLD_ISO): void {
  const dir = recordDir(root, 'acme', seat);
  const receipt = signReceiptPayload(
    { kind: 'receipt', status: 'read', id, to: seat, root, session: 'acme', at: atIso },
    home,
  );
  const wrote = writeReceipt(dir, receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
  const stamp = new Date(atIso);
  utimesSync(receiptFile(dir, id, 'read'), stamp, stamp);
}

function ageFamily(seat: string, id: string, at: Date): void {
  const dir = recordDir(root, 'acme', seat);
  for (const name of readdirSync(dir)) {
    if (name === id || name.startsWith(`${id}.`)) {
      utimesSync(join(dir, name), at, at);
    }
  }
}

function livePath(seat: string, name: string): string {
  return join(recordDir(root, 'acme', seat), name);
}

function archiveSeatDir(seat: string, date = DATE): string {
  return join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, date, 'acme', seat);
}

function defaultSlices(): ChoresSlices {
  return {
    sliceMs: 2_000,
    stopping: () => false,
    yield: async () => true,
  };
}

describe('slice 1: archives retired drops into send-drops/.archive with a signed manifest', () => {
  test('moves an old read family with its sidecars and writes a verified signed manifest', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    writeFileSync(livePath('worker', `${READ_ID_1}.wake`), '{"at":"2026-09-20T00:00:00.000Z","state":"read"}\n');
    writeFileSync(livePath('worker', `${READ_ID_1}.reported`), '{"at":"2026-09-20T00:00:00.000Z"}\n');
    ageFamily('worker', READ_ID_1, OLD);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toBeNull();
    expect(report.archived).toHaveLength(1);
    expect(report.archived[0]?.id).toBe(READ_ID_1);
    expect(report.archived[0]?.seat).toBe('worker');
    expect(report.manifestPath).not.toBeNull();

    // Nothing remains in the live seat folder, and every file is preserved in the archive folder.
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(false);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(false);
    expect(existsSync(livePath('worker', `${READ_ID_1}.wake`))).toBe(false);
    expect(existsSync(livePath('worker', `${READ_ID_1}.reported`))).toBe(false);

    const destDir = archiveSeatDir('worker');
    expect(existsSync(join(destDir, READ_ID_1))).toBe(true);
    expect(existsSync(join(destDir, `${READ_ID_1}.read.json`))).toBe(true);
    expect(existsSync(join(destDir, `${READ_ID_1}.wake`))).toBe(true);
    expect(existsSync(join(destDir, `${READ_ID_1}.reported`))).toBe(true);

    // The manifest sits inside send-drops/.archive/<DATE>/ and verifies with the checkout message key.
    const manifestRaw = JSON.parse(readFileSync(report.manifestPath!, 'utf8')) as unknown;
    const verified = verifyDropArchive(manifestRaw, messageKeyOf(home));
    expect(verified).not.toBeNull();
    expect(verified?.root).toBe(root);
    expect(verified?.date).toBe(DATE);
    expect(verified?.families).toHaveLength(1);
    expect(verified?.families[0]?.files.map((f) => f.source)).toEqual([
      `.agents/send-drops/acme/worker/${READ_ID_1}`,
      `.agents/send-drops/acme/worker/${READ_ID_1}.wake`,
      `.agents/send-drops/acme/worker/${READ_ID_1}.reported`,
      `.agents/send-drops/acme/worker/${READ_ID_1}.read.json`,
    ]);
  });

  test('.unread.json stays consistent and an unread drop is never moved', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    plant('worker', UNREAD_ID, OLD_ISO);
    ageFamily('worker', UNREAD_ID, OLD);

    const unreadPath = livePath('worker', '.unread.json');
    writeFileSync(
      unreadPath,
      `${JSON.stringify(
        {
          v: 1,
          unread: {
            lead: {
              entries: [
                { id: UNREAD_ID, at: OLD_ISO },
                { id: READ_ID_1, at: OLD_ISO },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    utimesSync(unreadPath, OLD, OLD);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toBeNull();
    expect(report.archived.map((entry) => entry.id)).toEqual([READ_ID_1]);

    // The unread drop is never moved, even though it is 35 days old.
    expect(existsSync(livePath('worker', UNREAD_ID))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), UNREAD_ID))).toBe(false);

    // .unread.json remains in the live seat folder, retains UNREAD_ID, and drops the archived READ_ID_1.
    expect(existsSync(unreadPath)).toBe(true);
    const updatedHint = JSON.parse(readFileSync(unreadPath, 'utf8')) as {
      v: number;
      unread: Record<string, { entries: { id: string; at: string }[] }>;
    };
    expect(updatedHint.unread.lead?.entries).toEqual([{ id: UNREAD_ID, at: OLD_ISO }]);
  });

  test('general briefs, pending/taken drops, active fallback markers, and recent drops stay', async () => {
    // 1. General brief (even with a read receipt and old timestamp)
    plant('worker', BRIEF_ID, OLD_ISO, { from: GENERAL_BRIEF_FROM, rule: GENERAL_BRIEF_RULE });
    markRead('worker', BRIEF_ID, OLD_ISO);
    ageFamily('worker', BRIEF_ID, OLD);

    // 2. Drop with .pending marker (even with a read receipt)
    plant('worker', PENDING_ID, OLD_ISO);
    markRead('worker', PENDING_ID, OLD_ISO);
    writeFileSync(livePath('worker', `${PENDING_ID}.pending`), '{"ts":"2026-09-20T00:00:00.000Z"}\n');
    ageFamily('worker', PENDING_ID, OLD);

    // 3. Drop with live .fallback.json marker
    plant('worker', FALLBACK_ID, OLD_ISO);
    markRead('worker', FALLBACK_ID, OLD_ISO);
    writeFileSync(livePath('worker', `${FALLBACK_ID}.fallback.json`), '{"format":1}\n');
    ageFamily('worker', FALLBACK_ID, OLD);

    // 4. Recent read drop inside the retention window
    plant('worker', RECENT_ID, NOW_ISO);
    markRead('worker', RECENT_ID, NOW_ISO);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toBeNull();
    expect(report.archived).toEqual([]);
    expect(existsSync(livePath('worker', BRIEF_ID))).toBe(true);
    expect(existsSync(livePath('worker', PENDING_ID))).toBe(true);
    expect(existsSync(livePath('worker', FALLBACK_ID))).toBe(true);
    expect(existsSync(livePath('worker', RECENT_ID))).toBe(true);
  });

  test('age uses signed at only, never mtime (same-user utimes cannot retire a fresh read or hold back an old read)', async () => {
    // 1. Sent 35d ago, read today (fresh read), but same-user utimes backdates both files to 35d ago -> must stay.
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, NOW_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    // 2. Sent 35d ago and read 35d ago, but same-user utimes sets both files' mtime to NOW -> must retire.
    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    ageFamily('worker', READ_ID_2, NOW);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toBeNull();
    expect(report.archived.map((f) => f.id)).toEqual([READ_ID_2]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);
    expect(existsSync(livePath('worker', READ_ID_2))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_2))).toBe(true);
  });

  test('a pass that stops or fails mid-way writes a signed manifest and reports every family that left the live folder', async () => {
    // Scene A: pass stops mid-way after moving READ_ID_1 and before moving READ_ID_2.
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    plant('worker', UNREAD_ID, OLD_ISO);

    const unreadPath = livePath('worker', '.unread.json');
    writeFileSync(
      unreadPath,
      `${JSON.stringify(
        {
          v: 1,
          unread: {
            lead: {
              entries: [
                { id: UNREAD_ID, at: OLD_ISO },
                { id: READ_ID_1, at: OLD_ISO },
                { id: READ_ID_2, at: OLD_ISO },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    let tickA = 0;
    let stopNow = false;
    const stopReport = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tickA += 10;
        return tickA;
      },
      slices: {
        sliceMs: 5,
        stopping: () => stopNow,
        yield: async () => {
          // Stop as soon as READ_ID_1 has been moved into the archive folder, before READ_ID_2 moves.
          if (existsSync(join(archiveSeatDir('worker'), READ_ID_1))) {
            stopNow = true;
            return false;
          }
          return true;
        },
      },
    });

    expect(stopReport.refused).toBeNull();
    expect(stopReport.archived.map((f) => f.id)).toEqual([READ_ID_1]);
    expect(stopReport.manifestPath).not.toBeNull();
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', READ_ID_2))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_2))).toBe(false);

    const stopManifest = verifyDropArchive(
      JSON.parse(readFileSync(stopReport.manifestPath!, 'utf8')) as unknown,
      messageKeyOf(home),
    );
    expect(stopManifest).not.toBeNull();
    expect(stopManifest?.families.map((f) => f.id)).toEqual([READ_ID_1]);

    const hintAfterStop = JSON.parse(readFileSync(unreadPath, 'utf8')) as {
      unread: Record<string, { entries: { id: string; at: string }[] }>;
    };
    expect(hintAfterStop.unread.lead?.entries.map((e) => e.id)).toEqual([UNREAD_ID, READ_ID_2]);

    // Scene B: pass fails on a later family (READ_ID_3 fails on its receipt rename after READ_ID_2 moved).
    const readId3 = '11111111-2222-4333-8444-555555555553';
    plant('worker', readId3, OLD_ISO);
    markRead('worker', readId3, OLD_ISO);

    let tickB = 0;
    let injectedFault = false;
    const errorReport = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tickB += 10;
        return tickB;
      },
      slices: {
        sliceMs: 5,
        stopping: () => false,
        yield: async () => {
          // Once READ_ID_2 has moved into the archive folder, plant a colliding file at
          // readId3's receipt destination so readId3 fails mid-family after moving its record.
          if (!injectedFault && existsSync(join(archiveSeatDir('worker'), READ_ID_2))) {
            injectedFault = true;
            writeFileSync(join(archiveSeatDir('worker'), `${readId3}.read.json`), 'collision\n');
          }
          return true;
        },
      },
    });

    expect(errorReport.refused).toContain(`${readId3}.read.json`);
    // READ_ID_2 completed its move and is covered by both the report and the signed manifest.
    expect(errorReport.archived.map((f) => f.id)).toEqual([READ_ID_2]);
    expect(errorReport.manifestPath).not.toBeNull();
    const errorManifest = verifyDropArchive(
      JSON.parse(readFileSync(errorReport.manifestPath!, 'utf8')) as unknown,
      messageKeyOf(home),
    );
    expect(errorManifest).not.toBeNull();
    expect(errorManifest?.families.map((f) => f.id)).toEqual([READ_ID_2]);

    // readId3's partial move (its record file) was rolled back to the live folder.
    expect(existsSync(livePath('worker', readId3))).toBe(true);
    expect(existsSync(livePath('worker', `${readId3}.read.json`))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), readId3))).toBe(false);
  });
});

describe('condition 2: never follow a link, never leave send-drops, and refuse whole pass on unexpected file types', () => {
  test('refuses the whole pass when a symlink exists inside a seat folder', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const outside = join(base, 'outside-target');
    writeFileSync(outside, 'secret\n');
    symlinkSync(outside, livePath('worker', READ_ID_2));

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toContain('symbolic link');
    expect(report.archived).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);
    expect(existsSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR))).toBe(false);
  });

  test('refuses the whole pass when the archive folder is a symlink pointing outside send-drops', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const outsideDir = join(base, 'outside-archive');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR));

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    expect(report.refused).toContain('symbolic link');
    expect(report.archived).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test('refuses the whole pass when an unexpected file or subdirectory sits in a seat folder', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    // Plant an unexpected file name in the seat drop folder.
    const unexpectedFile = livePath('worker', 'mystery.tar.gz');
    writeFileSync(unexpectedFile, 'unexpected bytes');

    const report1 = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });
    expect(report1.refused).toContain('unexpected');
    expect(report1.archived).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    rmSync(unexpectedFile);

    // Plant an unexpected nested directory in the seat drop folder.
    const unexpectedDir = livePath('worker', 'nested-dir');
    mkdirSync(unexpectedDir);
    const report2 = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });
    expect(report2.refused).toContain('unexpected');
    expect(report2.archived).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
  });

  test('refuses check-then-rename race when archive destination or manifest parent is swapped for a symlink mid-pass', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);

    const outsideDir = join(base, 'outside-race');
    mkdirSync(outsideDir, { recursive: true });

    // Race 1: After Phase 2 creates `.archive/<DATE>/acme/worker` and before Phase 3 moves READ_ID_1,
    // swap `.archive/<DATE>/acme/worker` for a symlink pointing to `outsideDir`.
    const destSeatDir = archiveSeatDir('worker');
    let tick1 = 0;
    let swappedSeatDir = false;
    const raceReport1 = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tick1 += 10;
        return tick1;
      },
      slices: {
        sliceMs: 5,
        stopping: () => false,
        yield: async () => {
          if (!swappedSeatDir && existsSync(destSeatDir)) {
            swappedSeatDir = true;
            rmSync(destSeatDir, { recursive: true, force: true });
            symlinkSync(outsideDir, destSeatDir);
          }
          return true;
        },
      },
    });

    expect(raceReport1.refused).toContain('symbolic link');
    expect(raceReport1.archived).toEqual([]);
    expect(raceReport1.manifestPath).toBeNull();
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);

    // Clean up `.archive` and test Race 2: swap `.archive/<DATE>` for a symlink after Phase 2's
    // directory check so the manifest parent path points outside `send-drops`.
    rmSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR), { recursive: true, force: true });
    const archiveDateDir = join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE);
    let tick2 = 0;
    let swappedDateDir = false;
    const raceReport2 = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tick2 += 10;
        return tick2;
      },
      slices: {
        sliceMs: 5,
        stopping: () => false,
        yield: async () => {
          if (!swappedDateDir && existsSync(destSeatDir)) {
            swappedDateDir = true;
            rmSync(archiveDateDir, { recursive: true, force: true });
            symlinkSync(outsideDir, archiveDateDir);
          }
          return true;
        },
      },
    });

    expect(raceReport2.refused).toContain('symbolic link');
    expect(raceReport2.archived).toEqual([]);
    expect(raceReport2.manifestPath).toBeNull();
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);
  });

  test('refuses the pass before any rename or folder creation when relative directory-descriptor moves are unavailable', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      atFfi: null,
      slices: defaultSlices(),
    });

    expect(report.refused).toContain('relative directory-descriptor moves (openat/renameat) are unavailable on this runtime');
    expect(report.archived).toEqual([]);
    expect(report.manifestPath).toBeNull();
    expect(existsSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR))).toBe(false);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);
  });

  test('detects and undoes a parent directory swap between the pre-check and the renameat / openat syscall', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const realOps = getRelativeDirOps();
    expect(realOps).not.toBeNull();
    if (!realOps) return;

    const outsideDir = join(root, 'outside-syscall-race-target');
    mkdirSync(outsideDir, { recursive: true });
    const destSeatDir = archiveSeatDir('worker');
    const movedAsideSeatDir = join(root, 'moved-aside-seat-dir');

    // Sub-test A: swap `destSeatDir` for a symlink to `outsideDir` inside `renameatExcl`,
    // i.e. AFTER `moveFileBetweenHeldDirs`'s pre-check (`verifyHeldDirChain` and `heldAt`) has passed
    // and right before the `renameat` syscall runs.
    let swappedBeforeRename = false;
    const reportA = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      atFfi: {
        ...realOps,
        renameatExcl: (fromfd, fromName, tofd, toName) => {
          if (!swappedBeforeRename && fromName === READ_ID_1) {
            swappedBeforeRename = true;
            renameSync(destSeatDir, movedAsideSeatDir);
            symlinkSync(outsideDir, destSeatDir);
          }
          return realOps.renameatExcl(fromfd, fromName, tofd, toName);
        },
      },
      slices: defaultSlices(),
    });

    expect(swappedBeforeRename).toBe(true);
    expect(reportA.refused).toContain('symbolic link');
    expect(reportA.archived).toEqual([]);
    expect(reportA.manifestPath).toBeNull();
    // Held fd move never wrote to `outsideDir`, and post-rename chain verification undid the move back to the live folder.
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);

    // Clean up and run Sub-test B: swap `.archive/<DATE>` for a symlink to `outsideDir` inside `openat`
    // when creating `manifest-<passId>.json`, i.e. AFTER `writeNewFileInHeldDir`'s pre-check has passed
    // and right before the `openat` syscall runs.
    rmSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR), { recursive: true, force: true });
    rmSync(movedAsideSeatDir, { recursive: true, force: true });
    const archiveDateDir = join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE);
    const movedAsideDateDir = join(root, 'moved-aside-date-dir');

    let swappedBeforeManifestOpen = false;
    const reportB = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      atFfi: {
        ...realOps,
        openat: (dirfd, name, flags, mode) => {
          if (!swappedBeforeManifestOpen && name.startsWith('manifest-')) {
            swappedBeforeManifestOpen = true;
            renameSync(archiveDateDir, movedAsideDateDir);
            symlinkSync(outsideDir, archiveDateDir);
          }
          return realOps.openat(dirfd, name, flags, mode);
        },
      },
      slices: defaultSlices(),
    });

    expect(swappedBeforeManifestOpen).toBe(true);
    expect(reportB.refused).toContain('symbolic link');
    expect(reportB.archived).toEqual([]);
    expect(reportB.manifestPath).toBeNull();
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', `${READ_ID_1}.read.json`))).toBe(true);
  });
});

describe('condition 3: runs only in the chores child, sliced, never on the daemon loop', () => {
  test('daemon inline sweep does not archive drops; chores child pass archives them sliced', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    ageFamily('worker', READ_ID_2, OLD);

    // 1. Daemon loop inline call (`sweepFallbackEscalationsSliced`) never touches send-drops records.
    await sweepFallbackEscalationsSliced({
      home,
      roots: [{ root, team }],
      now: () => NOW,
      retire: { limit: 256, lockWaitMs: 0 },
      slices: defaultSlices(),
    });
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);
    expect(existsSync(livePath('worker', READ_ID_2))).toBe(true);

    // 2. Chores child pass: first beat only escalates; second beat (>= FALLBACK_STORE_PASS_MS later)
    //    runs housekeeping and slices across candidates.
    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 5_000,
      sliceMs: 1,
      since: OLD_ISO,
      routes: [{ root, team: 'acme', session: 'acme', teamFile: team }],
    };
    const pass = createFallbackPass(config);
    const route: ChoresChildRoute = config.routes[0]!;

    let yields = 0;
    const childSlices: ChoresSlices = {
      sliceMs: 1,
      stopping: () => false,
      yield: async () => {
        yields += 1;
        return true;
      },
    };

    // First pass in child: initial pass, no housekeeping yet.
    const firstNotes = await pass({ route, at: new Date(NOW.getTime() - FALLBACK_STORE_PASS_MS), slices: childSlices });
    expect(firstNotes).toEqual([]);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(true);

    // Second pass in child at NOW: housekeeping runs drop retirement in the chores child.
    const secondNotes = await pass({ route, at: NOW, slices: childSlices });
    expect(secondNotes.some((line) => line.includes('drop store: archived 2'))).toBe(true);
    expect(existsSync(livePath('worker', READ_ID_1))).toBe(false);
    expect(existsSync(livePath('worker', READ_ID_2))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_2))).toBe(true);
  });

  test('retireDropsSliced yields between slice boundaries and stops cleanly when slices.yield returns false', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    ageFamily('worker', READ_ID_2, OLD);

    let clockTick = 0;
    let yields = 0;
    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        clockTick += 10;
        return clockTick;
      },
      slices: {
        sliceMs: 5,
        stopping: () => false,
        yield: async () => {
          yields += 1;
          return true;
        },
      },
    });
    expect(yields).toBeGreaterThan(0);
    expect(report.archived.length).toBe(2);
  });

  test('spawnChoresChild launches the child with unchanged arguments ([entry, "--inherited", nonce]) and no extra runtime flags', async () => {
    const fixtureEntry = join(root, 'echo-chores-argv.js');
    writeFileSync(
      fixtureEntry,
      'process.stderr.write(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }) + "\\n");\nprocess.exit(0);\n',
    );
    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 5_000,
      sliceMs: 1,
      since: OLD_ISO,
      routes: [{ root, team: 'acme', session: 'acme', teamFile: team }],
    };
    const notes: string[] = [];
    const child = spawnChoresChild({ config, entry: fixtureEntry });
    child.subscribe((ev) => {
      if (ev.kind === 'note') notes.push(ev.text);
    });
    await child.exited;

    expect(notes.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(notes[0]!) as { argv: string[]; execArgv: string[] };
    expect(parsed.execArgv).toEqual([]);
    expect(parsed.argv).toHaveLength(3);
    expect(parsed.argv[0]).toBe(fixtureEntry);
    expect(parsed.argv[1]).toBe('--inherited');
    expect(typeof parsed.argv[2]).toBe('string');
    expect(parsed.argv[2]!.length).toBeGreaterThan(0);
  });
});

/** Counts file content reads (`readFileSync` and `openSync` with O_RDONLY) under `send-drops` using a fake/wrapped fs. */
function withCountedDropReads<T>(rootDir: string, fn: () => T): { result: T; reads: string[]; bodyReads: string[]; receiptReads: string[]; pendingReads: string[] } {
  const sendDropsPrefix = join(rootDir, '.agents', 'send-drops');
  const reads: string[] = [];
  const realReadFileSync = fs.readFileSync;
  const realOpenSync = fs.openSync;
  const recordRead = (target: unknown): void => {
    if (typeof target !== 'string') return;
    if (!target.startsWith(sendDropsPrefix)) return;
    reads.push(target);
  };
  const spyRead = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    recordRead(path);
    return Reflect.apply(realReadFileSync, fs, [path, ...rest]);
  }) as typeof fs.readFileSync);
  const spyOpen = spyOn(fs, 'openSync').mockImplementation(((path: unknown, flags: unknown, ...rest: unknown[]) => {
    if (typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) === 0) {
      recordRead(path);
    }
    return Reflect.apply(realOpenSync, fs, [path, flags, ...rest]);
  }) as typeof fs.openSync);
  try {
    const result = fn();
    const bodyReads = reads.filter((p) => !p.endsWith('.json') && !p.endsWith('.pending') && !p.endsWith('.taken') && !p.endsWith('.wake') && !p.endsWith('.reported'));
    const receiptReads = reads.filter((p) => p.endsWith('.read.json') || p.endsWith('.replied.json') || p.endsWith('.delivered.json') || p.endsWith('.held.json'));
    const pendingReads = reads.filter((p) => p.endsWith('.pending'));
    return { result, reads, bodyReads, receiptReads, pendingReads };
  } finally {
    spyRead.mockRestore();
    spyOpen.mockRestore();
  }
}

describe('slice 2: hot read paths skip read bodies and cache verified stamps inside the retention window', () => {
  test('listUnread (inbox_check) returns identical unread rows, never reads read message bodies, and caches stamps on repeat calls', () => {
    const recentIso = '2026-11-03T12:00:00.000Z';
    for (let i = 1; i <= 20; i += 1) {
      const id = `019a4f10-1000-7000-8000-${String(i).padStart(12, '0')}`;
      plant('worker', id, recentIso);
      markRead('worker', id, recentIso);
    }
    const unreadA = '019a4f10-2000-7000-8000-000000000001';
    const unreadB = '019a4f10-2000-7000-8000-000000000002';
    plant('worker', unreadA, '2026-11-03T13:00:00.000Z');
    plant('worker', unreadB, '2026-11-03T14:00:00.000Z');

    const dropDir = recordDir(root, 'acme', 'worker');
    const context = { to: 'worker', root, session: 'acme' };

    const pass1 = withCountedDropReads(root, () => listUnread(dropDir, context, home));
    expect(pass1.result.map((m) => m.id)).toEqual([unreadA, unreadB]);
    // Pass 1 must never read the 20 already-read message body files, and reads each unread body at most once.
    expect(pass1.bodyReads.length).toBeLessThanOrEqual(2);

    const pass2 = withCountedDropReads(root, () => listUnread(dropDir, context, home));
    expect(pass2.result).toEqual(pass1.result);
    // Pass 2 reuses cached receipt stamps and cached unread record stamps: 0 file reads under send-drops.
    expect(pass2.reads.length).toBe(0);
  });

  test('recordCandidates and listUnackedMessages (team messages) return identical unacked rows without reading read message bodies', async () => {
    const recentIso = '2026-11-03T12:00:00.000Z';
    for (let i = 1; i <= 20; i += 1) {
      const id = `019a4f20-1000-7000-8000-${String(i).padStart(12, '0')}`;
      plant('worker', id, recentIso);
      markRead('worker', id, recentIso);
    }
    const unackedId = '019a4f20-2000-7000-8000-000000000001';
    plant('worker', unackedId, '2026-11-03T15:00:00.000Z');
    // Plain-text legacy drop stays ignored by listUnackedMessages and runMessages.
    writeFileSync(livePath('worker', '019a4f20-3000-7000-8000-000000000001'), 'from lead — plain text drop\nhello\n');

    const pass1 = withCountedDropReads(root, () => listUnackedMessages(root, 'acme', home));
    expect(pass1.result.map((m) => m.id)).toEqual([unackedId]);
    // Only the 1 unread record + 1 plain-text drop are read; none of the 20 read record bodies are read.
    expect(pass1.bodyReads.length).toBeLessThanOrEqual(2);

    const pass2 = withCountedDropReads(root, () => listUnackedMessages(root, 'acme', home));
    expect(pass2.result).toEqual(pass1.result);
    expect(pass2.reads.length).toBe(0);

    // runMessages --json serves the 1 unacked message and marks it read.
    let stdout = '';
    const exitCode = await runMessages(
      ['--json'],
      {
        cwd: root,
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stdout: (s) => { stdout += s; },
        stderr: () => {},
      },
      { home, now: () => NOW },
    );
    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout) as { counts: { messages: number; shown: number; refused: number } };
    expect(doc.counts).toEqual({ messages: 1, shown: 1, refused: 0 });
  });

  test('reconcile drop, .pending, and receipt scan caches .pending markers and skips re-reading unchanged files', () => {
    const recentIso = '2026-11-03T12:00:00.000Z';
    const dropDir = recordDir(root, 'acme', 'worker');
    for (let i = 1; i <= 15; i += 1) {
      const id = `019a4f30-1000-7000-8000-${String(i).padStart(12, '0')}`;
      plant('worker', id, recentIso);
      markRead('worker', id, recentIso);
      markPending(dropDir, {
        id,
        from: 'lead',
        to: 'worker',
        body: `message ${String(i)}`,
        ts: recentIso,
        leg: 'drop',
      });
    }

    const state = createReconcileState();
    const pass1 = withCountedDropReads(root, () =>
      reconcilePass({ project: 'acme', root, session: 'acme', home, state, now: NOW }),
    );
    expect(pass1.result.ok).toBe(true);
    expect(state.stats.filesRead).toBe(15);
    expect(pass1.pendingReads.length).toBe(15);

    // Second pass with unchanged directory: 0 file reads under send-drops (including .pending files).
    const pass2 = withCountedDropReads(root, () =>
      reconcilePass({ project: 'acme', root, session: 'acme', home, state, now: NOW }),
    );
    expect(pass2.result.ok).toBe(true);
    expect(state.stats.filesRead).toBe(0);
    expect(pass2.reads.length).toBe(0);

    // Add 1 new drop to worker's folder (changing directory mtime): only the 1 new drop is read;
    // the 15 existing drops and 15 .pending files are reused from cache without reading from disk.
    const newId = '019a4f30-2000-7000-8000-000000000001';
    plant('worker', newId, '2026-11-03T16:00:00.000Z');
    const pass3 = withCountedDropReads(root, () =>
      reconcilePass({ project: 'acme', root, session: 'acme', home, state, now: NOW }),
    );
    expect(pass3.result.ok).toBe(true);
    expect(state.stats.filesRead).toBe(1);
    expect(pass3.pendingReads.length).toBe(0);
    expect(pass3.receiptReads.length).toBe(0);
  });

  test('listDrops and runDrops return identical rows, never read read drop bodies, and reuse cached stamps on repeat calls', async () => {
    const recentIso = '2026-11-03T12:00:00.000Z';
    for (let i = 1; i <= 20; i += 1) {
      const id = `019a4f40-1000-7000-8000-${String(i).padStart(12, '0')}`;
      plant('worker', id, recentIso);
      markRead('worker', id, recentIso);
    }
    const unreadId = '019a4f40-2000-7000-8000-000000000001';
    plant('worker', unreadId, '2026-11-03T16:00:00.000Z');

    const dropDir = recordDir(root, 'acme', 'worker');
    const key = messageKeyOf(home);
    const context = { to: 'worker', root, session: 'acme' };

    const pass1 = withCountedDropReads(root, () => listDrops(dropDir, key, context));
    expect(pass1.result.kind).toBe('ok');
    if (pass1.result.kind === 'ok') {
      expect(pass1.result.rows.map((r) => r.id)).toEqual([unreadId]);
    }
    expect(pass1.bodyReads.length).toBe(1);

    const pass2 = withCountedDropReads(root, () => listDrops(dropDir, key, context));
    expect(pass2.result).toEqual(pass1.result);
    expect(pass2.reads.length).toBe(0);

    // Also verify runDrops --read --seat worker serves the unread message and writes its read receipt.
    let stdout = '';
    const exitCode = await runDrops(
      ['--read', '--seat', 'worker'],
      {
        cwd: root,
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stdout: (s) => { stdout += s; },
        stderr: () => {},
      },
      { home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`body for ${unreadId}`);
  });
});

describe('slice 3: deletes archived drops past the long window while keeping the signed manifest', () => {
  const LONG_FUTURE = new Date(NOW.getTime() + 95 * 24 * 60 * 60 * 1000);
  const MID_FUTURE = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

  test('reclaims archived drop families past the long window, removes empty session/seat folders, and retains the signed manifest', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    writeFileSync(livePath('worker', `${READ_ID_1}.wake`), '{"at":"2026-09-20T00:00:00.000Z","state":"read"}\n');
    writeFileSync(livePath('worker', `${READ_ID_1}.reported`), '{"at":"2026-09-20T00:00:00.000Z"}\n');
    ageFamily('worker', READ_ID_1, OLD);

    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    ageFamily('worker', READ_ID_2, OLD);

    // Step 1: Slice 1 archives both families into .archive/<DATE>/acme/worker/ with a signed manifest.
    const archivedReport = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });
    expect(archivedReport.refused).toBeNull();
    expect(archivedReport.archived.map((f) => f.id)).toEqual([READ_ID_1, READ_ID_2]);
    expect(archivedReport.reclaimed).toEqual([]);
    const manifestPath = archivedReport.manifestPath!;
    expect(manifestPath).not.toBeNull();

    // Step 2: Inside the long window (30 days after archiving), nothing in .archive is deleted.
    const midReport = await retireDropsSliced({
      root,
      home,
      team,
      at: MID_FUTURE,
      slices: defaultSlices(),
    });
    expect(midReport.refused).toBeNull();
    expect(midReport.reclaimed).toEqual([]);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_1}.read.json`))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_2))).toBe(true);

    // Step 3: Past the long window (95 days after archiving), the archived files and empty
    // <session>/<seat> directories are unlinked while the signed manifest stays intact.
    const reclaimReport = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(reclaimReport.refused).toBeNull();
    expect(reclaimReport.reclaimed.map((f) => f.id)).toEqual([READ_ID_1, READ_ID_2]);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_1}.read.json`))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_1}.wake`))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_1}.reported`))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_2))).toBe(false);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_2}.read.json`))).toBe(false);
    // Empty <seat> and <session> folders under .archive/<DATE>/ are removed.
    expect(existsSync(archiveSeatDir('worker'))).toBe(false);
    expect(existsSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE, 'acme'))).toBe(false);
    // The signed manifest stays in .archive/<DATE>/ and still verifies with the checkout message key.
    expect(existsSync(manifestPath)).toBe(true);
    const verified = verifyDropArchive(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, messageKeyOf(home));
    expect(verified).not.toBeNull();
    expect(verified?.families.map((f) => f.id)).toEqual([READ_ID_1, READ_ID_2]);

    // Step 4: Re-running after reclamation is an idempotent no-op.
    const repeatReport = await retireDropsSliced({
      root,
      home,
      team,
      at: new Date(LONG_FUTURE.getTime() + 86_400_000),
      slices: defaultSlices(),
    });
    expect(repeatReport.refused).toBeNull();
    expect(repeatReport.reclaimed).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  test('keep-all (event-retention-days = 0) is a complete no-op for both archiving and archive deletion', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const archivedReport = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });
    expect(archivedReport.archived.map((f) => f.id)).toEqual([READ_ID_1]);

    // Plant another old read drop in the live folder and set entity policy event-retention-days = 0 (keep-all).
    plant('worker', READ_ID_2, OLD_ISO);
    markRead('worker', READ_ID_2, OLD_ISO);
    ageFamily('worker', READ_ID_2, OLD);

    const setKeepAll = writePolicySet(
      home,
      { level: 'entity', target: 'floor', name: 'event-retention-days', value: 0 },
      { now: NOW },
    );
    expect(setKeepAll.ok).toBe(true);

    const keepAllReport = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(keepAllReport.refused).toBeNull();
    expect(keepAllReport.archived).toEqual([]);
    expect(keepAllReport.reclaimed).toEqual([]);
    // Both the live drop and the archived drop stay untouched under keep-all.
    expect(existsSync(livePath('worker', READ_ID_2))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(true);
  });

  test('refuses to delete archived drops when the manifest does not verify or a file digest does not match', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const archivedReport = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });
    const manifestPath = archivedReport.manifestPath!;
    const originalManifestText = readFileSync(manifestPath, 'utf8');
    const archivedRecordPath = join(archiveSeatDir('worker'), READ_ID_1);
    const originalRecordBytes = readFileSync(archivedRecordPath);

    // 1. Tamper with the archived record bytes so its SHA-256 digest mismatches the signed manifest.
    writeFileSync(archivedRecordPath, Buffer.concat([originalRecordBytes, Buffer.from('\n')]));
    const digestMismatch = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(digestMismatch.refused).toContain('digest');
    expect(digestMismatch.reclaimed).toEqual([]);
    expect(existsSync(archivedRecordPath)).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), `${READ_ID_1}.read.json`))).toBe(true);
    writeFileSync(archivedRecordPath, originalRecordBytes);

    // 2. Corrupt the manifest signature: nothing is unlinked.
    const parsedManifest = JSON.parse(originalManifestText) as { payload: unknown; signature: string };
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ payload: parsedManifest.payload, signature: '0'.repeat(parsedManifest.signature.length) }, null, 2)}\n`,
    );
    const badSig = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(badSig.refused).toContain('manifest');
    expect(badSig.reclaimed).toEqual([]);
    expect(existsSync(archivedRecordPath)).toBe(true);
    writeFileSync(manifestPath, originalManifestText);

    // 3. Remove the manifest while archived files remain in .archive/<DATE>/acme/worker: refuses without deleting.
    rmSync(manifestPath);
    const missingManifest = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(missingManifest.refused).toContain('manifest');
    expect(missingManifest.reclaimed).toEqual([]);
    expect(existsSync(archivedRecordPath)).toBe(true);
    writeFileSync(manifestPath, originalManifestText, { mode: 0o600 });

    // 4. Plant an unlisted extra file inside .archive/<DATE>/acme/worker: refuses without deleting.
    const unlistedPath = join(archiveSeatDir('worker'), READ_ID_2);
    writeFileSync(unlistedPath, originalRecordBytes, { mode: 0o600 });
    const unlistedReport = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      slices: defaultSlices(),
    });
    expect(unlistedReport.refused).toContain('manifest');
    expect(unlistedReport.reclaimed).toEqual([]);
    expect(existsSync(archivedRecordPath)).toBe(true);
    rmSync(unlistedPath);
  });

  test('refuses symlink swaps inside .archive before or during descriptor-held unlinks and never unlinks outside send-drops', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: defaultSlices(),
    });

    const realOps = getRelativeDirOps();
    expect(realOps).not.toBeNull();
    if (!realOps) return;

    const outsideDir = join(base, 'outside-archive-reclaim');
    mkdirSync(outsideDir, { recursive: true });
    const outsideVictim = join(outsideDir, READ_ID_1);
    writeFileSync(outsideVictim, 'do not delete\n');

    const destSeatDir = archiveSeatDir('worker');
    const movedAsideSeatDir = join(base, 'moved-aside-archive-seat');

    // Swap `.archive/<DATE>/acme/worker` for a symlink to `outsideDir` right inside `unlinkat`.
    let swapped = false;
    const raced = await retireDropsSliced({
      root,
      home,
      team,
      at: LONG_FUTURE,
      atFfi: {
        ...realOps,
        unlinkat: (dirfd, name) => {
          if (!swapped && name === READ_ID_1) {
            swapped = true;
            renameSync(destSeatDir, movedAsideSeatDir);
            symlinkSync(outsideDir, destSeatDir);
          }
          return realOps.unlinkat(dirfd, name);
        },
      },
      slices: defaultSlices(),
    });

    expect(swapped).toBe(true);
    expect(raced.refused).toContain('symbolic link');
    expect(raced.reclaimed).toEqual([]);
    // The outside victim file is completely untouched because unlinks use the held fd and verify the parent chain.
    expect(existsSync(outsideVictim)).toBe(true);
  });

  test('chores child housekeeping logs reclaimed count and slices across archive reclamation', async () => {
    plant('worker', READ_ID_1, OLD_ISO);
    markRead('worker', READ_ID_1, OLD_ISO);
    ageFamily('worker', READ_ID_1, OLD);

    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 5_000,
      sliceMs: 1,
      since: OLD_ISO,
      routes: [{ root, team: 'acme', session: 'acme', teamFile: team }],
    };
    const pass = createFallbackPass(config);
    const route: ChoresChildRoute = config.routes[0]!;
    const childSlices: ChoresSlices = {
      sliceMs: 1,
      stopping: () => false,
      yield: async () => true,
    };

    // Pass 1: initial escalation-only beat.
    await pass({ route, at: new Date(NOW.getTime() - FALLBACK_STORE_PASS_MS), slices: childSlices });
    // Pass 2 at NOW: archives READ_ID_1.
    const notesArchive = await pass({ route, at: NOW, slices: childSlices });
    expect(notesArchive.some((line) => line.includes('drop store: archived 1'))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(true);

    // Pass 3 at LONG_FUTURE: reclaims READ_ID_1 from .archive and logs reclaimed count.
    const notesReclaim = await pass({ route, at: LONG_FUTURE, slices: childSlices });
    expect(notesReclaim.some((line) => line.includes('drop store: archived 0, reclaimed 1'))).toBe(true);
    expect(existsSync(join(archiveSeatDir('worker'), READ_ID_1))).toBe(false);
  });
});

