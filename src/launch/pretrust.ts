// A seat that starts in the lobby is about to open a folder its CLI has never been
// asked to trust. `up` and `add` write the record that CLI already reads, under the
// seat's home, before the workspace is created. The approved launch line is left as
// it is. A dry run writes nothing. A config file or folder that is a link is left
// untouched, and the seat gets the repair line. Antigravity's record was not captured,
// so that seat still starts: a guessed file is not written, and a refusal could not be cleared.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { charterCoversFolder } from '../charter/check.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { profileFor } from '../profiles/index.ts';

/** The fields a launch seat needs for the lobby trust decision. */
export interface PretrustSeat {
  cli: string;
  cwd: string;
  lobby?: boolean;
  launchProblem?: string;
  unidentifiedHold?: string;
  stopped?: boolean;
  grantKeep?: string;
  waiting?: unknown;
  stage?: 'launched' | 'named' | 'ready';
  pane?: string;
  agentLive?: boolean;
  budget?: { kind: string };
}

/** The repair line for a seat whose lobby cannot be trusted, or null when this seat
 *  is not about to start in the lobby, or when its record was written. `write: false`
 *  is a dry run: a CLI with a known record is left for the real run, and a CLI
 *  without one still reports its line. */
export function lobbyPretrustLine(
  seat: PretrustSeat,
  home: string,
  opts: { write: boolean; now: Date },
): string | null {
  if (!launchesIntoLobby(seat)) return null;
  const writer = WRITERS[seat.cli];
  // A shipped CLI with no captured record still starts. Inventing its file would be a guess,
  // and leaving it out would make the repair unusable: the next run could not see the grant.
  if (!writer) return null;
  if (!opts.write) {
    // A dry run writes nothing. It still reports a Claude file that cannot be merged.
    if (seat.cli === 'claude-code' && claudeUnmergeable(home)) return repair(seat.cli, seat.cwd);
    return null;
  }
  let lobby = seat.cwd;
  try {
    lobby = realpathSync(seat.cwd);
    writer(lobby, home, opts.now);
    return null;
  } catch {
    return repair(seat.cli, lobby);
  }
}

/** The same seats `up` is about to launch into the lobby. A seat already refused, or
 *  one the plan will not launch, is left alone. */
function launchesIntoLobby(seat: PretrustSeat): boolean {
  return Boolean(seat.lobby) && startsFresh(seat);
}

/** A seat the plan is about to start, wherever it starts: not refused, held, stopped or
 *  already running, and with a profile. */
function startsFresh(seat: PretrustSeat): boolean {
  if (seat.unidentifiedHold || seat.stopped || seat.launchProblem || seat.grantKeep || seat.waiting) {
    return false;
  }
  if (!profileFor(seat.cli)) return false;
  const fresh = seat.stage === undefined || !seat.pane || (seat.stage === 'launched' && !seat.agentLive);
  if (!fresh) return false;
  return seat.budget?.kind !== 'refuse';
}

/** Writes the trust record of a launching seat that starts in the team's project root, in the
 *  record its CLI already reads (the file `--trust` or the CLI's own dialog writes), so no folder
 *  question waits in its pane and nothing is ever typed into it. Only the project root: a seat
 *  starting anywhere else, a lobby seat (`lobbyPretrustLine` owns that), a seat that does not
 *  start now, or a CLI with no captured record writes nothing. A record that cannot be written is
 *  not a refusal: the seat starts, and its dialog is handled the way it was before. True when the
 *  record is written or already held. */
export function projectRootPretrust(seat: PretrustSeat, home: string, opts: { now: Date; root: string }): boolean {
  if (seat.lobby || !isAbsolute(seat.cwd) || !startsFresh(seat)) return false;
  const writer = WRITERS[seat.cli];
  if (!writer) return false;
  try {
    const folder = realpathSync(seat.cwd);
    if (folder !== realpathSync(opts.root)) return false;
    writer(folder, home, opts.now);
    return true;
  } catch {
    return false;
  }
}

/** Writes the trust record of a launching seat's start folder when that folder sits under a
 *  verified charter root. The vendor's folder question is then already answered. A lobby seat,
 *  a seat that does not start now, a CLI with no captured record, or a folder outside the
 *  charter writes nothing. A record that cannot be written is not a refusal. */
export function charterFolderPretrust(
  seat: PretrustSeat,
  home: string,
  opts: { now: Date; store?: OwnerSeatKeyStore },
): boolean {
  if (seat.lobby || !isAbsolute(seat.cwd) || !startsFresh(seat)) return false;
  const writer = WRITERS[seat.cli];
  if (!writer) return false;
  try {
    const folder = realpathSync(seat.cwd);
    if (!charterCoversFolder(home, folder, opts.store)) return false;
    writer(folder, home, opts.now);
    return true;
  } catch {
    return false;
  }
}

/** What a create-grant run may trust beyond the lobby: the seat's own start folder (the
 *  project, for a lead). `covers` says the grant that admitted the run names the folder in its
 *  paths; `listed` says the team file's `trust:` does. Both must hold. */
export interface FolderGrant {
  covers(folder: string): boolean;
  listed(folder: string): boolean;
}

/** Writes the trust record of a launching seat's start folder, for a run a create-grant
 *  admitted. True when the folder was written or already recorded. Nothing is written for a
 *  lobby seat (`lobbyPretrustLine` owns that), a seat that does not start now, a CLI with no
 *  captured record, or a folder the grant or the file's `trust:` does not both name. A folder
 *  that cannot be written is not a refusal: the seat starts, and the CLI's own dialog is
 *  handled the way it was before. */
export function grantedFolderPretrust(
  seat: PretrustSeat,
  home: string,
  opts: { now: Date; grant: FolderGrant },
): boolean {
  if (seat.lobby || !isAbsolute(seat.cwd) || !startsFresh(seat)) return false;
  const writer = WRITERS[seat.cli];
  if (!writer) return false;
  try {
    const folder = realpathSync(seat.cwd);
    if (!opts.grant.covers(folder) || !opts.grant.listed(folder)) return false;
    writer(folder, home, opts.now);
    return true;
  } catch {
    return false;
  }
}

function repair(cli: string, lobby: string): string {
  switch (cli) {
    case 'grok':
      return `the lobby is not trusted for grok: run grok --trust in ${lobby}`;
    case 'cursor':
      return `the lobby is not trusted for cursor: run cursor-agent --trust in ${lobby}`;
    case 'claude-code':
      return `the lobby is not trusted for claude: run claude in ${lobby} and accept the folder`;
    case 'codex':
      return `the lobby is not trusted for codex: run codex in ${lobby} and accept the folder`;
    case 'antigravity':
      return `the lobby is not trusted for agy: run agy in ${lobby} and accept the folder`;
    default: {
      const binary = profileFor(cli)?.binary ?? cli;
      return `the lobby is not trusted for ${binary}: run ${binary} in ${lobby} and accept the folder`;
    }
  }
}

type Writer = (lobby: string, home: string, now: Date) => void;

const WRITERS: Readonly<Record<string, Writer>> = {
  grok: writeGrok,
  cursor: writeCursor,
  'claude-code': writeClaude,
  codex: writeCodex,
};

/** `grok --trust` writes this table. The command needs no terminal to do it. */
function writeGrok(lobby: string, home: string, now: Date): void {
  const header = `[folders.${tomlString(lobby)}]`;
  const file = join(home, '.grok', 'trusted_folders.toml');
  assertNoLink(file, home);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (tableValue(text, header, 'trusted') === 'true') return;
  const next = mergeTable(text, header, [
    { key: 'trusted', value: 'true' },
    { key: 'decided_at', value: String(Math.floor(now.getTime() / 1000)) },
  ]);
  if (next === null) return;
  writePrivate(file, next, home);
}

/** The cursor-agent build writes this marker, and treats the file's presence as trust. */
function writeCursor(lobby: string, home: string, now: Date): void {
  const file = join(home, '.cursor', 'projects', cursorSlug(lobby), '.workspace-trusted');
  assertNoLink(file, home);
  if (existsSync(file)) return;
  const body = JSON.stringify(
    { trustedAt: now.toISOString(), workspacePath: lobby, trustMethod: 'cli-flag' },
    null,
    2,
  );
  writePrivate(file, body, home);
}

/** Claude Code reads `projects[<path>].hasTrustDialogAccepted` from `~/.claude.json`.
 *  A trust of the home directory is session-only, so that path is never written. */
function claudeUnmergeable(home: string): boolean {
  const file = join(home, '.claude.json');
  try {
    assertNoLink(file, home);
  } catch {
    return true;
  }
  if (!existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!plain(parsed)) return true;
    return parsed.projects !== undefined && !plain(parsed.projects);
  } catch {
    return true;
  }
}

function writeClaude(lobby: string, home: string): void {
  if (realpathSync(home) === lobby) throw new Error('home trust is session-only');
  const file = join(home, '.claude.json');
  assertNoLink(file, home);
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!plain(parsed)) throw new Error('claude config is not an object');
    doc = parsed;
  }
  const projects = doc.projects;
  let table: Record<string, unknown>;
  if (projects === undefined) {
    table = {};
    doc.projects = table;
  } else if (!plain(projects)) {
    throw new Error('claude projects is not an object');
  } else {
    table = projects;
  }
  const current = table[lobby];
  let entry: Record<string, unknown>;
  if (current === undefined) {
    entry = {};
    table[lobby] = entry;
  } else if (!plain(current)) {
    throw new Error('claude project entry is not an object');
  } else {
    entry = current;
  }
  if (entry.hasTrustDialogAccepted === true) return;
  entry.hasTrustDialogAccepted = true;
  writePrivate(file, `${JSON.stringify(doc, null, 2)}\n`, home);
}

/** `codex exec` uses workspace-write once this table says the folder is trusted. */
function writeCodex(lobby: string, home: string): void {
  const header = `[projects.${tomlString(lobby)}]`;
  const file = join(home, '.codex', 'config.toml');
  assertNoLink(file, home);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (tableValue(text, header, 'trust_level') === '"trusted"') return;
  const next = mergeTable(text, header, [{ key: 'trust_level', value: '"trusted"' }]);
  if (next === null) return;
  writePrivate(file, next, home);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The slug cursor-agent uses for `~/.cursor/projects/<slug>`. */
function cursorSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function writePrivate(file: string, text: string, home: string): void {
  assertNoLink(file, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
}

/** The file and each folder under the home are opened as themselves. A link, including
 *  one whose target is absent, is not a path this run reads or writes. */
function assertNoLink(path: string, home: string): void {
  let current = path;
  while (current.startsWith(`${home}/`)) {
    let linked = false;
    try {
      linked = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (linked) throw new Error('a symbolic link');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

function tableValue(text: string, header: string, key: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === header);
  if (at < 0) return null;
  const pattern = new RegExp(`^${key}\\s*=\\s*(.*)$`);
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('[')) break;
    const match = pattern.exec(line.trim());
    if (match) return match[1] ?? '';
  }
  return null;
}

function mergeTable(
  text: string,
  header: string,
  fields: readonly { key: string; value: string }[],
): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === header);
  if (at < 0) {
    const body = [header, ...fields.map((field) => `${field.key} = ${field.value}`), ''].join('\n');
    if (text === '') return body;
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return base.endsWith('\n\n') ? base + body : `${base}\n${body}`;
  }
  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? '').trim().startsWith('[')) end++;
  const section = lines.slice(at + 1, end);
  let changed = false;
  for (const field of fields) {
    if (upsert(section, field.key, field.value)) changed = true;
  }
  if (!changed) return null;
  return [...lines.slice(0, at + 1), ...section, ...lines.slice(end)].join('\n');
}

function upsert(section: string[], key: string, value: string): boolean {
  const wanted = `${key} = ${value}`;
  const pattern = new RegExp(`^${key}\\s*=`);
  const at = section.findIndex((line) => pattern.test(line.trim()));
  if (at >= 0) {
    if (section[at]?.trim() === wanted) return false;
    section[at] = wanted;
    return true;
  }
  let insert = section.length;
  while (insert > 0 && (section[insert - 1] ?? '').trim() === '') insert--;
  section.splice(insert, 0, wanted);
  return true;
}
