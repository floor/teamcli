import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { heldAt } from '../launch/rules-file.ts';
import { lobbyDir } from '../lobby/gate.ts';
import { contextLine, hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import {
  parseHistoryLine,
  readAllHistories,
  readHistory,
  readNoFollow,
  type HistoryEntry,
} from '../send/history.ts';
import { storePath } from '../store/store.ts';

export const USAGE = `Usage: team feed [--seat <name>] [--limit <n>] [--all] [--audit <path>] [--briefs <dir>] [--follow] [--json]

Reads the project's message history from the 0600 log in its state folder
(~/.config/team/<project>-<hash>/messages.jsonl), together with any brief files
(briefs/<from>-to-<to>.md) and Desk audit lines when present. Each event is one
row: when it was written, its kind (the send outcome), who sent it to whom, and
its body folded to one line.

Options:
  --seat <name>    only messages sent by or to this seat
  --limit <n>      at most the last <n> entries (default 50)
  --all            read message history across all project state folders on this machine
  --audit <path>   include Desk or bridge audit JSONL lines from <path>
  --briefs <dir>   include <from>-to-<to>.md brief files from <dir>
  --follow         keep reading as new lines arrive, across log rotations
  --json           one team.feed document ({..., events: [{ts, from, to, body, id, outcome, spec?, resolved?, ms?, via?, failed?}]})

Exits 0 when the feed is printed, 1 when the history log can't be read, 2 when the invocation or team file can't be read.
`;

export const DEFAULT_FEED_LIMIT = 50;
export const MAX_FEED_LIMIT = 10_000;

export type FeedSources = {
  home: string;
  auditPath?: string;
  briefsDir?: string;
  /**
   * Called between `--follow` polls. Returns `true` to perform another read pass,
   * or `false` to stop following and exit 0.
   */
  poll?: (tick: number) => Promise<boolean>;
};

function defaultPoll(): Promise<boolean> {
  return new Promise((resolvePoll) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      clearTimeout(timer);
      resolvePoll(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolvePoll(true);
    }, 250);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const realSources: FeedSources = {
  home: homedir(),
  poll: () => defaultPoll(),
};

const feed: Command = (argv, io) => runFeed(argv, io, realSources);
export default feed;

const BRIEF_NAME = /^([A-Za-z0-9._-]+)-to-([A-Za-z0-9._-]+)\.md$/;
const SECTION_HEADING = /^##\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)\b(?:\s*(?:—|–|-+)\s*(.*))?$/;
const FROM_HEADER = /^From\s+([A-Za-z0-9._-]+)\s*[:.]\s*(.*)$/i;

function normalizeIsoTimestamp(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z?$/.test(raw)) {
    const base = raw.endsWith('Z') ? raw.slice(0, -1) : raw;
    return `${base}:00.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/.test(raw)) {
    const base = raw.endsWith('Z') ? raw.slice(0, -1) : raw;
    return `${base}.000Z`;
  }
  return raw;
}

function parseBriefFileSections(name: string, fileFrom: string, fileTo: string, text: string, fallbackMtimeIso: string): HistoryEntry[] {
  const lines = text.split('\n');
  const sections: Array<{ ts: string; headingRest: string; bodyLines: string[] }> = [];
  let current: { ts: string; headingRest: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const hit = SECTION_HEADING.exec(line.trim());
    if (hit) {
      if (current) sections.push(current);
      current = {
        ts: normalizeIsoTimestamp(hit[1] ?? ''),
        headingRest: (hit[2] ?? '').trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    const body = text.trim();
    if (body === '') return [];
    return [{ ts: fallbackMtimeIso, from: fileFrom, to: fileTo, body, id: `brief:${name}:${fallbackMtimeIso}`, outcome: 'brief' }];
  }

  const out: HistoryEntry[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    let from = fileFrom;
    let to = fileTo;
    let title = sec.headingRest;

    const headerHit = FROM_HEADER.exec(title);
    if (headerHit) {
      const sender = (headerHit[1] ?? '').toLowerCase();
      if (sender === fileTo.toLowerCase()) {
        from = fileTo;
        to = fileFrom;
      } else if (sender === fileFrom.toLowerCase()) {
        from = fileFrom;
        to = fileTo;
      }
      title = (headerHit[2] ?? '').trim();
    }

    const cleanedLines = [...sec.bodyLines];
    while (
      cleanedLines.length > 0 &&
      (cleanedLines[cleanedLines.length - 1]!.trim() === '' ||
        /^---+$/.test(cleanedLines[cleanedLines.length - 1]!.trim()))
    ) {
      cleanedLines.pop();
    }
    let bodyText = cleanedLines.join('\n').trim();
    if (!headerHit && bodyText.length > 0) {
      const firstLineHit = FROM_HEADER.exec(bodyText.split('\n')[0] ?? '');
      if (firstLineHit) {
        const sender = (firstLineHit[1] ?? '').toLowerCase();
        if (sender === fileTo.toLowerCase()) {
          from = fileTo;
          to = fileFrom;
        } else if (sender === fileFrom.toLowerCase()) {
          from = fileFrom;
          to = fileTo;
        }
      }
    }

    const combined =
      title && bodyText
        ? bodyText.includes('\n')
          ? `${title}\n${bodyText}`
          : `${title}: ${bodyText}`
        : title || bodyText;
    if (combined === '') continue;
    out.push({
      ts: sec.ts,
      from,
      to,
      body: combined,
      id: `brief:${name}:${String(i)}:${sec.ts}`,
      outcome: 'brief',
    });
  }
  return out;
}

function readBriefsFromDir(briefsDir: string): HistoryEntry[] {
  if (heldAt(briefsDir).kind !== 'folder') return [];
  let names: string[];
  try {
    names = readdirSync(briefsDir).sort();
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const name of names) {
    const match = BRIEF_NAME.exec(name);
    if (!match) continue;
    const from = match[1] ?? '';
    const to = match[2] ?? '';
    const path = join(briefsDir, name);
    if (heldAt(path).kind !== 'file') continue;
    const text = readNoFollow(path);
    if (text === null) continue;
    let mtimeIso = '';
    try {
      mtimeIso = lstatSync(path).mtime.toISOString();
    } catch {
      continue;
    }
    for (const entry of parseBriefFileSections(name, from, to, text, mtimeIso)) {
      out.push(entry);
    }
  }
  return out;
}

function readBriefEntries(roots: string[]): HistoryEntry[] {
  const seenDirs = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const dir of roots) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const entry of readBriefsFromDir(dir)) {
      out.push(entry);
    }
  }
  return out;
}

export function parseAuditLine(raw: string, index: number, defaultTo = 'desk', sourceTag = 'audit'): HistoryEntry | null {
  const direct = parseHistoryLine(raw);
  if (direct !== null) return direct;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const ts = typeof obj.ts === 'string' ? obj.ts : typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (ts === null) return null;

  const event = typeof obj.event === 'string' ? obj.event : null;
  const reqId = typeof obj.request_id === 'string' ? obj.request_id : null;
  const reason = typeof obj.reason === 'string' ? obj.reason : typeof obj.detail === 'string' ? obj.detail : null;

  const explicitBody =
    typeof obj.body === 'string'
      ? obj.body
      : typeof obj.question === 'string'
        ? obj.question
        : typeof obj.summary === 'string'
          ? obj.summary
          : typeof obj.answer === 'string'
            ? obj.answer
            : typeof obj.reply === 'string'
              ? obj.reply
              : null;

  let body = explicitBody;
  if (body === null && event !== null) {
    if (reqId && reason) body = `${event} (${reqId}: ${reason})`;
    else if (reqId) body = `${event} (${reqId})`;
    else if (reason) body = `${event}: ${reason}`;
    else body = event;
  }
  if (body === null) return null;

  const from =
    typeof obj.from === 'string'
      ? obj.from
      : typeof obj.caller === 'string'
        ? obj.caller
        : typeof obj.caller_id === 'string'
          ? obj.caller_id
          : 'desk';
  const to =
    typeof obj.to === 'string'
      ? obj.to
      : typeof obj.seat === 'string'
        ? obj.seat
        : typeof obj.target_alias === 'string'
          ? obj.target_alias
          : typeof obj.seat_alias === 'string'
            ? obj.seat_alias
            : defaultTo;
  const explicitId = typeof obj.id === 'string' ? obj.id : reqId;
  const id =
    explicitId !== null && explicitBody !== null
      ? explicitId
      : reqId !== null
        ? `${sourceTag}:${reqId}:${event ?? 'audit'}:${ts}`
        : `${sourceTag}:${String(index)}:${ts}`;
  const outcome =
    typeof obj.outcome === 'string' ? obj.outcome : event !== null ? event : 'audit';
  return { ts, from, to, body, id, outcome };
}

function readSingleAuditFile(path: string, defaultTo: string, sourceTag: string): HistoryEntry[] {
  if (heldAt(path).kind !== 'file') return [];
  const text = readNoFollow(path);
  if (text === null) return [];
  const out: HistoryEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const entry = parseAuditLine(lines[i] ?? '', i, defaultTo, sourceTag);
    if (entry !== null) out.push(entry);
  }
  return out;
}

function readGuardAnswers(answerDir: string, seatAlias: string): HistoryEntry[] {
  if (heldAt(answerDir).kind !== 'folder') return [];
  let names: string[];
  try {
    names = readdirSync(answerDir).sort();
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = join(answerDir, name);
    if (heldAt(full).kind !== 'file') continue;
    const text = readNoFollow(full);
    if (text === null) continue;
    let mtimeIso = '';
    try {
      mtimeIso = lstatSync(full).mtime.toISOString();
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const body =
          typeof obj.answer === 'string'
            ? obj.answer
            : typeof obj.reply === 'string'
              ? obj.reply
              : typeof obj.summary === 'string'
                ? obj.summary
                : typeof obj.body === 'string'
                  ? obj.body
                  : null;
        if (!body) continue;
        const reqId = typeof obj.request_id === 'string' ? obj.request_id : name.slice(0, -5);
        const to =
          typeof obj.caller === 'string'
            ? obj.caller
            : typeof obj.to === 'string'
              ? obj.to
              : 'desk';
        const ts =
          typeof obj.ts === 'string'
            ? obj.ts
            : typeof obj.created_at === 'string'
              ? obj.created_at
              : mtimeIso;
        out.push({
          ts,
          from: seatAlias,
          to,
          body,
          id: `answer:${seatAlias}:${reqId}`,
          outcome: 'answered',
        });
      } catch {}
    }
  }
  return out;
}

function discoverLobbyAuditEntries(home: string, seenPaths: Set<string>): HistoryEntry[] {
  const lobby = lobbyDir(home);
  if (heldAt(lobby).kind !== 'folder') return [];
  let subdirs: string[];
  try {
    subdirs = readdirSync(lobby).sort();
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const sub of subdirs) {
    const dir = join(lobby, sub);
    if (heldAt(dir).kind !== 'folder') continue;
    let defaultTo = sub;
    let auditCandidate = join(dir, 'audit.jsonl');

    const guardPath = join(dir, 'guard.json');
    if (heldAt(guardPath).kind === 'file') {
      const guardText = readNoFollow(guardPath);
      if (guardText !== null) {
        try {
          const parsed = JSON.parse(guardText) as { target_alias?: unknown; audit_file?: unknown };
          if (typeof parsed.target_alias === 'string' && parsed.target_alias.trim() !== '') {
            defaultTo = parsed.target_alias;
          }
          if (typeof parsed.audit_file === 'string' && isAbsolute(parsed.audit_file)) {
            auditCandidate = parsed.audit_file;
          }
        } catch {}
      }
    }

    const bridgePath = join(dir, 'bridge.json');
    if (heldAt(bridgePath).kind === 'file') {
      const bridgeText = readNoFollow(bridgePath);
      if (bridgeText !== null) {
        try {
          const parsed = JSON.parse(bridgeText) as { audit_file?: unknown };
          if (typeof parsed.audit_file === 'string' && isAbsolute(parsed.audit_file)) {
            auditCandidate = parsed.audit_file;
          }
        } catch {}
      }
    }

    if (!seenPaths.has(auditCandidate)) {
      seenPaths.add(auditCandidate);
      for (const entry of readSingleAuditFile(auditCandidate, defaultTo, sub)) {
        out.push(entry);
      }
    }

    const replyCfgPath = join(dir, 'seat-reply-config.json');
    let answerDir = join(dir, 'answers');
    let seatAlias = defaultTo;
    if (heldAt(replyCfgPath).kind === 'file') {
      const replyText = readNoFollow(replyCfgPath);
      if (replyText !== null) {
        try {
          const parsed = JSON.parse(replyText) as { seat_alias?: unknown; answer_dir?: unknown };
          if (typeof parsed.seat_alias === 'string' && parsed.seat_alias.trim() !== '') {
            seatAlias = parsed.seat_alias;
          }
          if (typeof parsed.answer_dir === 'string' && isAbsolute(parsed.answer_dir)) {
            answerDir = parsed.answer_dir;
          }
        } catch {}
      }
    }
    if (!seenPaths.has(answerDir)) {
      seenPaths.add(answerDir);
      for (const entry of readGuardAnswers(answerDir, seatAlias)) {
        out.push(entry);
      }
    }
  }
  return out;
}

function readAuditEntries(
  project: string | null,
  root: string | null,
  home: string,
  explicitPath?: string,
): HistoryEntry[] {
  const seenPaths = new Set<string>();
  const out: HistoryEntry[] = [];

  if (explicitPath) {
    seenPaths.add(explicitPath);
    for (const line of readSingleAuditFile(explicitPath, 'desk', 'audit')) {
      out.push(line);
    }
  }
  if (project !== null && root !== null) {
    const storeAudit = join(storePath(project, root, home), 'audit.jsonl');
    if (!seenPaths.has(storeAudit)) {
      seenPaths.add(storeAudit);
      for (const line of readSingleAuditFile(storeAudit, 'desk', project)) {
        out.push(line);
      }
    }
  }
  for (const line of discoverLobbyAuditEntries(home, seenPaths)) {
    out.push(line);
  }
  return out;
}

function collectEntries(
  project: string | null,
  root: string | null,
  allTeams: boolean,
  sources: FeedSources,
  seatFilter: string | undefined,
  explicitAudit: string | undefined,
  explicitBriefs: string | undefined,
): { ok: true; entries: HistoryEntry[] } | { ok: false; reason: string } {
  const read =
    allTeams || project === null || root === null
      ? readAllHistories(sources.home)
      : readHistory(project, root, sources.home);
  if (!read.ok) return read;

  const briefDirs: string[] = [];
  if (root !== null) briefDirs.push(join(root, 'briefs'));
  if (sources.briefsDir) briefDirs.push(sources.briefsDir);
  if (explicitBriefs) briefDirs.push(explicitBriefs);

  const briefs = readBriefEntries(briefDirs);
  const audits = readAuditEntries(project, root, sources.home, explicitAudit ?? sources.auditPath);
  let all: HistoryEntry[];
  if (briefs.length === 0 && audits.length === 0) {
    all = read.entries;
  } else {
    all = [...read.entries, ...briefs, ...audits].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
  if (seatFilter !== undefined) {
    all = all.filter((entry) => entry.from === seatFilter || entry.to === seatFilter);
  }
  return { ok: true, entries: all };
}

function timeOf(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts)) {
    return ts.slice(11, 19);
  }
  return ts;
}

/** The KIND cell: the entry's outcome, with the path and the milliseconds when the send
 *  recorded them — absent on a line written without them, as the old line was. */
function kindOf(entry: HistoryEntry): string {
  const meta = [
    entry.via !== undefined ? `via ${entry.via}` : null,
    entry.ms !== undefined ? `in ${String(Math.round(entry.ms))} ms` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
  return meta === '' ? entry.outcome : `${entry.outcome} (${meta})`;
}

function eventJson(entry: HistoryEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    ts: entry.ts,
    from: entry.from,
    to: entry.to,
    body: entry.body,
    id: entry.id,
    outcome: entry.outcome,
  };
  // Present only when the send recorded them, so older readers see the same object.
  if (entry.spec !== undefined) obj.spec = entry.spec;
  if (entry.resolved !== undefined) obj.resolved = entry.resolved;
  if (entry.ms !== undefined) obj.ms = entry.ms;
  if (entry.via !== undefined) obj.via = entry.via;
  if (entry.failed !== undefined) obj.failed = entry.failed;
  return obj;
}

/** The context line opens a run once; null when the run is not team-scoped (`--all` or
 *  outside a checkout), and a follow that starts empty prints nothing until its first event. */
type Scope = { context: string | null; printed: boolean };

function printContext(io: Io, scope: Scope): void {
  if (scope.printed || scope.context === null) return;
  io.stdout(`${scope.context}\n`);
  scope.printed = true;
}

/** One batch of events: the context line when it has not opened the run yet, the four-column
 *  table, and the batch's count. `--follow` prints one batch per pass that brought new events. */
function printBatch(io: Io, scope: Scope, entries: readonly HistoryEntry[]): void {
  printContext(io, scope);
  const lines = renderTable({
    headers: ['TIME', 'KIND', 'SEAT', 'DETAIL'],
    rows: entries.map((entry) => [timeOf(entry.ts), kindOf(entry), `${entry.from} -> ${entry.to}`, entry.body]),
    indent: scope.context === null ? '' : '  ',
    style: ttyStyle(io, { json: false }),
  });
  io.stdout(`${lines.join('\n')}\n${entries.length} event(s)\n`);
}

function keyOf(entry: HistoryEntry): string {
  return `${entry.id}\0${entry.outcome}\0${entry.ts}`;
}

function usage(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'feed.usage', message, null);
  else io.stderr(`team feed: ${message}\n${USAGE}`);
  return 2; // exit: feed.usage
}

function configuration(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'feed.configuration', message, null);
  else io.stderr(`team feed: ${message}\n`);
  return 2; // exit: feed.configuration
}

function unreadable(io: Io, reason: string, json: boolean): number {
  const message = `the history log cannot be read: ${reason}`;
  if (json) writeJsonError(io, 'feed.unreadable', message, null);
  else io.stderr(`team feed: ${message}\n`);
  return 1; // exit: feed.unreadable
}

export async function runFeed(argv: string[], io: Io, sources: FeedSources = realSources): Promise<number> {
  const args = readArgs(argv, ['seat', 'limit', 'audit', 'briefs'], ['all', 'follow', 'json']);
  // The raw argv, not the parser's flags: an unknown option before `--json`, or `--json=<value>`,
  // must still route the refusal through the `team.feed` error document on stdout.
  const json = hasJsonFlag(argv);
  const follow = args.flags.has('follow');
  // A follow is a stream of tables, not one document: `--json` prints one object per run. The
  // refusal for asking for both is still the `--json` error document — the flag decides the
  // output, never whether an envelope exists.
  if (args.error || args.rest.length || (follow && json)) {
    const why = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0] ?? ''}"` : "--follow and --json can't be used together");
    return usage(io, why, json);
  }

  const seatFilter = args.values.seat;
  if (seatFilter !== undefined && seatFilter.trim() === '') {
    return usage(io, '--seat requires a seat name', json);
  }

  const auditFlag = args.values.audit;
  if (auditFlag !== undefined && auditFlag.trim() === '') {
    return usage(io, '--audit requires a file path', json);
  }
  const briefsFlag = args.values.briefs;
  if (briefsFlag !== undefined && briefsFlag.trim() === '') {
    return usage(io, '--briefs requires a directory path', json);
  }

  let limit = DEFAULT_FEED_LIMIT;
  if (args.values.limit !== undefined) {
    const raw = args.values.limit;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (parsed < 1 || parsed > MAX_FEED_LIMIT) {
      return usage(io, `--limit takes a whole number, 1 to ${String(MAX_FEED_LIMIT)} (got "${raw}")`, json);
    }
    limit = parsed;
  }

  const allTeams = args.flags.has('all');

  const explicitAudit = auditFlag !== undefined ? resolve(io.cwd, auditFlag) : undefined;
  const explicitBriefs = briefsFlag !== undefined ? resolve(io.cwd, briefsFlag) : undefined;

  let project: string | null = null;
  let session: string | null = null;
  let root: string | null = null;
  const lobbyRoot = lobbyDir(sources.home);
  const lobbiesRoot = join(sources.home, '.config', 'team', 'lobbies');
  const inDeskLobby =
    io.cwd === lobbyRoot ||
    io.cwd.startsWith(`${lobbyRoot}/`) ||
    io.cwd === lobbiesRoot ||
    io.cwd.startsWith(`${lobbiesRoot}/`);
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (loaded.ok) {
    project = loaded.team.project;
    session = loaded.team.session;
    root = loaded.root;
  } else if (!allTeams && !inDeskLobby) {
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message))
      .join('; ');
    return configuration(io, message || 'the team file cannot be read', json);
  }

  const initial = collectEntries(project, root, allTeams, sources, seatFilter, explicitAudit, explicitBriefs);
  if (!initial.ok) return unreadable(io, initial.reason, json);

  const seen = new Set<string>();
  const slice = initial.entries.slice(-limit);
  const scope: Scope = {
    context: project !== null && session !== null ? contextLine(project, session) : null,
    printed: false,
  };
  if (json) {
    writeJson(io, 'team.feed', {
      format: 1 as const,
      project,
      session,
      events: slice.map(eventJson),
    });
  } else if (slice.length > 0) {
    printBatch(io, scope, slice);
  } else if (!follow) {
    // An empty feed is still one answer: the context line and a zero count, never a bare table.
    printContext(io, scope);
    io.stdout('0 event(s)\n');
  }
  for (const entry of initial.entries) seen.add(keyOf(entry));

  if (follow) {
    const poll = sources.poll ?? (() => defaultPoll());
    let tick = 0;
    while (await poll(tick++)) {
      const next = collectEntries(project, root, allTeams, sources, seatFilter, explicitAudit, explicitBriefs);
      if (!next.ok) return unreadable(io, next.reason, json);
      const fresh: HistoryEntry[] = [];
      for (const entry of next.entries) {
        const key = keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(entry);
      }
      if (fresh.length > 0) printBatch(io, scope, fresh);
    }
  }

  return 0; // exit: feed.ok
}
