// Automatic transport-drop archive pass for the chores child (slice 1: archive, never delete).
//
// Retired drops and their companion sidecars move from `<root>/.agents/send-drops/<session>/<seat>/`
// into `<root>/.agents/send-drops/.archive/<YYYY-MM-DD>/<session>/<seat>/`, accompanied by a signed
// manifest record under `<root>/.agents/send-drops/.archive/<YYYY-MM-DD>/manifest-<stamp>.json`.
// Nothing is deleted in slice 1.
//
// Safety rules:
// 1. Only a verified message record with a verified read or replied receipt (`isRead`) and no
//    `.pending`, `.taken`, `.fallback.json` or `.fallback-note-*` marker, older than the resolved
//    retention window, may move. Unread drops, general briefs and client records never move.
// 2. Never follow a symbolic link, never leave `<root>/.agents/send-drops`, and refuse the whole
//    pass before moving anything if any link, non-regular entry, foreign-owned entry or unexpected
//    file name appears anywhere in the tree.
// 3. Within each family, the record and non-receipt sidecars move first and the read/replied
//    receipts move last, so a crash mid-move never leaves an unacked record in the live folder.
// 4. `.unread.json` stays in the live seat folder: unread ids stay untouched, and any stale entry
//    naming a drop that was just archived is pruned atomically.
import { createHash, type KeyObject } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { SweepSlices } from '../daemon/fallback-sweep.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { folderProblemAt } from '../held.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { heldAt } from '../launch/rules-file.ts';
import { currentClaimIn } from '../mcp/inbox.ts';
import { DAEMON_BACKLOG_DEFAULTS, eventThresholdsInForce } from '../policy/index.ts';
import { messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { ensureFoldersBelow } from './history.ts';
import type { MovedFile } from './message-archive.ts';
import { isRead, recordAuthOf, sameFolder, type RecordPayload } from './record.ts';

export const DROP_ARCHIVE_DOMAIN = 'teamcli-drop-archive-v1\0';
export const DROP_ARCHIVE_DIR = '.archive';

/** Default steady-state limit per pass, matching `FALLBACK_STORE_PASS_LIMIT`. */
export const DROP_ARCHIVE_PASS_LIMIT = 256;

const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const WORK_PREFIX = 'work-';

/** Sidecars moved after the message record and before the read/replied receipts. */
const PRE_RECEIPT_SUFFIXES: readonly string[] = [
  '.wake',
  '.wake-try',
  '.reported',
  '.draft',
  '.closed.json',
  '.channel-push.json',
  '.held.json',
  '.delivered.json',
  '.held',
  '.delivered',
];

/** Terminal receipts moved last so a crash never leaves the message record without its receipt. */
const RECEIPT_SUFFIXES: readonly string[] = [
  '.replied',
  '.read',
  '.replied.json',
  '.read.json',
];

/** Known fixed sidecar suffixes that may legitimately sit beside a message id in a seat folder. */
const KNOWN_SIDECAR_SUFFIXES: readonly string[] = [
  ...PRE_RECEIPT_SUFFIXES,
  ...RECEIPT_SUFFIXES,
  '.pending',
  '.taken',
  '.fallback.json',
];

const FALLBACK_NOTE_SUFFIX = /^\.fallback-note-[0-9a-f]{16}\.json$/;
const RECEIPT_TEMP_SUFFIX = /^\.(?:read|replied|delivered|held)\.json\.[0-9]+\.[0-9a-f]+\.new$/;
const UNREAD_TEMP_NAME = /^\.unread\.json\.[0-9]+\.tmp$/;
const RESERVE_TEMP_NAME = /^\.[0-9]+\.[0-9a-f]+\.tmp$/;

export type DropArchiveFamily = {
  session: string;
  seat: string;
  id: string;
  files: MovedFile[];
};

export type DropArchivePayload = {
  kind: 'drop-archive';
  format: 1;
  root: string;
  date: string;
  at: string;
  families: DropArchiveFamily[];
};

export type SignedDropArchive = {
  payload: DropArchivePayload;
  signature: string;
};

export type DropRetirementInput = {
  root: string;
  home: string;
  team?: TeamFile;
  at: Date;
  /** Override the retention window in ms; absent, resolves `event-retention-days` for the root. */
  olderThanMs?: number;
  limit?: number;
  backlogAbove?: number;
  backlogLimit?: number;
};

export type DropRetirementReport = {
  at: string;
  archived: DropArchiveFamily[];
  manifestPath: string | null;
  scanned: number;
  stayed: number;
  refused: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMovedFile(value: unknown): value is MovedFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.digest === 'string' &&
    value.digest !== '' &&
    typeof value.bytes === 'number' &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.source === 'string' &&
    value.source !== '' &&
    typeof value.dest === 'string' &&
    value.dest !== ''
  );
}

function isArchiveFamily(value: unknown): value is DropArchiveFamily {
  if (!isRecord(value)) return false;
  if (typeof value.session !== 'string' || !RECORD_NAME.test(value.session)) return false;
  if (typeof value.seat !== 'string' || !RECORD_NAME.test(value.seat)) return false;
  if (typeof value.id !== 'string' || !RECORD_NAME.test(value.id)) return false;
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  return value.files.every(isMovedFile);
}

/** Verifies a signed drop-archive manifest against `key`, returning its payload or null. */
export function verifyDropArchive(raw: unknown, key: KeyObject): DropArchivePayload | null {
  if (!isRecord(raw) || typeof raw.signature !== 'string' || raw.signature === '') return null;
  const payload = raw.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'drop-archive' || payload.format !== 1) return null;
  if (typeof payload.root !== 'string' || payload.root === '') return null;
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return null;
  if (typeof payload.at !== 'string' || !Number.isFinite(Date.parse(payload.at))) return null;
  if (!Array.isArray(payload.families) || !payload.families.every(isArchiveFamily)) return null;
  if (!verifyDomain(DROP_ARCHIVE_DOMAIN, payload as unknown as Json, raw.signature, key)) return null;
  return payload as unknown as DropArchivePayload;
}

/** Whether `name` is an expected regular file name inside `.agents/send-drops/<session>/<seat>/`. */
function isExpectedSeatDropFile(name: string): boolean {
  if (name === '.inbox-listener' || name === '.unread.json') return true;
  if (UNREAD_TEMP_NAME.test(name) || RESERVE_TEMP_NAME.test(name)) return true;
  if (!name.includes('.')) return RECORD_NAME.test(name);
  const dot = name.indexOf('.');
  const id = name.slice(0, dot);
  const suffix = name.slice(dot);
  if (id === '' || !RECORD_NAME.test(id) || id.startsWith(WORK_PREFIX)) return false;
  if (KNOWN_SIDECAR_SUFFIXES.includes(suffix)) return true;
  if (FALLBACK_NOTE_SUFFIX.test(suffix) || RECEIPT_TEMP_SUFFIX.test(suffix)) return true;
  return false;
}

/** Reads a regular file with `O_NOFOLLOW` and returns its bytes and mtimeMs, or throws. */
function readRegularNoFollow(path: string): { data: Buffer; mtimeMs: number } {
  const held = heldAt(path);
  if (held.kind === 'link') throw new Error(`${path}: a symbolic link was found and not followed`);
  if (held.kind !== 'file') throw new Error(`${path}: not a regular file`);
  if (process.getuid !== undefined && held.uid !== process.getuid()) {
    throw new Error(`${path}: another user's file`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path}: not a regular file`);
    return { data: readFileSync(fd), mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function insideSendDrops(sendDropsDir: string, target: string): boolean {
  const rel = relative(sendDropsDir, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveRetentionMs(
  root: string,
  home: string,
  team: TeamFile | undefined,
  at: Date,
  explicitMs: number | undefined,
): { ms: number; refusal: null } | { ms: null; refusal: string } {
  if (explicitMs !== undefined) {
    return Number.isFinite(explicitMs) && explicitMs >= 0
      ? { ms: explicitMs, refusal: null }
      : { ms: null, refusal: 'the drop retention window is not a valid duration' };
  }
  let resolvedTeam = team;
  if (resolvedTeam === undefined) {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) {
      return { ms: null, refusal: loaded.errors[0]?.message ?? 'the team file cannot be read' };
    }
    resolvedTeam = loaded.team;
  }
  const inForce = eventThresholdsInForce({
    home,
    entity: resolvedTeam.entity ?? '',
    projectId: projectIdOfTeam(home, resolvedTeam, root) ?? '',
    root,
    team: resolvedTeam,
    now: at,
    upToLevel: 'team',
  });
  if (!inForce.ok) {
    const why = inForce.refusals.map((r) => r.message).join('; ');
    return { ms: null, refusal: why === '' ? 'the retention policy could not be read' : why };
  }
  return { ms: inForce.thresholds.retention_days * 86_400_000, refusal: null };
}

function isClientRecord(payload: RecordPayload): boolean {
  return payload.from_client !== undefined || payload.to_client !== undefined;
}

type CandidateFamily = {
  session: string;
  seat: string;
  id: string;
  seatDir: string;
  files: string[];
  newestMs: number;
};

function archiveManifestPath(archiveDateDir: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let path = join(archiveDateDir, `manifest-${stamp}.json`);
  for (let n = 2; existsSync(path); n += 1) {
    path = join(archiveDateDir, `manifest-${stamp}-${String(n)}.json`);
  }
  return path;
}

/** Removes archived message ids from `.unread.json` in `seatDir` while keeping all unread ids intact. */
function pruneArchivedFromUnreadHint(seatDir: string, archivedIds: ReadonlySet<string>): string | null {
  if (archivedIds.size === 0) return null;
  const hintPath = join(seatDir, '.unread.json');
  const held = heldAt(hintPath);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return `${hintPath}: a symbolic link was found and not followed`;
  if (held.kind !== 'file') return `${hintPath}: unexpected ${held.kind} at .unread.json`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) {
    return `${hintPath}: another user's file`;
  }
  let parsed: unknown;
  try {
    const { data } = readRegularNoFollow(hintPath);
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    // An unreadable hint is left untouched as it stands.
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.unread)) return null;
  const unread = parsed.unread as Record<string, unknown>;
  const nextUnread: Record<string, { entries: { id: string; at: string }[] }> = {};
  let changed = false;
  for (const [peer, rawEntry] of Object.entries(unread)) {
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.entries)) continue;
    const kept: { id: string; at: string }[] = [];
    for (const item of rawEntry.entries) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.at !== 'string') continue;
      if (archivedIds.has(item.id)) {
        changed = true;
        continue;
      }
      kept.push({ id: item.id, at: item.at });
    }
    if (kept.length > 0) nextUnread[peer] = { entries: kept };
  }
  if (!changed) return null;
  const tmp = join(seatDir, `.unread.json.${String(process.pid)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ v: 1, unread: nextUnread }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, hintPath);
  } catch {
    try {
      // Leave the existing hint intact if the atomic swap could not complete.
    } catch {}
  }
  return null;
}

/**
 * Generator driving one root's drop-archive pass a step at a time. Yields between directory and
 * candidate inspections so the chores child's slice clock can yield to the event loop and answer
 * heartbeats without stalling.
 */
export function* dropRetirementSteps(input: DropRetirementInput): Generator<void, DropRetirementReport> {
  const { root, home, at } = input;
  const atIso = at.toISOString();
  const date = atIso.slice(0, 10);
  const empty = (refused: string | null = null, scanned = 0, stayed = 0): DropRetirementReport => ({
    at: atIso,
    archived: [],
    manifestPath: null,
    scanned,
    stayed,
    refused,
  });

  yield;
  const agentsDir = join(root, '.agents');
  if (heldAt(agentsDir).kind === 'missing') return empty();
  const agentsProblem = folderProblemAt(agentsDir);
  if (agentsProblem !== null) return empty(`${agentsDir}: ${agentsProblem}`);

  const sendDropsDir = join(agentsDir, 'send-drops');
  if (heldAt(sendDropsDir).kind === 'missing') return empty();
  const sendDropsProblem = folderProblemAt(sendDropsDir);
  if (sendDropsProblem !== null) return empty(`${sendDropsDir}: ${sendDropsProblem}`);

  // Pre-check `.archive` if it already stands in `send-drops`: a link or non-folder refuses the pass.
  const archiveRoot = join(sendDropsDir, DROP_ARCHIVE_DIR);
  if (heldAt(archiveRoot).kind !== 'missing') {
    const archiveProblem = folderProblemAt(archiveRoot);
    if (archiveProblem !== null) return empty(`${archiveRoot}: ${archiveProblem}`);
  }

  const retention = resolveRetentionMs(root, home, input.team, at, input.olderThanMs);
  if (retention.ms === null) return empty(retention.refusal);
  const cutoff = at.getTime() - retention.ms;

  const keyState = messageKeyState(home);
  if (keyState.kind === 'missing') return empty();
  if (keyState.kind === 'unreadable') return empty(`the message key is unreadable: ${keyState.why}`);
  const key = keyState.key;

  // Phase 1: Full pre-flight tree inspection + candidate discovery.
  // Any link, non-regular entry in a seat folder, foreign-owned entry, or unexpected file name
  // refuses the whole pass before a single file is moved.
  let sessionEntries: string[];
  try {
    sessionEntries = readdirSync(sendDropsDir).sort();
  } catch (error) {
    return empty(`${sendDropsDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidates: CandidateFamily[] = [];
  let scanned = 0;
  let stayed = 0;

  for (const session of sessionEntries) {
    yield;
    if (session === DROP_ARCHIVE_DIR) continue;
    const sessionDir = join(sendDropsDir, session);
    if (!insideSendDrops(sendDropsDir, sessionDir) || !RECORD_NAME.test(session)) {
      return empty(`${sessionDir}: unexpected entry in send-drops`);
    }
    const sessionHeld = heldAt(sessionDir);
    if (sessionHeld.kind === 'link') {
      return empty(`${sessionDir}: a symbolic link was found and not followed`);
    }
    if (sessionHeld.kind !== 'folder') {
      return empty(`${sessionDir}: unexpected ${sessionHeld.kind} in send-drops`);
    }
    const sessionProblem = folderProblemAt(sessionDir);
    if (sessionProblem !== null) return empty(`${sessionDir}: ${sessionProblem}`);

    let seatEntries: string[];
    try {
      seatEntries = readdirSync(sessionDir).sort();
    } catch (error) {
      return empty(`${sessionDir}: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const seat of seatEntries) {
      yield;
      const seatDir = join(sessionDir, seat);
      if (!insideSendDrops(sendDropsDir, seatDir) || !RECORD_NAME.test(seat)) {
        return empty(`${seatDir}: unexpected entry in session drop folder`);
      }
      const seatHeld = heldAt(seatDir);
      if (seatHeld.kind === 'link') {
        return empty(`${seatDir}: a symbolic link was found and not followed`);
      }
      if (seatHeld.kind !== 'folder') {
        return empty(`${seatDir}: unexpected ${seatHeld.kind} in session drop folder`);
      }
      const seatProblem = folderProblemAt(seatDir);
      if (seatProblem !== null) return empty(`${seatDir}: ${seatProblem}`);

      let fileNames: string[];
      try {
        fileNames = readdirSync(seatDir).sort();
      } catch (error) {
        return empty(`${seatDir}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const fileSet = new Set<string>();
      const fallbackNoteIds = new Set<string>();
      for (const name of fileNames) {
        yield;
        const filePath = join(seatDir, name);
        if (!insideSendDrops(sendDropsDir, filePath)) {
          return empty(`${filePath}: path escapes send-drops`);
        }
        const held = heldAt(filePath);
        if (held.kind === 'link') {
          return empty(`${filePath}: a symbolic link was found and not followed`);
        }
        if (held.kind !== 'file') {
          return empty(`${filePath}: unexpected ${held.kind} in seat drop folder`);
        }
        if (process.getuid !== undefined && held.uid !== process.getuid()) {
          return empty(`${filePath}: another user's file`);
        }
        if (!isExpectedSeatDropFile(name)) {
          return empty(`${filePath}: unexpected file in seat drop folder`);
        }
        fileSet.add(name);
        const dot = name.indexOf('.');
        if (dot > 0 && FALLBACK_NOTE_SUFFIX.test(name.slice(dot))) {
          fallbackNoteIds.add(name.slice(0, dot));
        }
      }

      const activeClaim = currentClaimIn(root, session, seat);

      for (const name of fileNames) {
        if (name.includes('.') || name.startsWith(WORK_PREFIX) || !RECORD_NAME.test(name)) continue;
        yield;
        scanned += 1;
        const recordPath = join(seatDir, name);
        let recordRead: { data: Buffer; mtimeMs: number };
        try {
          recordRead = readRegularNoFollow(recordPath);
        } catch (error) {
          return empty(error instanceof Error ? error.message : String(error), scanned, stayed);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(recordRead.data.toString('utf8')) as unknown;
        } catch {
          stayed += 1;
          continue;
        }
        const auth = recordAuthOf(parsed, key);
        if (auth.kind !== 'ok') {
          stayed += 1;
          continue;
        }
        const payload = auth.value.payload;
        if (
          payload.id !== name ||
          payload.to !== seat ||
          payload.session !== session ||
          !sameFolder(payload.root, root)
        ) {
          stayed += 1;
          continue;
        }
        if (
          isGeneralBriefRecord(payload) ||
          (payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE) ||
          activeClaim?.id === name
        ) {
          stayed += 1;
          continue;
        }
        if (isClientRecord(payload)) {
          stayed += 1;
          continue;
        }
        if (
          fileSet.has(`${name}.pending`) ||
          fileSet.has(`${name}.taken`) ||
          fileSet.has(`${name}.fallback.json`) ||
          fallbackNoteIds.has(name)
        ) {
          stayed += 1;
          continue;
        }
        if (!isRead(seatDir, name, { to: seat, root, session }, key)) {
          stayed += 1;
          continue;
        }

        const familyFiles: string[] = [
          name,
          ...PRE_RECEIPT_SUFFIXES.map((suffix) => `${name}${suffix}`).filter((f) => fileSet.has(f)),
          ...RECEIPT_SUFFIXES.map((suffix) => `${name}${suffix}`).filter((f) => fileSet.has(f)),
        ];
        let newestMs = Date.parse(payload.at);
        if (!Number.isFinite(newestMs)) {
          stayed += 1;
          continue;
        }
        let mtimeOk = true;
        for (const f of familyFiles) {
          try {
            const { mtimeMs } = readRegularNoFollow(join(seatDir, f));
            if (mtimeMs > newestMs) newestMs = mtimeMs;
          } catch {
            mtimeOk = false;
            break;
          }
        }
        if (!mtimeOk || newestMs > cutoff) {
          stayed += 1;
          continue;
        }
        candidates.push({ session, seat, id: name, seatDir, files: familyFiles, newestMs });
      }
    }
  }

  if (candidates.length === 0) return empty(null, scanned, stayed);

  candidates.sort((a, b) =>
    a.newestMs - b.newestMs ||
    a.session.localeCompare(b.session) ||
    a.seat.localeCompare(b.seat) ||
    a.id.localeCompare(b.id),
  );

  const steadyLimit = input.limit ?? DROP_ARCHIVE_PASS_LIMIT;
  const backlogAbove = input.backlogAbove ?? DAEMON_BACKLOG_DEFAULTS.above;
  const backlogLimit = input.backlogLimit ?? DAEMON_BACKLOG_DEFAULTS.limit;
  const passLimit = candidates.length > backlogAbove ? Math.max(steadyLimit, backlogLimit) : steadyLimit;
  const selected = candidates.slice(0, passLimit);

  // Phase 2: Pre-check all destination folders and hash every source file before moving anything.
  const relativeDestFolders = new Set<string>();
  const archiveDateRel = join(DROP_ARCHIVE_DIR, date);
  relativeDestFolders.add(archiveDateRel);
  for (const item of selected) {
    const relFolder = join(DROP_ARCHIVE_DIR, date, item.session, item.seat);
    const absDest = join(sendDropsDir, relFolder);
    if (!insideSendDrops(sendDropsDir, absDest)) {
      return empty(`${absDest}: destination escapes send-drops`, scanned, stayed);
    }
    relativeDestFolders.add(relFolder);
  }

  const folderProblem = ensureFoldersBelow(sendDropsDir, [...relativeDestFolders]);
  if (folderProblem !== null) return empty(folderProblem, scanned, stayed);

  type PreparedFamily = {
    candidate: CandidateFamily;
    destDir: string;
    hashed: { name: string; digest: string; bytes: number }[];
  };
  const prepared: PreparedFamily[] = [];

  for (const item of selected) {
    yield;
    const destDir = join(sendDropsDir, DROP_ARCHIVE_DIR, date, item.session, item.seat);
    for (const file of item.files) {
      const destPath = join(destDir, file);
      if (heldAt(destPath).kind !== 'missing') {
        return empty(`${destPath}: destination already holds ${file}`, scanned, stayed);
      }
    }
    const hashed: { name: string; digest: string; bytes: number }[] = [];
    for (const file of item.files) {
      try {
        const { data } = readRegularNoFollow(join(item.seatDir, file));
        hashed.push({
          name: file,
          digest: createHash('sha256').update(data).digest('hex'),
          bytes: data.byteLength,
        });
      } catch (error) {
        return empty(error instanceof Error ? error.message : String(error), scanned, stayed);
      }
    }
    prepared.push({ candidate: item, destDir, hashed });
  }

  // Phase 3: Move each family (record and non-receipt sidecars first, receipts last), update
  // `.unread.json` per seat folder, and write the signed archive manifest.
  const archived: DropArchiveFamily[] = [];
  const archivedBySeatDir = new Map<string, Set<string>>();

  for (const item of prepared) {
    yield;
    const { candidate, destDir, hashed } = item;
    const movedFiles: MovedFile[] = [];
    for (const file of hashed) {
      const source = join(candidate.seatDir, file.name);
      const dest = join(destDir, file.name);
      if (!insideSendDrops(sendDropsDir, source) || !insideSendDrops(sendDropsDir, dest)) {
        return empty('archive move path escapes send-drops', scanned, stayed);
      }
      try {
        renameSync(source, dest);
      } catch (error) {
        return empty(
          `cannot move ${relative(root, source)}: ${error instanceof Error ? error.message : String(error)}`,
          scanned,
          stayed,
        );
      }
      movedFiles.push({
        digest: file.digest,
        bytes: file.bytes,
        source: relative(root, source).split(sep).join('/'),
        dest: relative(root, dest).split(sep).join('/'),
      });
    }
    archived.push({
      session: candidate.session,
      seat: candidate.seat,
      id: candidate.id,
      files: movedFiles,
    });
    let ids = archivedBySeatDir.get(candidate.seatDir);
    if (ids === undefined) {
      ids = new Set<string>();
      archivedBySeatDir.set(candidate.seatDir, ids);
    }
    ids.add(candidate.id);
  }

  for (const [seatDir, ids] of archivedBySeatDir.entries()) {
    const problem = pruneArchivedFromUnreadHint(seatDir, ids);
    if (problem !== null) return empty(problem, scanned, stayed);
  }

  const archiveDateDir = join(sendDropsDir, DROP_ARCHIVE_DIR, date);
  const manifestPath = archiveManifestPath(archiveDateDir, at);
  if (!insideSendDrops(sendDropsDir, manifestPath) || dirname(manifestPath) !== archiveDateDir) {
    return empty('manifest path escapes send-drops archive', scanned, stayed);
  }
  const payload: DropArchivePayload = {
    kind: 'drop-archive',
    format: 1,
    root,
    date,
    at: atIso,
    families: archived,
  };
  const signed: SignedDropArchive = {
    payload,
    signature: signDomain(DROP_ARCHIVE_DOMAIN, payload as unknown as Json, key),
  };
  try {
    writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    return empty(
      `${manifestPath}: the archive manifest could not be written: ${error instanceof Error ? error.message : String(error)}`,
      scanned,
      stayed,
    );
  }

  return {
    at: atIso,
    archived,
    manifestPath,
    scanned,
    stayed,
    refused: null,
  };
}

/**
 * Runs the drop-archive pass a slice at a time under `input.slices`, yielding to the chores
 * child's event loop whenever `sliceMs` elapses. Stops cleanly at the next slice boundary when
 * `slices.stopping()` is true.
 */
export async function retireDropsSliced(
  input: DropRetirementInput & { slices: SweepSlices; sliceClock?: () => number },
): Promise<DropRetirementReport> {
  const clock = input.sliceClock ?? Date.now;
  const steps = dropRetirementSteps(input);
  let sliceStart = clock();
  let step = steps.next();
  while (!step.done) {
    if (clock() - sliceStart >= input.slices.sliceMs) {
      const more = await input.slices.yield();
      if (!more || input.slices.stopping()) {
        steps.return({
          at: input.at.toISOString(),
          archived: [],
          manifestPath: null,
          scanned: 0,
          stayed: 0,
          refused: null,
        });
        return {
          at: input.at.toISOString(),
          archived: [],
          manifestPath: null,
          scanned: 0,
          stayed: 0,
          refused: null,
        };
      }
      sliceStart = clock();
    }
    step = steps.next();
  }
  return step.value;
}
