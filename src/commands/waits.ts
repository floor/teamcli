// `team waits`: who waits on whom, and since when.
//
// A wait is a signed message record of kind `task` or `question` with no verifying `replied`
// receipt beside it. Records only ever sit in the recipient's own folder
// (`<root>/.agents/send-drops/<session>/<seat>/<id>`), so a sender finds its waits by walking the
// transport trees the registry names — its own checkout and every other one — and keeping the
// records whose sender is a seat of this team. A seat lists the waits it wrote; a lead lists its
// whole team's, cross-team ones included, each shown by the team it points at. The retention
// window is this team's signed `event-retention-days` word (30 days by default): a record older
// than the window is left out of the list; this read deletes and answers nothing.
//
// Read-only: no receipt, marker or key is written. A missing message key verifies nothing, so
// the list is empty and the note says why.
import { type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller } from '../caller.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import {
  contextLine,
  formatRelativeTime,
  hasJsonFlag,
  pluralCount,
  refuse,
  renderNotes,
  renderTable,
  writeJson,
} from '../output/index.ts';
import { eventThresholdsInForce } from '../policy/thresholds.ts';
import { readTeams, teamIdOf, type TeamRecord } from '../registry/teams.ts';
import {
  receiptFile,
  receiptHolds,
  recordAuthOfSealed,
  sealedRecordOf,
  sameFolder,
  WAITING_KINDS,
  type MessageKind,
  type RecordPayload,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

export const USAGE = `Usage: team waits [--json]

Lists the messages this seat is waiting on an answer to: signed records of
kind task or question it sent that no replied receipt answers yet, with the
seat they point at, the work item, and how long they have waited. A lead
lists its whole team's waits, including records its seats wrote into another
team's checkout. Every message record is read where it sits — the recipient's
own folder — and verified with this checkout's message key, so a tampered
file proves nothing and is never listed. The retention window is the signed
event-retention-days word of the team's policy chain (30 days by default); an
older record is left out of the list, never deleted.

Exits 0 when the waits are listed, 1 when the caller or the team file is
refused, 2 when the invocation, the registry or the retention policy can't be
read.
`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The prefix a work nudge's file carries in the same folder; it is a prompt for the seat,
 *  never a message record (`work-<uuid>`). */
const WORK_PREFIX = 'work-';

export type WaitsSources = {
  home: string;
  now(): Date;
};

export const realSources: WaitsSources = { home: homedir(), now: () => new Date() };

const waits: Command = (argv, io) => runWaits(argv, io, realSources);
export default waits;

/** One refusal on the caller or the team file: `waits.refused`, exit 1, always. */
function refused(io: Io, json: boolean, message: string, repair: string | null = null): number {
  refuse(io, json, 'waits', { id: 'waits.refused', message, repair });
  return 1; // exit: waits.refused
}

/** A team file, registry or policy this run cannot read. Exit 2, always. */
function configuration(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'waits', { id: 'waits.configuration', message, repair: null });
  return 2; // exit: waits.configuration
}

/** The invocation cannot be read. Exit 2, always. */
function usage(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'waits', { id: 'waits.usage', message, repair: null, usage: USAGE });
  return 2; // exit: waits.usage
}

/** One wait, as the table and the document carry it: the sender is this team's seat the record
 *  names, and the awaited seat is shown with its team when the record sits in another checkout. */
type Wait = {
  id: string;
  from: string;
  from_id: string | null;
  to: string;
  to_id: string | null;
  kind: MessageKind;
  at: string;
  age_seconds: number;
  to_team: string | null;
  thread: string;
  work?: string;
  subject?: string;
};

type ScanContext = {
  key: KeyObject;
  now: Date;
  /** The caller's own checkout, by team id: the one root where a record without an agent id is
   *  read by the seat name the team file declares. */
  ownRootId: string;
  /** The team's roster agent id to the seat it holds. */
  roster: Map<string, string>;
  /** The seats this team file declares. */
  declared: Set<string>;
  /** The one seat whose waits count, or null for every seat of the team (a lead's view). */
  scopeSeat: string | null;
  retentionSeconds: number;
  /** A registered checkout's team id to the project name it is listed under. */
  projects: Map<string, string>;
};

function isDirAt(at: string): boolean {
  try {
    return lstatSync(at).isDirectory();
  } catch {
    return false;
  }
}

/** The names in one folder, in name order; a folder this machine cannot read is no names. */
function namesIn(at: string): string[] {
  try {
    return readdirSync(at).sort();
  } catch {
    return [];
  }
}

/** The seat of this team that wrote the record, or null when it is not this team's. An agent id
 *  must match a roster line; a record written without one is a declared seat's only inside this
 *  team's own checkout, and only for a name the team file declares. A same-named seat of another
 *  team therefore never reads as this team's. */
function seatOfSender(payload: RecordPayload, rootId: string, ctx: ScanContext): string | null {
  if (payload.from_id !== null) return ctx.roster.get(payload.from_id) ?? null;
  if (rootId === ctx.ownRootId && ctx.declared.has(payload.from)) return payload.from;
  return null;
}

/** One file read as a waiting record, or null when it is not one: unsettled, unreadable, not
 *  this version's, not this folder's record, not a task or question, already answered, another
 *  team's sender, another seat's (a worker's view), outside the retention window, or stamped
 *  with no readable time. */
function readWait(path: string, root: string, rootId: string, session: string, seat: string, name: string, ctx: ScanContext): Wait | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const sealed = sealedRecordOf(parsed);
  if (sealed === null) return null;
  const auth = recordAuthOfSealed(sealed, ctx.key);
  if (auth.kind !== 'ok') return null;
  const payload = auth.value.payload;
  if (payload.id !== name || payload.to !== seat || payload.session !== session) return null;
  if (!sameFolder(payload.root, root)) return null;
  const kind = payload.message_kind;
  if (kind === undefined || !WAITING_KINDS.includes(kind)) return null;
  const dir = join(root, '.agents', 'send-drops', session, seat);
  if (receiptHolds(receiptFile(dir, name, 'replied'), name, 'replied', { to: seat, root, session }, ctx.key)) return null;
  const sender = seatOfSender(payload, rootId, ctx);
  if (sender === null) return null;
  if (ctx.scopeSeat !== null && sender !== ctx.scopeSeat) return null;
  const sentAt = Date.parse(payload.at);
  if (!Number.isFinite(sentAt)) return null;
  const ageSeconds = Math.max(0, Math.round((ctx.now.getTime() - sentAt) / 1000));
  if (ageSeconds > ctx.retentionSeconds) return null;
  return {
    id: payload.id,
    from: sender,
    from_id: payload.from_id,
    to: payload.to,
    to_id: payload.to_id,
    kind,
    at: payload.at,
    age_seconds: ageSeconds,
    to_team: ctx.projects.get(teamIdOf(payload.root)) ?? null,
    thread: payload.thread,
    ...(payload.work === undefined ? {} : { work: payload.work }),
    ...(payload.subject === undefined ? {} : { subject: payload.subject }),
  };
}

/** Every waiting record in one checkout: the recipient's folders of every session and seat. */
function waitsInRoot(root: string, ctx: ScanContext): Wait[] {
  const base = join(root, '.agents', 'send-drops');
  const rootId = teamIdOf(root);
  const out: Wait[] = [];
  for (const session of namesIn(base)) {
    if (!NAME.test(session)) continue;
    const sessionDir = join(base, session);
    if (!isDirAt(sessionDir)) continue;
    for (const seat of namesIn(sessionDir)) {
      if (!NAME.test(seat)) continue;
      const seatDir = join(sessionDir, seat);
      if (!isDirAt(seatDir)) continue;
      for (const name of namesIn(seatDir)) {
        if (!NAME.test(name) || name.includes('.') || name.startsWith(WORK_PREFIX)) continue;
        const path = join(seatDir, name);
        let isFile = false;
        try {
          isFile = lstatSync(path).isFile();
        } catch {
          continue;
        }
        if (!isFile) continue;
        const found = readWait(path, root, rootId, session, seat, name, ctx);
        if (found !== null) out.push(found);
      }
    }
  }
  return out;
}

/** The awaited seat as the table shows it: plain inside this team, `seat@project` across teams. */
function awaitedOf(wait: Wait, project: string): string {
  return wait.to_team === null || wait.to_team === project ? wait.to : `${wait.to}@${wait.to_team}`;
}

export async function runWaits(argv: string[], io: Io, sources: WaitsSources): Promise<number> {
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  if (args.error) return usage(io, json, args.error);
  if (args.rest.length > 0) return usage(io, json, `unexpected "${args.rest[0]}"`);

  const caller = callerOf(io);
  if (caller.kind !== 'seat') {
    const described = caller.kind === 'owner' ? 'the owner' : describeCaller(caller);
    return refused(io, json, `only a seat of this team sees its waits; this call is ${described}`);
  }

  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, withoutFileOffer(message) || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  if (!team.seats.some((seat) => seat.name === caller.name)) {
    return refused(io, json, `only a seat of this team sees its waits; this call is ${describeCaller(caller)}`);
  }

  let registry: Record<string, TeamRecord>;
  try {
    registry = readTeams(sources.home);
  } catch (error) {
    return configuration(io, json, `the team registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const now = sources.now();
  const inForce = eventThresholdsInForce({
    home: sources.home,
    entity: team.entity,
    projectId: projectIdOfTeam(sources.home, team, root),
    root,
    team,
    now,
    upToLevel: 'team',
  });
  if (!inForce.ok) {
    const said = inForce.refusals.map((refusal) => refusal.message).join('; ');
    return configuration(io, json, `the event-retention policy cannot be read: ${said === '' ? 'no reason was given' : said}`);
  }
  const retentionDays = inForce.thresholds.retention_days;

  // The roots this read walks: every checkout the registry names, and the caller's own even when
  // the registry does not list it. A record is only ever in the recipient's folder, so a wait a
  // seat wrote into another team's checkout is found there, not here.
  const ownRootId = teamIdOf(root);
  const projects = new Map<string, string>();
  const roots = new Map<string, string>();
  roots.set(ownRootId, root);
  for (const record of Object.values(registry)) {
    if (record.root === '' || !existsSync(record.root) || !isDirAt(record.root)) continue;
    const id = teamIdOf(record.root);
    projects.set(id, record.project);
    if (!roots.has(id)) roots.set(id, record.root);
  }
  projects.set(ownRootId, team.project);

  // The lead's seat, however the file spelled it (`coordinator:` or `leads: true`): the team
  // file's `orchestrator` is that seat. Every other caller sees only its own waits.
  const lead = caller.name === team.orchestrator;

  const roster = new Map<string, string>();
  for (const line of registry[ownRootId]?.roster ?? []) {
    if (!roster.has(line.agent)) roster.set(line.agent, line.seat);
  }

  const keyState = messageKeyState(sources.home);
  const notes: string[] = [];
  let found: Wait[] = [];
  if (keyState.kind !== 'key') {
    notes.push(keyState.kind === 'missing'
      ? 'the message key is not in this home, so no record can be verified'
      : `the message key cannot be read (${keyState.why}), so no record can be verified`);
  } else {
    const ctx: ScanContext = {
      key: keyState.key,
      now,
      ownRootId,
      roster,
      declared: new Set(team.seats.map((seat) => seat.name)),
      scopeSeat: lead ? null : caller.name,
      retentionSeconds: retentionDays * 86_400,
      projects,
    };
    const collected: Wait[] = [];
    for (const scanned of roots.values()) collected.push(...waitsInRoot(scanned, ctx));
    collected.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    found = collected;
  }

  const rows = found.map((wait) => [wait.from, awaitedOf(wait, team.project), wait.kind, wait.work ?? '-', formatRelativeTime(wait.at, now)]);
  if (json) {
    writeJson(io, 'team.waits', {
      format: 1,
      project: team.project,
      session: team.session,
      seat: caller.name,
      scope: lead ? 'team' : 'seat',
      retention_days: retentionDays,
      waits: found,
      ...(notes.length > 0 ? { notes } : {}),
    });
  } else {
    const lines = [contextLine(team.project, team.session), ...renderTable({ headers: ['WAITER', 'AWAITED', 'KIND', 'WORK', 'WAITING'], rows })];
    if (found.length === 0) lines.push('', 'no waits');
    else lines.push('', pluralCount(found.length, 'wait'));
    if (notes.length > 0) lines.push('', ...renderNotes(notes));
    io.stdout(`${lines.join('\n')}\n`);
  }
  return 0; // exit: waits.ok
}
