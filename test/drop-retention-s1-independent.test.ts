// Independent coverage of drop-retention slice 1 and its fixes at 908521452.
// An unread drop stays. A stop or a rename error mid-pass leaves a signed manifest of every
// family that left the live folder. A parent swapped for a link between the check and the move
// never lands a file outside send-drops, and without held-descriptor moves the pass refuses
// before any rename. Age is the signed at. The chores child is launched with the same arguments.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnChoresChild, type ChoresChildConfig } from '../src/daemon/chores/spawn.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  DROP_ARCHIVE_DIR,
  getRelativeDirOps,
  retireDropsSliced,
  verifyDropArchive,
} from '../src/send/drop-retention.ts';
import { receiptFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
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
const OLD = new Date(NOW.getTime() - 35 * 24 * 60 * 60 * 1000);
const NOW_ISO = NOW.toISOString();
const OLD_ISO = OLD.toISOString();
const DATE = NOW_ISO.slice(0, 10);

const UNREAD = '019a4f61-1000-7000-8000-000000000001';
const FRESH = '019a4f61-1000-7000-8000-000000000002';
const STALE = '019a4f61-1000-7000-8000-000000000003';
const STOP_A = '019a4f61-1000-7000-8000-000000000004';
const STOP_B = '019a4f61-1000-7000-8000-000000000005';
const MOVED = '019a4f61-1000-7000-8000-000000000006';
const COLLIDE = '019a4f61-1000-7000-8000-000000000007';
const LINKED = '019a4f61-1000-7000-8000-000000000008';

let base = '';
let root = '';
let home = '';
let team: TeamFile;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drop-s1-')));
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

function archived(name: string): string {
  return join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE, 'acme', 'worker', name);
}

function plant(id: string, atIso: string): void {
  const path = plantRecord(home, root, 'acme', 'worker', id, `body for ${id}\n`, { at: atIso, from: 'lead' });
  const at = new Date(atIso);
  utimesSync(path, at, at);
}

function markRead(id: string, atIso: string): void {
  const dir = recordDir(root, 'acme', 'worker');
  const receipt = signReceiptPayload(
    { kind: 'receipt', status: 'read', id, to: 'worker', root, session: 'acme', at: atIso },
    home,
  );
  const wrote = writeReceipt(dir, receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
  const at = new Date(atIso);
  utimesSync(receiptFile(dir, id, 'read'), at, at);
}

function age(id: string, at: Date): void {
  const dir = recordDir(root, 'acme', 'worker');
  utimesSync(join(dir, id), at, at);
  const receipt = receiptFile(dir, id, 'read');
  if (existsSync(receipt)) utimesSync(receipt, at, at);
}

function slices(yielding: () => Promise<boolean> | boolean = async () => true) {
  return { sliceMs: 2_000, stopping: () => false, yield: async () => yielding() };
}

function manifestIds(path: string | null): string[] {
  expect(path).not.toBeNull();
  const verified = verifyDropArchive(JSON.parse(readFileSync(path!, 'utf8')) as unknown, messageKeyOf(home));
  expect(verified).not.toBeNull();
  return (verified?.families ?? []).map((family) => family.id).sort();
}

describe('drop-retention slice 1', () => {
  test('an unread drop is never moved, and a same-user utimes cannot retire a fresh read', async () => {
    plant(UNREAD, OLD_ISO);
    age(UNREAD, OLD);
    plant(FRESH, OLD_ISO);
    markRead(FRESH, NOW_ISO);
    age(FRESH, OLD);
    plant(STALE, OLD_ISO);
    markRead(STALE, OLD_ISO);
    age(STALE, NOW);

    const report = await retireDropsSliced({ root, home, team, at: NOW, slices: slices() });

    expect(report.refused).toBeNull();
    expect(report.archived.map((family) => family.id)).toEqual([STALE]);
    expect(existsSync(live(UNREAD))).toBe(true);
    expect(existsSync(archived(UNREAD))).toBe(false);
    expect(existsSync(live(FRESH))).toBe(true);
    expect(existsSync(live(`${FRESH}.read.json`))).toBe(true);
    expect(existsSync(archived(STALE))).toBe(true);
  });

  test('a mid-pass stop leaves a signed manifest of the family that left and leaves the rest live', async () => {
    plant(STOP_A, OLD_ISO);
    markRead(STOP_A, OLD_ISO);
    age(STOP_A, OLD);
    plant(STOP_B, OLD_ISO);
    markRead(STOP_B, OLD_ISO);
    age(STOP_B, OLD);

    let stop = false;
    let tick = 0;
    const stopped = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tick += 10;
        return tick;
      },
      slices: {
        sliceMs: 5,
        stopping: () => stop,
        yield: async () => {
          if (existsSync(archived(STOP_A))) {
            stop = true;
            return false;
          }
          return true;
        },
      },
    });

    expect(stopped.refused).toBeNull();
    expect(stopped.archived.map((family) => family.id)).toEqual([STOP_A]);
    expect(manifestIds(stopped.manifestPath)).toEqual([STOP_A]);
    expect(existsSync(live(STOP_B))).toBe(true);
    expect(existsSync(archived(STOP_B))).toBe(false);
  });

  test('a rename error mid-pass leaves a signed manifest of every family that left, and rolls the failed family back', async () => {
    plant(MOVED, OLD_ISO);
    markRead(MOVED, OLD_ISO);
    age(MOVED, OLD);
    plant(COLLIDE, OLD_ISO);
    markRead(COLLIDE, OLD_ISO);
    age(COLLIDE, OLD);
    let collided = false;
    let tick = 0;
    const failed = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      sliceClock: () => {
        tick += 10;
        return tick;
      },
      slices: {
        sliceMs: 5,
        stopping: () => false,
        yield: async () => {
          if (!collided && existsSync(archived(MOVED))) {
            collided = true;
            writeFileSync(archived(`${COLLIDE}.read.json`), 'collision\n');
          }
          return true;
        },
      },
    });

    expect(collided).toBe(true);
    expect(failed.refused).toContain(`${COLLIDE}.read.json`);
    expect(failed.archived.map((family) => family.id)).toEqual([MOVED]);
    expect(manifestIds(failed.manifestPath)).toEqual([MOVED]);
    expect(existsSync(live(COLLIDE))).toBe(true);
    expect(existsSync(live(`${COLLIDE}.read.json`))).toBe(true);
    expect(existsSync(archived(COLLIDE))).toBe(false);
  });

  test('a parent swapped for a link between the check and the move never leaves send-drops, and missing descriptor moves refuse first', async () => {
    plant(LINKED, OLD_ISO);
    markRead(LINKED, OLD_ISO);
    age(LINKED, OLD);

    const unavailable = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      atFfi: null,
      slices: slices(),
    });
    expect(unavailable.refused).toContain('relative directory-descriptor moves (openat/renameat) are unavailable on this runtime');
    expect(unavailable.archived).toEqual([]);
    expect(unavailable.manifestPath).toBeNull();
    expect(existsSync(join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR))).toBe(false);
    expect(existsSync(live(LINKED))).toBe(true);

    const ops = getRelativeDirOps();
    expect(ops).not.toBeNull();
    if (ops === null) return;
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const aside = join(base, 'aside-seat');
    const seatDir = join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE, 'acme', 'worker');
    let swapped = false;
    const raced = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      atFfi: {
        ...ops,
        renameatExcl: (fromFd, fromName, toFd, toName) => {
          if (!swapped && fromName === LINKED) {
            swapped = true;
            renameSync(seatDir, aside);
            symlinkSync(outside, seatDir);
          }
          return ops.renameatExcl(fromFd, fromName, toFd, toName);
        },
      },
      slices: slices(),
    });

    expect(swapped).toBe(true);
    expect(raced.refused).toContain('symbolic link');
    expect(raced.archived).toEqual([]);
    expect(raced.manifestPath).toBeNull();
    expect(existsSync(join(outside, LINKED))).toBe(false);
    expect(existsSync(live(LINKED))).toBe(true);
    expect(existsSync(live(`${LINKED}.read.json`))).toBe(true);
  });

  test('the chores child is launched with the entry, --inherited, and the nonce, and no runtime flags', async () => {
    const entry = join(root, 'echo-chores-argv.js');
    writeFileSync(entry, 'process.stderr.write(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }) + "\\n");\nprocess.exit(0);\n');
    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 5_000,
      sliceMs: 1,
      since: OLD_ISO,
      routes: [{ root, team: 'acme', session: 'acme', teamFile: team }],
    };
    const notes: string[] = [];
    const child = spawnChoresChild({ config, entry });
    child.subscribe((event) => {
      if (event.kind === 'note') notes.push(event.text);
    });
    await child.exited;

    expect(notes.length).toBeGreaterThan(0);
    const heard = JSON.parse(notes[0]!) as { argv: string[]; execArgv: string[] };
    expect(heard.execArgv).toEqual([]);
    expect(heard.argv).toEqual([entry, '--inherited', heard.argv[2]]);
    expect(heard.argv[2]?.length).toBeGreaterThan(0);
    expect(heard.argv.some((word) => word.startsWith('--experimental'))).toBe(false);
  });
});
