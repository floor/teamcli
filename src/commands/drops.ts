// `team drops`: what is waiting in the calling seat's own drop folder.
//
// A drop is a message file another seat's `team send` wrote under
// `.agents/send-drops/<session>/<seat>/`, and the file is the message: nothing in this build
// deletes one. The receiving seat reads what is there with `team drops`, and a Claude Code
// Monitor reads each file as it lands with `team drops --follow`. A send of this version writes
// a signed record (`src/send/record.ts`) whose payload names the sender; a file a previous build
// wrote is still a drop, and its first line names the sender. A `<id>.read.json` receipt beside
// it — the sidecar the seat's inbox server writes when it hands the drop over, the same name the
// record spine gives a read receipt — means the drop was read, and it is not listed.
import { type KeyObject } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import { findRoot, loadTeamFile, NOT_A_REPO_NO_FILE } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
} from '../output/index.ts';
import { receiptPath } from '../mcp/inbox.ts';
import { signedRecordOf, verifyRecord } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

export const USAGE = `Usage: team drops [--follow] [--json]

Lists the drop files waiting in the calling seat's own drop folder,
.agents/send-drops/<session>/<seat>: one row each, with the sender the message
record names — or, in a file an earlier build wrote, its first line — and the
file's absolute path. A drop that has an <id>.read.json receipt beside it
is read, and is not listed.

Options:
  --follow   print one line per drop file that appears while it runs,
             \`from <sender> — <path>\`, each line as it lands; Ctrl-C stops it
             with exit 0. Drops already on disk when it starts are not printed.
  --json     one team.drops document ({format, project, session, seat, drops, counts});
             it and --follow can't be used together

Exits 0 when the folder is read, 1 when the caller is not a placed seat of this
team, the team file can't be read, or the drop folder can't be read, 2 when the
invocation can't be read or this folder is not a git repository.
`;

/** One waiting drop: its file name (the send's id), the sender the message record names (or, in
 *  a file an earlier build wrote, its first line), when the file landed, and its absolute path.
 *  `from` is null when there is no sender to read: the file is still a drop, and its sender is
 *  simply unknown. */
export type DropRow = {
  id: string;
  from: string | null;
  received: string;
  path: string;
};

export type DropsSources = {
  home: string;
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

export const realSources: DropsSources = { home: homedir(), poll: () => defaultPoll() };

export const drops: Command = (argv, io) => runDrops(argv, io, realSources);
export default drops;

const ADMITTED = ' — admitted by: ';

/**
 * The sender a drop's first line names, in the forms `team send` writes (`senderHeader`):
 * `the owner`, `the file's seat <seat> (no registry record yet)`, or
 * `<agent id> (<name>, <seat>@<team>)`, each followed by ` — admitted by: <rule>`. A line in no
 * known form is read as whatever stands between `from ` and the admission, and an empty one is
 * null.
 */
export function senderOf(header: string): string | null {
  if (!header.startsWith('from ')) return null;
  const cut = header.indexOf(ADMITTED);
  const lead = (cut === -1 ? header : header.slice(0, cut)).slice('from '.length).trim();
  if (lead === 'the owner') return 'the owner';
  const fileSeat = /^the file's seat (\S+) \(no registry record yet\)$/.exec(lead);
  if (fileSeat) return fileSeat[1] ?? null;
  const registered = /^\S+ \((.+), [^,()]+@[^()]+\)$/.exec(lead);
  if (registered) return registered[1] ?? null;
  return lead === '' ? null : lead;
}

/** Whether a receipt file is there. An unreadable path counts as missing: the drop is still
 *  waiting, and a listing does not fail over a receipt it cannot see. */
function receiptHeld(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The file's text as JSON, or undefined when it is not JSON at all (an older raw drop). */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type DropListing = { kind: 'ok'; rows: DropRow[] } | { kind: 'unreadable'; reason: string };

/**
 * The unread drops in one seat's folder, oldest first. A name with a dot in it is a sidecar
 * (`<id>.pending`, `<id>.taken`, `<id>.<hex>.tmp`, `<id>.read.json`), never a drop; a symlink or a
 * directory whose name is plain is not a drop either. A folder that does not exist is an empty
 * one: no send has written here yet.
 */
export function listDrops(dropDir: string, key?: KeyObject): DropListing {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'ok', rows: [] };
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const rows: DropRow[] = [];
  for (const name of names) {
    if (name.includes('.')) continue;
    const path = join(dropDir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // The receipt means the drop was handed over: it is read, and this reading is done with it.
    // Its name is the inbox's own rule (`<id>.read.json`), the one the server writes.
    if (receiptHeld(receiptPath(dropDir, name))) continue;
    let from: string | null = null;
    try {
      const text = readFileSync(path, 'utf8');
      const record = signedRecordOf(parsedJson(text));
      if (record !== null) {
        // The record names its sender in the payload. The key that verified it is the message
        // key; when the folder is read with no key at all, the payload is still what is shown —
        // a record that fails the key it was checked with leaves the sender unknown.
        from = key === undefined || verifyRecord(record, key) ? record.payload.from : null;
      } else {
        from = senderOf(text.split('\n', 1)[0] ?? '');
      }
    } catch {
      // The file is still a drop; its sender is unknown.
    }
    rows.push({ id: name, from, received: stat.mtime.toISOString(), path });
  }
  return {
    kind: 'ok',
    rows: rows.sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id)),
  };
}

/** `from <sender> — <path>`, the one line `--follow` prints per new drop. */
function followLine(row: DropRow): string {
  return `from ${row.from ?? 'unknown'} — ${row.path}\n`;
}

/** The refusal every caller that is not a placed seat of this team gets. */
function refuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'drops.refused', message, null);
  else io.stderr(`team drops: ${message}\n`);
  // exit: drops.refused
  return 1;
}

/**
 * Reads the caller's own drop folder: the caller must be a seat of this team on the pane the
 * state records for it, and the folder is the one its messages land in. `--json` prints the
 * listing as one document; `--follow` prints each file that appears while it runs, and never
 * the ones already there, so a Monitor starts quiet.
 */
export async function runDrops(argv: string[], io: Io, sources: DropsSources = realSources): Promise<number> {
  const args = readArgs(argv, [], ['follow', 'json']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const follow = args.flags.has('follow');
  if (args.error || args.rest.length || (follow && json)) {
    const problem = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0] ?? ''}"` : "--follow and --json can't be used together");
    if (json) {
      writeJsonError(io, 'drops.invocation', problem, null);
    } else {
      io.stderr(`team drops: ${problem}\n${USAGE}`);
    }
    // exit: drops.invocation
    return 2;
  }
  const root = findRoot(io.cwd);
  if (!root) {
    if (json) {
      writeJsonError(io, 'drops.not-a-repo', NOT_A_REPO_NO_FILE, null);
    } else {
      io.stderr(`team drops: ${NOT_A_REPO_NO_FILE}\n`);
    }
    // exit: drops.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? "the team file can't be read";
    if (json) {
      writeJsonError(io, 'drops.file', message, null);
    } else {
      io.stderr(`team drops: ${message}\n`);
    }
    // exit: drops.file
    return 1;
  }
  const dir = dirname(loaded.path);
  const session = loaded.team.session;
  const { caller, shown } = judgeCallerOf(io, session);
  const named = caller.kind === 'seat' && loaded.team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (named === null) {
    return refuse(io, json, `only a seat of this team reads its own drops; this call is ${describeCaller(shown)}`);
  }
  const verdict = callerVerdict(named, named.name, standingOf(dir, session, named));
  if (verdict.kind === 'no-pane') return refuse(io, json, noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse(io, json, anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse(io, json, `only a seat of this team reads its own drops; this call is ${describeCaller(shown)}`);
  }
  const seat = named.name;
  const dropDir = join(dir, 'send-drops', session, seat);
  const keyState = messageKeyState(sources.home);
  const key = keyState.kind === 'key' ? keyState.key : undefined;
  const first = listDrops(dropDir, key);
  let unreadable: string | null = first.kind === 'unreadable' ? first.reason : null;
  const rows = first.kind === 'ok' ? first.rows : [];
  if (follow) {
    const poll = sources.poll ?? (() => defaultPoll());
    // The drops already there are waiting, not new: a Monitor starts quiet and prints only what
    // lands while it runs.
    const seen = new Set(rows.map((row) => row.id));
    let tick = 0;
    while (await poll(tick++)) {
      const next = listDrops(dropDir, key);
      if (next.kind === 'unreadable') {
        unreadable = next.reason;
        break;
      }
      for (const row of next.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        io.stdout(followLine(row));
      }
    }
  }
  if (unreadable !== null) {
    const message = `the drop folder can't be read: ${unreadable}`;
    if (json) {
      writeJsonError(io, 'drops.unreadable', message, null);
    } else {
      io.stderr(`team drops: ${message}\n`);
    }
    // exit: drops.unreadable
    return 1;
  }
  if (!follow) {
    if (json) {
      writeJson(io, 'team.drops', {
        format: 1 as const,
        project: loaded.team.project,
        session,
        seat,
        drops: rows.map((row) => ({ from: row.from, received: row.received, path: row.path })),
        counts: { drops: rows.length },
      });
    } else {
      const lines = [
        contextLine(loaded.team.project, session),
        ...renderTable({
          headers: ['FROM', 'PATH'],
          rows: rows.map((row) => [row.from ?? 'unknown', row.path]),
          indent: '  ',
          style: ttyStyle(io),
        }),
        '',
        pluralCount(rows.length, 'drop'),
      ];
      io.stdout(`${lines.join('\n')}\n`);
    }
  }
  // exit: drops.ok
  return 0;
}
