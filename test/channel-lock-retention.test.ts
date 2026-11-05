// A push leaves .channel-emitted and a fallback leaves .channel-abort beside the record.
// Both belong to the family and move before the read receipt. An unknown name still
// refuses the whole pass before anything moves. The commit lock is not one of these names.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { DROP_ARCHIVE_DIR, retireDropsSliced, verifyDropArchive } from '../src/send/drop-retention.ts';
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

const EMITTED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01';
const ABORT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02';

let base: string;
let root: string;
let home: string;
let team: TeamFile;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-retention-')));
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

function plant(id: string): void {
  const path = plantRecord(home, root, 'acme', 'worker', id, `body for ${id}\n`, {
    at: OLD_ISO,
    from: 'lead',
  });
  utimesSync(path, OLD, OLD);
}

function markRead(id: string): void {
  const dir = recordDir(root, 'acme', 'worker');
  const receipt = signReceiptPayload(
    { kind: 'receipt', status: 'read', id, to: 'worker', root, session: 'acme', at: OLD_ISO },
    home,
  );
  const wrote = writeReceipt(dir, receipt, home);
  if (!wrote.ok) throw new Error(wrote.reason);
  utimesSync(receiptFile(dir, id, 'read'), OLD, OLD);
}

function live(name: string): string {
  return join(recordDir(root, 'acme', 'worker'), name);
}

function archiveDir(): string {
  return join(root, '.agents', 'send-drops', DROP_ARCHIVE_DIR, DATE, 'acme', 'worker');
}

describe('channel handoff sidecars retire with the record', () => {
  test('moves .channel-emitted and .channel-abort before the read receipt', async () => {
    plant(EMITTED_ID);
    markRead(EMITTED_ID);
    writeFileSync(live(`${EMITTED_ID}.channel-emitted`), 'emitted\n');
    utimesSync(live(`${EMITTED_ID}.channel-emitted`), OLD, OLD);

    plant(ABORT_ID);
    markRead(ABORT_ID);
    writeFileSync(live(`${ABORT_ID}.channel-abort`), 'abort\n');
    utimesSync(live(`${ABORT_ID}.channel-abort`), OLD, OLD);

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: { sliceMs: 2_000, stopping: () => false, yield: async () => true },
    });

    expect(report.refused).toBeNull();
    expect(report.archived.map((item) => item.id).sort()).toEqual([EMITTED_ID, ABORT_ID]);
    expect(existsSync(live(EMITTED_ID))).toBe(false);
    expect(existsSync(live(`${EMITTED_ID}.channel-emitted`))).toBe(false);
    expect(existsSync(live(ABORT_ID))).toBe(false);
    expect(existsSync(live(`${ABORT_ID}.channel-abort`))).toBe(false);
    expect(existsSync(join(archiveDir(), `${EMITTED_ID}.channel-emitted`))).toBe(true);
    expect(existsSync(join(archiveDir(), `${ABORT_ID}.channel-abort`))).toBe(true);

    const verified = verifyDropArchive(JSON.parse(readManifest(report.manifestPath)), messageKeyOf(home));
    expect(verified).not.toBeNull();
    const sources = verified?.families.map((family) => family.files.map((file) => file.source));
    expect(sources).toContainEqual([
      `.agents/send-drops/acme/worker/${EMITTED_ID}`,
      `.agents/send-drops/acme/worker/${EMITTED_ID}.channel-emitted`,
      `.agents/send-drops/acme/worker/${EMITTED_ID}.read.json`,
    ]);
    expect(sources).toContainEqual([
      `.agents/send-drops/acme/worker/${ABORT_ID}`,
      `.agents/send-drops/acme/worker/${ABORT_ID}.channel-abort`,
      `.agents/send-drops/acme/worker/${ABORT_ID}.read.json`,
    ]);
  });

  test('refuses the whole pass when an unknown file sits beside a handoff sidecar', async () => {
    plant(EMITTED_ID);
    markRead(EMITTED_ID);
    writeFileSync(live(`${EMITTED_ID}.channel-emitted`), 'emitted\n');
    writeFileSync(live('mystery.tar.gz'), 'unexpected bytes');

    const report = await retireDropsSliced({
      root,
      home,
      team,
      at: NOW,
      slices: { sliceMs: 2_000, stopping: () => false, yield: async () => true },
    });

    expect(report.refused).toContain('unexpected');
    expect(report.archived).toEqual([]);
    expect(existsSync(live(EMITTED_ID))).toBe(true);
    expect(existsSync(live(`${EMITTED_ID}.channel-emitted`))).toBe(true);
    expect(existsSync(live(`${EMITTED_ID}.read.json`))).toBe(true);
    expect(readdirSync(join(root, '.agents', 'send-drops')).includes(DROP_ARCHIVE_DIR)).toBe(false);
  });
});

function readManifest(path: string | null): string {
  if (path === null) throw new Error('missing archive manifest');
  return readFileSync(path, 'utf8');
}
