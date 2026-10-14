// A seat that starts in the lobby is about to open a folder its CLI has never been
// asked to trust. `up` and `add` write the record that CLI already reads, under the
// seat's home, before the workspace is created. The approved launch line is left as
// it is. A dry run writes nothing. Antigravity's record was not captured, so that
// seat is left out with one repair line rather than a guessed file.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  if (!seat.lobby || seat.unidentifiedHold || seat.stopped || seat.launchProblem || seat.grantKeep || seat.waiting) {
    return false;
  }
  if (!profileFor(seat.cli)) return false;
  const fresh = seat.stage === undefined || !seat.pane || (seat.stage === 'launched' && !seat.agentLive);
  if (!fresh) return false;
  return seat.budget?.kind !== 'refuse';
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
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (tableValue(text, header, 'trusted') === 'true') return;
  const next = mergeTable(text, header, [
    { key: 'trusted', value: 'true' },
    { key: 'decided_at', value: String(Math.floor(now.getTime() / 1000)) },
  ]);
  if (next === null) return;
  writePrivate(file, next);
}

/** The cursor-agent build writes this marker, and treats the file's presence as trust. */
function writeCursor(lobby: string, home: string, now: Date): void {
  const file = join(home, '.cursor', 'projects', cursorSlug(lobby), '.workspace-trusted');
  if (existsSync(file)) return;
  const body = JSON.stringify(
    { trustedAt: now.toISOString(), workspacePath: lobby, trustMethod: 'cli-flag' },
    null,
    2,
  );
  writePrivate(file, body);
}

/** Claude Code reads `projects[<path>].hasTrustDialogAccepted` from `~/.claude.json`.
 *  A trust of the home directory is session-only, so that path is never written. */
function claudeUnmergeable(home: string): boolean {
  const file = join(home, '.claude.json');
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
  writePrivate(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** `codex exec` uses workspace-write once this table says the folder is trusted. */
function writeCodex(lobby: string, home: string): void {
  const header = `[projects.${tomlString(lobby)}]`;
  const file = join(home, '.codex', 'config.toml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (tableValue(text, header, 'trust_level') === '"trusted"') return;
  const next = mergeTable(text, header, [{ key: 'trust_level', value: '"trusted"' }]);
  if (next === null) return;
  writePrivate(file, next);
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

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
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
