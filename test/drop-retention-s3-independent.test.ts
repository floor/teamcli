// Independent coverage of reclaiming an archived drop family past the long window.
// Keep-all deletes nothing. A verifying family past the window is removed and its manifest stays.
// A tampered file, an unlisted extra file, or a forged manifest keeps the family whole.
// A parent swapped for a link during the unlink never deletes outside the archive.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { receiptFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import {
  DROP_ARCHIVE_DIR,
  getRelativeDirOps,
  retireDropsSliced,
  verifyDropArchive,
} from '../src/send/drop-retention.ts';
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

const NOW = new Date('2026-11-04T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
const INSIDE = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(NOW.getTime() + 95 * 24 * 60 * 60 * 1000);
const OLD_ISO = OLD.toISOString();
const DATE = NOW.toISOString().slice(0, 10);

const GONE = '019a4f61-3000-7000-8000-000000000001';
const HELD = '019a4f61-3000-7000-8000-000000000002';
const EXTRA = '019a4f61-3000-7000-8000-000000000003';
const LIVE = '019a4f61-3000-7000-8000-000000000004';

let base = '';
let root = '';
let home = '';
let team: TeamFile;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drop-s3-')));
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
  discardFixtures([base], { roots: [tmpdir()] });
  base = '';
});

function live(name: string): string {
  return join(recordDir(root, 'acme', 'worker'), name);
}

function seatDir(): string {
  return join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE, 'acme', 'worker');
}

function archived(name: string): string {
  return join(seatDir(), name);
}

function plantRead(id: string): void {
  const path = plantRecord(home, root, 'acme', 'worker', id, `body for ${id}\n`, { at: OLD_ISO, from: 'lead' });
  utimesSync(path, OLD, OLD);
  const receipt = signReceiptPayload(
    { kind: 'receipt', status: 'read', id, to: 'worker', root, session: 'acme', at: OLD_ISO },
    home,
  );
  const wrote = writeReceipt(recordDir(root, 'acme', 'worker'), receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
  utimesSync(receiptFile(recordDir(root, 'acme', 'worker'), id, 'read'), OLD, OLD);
}

function slices() {
  return { sliceMs: 2_000, stopping: () => false, yield: async () => true };
}

async function archive(id: string): Promise<string> {
  plantRead(id);
  const report = await retireDropsSliced({ root, home, team, at: NOW, slices: slices() });
  expect(report.refused).toBeNull();
  expect(report.reclaimed).toEqual([]);
  expect(report.archived.map((family) => family.id)).toEqual([id]);
  expect(report.manifestPath).not.toBeNull();
  if (report.manifestPath === null) throw new Error('the archive pass wrote no manifest');
  return report.manifestPath;
}

describe('drop-retention slice 3', () => {
  test('a family inside the long window stays, and a family past it is deleted while the manifest stays', async () => {
    const manifestPath = await archive(GONE);
    const manifestBytes = readFileSync(manifestPath);

    const inside = await retireDropsSliced({ root, home, team, at: INSIDE, slices: slices() });
    expect(inside.refused).toBeNull();
    expect(inside.reclaimed).toEqual([]);
    expect(existsSync(archived(GONE))).toBe(true);
    expect(existsSync(archived(`${GONE}.read.json`))).toBe(true);

    const reclaimed = await retireDropsSliced({ root, home, team, at: PAST, slices: slices() });
    expect(reclaimed.refused).toBeNull();
    expect(reclaimed.reclaimed.map((family) => family.id)).toEqual([GONE]);
    expect(existsSync(archived(GONE))).toBe(false);
    expect(existsSync(archived(`${GONE}.read.json`))).toBe(false);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    const verified = verifyDropArchive(JSON.parse(manifestBytes.toString('utf8')) as unknown, messageKeyOf(home));
    expect(verified?.families.map((family) => family.id)).toEqual([GONE]);
  });

  test('keep-all deletes nothing, live or archived', async () => {
    await archive(HELD);
    const archivedBytes = readFileSync(archived(HELD));
    plantRead(LIVE);
    const set = writePolicySet(
      home,
      { level: 'entity', target: 'floor', name: 'event-retention-days', value: 0 },
      { now: NOW },
    );
    expect(set.ok).toBe(true);

    const report = await retireDropsSliced({ root, home, team, at: PAST, slices: slices() });
    expect(report.refused).toBeNull();
    expect(report.archived).toEqual([]);
    expect(report.reclaimed).toEqual([]);
    expect(readFileSync(archived(HELD))).toEqual(archivedBytes);
    expect(existsSync(live(LIVE))).toBe(true);
    expect(existsSync(live(`${LIVE}.read.json`))).toBe(true);
  });

  test('a tampered file, an unlisted extra file, or a forged manifest keeps the family whole', async () => {
    const manifestPath = await archive(HELD);
    const manifestText = readFileSync(manifestPath, 'utf8');
    const recordPath = archived(HELD);
    const recordBytes = readFileSync(recordPath);
    const receiptPath = archived(`${HELD}.read.json`);

    writeFileSync(recordPath, Buffer.concat([recordBytes, Buffer.from('\n')]));
    const tampered = await retireDropsSliced({ root, home, team, at: PAST, slices: slices() });
    expect(tampered.refused).toContain('digest');
    expect(tampered.reclaimed).toEqual([]);
    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(receiptPath)).toBe(true);
    writeFileSync(recordPath, recordBytes);

    const parsed = JSON.parse(manifestText) as { payload: unknown; signature: string };
    writeFileSync(manifestPath, `${JSON.stringify({
      payload: parsed.payload,
      signature: '0'.repeat(parsed.signature.length),
    }, null, 2)}\n`);
    const forged = await retireDropsSliced({ root, home, team, at: PAST, slices: slices() });
    expect(forged.refused).toContain('manifest');
    expect(forged.reclaimed).toEqual([]);
    expect(readFileSync(recordPath)).toEqual(recordBytes);
    expect(existsSync(receiptPath)).toBe(true);
    writeFileSync(manifestPath, manifestText);

    writeFileSync(archived(EXTRA), recordBytes);
    const unlisted = await retireDropsSliced({ root, home, team, at: PAST, slices: slices() });
    expect(unlisted.refused).toContain('manifest');
    expect(unlisted.reclaimed).toEqual([]);
    expect(readFileSync(recordPath)).toEqual(recordBytes);
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(archived(EXTRA))).toBe(true);
  });

  test('a parent swapped for a link during the unlink never deletes outside the archive', async () => {
    await archive(GONE);
    const ops = getRelativeDirOps();
    expect(ops).not.toBeNull();
    if (ops === null) throw new Error('relative directory operations are unavailable');

    const outside = join(base, 'outside');
    mkdirSync(outside);
    const victim = join(outside, GONE);
    writeFileSync(victim, 'stay\n');
    const aside = join(base, 'aside-seat');
    let swapped = false;
    const raced = await retireDropsSliced({
      root,
      home,
      team,
      at: PAST,
      atFfi: {
        ...ops,
        unlinkat: (dirfd, name) => {
          if (!swapped && name === GONE) {
            swapped = true;
            renameSync(seatDir(), aside);
            symlinkSync(outside, seatDir());
          }
          return ops.unlinkat(dirfd, name);
        },
      },
      slices: slices(),
    });

    expect(swapped).toBe(true);
    expect(raced.refused).toContain('symbolic link');
    expect(raced.reclaimed).toEqual([]);
    expect(readFileSync(victim, 'utf8')).toBe('stay\n');
    expect(existsSync(join(outside, `${GONE}.read.json`))).toBe(false);
    expect(existsSync(join(aside, `${GONE}.read.json`))).toBe(true);
  });
});
