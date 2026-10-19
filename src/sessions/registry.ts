// The session registry: one append-only record per CLI session a seat ran, written by TeamCLI
// itself at up, restart, swap and down, never from the agent's word.
//
// A session is a CLI process launched for a seat: it starts when the launch command runs and
// ends when the seat is stopped, restarted or replaced. The record lives in the project's state
// folder beside `messages.jsonl` (`<home>/.config/team/<project>-<hash>/sessions.jsonl`), one
// JSON event per line. Two events make one record:
//
//   {"event":"start","id":"ses_…","ts":"…","team":"…","seat":"…",…}
//   {"event":"end","id":"ses_…","ts":"…","reason":"restart",…}
//
// Folding the lines in file order gives the record: the start's fields, then the end's. A start
// whose seat already had a session open closes that one as `crash` in the same step — a launch
// that finds a record open is the proof its process is gone — unless it is the same launch
// reported twice (same pane, same CLI session id), which is no new session.
//
// The file is append-only: `appendStoreLine` is called with `rotate: false`, so no line is ever
// dropped or rewritten. A missing entry (a token count, a cost, a link, a CLI retention) is
// absent, never zero: "unknown" is a reading the command prints, not a value the registry writes.
import { randomBytes } from 'node:crypto';
import type { Seat, TeamFile } from '../file/types.ts';
import { supportsSessionResume } from '../profiles/profile.ts';
import { appendStoreLine, listStoreDirs, readStoreLines } from '../send/history.ts';
import { withLock } from '../state.ts';
import { storePath } from '../store/store.ts';

/** The file inside `<project state folder>/` that holds the registry. */
export const SESSIONS_FILE = 'sessions.jsonl';

/** The stream's name in a refusal. */
const LABEL = 'session registry';

/** How a session ended: the words the design note fixes. `quota` has no writer yet — no command
 *  stops a seat for quota in this version — and stays in the vocabulary for the one that will. */
export type SessionEndReason = 'swap' | 'restart' | 'crash' | 'owner-stop' | 'quota';

/** A count is measured by the CLI or estimated by TeamCLI; the marker is never omitted. */
export type TokenReading = {
  in?: number;
  out?: number;
  cached?: number;
  source: 'measured' | 'estimated';
};

/** A currency amount, in the same two readings. */
export type CostReading = {
  amount: number;
  currency: string;
  source: 'measured' | 'estimated';
};

/** What a session produced. A list is absent when the session produced none that TeamCLI saw;
 *  nothing reads a repository to guess. */
export type SessionLinks = {
  commits?: string[];
  prs?: string[];
  releases?: string[];
};

/** The start of one session. Every optional field is absent when the launch could not know it. */
export type SessionStartEvent = {
  event: 'start';
  ts: string;
  id: string;
  /** The team file's `entity:`, when it names one. */
  entity?: string;
  /** The project the team sits in (`in project:`), or the team's own name when it sits in none. */
  project: string;
  /** The team's own name (`project:` in the team file). */
  team: string;
  seat: string;
  nickname?: string;
  cli: string;
  /** The lab: the vendor the CLI belongs to. */
  lab: string;
  model?: string;
  version?: string;
  effort?: string;
  /** The account the seat spends: its own `account:`, else the vendor, which is the account. */
  account: string;
  /** The herdr session the seat was launched in. */
  herdr_session: string;
  pane?: string;
  workspace?: string;
  /** The CLI's own session id: the one TeamCLI set at launch where the CLI takes one, else the
   *  one herdr reported for the pane. Absent when neither was known. */
  cli_session?: string;
  /** Whether the CLI keeps the session to resume it. Absent when not known. */
  resumable?: boolean;
  /** The CLI's retention end, when known. Absent otherwise — never a guessed date. */
  resume_until?: string;
  /** The handover file the next session reads first, when one was written. */
  handover?: string;
  /** The session this seat ran before, in this team and herdr session. */
  previous?: string;
};

/** The end of one session, appended once. */
export type SessionEndEvent = {
  event: 'end';
  ts: string;
  id: string;
  reason: SessionEndReason;
  /** Why, in one line, when the reason alone does not say it (a crash found by a launch). */
  note?: string;
  cli_session?: string;
  resumable?: boolean;
  resume_until?: string;
  handover?: string;
  tokens?: TokenReading;
  cost?: CostReading;
  links?: SessionLinks;
};

export type SessionEvent = SessionStartEvent | SessionEndEvent;

/** One folded record: the start, the end when there is one, and the chain around it. */
export type SessionRecord = SessionStartEvent & {
  /** When it ended. Absent on a record the registry has not seen end. */
  ended?: string;
  reason?: SessionEndReason;
  note?: string;
  tokens?: TokenReading;
  cost?: CostReading;
  links?: SessionLinks;
  /** The next session the same seat ran, when one has started since. */
  next?: string;
};

export type SessionRead =
  | { ok: true; sessions: SessionRecord[] }
  | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((one) => typeof one === 'string')
    ? (value as string[])
    : undefined;
}

const REASONS: readonly SessionEndReason[] = ['swap', 'restart', 'crash', 'owner-stop', 'quota'];
const READINGS = ['measured', 'estimated'] as const;

function tokensOf(value: unknown): TokenReading | undefined {
  if (!isObject(value)) return undefined;
  const source = value.source;
  if (source !== 'measured' && source !== 'estimated') return undefined;
  const inCount = optionalCount(value.in);
  const outCount = optionalCount(value.out);
  const cached = optionalCount(value.cached);
  if (inCount === undefined && outCount === undefined && cached === undefined) return undefined;
  return {
    ...(inCount === undefined ? {} : { in: inCount }),
    ...(outCount === undefined ? {} : { out: outCount }),
    ...(cached === undefined ? {} : { cached }),
    source,
  };
}

function costOf(value: unknown): CostReading | undefined {
  if (!isObject(value)) return undefined;
  const amount = optionalCount(value.amount);
  const currency = optionalString(value.currency);
  const source = value.source;
  if (amount === undefined || currency === undefined) return undefined;
  if (source !== 'measured' && source !== 'estimated') return undefined;
  return { amount, currency, source };
}

function linksOf(value: unknown): SessionLinks | undefined {
  if (!isObject(value)) return undefined;
  const commits = optionalStrings(value.commits);
  const prs = optionalStrings(value.prs);
  const releases = optionalStrings(value.releases);
  if (commits === undefined && prs === undefined && releases === undefined) return undefined;
  return {
    ...(commits === undefined ? {} : { commits }),
    ...(prs === undefined ? {} : { prs }),
    ...(releases === undefined ? {} : { releases }),
  };
}

/** One line as an event, or null when it is not one this version writes. */
export function parseSessionLine(raw: string): SessionEvent | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const ts = optionalString(parsed.ts);
  const id = optionalString(parsed.id);
  if (ts === undefined || id === undefined) return null;

  if (parsed.event === 'start') {
    const project = optionalString(parsed.project);
    const team = optionalString(parsed.team);
    const seat = optionalString(parsed.seat);
    const cli = optionalString(parsed.cli);
    const lab = optionalString(parsed.lab);
    const account = optionalString(parsed.account);
    const herdrSession = optionalString(parsed.herdr_session);
    if (project === undefined || team === undefined || seat === undefined) return null;
    if (cli === undefined || lab === undefined || account === undefined || herdrSession === undefined) return null;
    const entity = optionalString(parsed.entity);
    const nickname = optionalString(parsed.nickname);
    const model = optionalString(parsed.model);
    const version = optionalString(parsed.version);
    const effort = optionalString(parsed.effort);
    const pane = optionalString(parsed.pane);
    const workspace = optionalString(parsed.workspace);
    const cliSession = optionalString(parsed.cli_session);
    const resumeUntil = optionalString(parsed.resume_until);
    const handover = optionalString(parsed.handover);
    const previous = optionalString(parsed.previous);
    return {
      event: 'start',
      ts,
      id,
      ...(entity === undefined ? {} : { entity }),
      project,
      team,
      seat,
      ...(nickname === undefined ? {} : { nickname }),
      cli,
      lab,
      ...(model === undefined ? {} : { model }),
      ...(version === undefined ? {} : { version }),
      ...(effort === undefined ? {} : { effort }),
      account,
      herdr_session: herdrSession,
      ...(pane === undefined ? {} : { pane }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(cliSession === undefined ? {} : { cli_session: cliSession }),
      ...(typeof parsed.resumable === 'boolean' ? { resumable: parsed.resumable } : {}),
      ...(resumeUntil === undefined ? {} : { resume_until: resumeUntil }),
      ...(handover === undefined ? {} : { handover }),
      ...(previous === undefined ? {} : { previous }),
    };
  }

  if (parsed.event === 'end') {
    const reason = REASONS.find((one) => one === parsed.reason);
    if (reason === undefined) return null;
    const note = optionalString(parsed.note);
    const cliSession = optionalString(parsed.cli_session);
    const resumeUntil = optionalString(parsed.resume_until);
    const handover = optionalString(parsed.handover);
    const tokens = tokensOf(parsed.tokens);
    const cost = costOf(parsed.cost);
    const links = linksOf(parsed.links);
    return {
      event: 'end',
      ts,
      id,
      reason,
      ...(note === undefined ? {} : { note }),
      ...(cliSession === undefined ? {} : { cli_session: cliSession }),
      ...(typeof parsed.resumable === 'boolean' ? { resumable: parsed.resumable } : {}),
      ...(resumeUntil === undefined ? {} : { resume_until: resumeUntil }),
      ...(handover === undefined ? {} : { handover }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(cost === undefined ? {} : { cost }),
      ...(links === undefined ? {} : { links }),
    };
  }

  return null;
}

/** Lines to events, malformed lines skipped; the registry never refuses to show the rest. */
export function parseSessionLines(lines: readonly string[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of lines) {
    const event = parseSessionLine(line);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * Folds events in file order into records, keeping the order the sessions started in. An end
 * fills the record the start made; a second end for the same id is ignored (the append-only
 * writer appends one). `next` is read back from the start that names this record `previous`, so
 * the chain is available from either side.
 */
export function foldSessions(events: readonly SessionEvent[]): SessionRecord[] {
  const records = new Map<string, SessionRecord>();
  const order: string[] = [];
  for (const event of events) {
    if (event.event === 'start') {
      if (records.has(event.id)) continue;
      records.set(event.id, { ...event });
      order.push(event.id);
      continue;
    }
    const record = records.get(event.id);
    if (record === undefined || record.ended !== undefined) continue;
    record.ended = event.ts;
    record.reason = event.reason;
    if (event.note !== undefined) record.note = event.note;
    if (event.cli_session !== undefined) record.cli_session = event.cli_session;
    if (event.resumable !== undefined) record.resumable = event.resumable;
    if (event.resume_until !== undefined) record.resume_until = event.resume_until;
    if (event.handover !== undefined) record.handover = event.handover;
    if (event.tokens !== undefined) record.tokens = event.tokens;
    if (event.cost !== undefined) record.cost = event.cost;
    if (event.links !== undefined) record.links = event.links;
  }
  for (const record of records.values()) {
    if (record.previous === undefined) continue;
    const before = records.get(record.previous);
    if (before !== undefined && before.next === undefined) before.next = record.id;
  }
  return order.map((id) => records.get(id) as SessionRecord);
}

/** Reads one project state folder's registry. A missing file is no sessions. */
export function readStoreSessions(storeDir: string, home: string): SessionRead {
  const read = readStoreLines(storeDir, SESSIONS_FILE, home, LABEL);
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, sessions: foldSessions(parseSessionLines(read.lines)) };
}

/** Reads every project state folder's registry on this machine, oldest session first. */
export function readAllSessions(home: string): SessionRead {
  const listed = listStoreDirs(home);
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const sessions: SessionRecord[] = [];
  for (const dir of listed.dirs) {
    const read = readStoreSessions(dir, home);
    if (!read.ok) return read;
    for (const session of read.sessions) sessions.push(session);
  }
  sessions.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return { ok: true, sessions };
}

/** Where one team's registry lives. */
export function sessionsPath(team: TeamFile, root: string, home: string): string {
  return storePath(team.project, root, home);
}

/** The session id this version mints: `ses_` and 12 lowercase hex characters. */
export function mintSessionId(): string {
  return `ses_${randomBytes(6).toString('hex')}`;
}

/**
 * What a launch tells the registry. `cli_session` is the id TeamCLI set at launch, where the CLI
 * takes one, else the id herdr reported for the pane. `now` is the injected clock, so a test's
 * record has the time its fixture says.
 */
export type BeginInput = {
  home: string;
  root: string;
  team: TeamFile;
  session: string;
  seat: Seat;
  pane: string;
  workspace?: string;
  cli_session?: string;
  /**
   * Why the open session this launch replaces ended, when the launcher closed it on purpose:
   * a drift repair is a `swap`. Absent, a replaced session is a `crash`.
   */
  replaces?: SessionEndReason;
  now?: Date;
};

export type EndInput = {
  home: string;
  root: string;
  team: TeamFile;
  session: string;
  /** One seat, or every open session of the team when absent (a session found stopped). */
  seat?: string;
  reason: SessionEndReason;
  note?: string;
  now?: Date;
};

/**
 * Records the start of a session for `seat` in `pane`. When the seat already has a session open
 * in this team and herdr session:
 * - the same pane and the same defined CLI session id is the same launch reported twice:
 *   nothing is written;
 * - anything else is a launch that replaces the old one: the old record ends as `crash`, or as
 *   the `replaces` reason the caller gives (a drift repair is a `swap`), then the new one starts
 *   with `previous` naming it. Two launches without a CLI session id are never the same launch:
 *   a CLI that takes no id, relaunched in its pane, is a new session.
 * Recording never fails a launch: an error comes back as the note to log.
 */
export function beginSession(input: BeginInput): { id: string } | { note: string } {
  const { home, root, team, session, seat } = input;
  const now = input.now ?? new Date();
  const ts = now.toISOString();
  const storeDir = sessionsPath(team, root, home);
  try {
    return withLock(storeDir, () => {
      const read = readStoreSessions(storeDir, home);
      if (!read.ok) return { note: read.reason };
      const open = read.sessions.filter(
        (one) => one.team === team.project && one.herdr_session === session && one.seat === seat.name && one.ended === undefined,
      );
      const latest = open.at(-1);
      if (latest !== undefined) {
        // Two launches are one only when both carry a CLI session id and the ids agree. A CLI
        // that takes no id (`codex`, say) relaunched in its pane is a new session, never the old.
        const sameLaunch = latest.pane === input.pane
          && latest.cli_session !== undefined
          && latest.cli_session === input.cli_session;
        if (sameLaunch) return { id: latest.id };
        const reason = input.replaces ?? 'crash';
        const closed = appendSessionEvent(home, team, root, {
          event: 'end',
          ts,
          id: latest.id,
          reason,
          ...(reason === 'crash' ? { note: 'a new launch found this session open' } : {}),
        });
        if (!closed.ok) return closed;
      }
      const previous = latest?.id
        ?? read.sessions.filter((one) => one.team === team.project && one.herdr_session === session && one.seat === seat.name).at(-1)?.id;
      const id = mintSessionId();
      const event: SessionStartEvent = {
        event: 'start',
        ts,
        id,
        ...(team.entity === null ? {} : { entity: team.entity }),
        project: team.inProject ?? team.project,
        team: team.project,
        seat: seat.name,
        ...(seat.nickname === undefined ? {} : { nickname: seat.nickname }),
        cli: seat.cli,
        lab: seat.vendor,
        ...(seat.model ? { model: seat.model } : {}),
        ...(seat.version ? { version: seat.version } : {}),
        ...(seat.effort ? { effort: seat.effort } : {}),
        account: seat.account ?? seat.vendor,
        herdr_session: session,
        pane: input.pane,
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        ...(input.cli_session === undefined ? {} : { cli_session: input.cli_session }),
        ...(input.cli_session !== undefined && supportsSessionResume(seat.cli) ? { resumable: true } : {}),
        ...(previous === undefined ? {} : { previous }),
      };
      const written = appendSessionEvent(home, team, root, event);
      if (!written.ok) return written;
      return { id };
    });
  } catch (error) {
    return { note: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Records the end of a session: one seat's open record, or every open record of the team in
 * this herdr session when no seat is named. A record the registry never opened is no error and
 * nothing is written. An error comes back as the note to log.
 */
export function endSession(input: EndInput): { ended: string[] } | { note: string } {
  const { home, root, team, session } = input;
  const ts = (input.now ?? new Date()).toISOString();
  const storeDir = sessionsPath(team, root, home);
  try {
    return withLock(storeDir, () => {
      const read = readStoreSessions(storeDir, home);
      if (!read.ok) return { note: read.reason };
      const open = read.sessions.filter(
        (one) => one.team === team.project
          && one.herdr_session === session
          && (input.seat === undefined || one.seat === input.seat)
          && one.ended === undefined,
      );
      const ended: string[] = [];
      for (const record of open) {
        const written = appendSessionEvent(home, team, root, {
          event: 'end',
          ts,
          id: record.id,
          reason: input.reason,
          ...(input.note === undefined ? {} : { note: input.note }),
        });
        if (!written.ok) return written;
        ended.push(record.id);
      }
      return { ended };
    });
  } catch (error) {
    return { note: error instanceof Error ? error.message : String(error) };
  }
}

function appendSessionEvent(
  home: string,
  team: TeamFile,
  root: string,
  event: SessionEvent,
): { ok: true } | { ok: false; note: string } {
  const written = appendStoreLine(team.project, root, home, SESSIONS_FILE, event, { rotate: false, label: LABEL });
  return written.ok ? { ok: true } : { ok: false, note: written.reason };
}
