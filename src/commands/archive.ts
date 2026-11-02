// `team archive`: snapshot the team file, the state and the queues into an archive folder, then
// stop the team — the `down` path, with the flags this command shares with it. `--keep-running`
// takes the snapshot alone, and `--dry-run` prints both halves' plans and writes nothing.
//
// The archive is the record of a team as it was: `team.yaml` verbatim, `team.state.json` verbatim,
// the per-seat send queues under `drops/`, and a `manifest.json` naming all of it, with each
// file's sha256 — the one read `team init --from-archive` restores from. It holds what was
// actually there: a team that never launched has no state, and one no message ever reached has no
// drops. Links are never followed into the archive.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { LoadResult } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { gateVerdict } from '../permissions/who.ts';
import { ensureFoldersBelow } from '../send/history.ts';
import { manifestPath, moveFamily, parseDuration, scanArchiveSeat, scanLegacySeat, writeManifest, type MovedFile } from '../send/message-archive.ts';
import { STATE_FILE } from '../state.ts';
import { messageKeyState } from '../store/keys.ts';
import { storePath, storesFolder } from '../store/store.ts';
import { version } from '../version.ts';
import { realSources, runDown, type DownSources } from './down.ts';
import { raiseSecurityRefusal } from './reply.ts';

export const archive: Command = (argv, io) => runArchive(argv, io, realSources);
export default archive;

export const USAGE = `Usage: team archive [--out <folder>] [--keep-running] [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]
Usage: team archive --seat <seat> --older-than <dur> [--dry-run] [--file <path>]

Snapshots the team file, the state and the queues into an archive folder, then
stops the team. --keep-running takes the snapshot alone, and --dry-run prints
both halves' plans and writes nothing.

The scoped form moves one seat's acknowledged message families, and the
plain-text drops an earlier build wrote, out of the trees a bus pass re-reads:
only the owner or a seat this team marks \`leads\` runs it, only families older
than <dur> move, and the general brief, a client's record, a pending handoff,
an unread family and a fresh one always stay. Every file is moved, never
deleted, and a manifest records each one's sha256. It never stops the team and
writes nothing under --dry-run.
`;

/** The manifest beside the copies: what this archive is, and the one hash a restore verifies. */
export type ArchiveManifest = {
  format: 1;
  kind: 'teamcli-archive';
  project: string;
  session: string;
  root: string;
  stampedAt: string;
  by: string;
  teamcli: string;
  team: { sha256: string; bytes: number };
  state: { sha256: string; bytes: number } | null;
  drops: { files: number; seats: Record<string, number> } | null;
};

const DROPS = 'send-drops';
/** How deep a copied tree may go: `drops/<session>/<seat>/<id>` is three. */
const TREE_DEPTH = 4;

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `<project>-<root hash>` as the store folder spells it, plus a UTC stamp: one archive folder
 *  per run, never overwritten. */
export function archiveFolderName(project: string, root: string, home: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${storePath(project, root, home).split('/').pop() as string}-${stamp}`;
}

/** Every regular file under `dir`, as paths relative to it with "/" between segments, in a stable
 *  order. A link, a socket, a fifo or anything else that is not a directory or a regular file is
 *  skipped: the archive holds what team wrote, never what a link points at. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > TREE_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(rel === '' ? dir : join(dir, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel === '' ? name : `${rel}/${name}`;
      let stat;
      try {
        stat = lstatSync(join(dir, child));
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(child, depth + 1);
      else if (stat.isFile()) out.push(child);
    }
  };
  walk('', 1);
  return out;
}

/** `path` when it is a regular file worth copying, null otherwise — a state that is a link, a
 *  folder or unreadable is left out of the archive rather than followed or refused. */
function plainFile(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** A file copied with the private mode the originals carry, and its bytes handed back. */
function copyFile(from: string, to: string): Buffer {
  const data = readFileSync(from);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  writeFileSync(to, data, { mode: 0o600 });
  return data;
}

/**
 * Writes the archive and returns its folder and the lines naming what went in, or the refusal's
 * own words. `dry` plans those lines and writes nothing. The caller, the team file and the out
 * folder are checked by `runArchive`, the one place both entry points share.
 */
export function writeArchive(options: {
  file: string;
  root: string;
  project: string;
  session: string;
  home: string;
  out: string;
  caller: string;
  now: Date;
  dry: boolean;
}): { ok: true; dir: string; lines: string[] } | { ok: false; reason: string } {
  const { file, root, project, session, home, out, caller, now, dry } = options;
  const agents = dirname(file);
  const statePath = plainFile(join(agents, STATE_FILE));
  const dropsDir = join(agents, DROPS);
  const drops = existsSync(dropsDir) ? filesUnder(dropsDir) : [];

  const dir = join(out, archiveFolderName(project, root, home, now));
  if (existsSync(dir)) return { ok: false, reason: `${dir} exists already: an archive is never overwritten` };

  const lines = ['team.yaml'];
  if (statePath) lines.push(STATE_FILE);
  if (drops.length) lines.push(`${DROPS} (${drops.length} file${drops.length === 1 ? '' : 's'})`);
  if (dry) return { ok: true, dir, lines };

  mkdirSync(out, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const teamBytes = copyFile(file, join(dir, 'team.yaml'));
  const stateBytes = statePath === null ? null : copyFile(statePath, join(dir, STATE_FILE));
  const seats: Record<string, number> = {};
  for (const rel of drops) {
    const seat = rel.split('/').slice(0, -1).join('/');
    seats[seat] = (seats[seat] ?? 0) + 1;
    copyFile(join(dropsDir, rel), join(dir, DROPS, rel));
  }
  const manifest: ArchiveManifest = {
    format: 1,
    kind: 'teamcli-archive',
    project,
    session,
    root,
    stampedAt: now.toISOString(),
    by: caller,
    teamcli: version(),
    team: { sha256: sha256(teamBytes), bytes: teamBytes.byteLength },
    state: stateBytes === null ? null : { sha256: sha256(stateBytes), bytes: stateBytes.byteLength },
    drops: drops.length ? { files: drops.length, seats } : null,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, dir, lines };
}

/** What is wrong with a parsed manifest, or null when nothing is. */
function manifestProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'is not an object';
  const manifest = value as Record<string, unknown>;
  if (manifest.kind !== 'teamcli-archive') return `is not a teamcli archive: its kind is ${JSON.stringify(manifest.kind) ?? 'missing'}`;
  if (manifest.format !== 1) return `is format ${JSON.stringify(manifest.format)}, and this teamcli reads format 1`;
  const team = manifest.team as Record<string, unknown> | null | undefined;
  if (typeof team?.sha256 !== 'string') return 'names no team file';
  return null;
}

/**
 * The team file an archive holds, checked against its manifest before it is handed back: the
 * manifest is there, parses, is a teamcli archive this version reads, and the stored file's
 * sha256 — read from the bytes, so the copy cannot be re-encoded on the way — is the one the
 * manifest recorded. `folder` may be relative to `cwd`. `init --from-archive` is the one caller.
 */
export function readArchive(folder: string, cwd: string): { ok: true; text: string; manifest: ArchiveManifest } | { ok: false; reason: string } {
  const dir = isAbsolute(folder) ? folder : resolve(cwd, folder);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: `no archive at ${folder}: it holds no manifest.json` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // Fixed words: a parser's own message quotes the bytes it choked on, and this file is the reader's.
    return { ok: false, reason: `the manifest in ${folder} is not valid JSON` };
  }
  const problem = manifestProblem(parsed);
  if (problem !== null) return { ok: false, reason: `the manifest in ${folder} ${problem}` };
  const manifest = parsed as ArchiveManifest;
  const file = join(dir, 'team.yaml');
  if (!existsSync(file)) return { ok: false, reason: `the archive at ${folder} holds no team.yaml` };
  const bytes = readFileSync(file);
  const got = sha256(bytes);
  if (got !== manifest.team.sha256) {
    return { ok: false, reason: `team.yaml in ${folder} is not the file the manifest recorded: its sha256 is ${got}, the manifest's is ${manifest.team.sha256}` };
  }
  return { ok: true, text: bytes.toString('utf8'), manifest };
}

/** Whether argv asks for the scoped form, before the parser sees it: `--seat` and
 *  `--older-than`, in either spelling the parser accepts. */
function mentions(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

/** The invocation cannot be read, in either form. Exit 2, always. */
function invocation(io: Io, message: string): number {
  io.stderr(`team archive: ${message}\n${USAGE}`);
  return 2; // exit: archive.invocation
}

/** The scoped call's refusal: not the owner's or a lead's, or no key to judge the receipts. */
function scopedRefused(io: Io, message: string): number {
  io.stderr(`team archive: ${message}\n`);
  return 1; // exit: archive.scoped-refused
}

/** The scoped call's written outcome: every due family moved, or nothing was due. */
function scopedDone(io: Io, lines: readonly string[]): number {
  for (const line of lines) io.stdout(`${line}\n`);
  return 0; // exit: archive.scoped
}

/** The scoped call's failed outcome: at least one family was left in place, or the move was
 *  refused before it began. The failures are named on stderr; a summary travels to stdout. */
function scopedFailed(io: Io, lines: readonly string[], failures: readonly string[]): number {
  for (const failure of failures) io.stderr(`team archive: ${failure}\n`);
  for (const line of lines) io.stdout(`${line}\n`);
  return 1; // exit: archive.scoped-failed
}

/**
 * `home` and `now` come from the sources, as `down`'s do; tests and the docs runner hand in a
 * temporary home and a pinned clock, so the archive folder's name is theirs.
 */
export async function runArchive(argv: string[], io: Io, sources: DownSources = realSources): Promise<number> {
  // The two forms parse different flags; `--seat` or `--older-than` names the scoped one before
  // either parser sees the rest.
  const scoped = mentions(argv, 'seat') || mentions(argv, 'older-than');
  const args = scoped
    ? readArgs(argv, ['seat', 'older-than', 'file'], ['dry-run'])
    : readArgs(argv, ['out', 'session', 'file'], ['keep-running', 'dry-run', 'wait', 'abandon']);
  // The stop and the snapshot are the whole-team form's; a scoped call only moves messages. The
  // raw argv is read first, so the refusal names the flag rather than the parser's unknown option.
  if (scoped) {
    for (const name of ['out', 'keep-running', 'wait', 'abandon', 'session'] as const) {
      if (mentions(argv, name)) return invocation(io, `--${name} is the whole-team archive's; --seat takes the message move alone`);
    }
  }
  if (args.error || args.rest.length) return invocation(io, args.error ?? `unexpected "${args.rest[0]}"`);
  if (!scoped && args.flags.has('keep-running') && (args.flags.has('wait') || args.flags.has('abandon') || args.values.session !== undefined)) {
    io.stderr('team archive: --wait, --abandon and --session are the stop\'s; --keep-running takes the snapshot alone. Drop --keep-running to stop the team.\n');
    // exit: archive.stop-flags
    return 2;
  }
  // The approval store's home, and where an archive goes by default; the real command's is the
  // owner's home, and `down`'s own sources are what a test hands in.
  const home = sources.home ?? homedir();
  const walked = walkCaller(io);
  if (!scoped) {
    const detached = detachedRefusal(walked);
    if (detached !== undefined) {
      io.stderr(`team archive: ${detached}\n`);
      // exit: archive.detached
      return 1;
    }
  }
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    io.stderr(`team archive: ${fileRefusal}\n`);
    // exit: archive.file-owner
    return 1;
  }
  // The default folder is the user's own store; anywhere else the archive could be written into a
  // checkout, so `--out` is the owner's, like `--file` above.
  if (!scoped && args.values.out !== undefined && !isOwner(walked)) {
    io.stderr(`team archive: --out is the owner's, from a terminal outside herdr; this call is ${describeCaller(walked)}\n`);
    // exit: archive.out-owner
    return 1;
  }
  const loaded = readTeamConfig(io.cwd, { file: args.values.file, home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team archive: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: archive.not-a-repo
    // exit: archive.file
    // exit: archive.file-invalid
    return 2;
  }
  const team = loaded.team;
  const dry = args.flags.has('dry-run');
  if (scoped) return await runScopedArchive(io, args, loaded, home, sources, dry);
  const keepRunning = args.flags.has('keep-running');
  // A relative `--out` is the caller's own folder, as `--file` and `--from-archive` are: the
  // folder is written where the caller asked for it, never where this process happens to sit.
  const out = args.values.out === undefined ? join(storesFolder(home), 'archive') : resolve(io.cwd, args.values.out);
  const written = writeArchive({
    file: loaded.path,
    root: loaded.root,
    project: team.project,
    session: team.session,
    home,
    out,
    caller: describeCaller(walked),
    now: sources.now(),
    dry,
  });
  if (!written.ok) {
    io.stderr(`team archive: ${written.reason}\n`);
    // exit: archive.exists
    return 1;
  }
  io.stdout(`${dry ? 'would archive to' : 'archived'} ${written.dir}:\n`);
  for (const line of written.lines) io.stdout(`  ${line}\n`);
  const folder = written.dir.split('/').pop() as string;
  if (keepRunning) {
    io.stdout('--keep-running: the stop is skipped.\n');
    if (!dry) logLine(dirname(loaded.path), 'archive', describeCaller(walked), `${folder}: ${written.lines.join(', ')}; the stop was skipped`);
    // exit: archive.keep-running
    return 0;
  }
  if (dry) io.stdout('dry run: nothing was archived\nwould stop the team:\n');
  else logLine(dirname(loaded.path), 'archive', describeCaller(walked), `${folder}: ${written.lines.join(', ')}; stopping`);
  const downArgv: string[] = [];
  if (args.flags.has('wait')) downArgv.push('--wait');
  if (args.flags.has('abandon')) downArgv.push('--abandon');
  if (args.values.session !== undefined) downArgv.push('--session', args.values.session);
  if (args.values.file !== undefined) downArgv.push('--file', args.values.file);
  if (dry) downArgv.push('--dry-run');
  // The stop is `down` itself — its caller gates, refusals, waits and exit codes are unchanged,
  // and a refused stop leaves the snapshot behind.
  return await runDown(downArgv, io, sources);
}

/**
 * `team archive --seat <seat> --older-than <dur>`: the lead's move of one seat's backlog. The
 * admission is the map's `archive` row — the owner or a seat this team marks `leads` — asked of
 * the caller's own placement, so nothing here needs a daemon: every read is guarded for a file
 * that vanished and a rename is atomic, as the proven procedure's proof showed. Families move
 * whole, record first for the transport tree and receipt first for the legacy store; every file
 * is read without following a link, hashed and renamed, never unlinked; the manifest is written
 * only after something moved, and a dry run writes nothing at all. One family's failure is
 * reported and the run continues, ending 1.
 */
async function runScopedArchive(
  io: Io,
  args: Args,
  loaded: Extract<LoadResult, { ok: true }>,
  home: string,
  sources: DownSources,
  dry: boolean,
): Promise<number> {
  const { team, root, path } = loaded;
  const dir = dirname(path);
  const agents = dir;
  const session = team.session;
  const seat = args.values.seat;
  const window = args.values['older-than'];
  if (seat === undefined) return invocation(io, '--older-than needs --seat <seat>');
  if (window === undefined) return invocation(io, '--seat needs --older-than <dur>');
  if (!team.seats.some((member) => member.name === seat)) return invocation(io, `"${seat}" is not a seat of this team`);
  const olderThanMs = parseDuration(window);
  if (olderThanMs === null) return invocation(io, `"${window}" is not a duration; write 90m, 12h or 7d`);

  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'archive', at, sources.now);
  const judged = judgeCallerIn(io, dir, team, verdictOf);
  if (verdictOf(judged.caller, standingOf(dir, judged.session, judged.caller)).kind !== 'ok') {
    raiseSecurityRefusal(team, root, home, dir, judged.caller, 'admission', seat, sources.now());
    return scopedRefused(
      io,
      `only the owner or a seat this team marks \`leads\` moves another seat's messages; this call is ${describeCaller(judged.caller)}`,
    );
  }
  const keyState = messageKeyState(home);
  if (keyState.kind !== 'key') return scopedRefused(io, 'no message key; nothing was moved');

  const now = sources.now();
  const date = now.toISOString().slice(0, 10);
  const transport = scanArchiveSeat({ root, session, seat, key: keyState.key, olderThanMs, now });
  const legacy = scanLegacySeat({ root, session, seat, key: keyState.key, olderThanMs, now });
  const planned = [...transport.move, ...legacy.move];
  const stays = [...transport.stays, ...legacy.stays];
  const families = planned.length;
  const files = planned.reduce((total, family) => total + family.files.length, 0);
  const lines: string[] = [];
  const failures: string[] = [];
  const movedFiles: MovedFile[] = [];
  let movedFamilies = 0;
  if (families === 0) {
    lines.push(`seat ${seat}, older than ${window}: nothing to move`);
  } else if (dry) {
    const familyWord = families === 1 ? 'family' : 'families';
    const fileWord = files === 1 ? 'file' : 'files';
    lines.push(`seat ${seat}, older than ${window}: would move ${String(families)} ${familyWord} (${String(files)} ${fileWord}); nothing was written`);
  } else {
    // The manifest is the record of the move: its folder's new components are checked before the
    // first rename, so a link standing where it would be made refuses the run with every family
    // still in place, rather than moving files whose record would land outside the checkout.
    const folderProblem = ensureFoldersBelow(agents, [relative(agents, dirname(manifestPath(agents, now)))]);
    // Nothing moved, and the caller sees the same failed outcome a left-behind family gives.
    if (folderProblem !== null) return scopedFailed(io, [], [folderProblem]);
    for (const family of planned) {
      const moved = moveFamily(family, { root, agents, date, session });
      movedFiles.push(...moved.moved);
      if (moved.errors.length > 0) failures.push(...moved.errors);
      else movedFamilies += 1;
    }
    const familyWord = movedFamilies === 1 ? 'family' : 'families';
    const fileWord = movedFiles.length === 1 ? 'file' : 'files';
    const failed = failures.length > 0 ? `; ${String(failures.length)} failed` : '';
    lines.push(`seat ${seat}, older than ${window}: ${String(movedFamilies)} ${familyWord} moved (${String(movedFiles.length)} ${fileWord})${failed}`);
  }
  const counts = new Map<string, number>();
  for (const stayed of stays) counts.set(stayed.reason, (counts.get(stayed.reason) ?? 0) + 1);
  for (const [reason, count] of [...counts.entries()].sort()) lines.push(`stay ${reason}: ${String(count)}`);
  if (!dry && movedFiles.length > 0) {
    const manifest = manifestPath(agents, now);
    const header = `# team message archive ${now.toISOString()} seat=${seat} older-than=${window} root=${root}`;
    const problem = writeManifest(manifest, header, movedFiles, agents);
    if (problem !== null) failures.push(problem);
    else lines.push(`manifest: ${relative(root, manifest)}`);
  }
  if (failures.length > 0) return scopedFailed(io, lines, failures);
  return scopedDone(io, lines);
}
