import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { heldAt } from '../launch/rules-file.ts';
import { parseHistoryLine, readHistory, readNoFollow, type HistoryEntry } from '../send/history.ts';
import { storePath } from '../store/store.ts';

export const USAGE = `Usage: team feed [--seat <name>] [--limit <n>] [--follow] [--json]

Reads the project's message history from the 0600 log in its state folder
(~/.config/team/<project>-<hash>/messages.jsonl), together with any brief files
(briefs/<from>-to-<to>.md) and Desk audit lines when present.

Options:
  --seat <name>   only messages sent by or to this seat
  --limit <n>     at most the last <n> entries (default 50)
  --follow        keep reading as new lines arrive, across log rotations
  --json          one JSON object per line ({ts, from, to, body, id, outcome})
`;

export const DEFAULT_FEED_LIMIT = 50;
export const MAX_FEED_LIMIT = 10_000;

export type FeedSources = {
  home: string;
  auditPath?: string;
  /**
   * Called between `--follow` polls. Returns `true` to perform another read pass,
   * or `false` to stop following and exit 0.
   */
  poll?: (tick: number) => Promise<boolean>;
};

function defaultPoll(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(true);
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

function readBriefEntries(root: string): HistoryEntry[] {
  const briefsDir = join(root, 'briefs');
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
    let ts = '';
    try {
      ts = lstatSync(path).mtime.toISOString();
    } catch {
      continue;
    }
    const body = text.trim();
    if (body === '') continue;
    out.push({ ts, from, to, body, id: `brief:${name}:${ts}`, outcome: 'brief' });
  }
  return out;
}

function parseAuditLine(raw: string, index: number): HistoryEntry | null {
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
  const body =
    typeof obj.body === 'string'
      ? obj.body
      : typeof obj.question === 'string'
        ? obj.question
        : typeof obj.summary === 'string'
          ? obj.summary
          : null;
  if (ts === null || body === null) return null;
  const from = typeof obj.from === 'string' ? obj.from : typeof obj.caller === 'string' ? obj.caller : 'bridge';
  const to = typeof obj.to === 'string' ? obj.to : typeof obj.seat === 'string' ? obj.seat : 'desk';
  const id =
    typeof obj.id === 'string'
      ? obj.id
      : typeof obj.request_id === 'string'
        ? obj.request_id
        : `audit:${String(index)}:${ts}`;
  const outcome =
    typeof obj.outcome === 'string' ? obj.outcome : typeof obj.event === 'string' ? obj.event : 'audit';
  return { ts, from, to, body, id, outcome };
}

function readAuditEntries(project: string, root: string, home: string, explicitPath?: string): HistoryEntry[] {
  const path = explicitPath ?? join(storePath(project, root, home), 'audit.jsonl');
  if (heldAt(path).kind !== 'file') return [];
  const text = readNoFollow(path);
  if (text === null) return [];
  const out: HistoryEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const entry = parseAuditLine(lines[i] ?? '', i);
    if (entry !== null) out.push(entry);
  }
  return out;
}

function collectEntries(
  project: string,
  root: string,
  sources: FeedSources,
  seatFilter: string | undefined,
): { ok: true; entries: HistoryEntry[] } | { ok: false; reason: string } {
  const read = readHistory(project, root, sources.home);
  if (!read.ok) return read;
  const briefs = readBriefEntries(root);
  const audits = readAuditEntries(project, root, sources.home, sources.auditPath);
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

function formatEntry(entry: HistoryEntry, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      ts: entry.ts,
      from: entry.from,
      to: entry.to,
      body: entry.body,
      id: entry.id,
      outcome: entry.outcome,
    })}\n`;
  }
  const lines = entry.body.split('\n');
  const first = lines[0] ?? '';
  const header = `${timeOf(entry.ts)}  ${entry.from} -> ${entry.to}  [${entry.outcome}]  ${first}\n`;
  if (lines.length === 1) return header;
  const rest = lines
    .slice(1)
    .map((line) => `          ${line}\n`)
    .join('');
  return `${header}${rest}`;
}

function usage(io: Io, message: string): number {
  io.stderr(`team feed: ${message}\n${USAGE}`);
  return 2; // exit: feed.usage
}

function configuration(io: Io, message: string): number {
  io.stderr(`team feed: ${message}\n`);
  return 2; // exit: feed.configuration
}

function unreadable(io: Io, reason: string): number {
  io.stderr(`team feed: the history log cannot be read: ${reason}\n`);
  return 1; // exit: feed.unreadable
}

export async function runFeed(argv: string[], io: Io, sources: FeedSources = realSources): Promise<number> {
  const args = readArgs(argv, ['seat', 'limit'], ['follow', 'json']);
  if (args.error) return usage(io, args.error);
  if (args.rest.length > 0) return usage(io, `unexpected "${args.rest[0] ?? ''}"`);

  const seatFilter = args.values.seat;
  if (seatFilter !== undefined && seatFilter.trim() === '') {
    return usage(io, '--seat requires a seat name');
  }

  let limit = DEFAULT_FEED_LIMIT;
  if (args.values.limit !== undefined) {
    const raw = args.values.limit;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (parsed < 1 || parsed > MAX_FEED_LIMIT) {
      return usage(io, `--limit takes a whole number, 1 to ${String(MAX_FEED_LIMIT)} (got "${raw}")`);
    }
    limit = parsed;
  }

  const json = args.flags.has('json');
  const follow = args.flags.has('follow');

  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message))
      .join('; ');
    return configuration(io, message || 'the team file cannot be read');
  }

  const initial = collectEntries(loaded.team.project, loaded.root, sources, seatFilter);
  if (!initial.ok) return unreadable(io, initial.reason);

  const seen = new Set<string>();
  const slice = initial.entries.slice(-limit);
  if (slice.length === 0 && ! json && !follow) {
    io.stdout('(no messages)\n');
  } else {
    for (const entry of slice) {
      io.stdout(formatEntry(entry, json));
    }
  }
  for (const entry of initial.entries) {
    seen.add(`${entry.id}\0${entry.outcome}\0${entry.ts}`);
  }

  if (follow) {
    const poll = sources.poll ?? (() => defaultPoll());
    let tick = 0;
    while (await poll(tick++)) {
      const next = collectEntries(loaded.team.project, loaded.root, sources, seatFilter);
      if (!next.ok) return unreadable(io, next.reason);
      for (const entry of next.entries) {
        const key = `${entry.id}\0${entry.outcome}\0${entry.ts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        io.stdout(formatEntry(entry, json));
      }
    }
  }

  return 0; // exit: feed.ok
}
