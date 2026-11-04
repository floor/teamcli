// The runtime-home migration: the kit folders that grew up in the machine-global lobby move
// into the runtime home under the machine folder, as one declared step of `team daemon
// install` (design: briefs-0.5.13/runtime-home-migration-design.md).
//
// The step's list is closed and named here. Unknown lobby folders are never moved or
// touched. Bridge and signer kits are known and deliberately not on the list: they wait
// for the connector lane, and their presence is reported as a later lane, never a refusal.
//
// A folder moves by rename on one filesystem. Across devices it is copied to a temp name
// beside the target, verified whole (names, sizes, hashes, modes from each source entry's
// own stat), renamed into place, and only then is the source removed — so a crash
// anywhere, including mid-copy, leaves each folder wholly in one home or the other, and a
// re-run sweeps the temp and resumes. Directory modes narrow to 0700 on landing; file
// modes are kept, never widened. The step never parses a file it moves, and deletes
// nothing but a moved folder's empty source and its own temps.
//
// A folder a still-loaded unit names is held, with the unit's label — read from the
// service manager's own records through the injected source, never a process walk. The
// step kills nothing. A moved guard folder prints the exact replacement `guard_dir`
// line for one batched re-approval, and the migration reports *moved, not complete*
// until no hosted team file names the old lobby path; resolving a stale word by name is
// never done — a signed word means the path it says. The undo below is the move's own
// inverse from the note, never automatic.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { lobbyDir } from '../lobby/gate.ts';
import { runtimeDir, runtimeKitsDir, runtimeMigrationNotePath } from './paths.ts';

/** The kit folders this step moves, in the order it moves them. */
export const RUNTIME_KIT_FOLDERS: readonly string[] = [
  'atlas-810',
  'desk-810',
  'iris-810',
  'guard-floor-iris',
  'guard-pilot-wk',
  'front-810',
  'mailbox-router',
];

/** Known kit folders a later lane owns; reported, never moved by this step. */
export const LATER_KIT_FOLDERS: readonly string[] = ['bridge-810', 'signer-810'];

const GUARD_FOLDERS: ReadonlySet<string> = new Set(['guard-floor-iris', 'guard-pilot-wk']);

export type LoadedProgram = { label: string; program: readonly string[] };

export type RuntimeMigrationSources = {
  now?: () => Date;
  /** The loaded units' own program words, from the service manager's records. */
  loadedPrograms?: () => LoadedProgram[];
  /** The guard folders hosted team files currently name (defaults resolved). */
  guardDirsNamed?: () => string[];
  /** Injected by a test: the rename, so EXDEV and mid-step crashes are scenes, not luck. */
  rename?: (from: string, to: string) => void;
  /** Injected by a test: one file's copy, so a mid-copy death is a scene. */
  copyFile?: (from: string, to: string) => void;
  /** Injected by a test: this process's user id, so another user's folder is a scene. */
  uid?: () => number;
};

export type RuntimeMigrationUndoReport = {
  movedBack: string[];
  held: { name: string; unit: string }[];
  refused: { name: string; why: string }[];
  /** Lobby `guard_dir` lines to re-approve in reverse, one per guard refused. */
  guardLines: string[];
  dryRun: boolean;
};

export type RuntimeMigrationReport = {
  moved: string[];
  alreadyMoved: string[];
  held: { name: string; unit: string }[];
  refused: { name: string; why: string }[];
  later: string[];
  /** Replacement `guard_dir` lines to re-approve, one per moved guard still named old. */
  guardLines: string[];
  /** False while a moved guard's old lobby path is still named by a hosted team file. */
  complete: boolean;
  dryRun: boolean;
};

type Note = {
  format: 1;
  moved: { name: string; from: string; to: string; at: string }[];
  guardsPending: string[];
};

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readNote(home: string): Note {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runtimeMigrationNotePath(home), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && (parsed as Note).format === 1
      && Array.isArray((parsed as Note).moved) && Array.isArray((parsed as Note).guardsPending)) {
      return parsed as Note;
    }
  } catch { /* no note yet, or not ours to read as one */ }
  return { format: 1, moved: [], guardsPending: [] };
}

function writeNote(home: string, note: Note): void {
  mkdirSync(runtimeDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(runtimeMigrationNotePath(home), `${JSON.stringify(note, null, 2)}\n`, { mode: 0o600 });
}

/** Every entry under `root`, relative, directories first in walk order. Links are named,
 *  never followed: the caller decides what a link means (here: refuse the folder). */
function walk(root: string): { dirs: string[]; files: string[]; links: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  const links: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push(rel);
      else if (stat.isDirectory()) {
        dirs.push(rel);
        visit(path, rel);
      } else files.push(rel);
    }
  };
  visit(root, '');
  return { dirs, files, links };
}

/** A file's sha256, read in chunks: bytes are hashed, never interpreted. */
function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 128);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function copyFileChunked(from: string, to: string, sources: RuntimeMigrationSources): void {
  if (sources.copyFile !== undefined) {
    sources.copyFile(from, to);
    return;
  }
  const input = openSync(from, 'r');
  try {
    const output = openSync(to, 'w', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 128);
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(output, buffer, written, read - written, null);
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}

/** The cross-device path: copy to the temp beside the target, verify whole, rename, remove. */
function copyVerifyMove(from: string, to: string, sources: RuntimeMigrationSources): void {
  const temp = join(dirname(to), `.${to.split('/').pop()}.moving-${randomBytes(6).toString('hex')}`);
  const shape = walk(from);
  mkdirSync(temp, { mode: 0o700 });
  for (const dir of shape.dirs) mkdirSync(join(temp, dir), { mode: statOrNull(join(from, dir))?.mode ?? 0o700 });
  for (const file of shape.files) copyFileChunked(join(from, file), join(temp, file), sources);
  // Modes come from each source entry's own stat; directories then narrow with the rest.
  for (const file of shape.files) chmodSync(join(temp, file), lstatSync(join(from, file)).mode & 0o777);
  const copied = walk(temp);
  const sameShape = JSON.stringify(shape) === JSON.stringify(copied);
  const verified = sameShape && shape.files.every((file) => (
    lstatSync(join(from, file)).size === lstatSync(join(temp, file)).size
    && (lstatSync(join(from, file)).mode & 0o777) === (lstatSync(join(temp, file)).mode & 0o777)
    && hashFile(join(from, file)) === hashFile(join(temp, file))
  ));
  if (!verified) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error('the copy did not verify against the source');
  }
  (sources.rename ?? renameSync)(temp, to);
  rmSync(from, { recursive: true, force: true });
}

/** Narrows every directory at and under `root` to 0700; file modes are kept. */
function narrowDirs(root: string): void {
  const visit = (dir: string): void => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && stat.isDirectory()) visit(path);
    }
  };
  visit(root);
}

function sweepTemps(kitsDir: string): void {
  let names: string[];
  try {
    names = readdirSync(kitsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^\..+\.moving-[0-9a-f]+$/.test(name)) rmSync(join(kitsDir, name), { recursive: true, force: true });
  }
}

/** The loaded unit whose program names `folder`, or null: held, never killed. */
function holdingUnit(folder: string, sources: RuntimeMigrationSources): string | null {
  for (const unit of sources.loadedPrograms?.() ?? []) {
    if (unit.program.some((word) => word === folder || word.startsWith(`${folder}/`))) return unit.label;
  }
  return null;
}

/**
 * The parent chain this step may act through: every existing component under home on
 * the way to the leaf must be a real folder this user owns. A link anywhere — the
 * lobby, the runtime home, its kits folder — is refused before anything is created
 * or removed through it, and so is anything owned by another user. Components that
 * do not stand yet will be made by this step, owned by this user.
 */
function chainProblem(home: string, leaf: string, sources: RuntimeMigrationSources): string | null {
  const uid = sources.uid?.() ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const below = leaf.slice(home.length).split('/').filter((part) => part !== '');
  let at = home;
  for (const part of below) {
    at = join(at, part);
    const stat = statOrNull(at);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) return `${at} is a link; links are never followed or moved through`;
    if (uid !== null && stat.uid !== uid) return `${at} is owned by another user`;
  }
  return null;
}

/**
 * Moves the listed kit folders from the machine lobby into the runtime home. With
 * `dryRun`, the same report is computed and nothing is moved or written.
 */
export function migrateRuntimeHome(
  home: string = homedir(),
  sources: RuntimeMigrationSources = {},
  options: { dryRun?: boolean } = {},
): RuntimeMigrationReport {
  const dryRun = options.dryRun === true;
  const lobby = lobbyDir(home);
  const kits = runtimeKitsDir(home);
  const rename = sources.rename ?? renameSync;
  const report: RuntimeMigrationReport = {
    moved: [], alreadyMoved: [], held: [], refused: [], later: [], guardLines: [], complete: true, dryRun,
  };
  const note = readNote(home);
  // The chains are judged before anything is made or swept through them: a link or a
  // stranger's folder above either home refuses every folder that stands to move.
  const chain = chainProblem(home, lobby, sources) ?? chainProblem(home, kits, sources);
  if (chain !== null) {
    for (const name of RUNTIME_KIT_FOLDERS) {
      if (statOrNull(join(lobby, name)) !== null) report.refused.push({ name, why: chain });
    }
    report.complete = report.refused.length === 0;
    return report;
  }
  if (!dryRun) {
    mkdirSync(kits, { recursive: true, mode: 0o700 });
    sweepTemps(kits);
  }
  for (const name of LATER_KIT_FOLDERS) {
    if (statOrNull(join(lobby, name)) !== null) report.later.push(name);
  }
  for (const name of RUNTIME_KIT_FOLDERS) {
    const from = join(lobby, name);
    const to = join(kits, name);
    const source = statOrNull(from);
    const target = statOrNull(to);
    if (source === null) {
      if (target !== null || note.moved.some((entry) => entry.name === name)) report.alreadyMoved.push(name);
      continue;
    }
    if (source.isSymbolicLink() || !source.isDirectory()) {
      report.refused.push({ name, why: `the lobby path ${from} is not a folder this step may move` });
      continue;
    }
    const leafChain = chainProblem(home, from, sources) ?? chainProblem(home, to, sources);
    if (leafChain !== null) {
      report.refused.push({ name, why: leafChain });
      continue;
    }
    if (target !== null) {
      report.refused.push({ name, why: `${name} stands in both homes (${from} and ${to}); neither was touched` });
      continue;
    }
    const unit = holdingUnit(from, sources);
    if (unit !== null) {
      report.held.push({ name, unit });
      continue;
    }
    if (walk(from).links.length > 0) {
      report.refused.push({ name, why: `${name} holds a link; links are never followed or moved` });
      continue;
    }
    if (dryRun) {
      report.moved.push(name);
      continue;
    }
    try {
      try {
        rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyVerifyMove(from, to, sources);
      }
      narrowDirs(to);
    } catch (error) {
      report.refused.push({ name, why: `${name} could not be moved: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    note.moved = [...note.moved.filter((entry) => entry.name !== name), { name, from, to, at: (sources.now?.() ?? new Date()).toISOString() }];
    try { writeNote(home, note); } catch { /* the folders as they stand are the state; the note follows */ }
    report.moved.push(name);
  }
  // The guard completion gate: a moved guard whose old lobby path a hosted team file still
  // names prints its replacement line once, batched, and keeps the migration not complete.
  const named = new Set(sources.guardDirsNamed?.() ?? []);
  const pending: string[] = [];
  const movedEntries = dryRun
    ? [...note.moved, ...report.moved
      .filter((name) => GUARD_FOLDERS.has(name) && !note.moved.some((entry) => entry.name === name))
      .map((name) => ({ name, from: join(lobby, name), to: join(kits, name), at: '' }))]
    : note.moved;
  for (const entry of movedEntries) {
    if (!GUARD_FOLDERS.has(entry.name)) continue;
    if (named.has(entry.from)) {
      report.guardLines.push(`guard_dir: ${entry.to}`);
      pending.push(entry.name);
    }
  }
  report.complete = pending.length === 0 && report.refused.length === 0;
  if (!dryRun && JSON.stringify(note.guardsPending) !== JSON.stringify(pending)) {
    note.guardsPending = pending;
    try { writeNote(home, note); } catch { /* as above */ }
  }
  return report;
}

/**
 * The rollback the migration itself offers (design §6): rename each folder the note
 * records back into the lobby, the move's own inverse. A guard moves back only before
 * its re-approval lands: once a hosted team file names the new home, the guard is
 * refused with that state named, and its lobby `guard_dir` line is printed for the
 * reverse re-approval. A folder standing in both homes is never merged; a folder a
 * loaded unit names in its new home is held. Never automatic — only ever called as an
 * explicit repair, and idempotent: an entry already back is simply dropped.
 */
export function undoRuntimeHomeMigration(
  home: string = homedir(),
  sources: RuntimeMigrationSources = {},
  options: { dryRun?: boolean } = {},
): RuntimeMigrationUndoReport {
  const dryRun = options.dryRun === true;
  const lobby = lobbyDir(home);
  const rename = sources.rename ?? renameSync;
  const report: RuntimeMigrationUndoReport = { movedBack: [], held: [], refused: [], guardLines: [], dryRun };
  const note = readNote(home);
  const named = new Set(sources.guardDirsNamed?.() ?? []);
  const kits = runtimeKitsDir(home);
  // The chains are judged before anything is made or swept through them, as the
  // forward move judges them; only then is a half-copied temp of an earlier undo
  // swept from the lobby, the mirror of the forward sweep.
  const chain = chainProblem(home, lobby, sources) ?? chainProblem(home, kits, sources);
  if (!dryRun) {
    if (chain === null) {
      mkdirSync(lobby, { recursive: true, mode: 0o700 });
      sweepTemps(lobby);
    }
  }
  // The step's own list order, like the forward move.
  const ordered = RUNTIME_KIT_FOLDERS
    .map((name) => note.moved.find((entry) => entry.name === name))
    .filter((entry) => entry !== undefined);
  for (const entry of ordered) {
    const { name, from, to } = entry;
    // The note is a record, not an instruction: only the pinned pair this step itself
    // writes may move. An entry naming any other path is refused whole.
    if (from !== join(lobby, name) || to !== join(kits, name)) {
      report.refused.push({ name, why: `${name}'s note entry names paths other than the pinned pair; nothing was moved` });
      continue;
    }
    if (chain !== null) {
      report.refused.push({ name, why: chain });
      continue;
    }
    const leafChain = chainProblem(home, from, sources) ?? chainProblem(home, to, sources);
    if (leafChain !== null) {
      report.refused.push({ name, why: leafChain });
      continue;
    }
    const target = statOrNull(to);
    const source = statOrNull(from);
    if (target === null) {
      // Already back (or gone): the note follows the folders as they stand.
      if (source !== null) report.movedBack.push(name);
      continue;
    }
    if (target.isSymbolicLink() || !target.isDirectory()) {
      report.refused.push({ name, why: `the runtime-home path ${to} is not a folder this step may move` });
      continue;
    }
    if (source !== null) {
      report.refused.push({ name, why: `${name} stands in both homes (${from} and ${to}); neither was touched` });
      continue;
    }
    if (GUARD_FOLDERS.has(name) && named.has(to)) {
      report.refused.push({
        name,
        why: `${name}: batches moved, re-approval landed, manual re-approval required — the signed word names the new home`,
      });
      report.guardLines.push(`guard_dir: ${from}`);
      continue;
    }
    const unit = holdingUnit(to, sources);
    if (unit !== null) {
      report.held.push({ name, unit });
      continue;
    }
    if (walk(to).links.length > 0) {
      report.refused.push({ name, why: `${name} holds a link; links are never followed or moved` });
      continue;
    }
    if (dryRun) {
      report.movedBack.push(name);
      continue;
    }
    try {
      try {
        rename(to, from);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyVerifyMove(to, from, sources);
      }
    } catch (error) {
      report.refused.push({ name, why: `${name} could not be moved back: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    report.movedBack.push(name);
    note.moved = note.moved.filter((kept) => kept.name !== name);
    note.guardsPending = note.guardsPending.filter((kept) => note.moved.some((moved) => moved.name === kept));
    try { writeNote(home, note); } catch { /* the folders as they stand are the state */ }
  }
  if (!dryRun && note.moved.length === 0 && note.guardsPending.length > 0) {
    note.guardsPending = [];
    try { writeNote(home, note); } catch { /* as above */ }
  }
  return report;
}

/** The undo report's plain lines, in the forward report's words. */
export function runtimeMigrationUndoLines(report: RuntimeMigrationUndoReport): string[] {
  const lines: string[] = [];
  const verb = report.dryRun ? 'would move back' : 'moved back';
  for (const name of report.movedBack) lines.push(`runtime home: ${verb} ${name}`);
  for (const held of report.held) lines.push(`runtime home: ${held.name} stays for now — the loaded unit ${held.unit} still names it`);
  for (const refused of report.refused) lines.push(`runtime home: refused ${refused.name}: ${refused.why}`);
  for (const line of report.guardLines) lines.push(`in the team file that names the new guard folder, set: ${line}`);
  return lines;
}

/** The report's plain lines, shared by the install's plain and dry-run prints. */
export function runtimeMigrationLines(report: RuntimeMigrationReport): string[] {
  const lines: string[] = [];
  const verb = report.dryRun ? 'would move' : 'moved';
  for (const name of report.moved) lines.push(`runtime home: ${verb} ${name}`);
  for (const held of report.held) lines.push(`runtime home: ${held.name} stays for now — the loaded unit ${held.unit} still names it`);
  for (const name of report.later) lines.push(`runtime home: ${name} stays for its later lane`);
  for (const refused of report.refused) lines.push(`runtime home: refused ${refused.name}: ${refused.why}`);
  for (const line of report.guardLines) lines.push(`in the team file that names the old guard folder, set: ${line}`);
  if (!report.complete && report.guardLines.length > 0) {
    lines.push('runtime home: moved, not complete — the migration closes when team check shows the new guard path');
  }
  return lines;
}
