import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, mkdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { storePath, type Standing } from '../store/store.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { validateTeamFile } from '../file/validate.ts';
import { profileFor } from '../profiles/index.ts';
import { rulesOf, RULES_DIFFER_FROM, type RulesOrigin } from './rules.ts';

/** `O_NOFOLLOW` is POSIX, not plain JS: a platform without it gets 0, and the `lstat` checks
 *  above every open still refuse a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The one line a seat's rules travel in, once they are in a file: `Read <path> (sha256 <hash>):
 *  your standing rules for this session; reply ready and wait for your brief.` The read-back can
 *  prove a path only of these characters — anything else and nothing is typed, fail closed. */
const TYPEABLE = /^[A-Za-z0-9._/@+-]+$/;

/** Whether a path can be typed and read back provably: no whitespace, no character outside
 *  letters, digits and `. _ / @ + -`. A path that fails is never quoted or escaped. */
export function typeablePath(path: string): boolean {
  return TYPEABLE.test(path);
}

/** Whether a seat name can become a file name: it must pass the team file's own seat-name rule
 *  (the same expression the parser holds, not a second one — so a leading `.` , a `/`, a `..`,
 *  a space or any other character the file refuses is refused here too), and the file name it
 *  makes must stay within 255 bytes. */
export function typeableSeat(seat: string): boolean {
  return SEAT_NAME.test(seat) && Buffer.byteLength(`${seat}.md`) <= 255;
}

/** The file a seat's rules are written to: `<project state folder>/rules/<seat name>.md`, the
 *  folder the approval store already uses for this project, never inside a worktree, the lobby
 *  or the project. A seat name the team file's own rule refuses gets no path at all — null, so
 *  nothing downstream can normalise it somewhere else — and no component of the built path may
 *  be `..` or empty: the pieces (`join`'s own normalisation, the store's sanitised project
 *  name, the validated seat) already keep that closed, and the check is the belt under them,
 *  so no future caller can walk a built path out of the state folder. */
export function rulesFilePath(project: string, root: string, home: string, seat: string): string | null {
  if (!typeableSeat(seat)) return null;
  const path = join(storePath(project, root, home), 'rules', `${seat}.md`);
  const components = path.startsWith('/') ? path.split('/').slice(1) : path.split('/');
  return components.every((component) => component !== '' && component !== '..') ? path : null;
}

/** The project name every rules-file path is resolved from: the **approved copy's**. A project
 *  rename is not approval drift (the project is not an owner section), so `up` does not refuse
 *  it — and the line a seat is told to obey must name the file the checks look at: resolved
 *  from the live file's new name, the file would land where `status` and `doctor` never look.
 *  Null when no approval is in force or its stored copy can't be read: there is no folder to
 *  name then. */
export function approvedProjectOf(standing: Standing): string | null {
  if (standing.kind !== 'verified') return null;
  const copy = validateTeamFile(standing.record.file);
  return copy.ok ? copy.team.project : null;
}

/** The file a seat's rules are written to, checked and removed — resolved the one way
 *  everywhere, from the approval in force and a seat name: the approved copy's project state
 *  folder. Null when no approval is in force, its stored copy can't be read, or the seat name
 *  is refused: no caller resolves this folder on its own. */
export function rulesFilePathOf(standing: Standing, seat: string, root: string, home: string): string | null {
  const project = approvedProjectOf(standing);
  return project === null ? null : rulesFilePath(project, root, home, seat);
}

/** The line typed into the seat's pane: the file's absolute path and the first 12 hex digits of
 *  its SHA-256, so the seat — and the read-back — can tell exactly which text is meant. */
export function rulesLine(path: string, hash12: string): string {
  return `Read ${path} (sha256 ${hash12}): your standing rules for this session; reply ready and wait for your brief.`;
}

/** The tail a quiet start (`team up --no-launch`) types in place of the ordinary one: the seat,
 *  fresh or resumed, is told not to pick up earlier work or read drops on its own. */
export const QUIET_START_TAIL = 'TeamCLI restart: do not continue any earlier work and do not read drops; reply ready and wait until your lead or the owner sends you a task.';

/** The rules line for a quiet start: the same path and hash, with {@link QUIET_START_TAIL}. */
export function quietRulesLine(line: string): string {
  const ordinary = ' reply ready and wait for your brief.';
  return line.endsWith(ordinary) ? `${line.slice(0, -ordinary.length)} ${QUIET_START_TAIL}` : `${line} ${QUIET_START_TAIL}`;
}

/** The first 12 hex digits of a text's SHA-256. */
export function rulesFileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** What one path holds, read with `lstat` so a link is a link and never followed: `missing` when
 *  nothing is there, else the kind with its mode and owner. One reading shared by the writer, the
 *  checks and the before-Enter look — there is no second way to look at these files. */
export type Held =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'fifo' }
  | { kind: 'folder'; mode: number; uid: number }
  | { kind: 'file'; mode: number; uid: number }
  | { kind: 'other' };

/** What `path` holds right now, without following anything. */
export function heldAt(path: string): Held {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return { kind: 'missing' };
  }
  if (held.isSymbolicLink()) return { kind: 'link' };
  if (held.isFIFO()) return { kind: 'fifo' };
  if (held.isDirectory()) return { kind: 'folder', mode: held.mode & 0o777, uid: held.uid };
  if (held.isFile()) return { kind: 'file', mode: held.mode & 0o777, uid: held.uid };
  return { kind: 'other' };
}

/** Reads a file without following a link: the path must already have been seen as a regular file
 *  (`heldAt`), and the open itself carries `O_NOFOLLOW` so what is read is that same file. Null
 *  on any fault — the caller refuses, never guesses. */
function readHeld(path: string): string | null {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const parts: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const took = readSync(fd, buffer, 0, buffer.length, null);
      if (took === 0) break;
      parts.push(Buffer.from(buffer.subarray(0, took)));
    }
    return Buffer.concat(parts).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What a folder of the write's ladder must be: a real directory of this user's. `mode` is the
 *  exact mode required of the folders `team` itself makes (`rules/` and the project state
 *  folder); the state root only has to be a directory of this user's, whatever mode the user
 *  keeps it in. The finding is for the report, so the owner knows what is there. */
function folderFinding(held: Held, mode: number | null): string | null {
  if (held.kind === 'missing') return null; // made below, one level, explicit mode
  if (held.kind === 'link') return 'a symbolic link';
  if (held.kind !== 'folder') return 'not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  if (mode !== null && held.mode !== mode) return `mode 0${held.mode.toString(8)}, not 0${mode.toString(8)}`;
  return null;
}

/** What the final name must hold when it holds anything: a regular file, this user's, `0600`.
 *  Anything else — a link, a FIFO, a directory, a wider mode, another owner — is named for the
 *  report and never replaced. */
function placeFinding(held: Held): string | null {
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link';
  if (held.kind === 'fifo') return 'a FIFO';
  if (held.kind === 'folder') return 'a directory';
  if (held.kind === 'other') return 'not a regular file';
  if (held.mode !== 0o600) return `mode 0${held.mode.toString(8)}, not 0600`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's file";
  return null;
}

/** What writing the rules file came to. `folder` is a folder of the ladder from the per-user
 *  state root down to `rules/` being something other than a real directory of this user's at the
 *  required mode; `place` is the final name holding anything other than this user's `0600`
 *  regular file; `changed` is a write that landed but did not read back as the line's hash;
 *  `not-written` is every other fault. In each refusal nothing was typed. */
export type RulesFileWrite =
  | { ok: true }
  | { ok: false; why: 'not-written' }
  | { ok: false; why: 'changed' }
  | { ok: false; why: 'folder'; what: string }
  | { ok: false; why: 'place'; what: string };

/** Writes the seat's rules to its file: nothing is followed, nothing the writer did not make
 *  is replaced. The path is built here, from the live project when the caller names one, and
 *  otherwise from the approval in force — a caller hands back no path of its own, so no `..`
 *  or swapped folder can be fed to the write — and a seat that has no path (no project to
 *  name, a name the rule refuses) is `not-written`. Every folder from `team`'s per-user state
 *  root down to `rules/` is checked with `lstat` — a real directory of this user's, not a
 *  link, `rules/` and the project folder exactly `0700` (a looser folder is refused, never
 *  `chmod`'d) — and a missing level is made one level at a time with an explicit mode, never by
 *  a recursive create that could walk through a link. The final name, if it holds anything,
 *  must be this user's `0600` regular file or the write refuses and says what is there. The
 *  text lands through a temporary of an unpredictable name opened
 *  `O_CREAT | O_EXCL | O_NOFOLLOW` at mode `0600` — an open that fails writes nothing and
 *  leaves nothing, and the temporary is removed on every failure path — and after the rename
 *  the file is read back without following a link and its SHA-256 compared with `hash12`, the
 *  hash the line carries: a mismatch refuses, nothing typed. */
export function writeRulesFile(
  standing: Standing,
  seat: string,
  root: string,
  home: string,
  text: string,
  hash12: string,
  random: () => string = () => randomBytes(10).toString('hex'),
  /** The live project. The path is still built here. A delivery of the live file passes it,
   *  so the file, the typed line and the checks name one folder. Absent, the path is the
   *  approval in force. */
  liveProject?: string,
): RulesFileWrite {
  const built = liveProject !== undefined
    ? rulesFilePath(liveProject, root, home, seat)
    : rulesFilePathOf(standing, seat, root, home);
  if (built === null) return { ok: false, why: 'not-written' };
  const path = built;
  // The ladder, top down: team's per-user state root (`<home>/.config/team`), the project state
  // folder, `rules/`. The mode is required only of the two `team` itself makes.
  const ladder: Array<{ at: string; mode: number | null }> = [
    { at: dirname(dirname(dirname(path))), mode: null },
    { at: dirname(dirname(path)), mode: 0o700 },
    { at: dirname(path), mode: 0o700 },
  ];
  for (const level of ladder) {
    const held = heldAt(level.at);
    if (held.kind === 'missing') {
      try {
        mkdirSync(level.at, { mode: 0o700 });
      } catch {
        return { ok: false, why: 'not-written' };
      }
    } else {
      const finding = folderFinding(held, level.mode);
      if (finding !== null) return { ok: false, why: 'folder', what: finding };
    }
  }
  const place = placeFinding(heldAt(path));
  if (place !== null) return { ok: false, why: 'place', what: place };
  const temporary = join(dirname(path), `${basename(path)}.${random()}.tmp`);
  let fd;
  try {
    // Each flag refuses a link planted at the temporary's name, its own way. `open(2)`: with
    // `O_CREAT` and `O_EXCL` set the open fails whenever the path exists, a symbolic link
    // included, whatever its target; `O_NOFOLLOW` refuses a link on its own. Measured here
    // (bun's `node:fs`, macOS): `O_WRONLY | O_CREAT` opens through the link into its target,
    // adding either flag refuses it (`EEXIST`, `ELOOP`). The exclusive flag refuses first, so
    // the no-follow is unreachable while it is there — a second lock, not the only one. It
    // stays: it is the one that keeps the open from following a link if the exclusive flag is
    // ever dropped.
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch {
    // The name is taken — or worse, is a link: exclusive no-follow refused it, nothing was
    // written, and what is there is not ours to remove.
    return { ok: false, why: 'not-written' };
  }
  try {
    const buffer = Buffer.from(text, 'utf8');
    for (let wrote = 0; wrote < buffer.length;) {
      wrote += writeSync(fd, buffer, wrote, buffer.length - wrote);
    }
    renameSync(temporary, path);
    closeSync(fd);
  } catch {
    // The temporary's descriptor closes on the way out of every failure too: a delivery that
    // leaked one would leak one per run, every run.
    try {
      closeSync(fd);
    } catch {
      // It went with whatever failed: nothing more to close.
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already took it, or the folder went: nothing more to clean.
    }
    return { ok: false, why: 'not-written' };
  }
  // Read back what landed, without following a link, and prove it is the text the line names.
  const held = heldAt(path);
  if (held.kind !== 'file') return { ok: false, why: 'changed' };
  const read = readHeld(path);
  if (read === null || rulesFileHash(read) !== hash12) return { ok: false, why: 'changed' };
  return { ok: true };
}

/** Whether the file at `path` still holds the text whose SHA-256 starts `hash12` — read the same
 *  no-follow way the writer reads it back: `lstat` says regular file, the open carries
 *  `O_NOFOLLOW`. The last look before Enter. */
export function rulesFileHolds(path: string, hash12: string): boolean {
  const held = heldAt(path);
  if (held.kind !== 'file' || held.mode !== 0o600) return false;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return false;
  const read = readHeld(path);
  return read !== null && rulesFileHash(read) === hash12;
}

/** Removes a seat's rules file — a temporary seat's, with the seat. The path is built here,
 *  like the writer's, from the live project when the caller names one and otherwise from the
 *  approval in force, and the writer's own checked chain is walked again before the unlink:
 *  every folder from the state root down to `rules/` must still be a real directory of this
 *  user's at the mode the writer keeps, so a `rules/` swapped for a symbolic link after the
 *  write is refused, never unlinked through. The final name must be this user's `0600`
 *  regular file — only what the writer itself would have made is taken. A seat with no path,
 *  a level of the chain missing (nothing was ever written), a chain that is not the writer's,
 *  a file that is not there: each leaves everything alone, nothing to complain about. */
export function removeRulesFile(
  standing: Standing,
  seat: string,
  root: string,
  home: string,
  liveProject?: string,
): void {
  const path = liveProject !== undefined
    ? rulesFilePath(liveProject, root, home, seat)
    : rulesFilePathOf(standing, seat, root, home);
  if (path === null) return;
  const ladder: Array<{ at: string; mode: number | null }> = [
    { at: dirname(dirname(dirname(path))), mode: null },
    { at: dirname(dirname(path)), mode: 0o700 },
    { at: dirname(path), mode: 0o700 },
  ];
  for (const level of ladder) {
    const held = heldAt(level.at);
    if (held.kind === 'missing') return; // nothing was ever written here
    if (folderFinding(held, level.mode) !== null) return; // not the writer's chain: leave it
  }
  const held = heldAt(path);
  if (held.kind === 'missing') return;
  if (placeFinding(held) !== null) return; // only the writer's own file is ours to take
  try {
    unlinkSync(path);
  } catch {
    // Nothing to remove, or not ours to touch: the seat is gone either way.
  }
}

/** What `status` and `doctor` say of one seat's rules file, against the rules text the live file
 *  gives it. `what` is the finding without the seat's name; `ok` asks for nothing. A file that
 *  differs is never rewritten by a check. */
export type RulesFileCheck = { ok: true } | { ok: false; what: string };

/** Checks one seat's rules file with the writer's own reading of a path (`heldAt`, then the
 *  no-follow open): a regular file, mode `0600`, owned by this user, holding exactly the rules
 *  text the file gives that seat. */
export function checkRulesFile(path: string, wanted: string, origin: RulesOrigin = 'file'): RulesFileCheck {
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: false, what: 'its rules file is missing' };
  if (held.kind === 'link') return { ok: false, what: 'its rules file is a symbolic link' };
  if (held.kind !== 'file') return { ok: false, what: 'its rules file is not a regular file' };
  if (held.mode !== 0o600) {
    return { ok: false, what: `its rules file has mode 0${held.mode.toString(8)}, not 0600` };
  }
  if (process.getuid === undefined || held.uid !== process.getuid()) {
    return { ok: false, what: 'its rules file is not owned by this user' };
  }
  const text = readHeld(path);
  if (text === null) return { ok: false, what: 'its rules file cannot be read' };
  return text === wanted ? { ok: true } : { ok: false, what: `its rules file differs from ${RULES_DIFFER_FROM[origin]}` };
}

/** One message-rules seat's delivery: the file its rules are written to, the text that goes in
 *  it, and the one line typed in its pane. The text and the folder are the **live** file's.
 *  A stored copy is not what a seat is told to obey, whether or not an approval is in force.
 *  `standing` and `live` stay in the signature so a caller does not have to change; both are
 *  ignored. A path that can't be typed safely is a refusal — before anything is written or typed. */
export function rulesDeliveryOf(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  root: string,
  home: string,
  live = false,
  origin: RulesOrigin = 'file',
): { text: string; path: string; line: string } | { refusal: string } {
  void standing;
  void live;
  const mode = profileFor(seat.cli)?.rulesMode ?? 'message';
  if (mode === 'option') return { refusal: 'its rules travel as a launch option' };
  if (mode === 'prepend') return { refusal: 'its rules are prepended to each brief: there is no rules file' };
  const path = rulesFilePath(team.project, root, home, seat.name);
  if (path === null || !typeablePath(path)) {
    return { refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" };
  }
  const text = rulesOf(team, seat, root, undefined, origin);
  return { text, path, line: rulesLine(path, rulesFileHash(text)) };
}

/** A message seat's delivery in the plan: the file its rules go to and the line that points at
 *  it, or the refusal that stops the seat before anything is typed. An option seat has neither. */
export function seatDeliveryOf(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  root: string,
  home: string,
  live = false,
  origin: RulesOrigin = 'file',
): { rulesFile?: { path: string; line: string }; rulesRefusal?: string } {
  if ((profileFor(seat.cli)?.rulesMode ?? 'message') !== 'message') return {};
  const delivery = rulesDeliveryOf(standing, team, seat, root, home, live, origin);
  if ('refusal' in delivery) return { rulesRefusal: delivery.refusal };
  return { rulesFile: { path: delivery.path, line: delivery.line } };
}
