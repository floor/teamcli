import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, callerVerdict, detachedRefusal, describeCaller, judgeCallerIn, standingOf, type Caller } from '../caller.ts';
import { readBriefFile, readCurrent, snapshotPath, writeCurrent, writeSnapshot, type BriefRecord } from '../brief/store.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { callerProblemOf, logWho, realHost, runSend, type SendHost } from './send.ts';

export const USAGE = `Usage: team brief <seat> <file> [--dry-run] [--json]
       team brief --done [--seat <name>] [--summary <text>] [--json]
       team brief --list [--json]

Hands a seat its brief and records it. \`team brief <seat> <file>\` copies the file once into
the team's brief folder (mode 0600), so a later edit of the file does not change what the seat
was given, writes the seat's record, and delivers the brief's text through \`team send\`: the
same drop file, the same trigger line, the same outcomes. Only the owner, or the orchestrator
from its own seat, may hand a brief. The record says assigned, then delivered, held,
unreachable or refused.

\`team brief --done\` is the seat's own word that its brief is finished: it marks the record
done with an optional one-line --summary, and writes one line to the team log. A seat marks its
own brief; the owner and the orchestrator may name another seat with --seat.

\`team brief --list\` prints one row per declared seat: its status, the brief's file name, how
long ago, and the summary. It writes nothing and needs no caller check.
`;

const SUMMARY_MAX = 280;

type Report = { json: boolean; seat: string | null };

const brief: Command = (argv, io) => runBrief(argv, io, realHost);
export default brief;

export async function runBrief(argv: string[], rawIo: Io, host: SendHost): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['seat', 'summary'], ['done', 'list', 'json', 'dry-run']);
  const report: Report = { json: args.flags.has('json'), seat: args.rest[0] ?? args.values.seat ?? null };
  if (args.error) return usage(io, args.error, report);
  const done = args.flags.has('done');
  const list = args.flags.has('list');
  if (done && list) return usage(io, '--done and --list cannot both be given', report);
  if ((args.values.seat !== undefined || args.values.summary !== undefined) && !done) return usage(io, '--seat and --summary are only meaningful with --done', report);
  if (args.flags.has('dry-run') && (done || list)) return usage(io, '--dry-run is only meaningful when handing a brief', report);

  const detached = detachedRefusal(callerOf(io));
  if (detached !== undefined && !list) {
    io.stderr(`team brief: ${detached}\n`);
    // exit: brief.detached
    return 1;
  }

  if (!done && !list && args.rest.length !== 2) return usage(io, 'a seat and a file are required', report);

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  const { team } = loaded;
  const dir = dirname(loaded.path);

  if (list) {
    if (args.rest.length > 0) return usage(io, '--list takes no seat or file', report);
    return listBriefs(io, dir, team, host, report);
  }
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logWho(caller, team);
  const at = standingOf(dir, judged.session, caller);

  if (done) {
    if (args.rest.length > 0) return usage(io, `unexpected "${args.rest[0] as string}": the summary is --summary <text>`, report);
    return markDone(io, dir, team, caller, who, at, args.values.seat, args.values.summary, host, report);
  }

  const [seatName, file] = args.rest as [string, string];
  const callerProblem = callerProblemOf(caller, team, at);
  if (callerProblem) return refuse(io, dir, who, callerProblem, host, report);
  const configured = team.seats.find((seat) => seat.name === seatName);
  if (!configured) {
    return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${team.seats.map((seat) => seat.name).join(', ') || '(none)'}`, host, report);
  }
  const source = resolve(io.cwd, file);
  const read = readBriefFile(source);
  if (!read.ok) return refuse(io, dir, who, `the brief file ${file}: ${read.why}`, host, report);

  const id = randomUUID();
  if (args.flags.has('dry-run')) {
    const text = `${seatName}: would hand ${basename(source)} (${read.sha256.slice(0, 12)}) through team send; nothing was written\n`;
    io.stdout(report.json ? `${JSON.stringify({ seat: seatName, status: 'dry-run', exit: 0, sha256: read.sha256 })}\n` : text);
    // exit: brief.dry-run
    return 0;
  }

  let snapshot: string;
  try {
    snapshot = writeSnapshot(dir, team.session, seatName, id, read.text);
  } catch {
    return configuration(io, `the brief folder under ${dir} cannot be written`, report);
  }
  const now = host.now().toISOString();
  const record: BriefRecord = {
    id,
    seat: seatName,
    source: basename(source),
    sha256: read.sha256,
    status: 'assigned',
    assigned_by: who,
    assigned_at: now,
  };
  try {
    writeCurrent(dir, team.session, seatName, record);
  } catch {
    return configuration(io, `the brief record under ${dir} cannot be written`, report);
  }

  // The delivery is `team send`'s, whole: its caller check runs again, its drop file and trigger
  // are the ones every send makes, and its outcome is read from its own document.
  let captured = '';
  const sending: Io = { ...io, stdout: (text) => void (captured += text), stderr: () => undefined };
  const sent = await runSend([seatName, '--file', snapshot, '--json'], sending, host);
  const outcome = sendOutcome(captured, sent);
  logLine(dir, 'brief', who, `${seatName}: ${outcome.status} ${id} (${read.sha256.slice(0, 12)})${outcome.error ? `: ${outcome.error}` : ''}`, host.now());

  if (outcome.status === 'delivered') {
    writeCurrent(dir, team.session, seatName, { ...record, status: 'delivered', delivered_at: host.now().toISOString() });
    if (report.json) io.stdout(`${JSON.stringify({ seat: seatName, status: 'delivered', exit: 0, id, sha256: read.sha256 })}\n`);
    else io.stdout(`${seatName}: briefed (${id.slice(0, 8)}, ${read.sha256.slice(0, 12)})\n`);
    // exit: brief.delivered
    return 0;
  }
  const status = outcome.status === 'held' ? 'held' : outcome.status === 'unreachable' ? 'unreachable' : 'refused';
  writeCurrent(dir, team.session, seatName, { ...record, status });
  const why = outcome.error ?? `team send answered ${outcome.status}`;
  if (report.json) io.stdout(`${JSON.stringify({ seat: seatName, status, exit: 1, id, error: why })}\n`);
  else if (status === 'held') io.stderr(`team brief: ${seatName}: held: ${why}; the brief is recorded, and the same command sends it again\n`);
  else if (status === 'unreachable') io.stderr(`team brief: ${seatName}: unreachable: ${why}\n`);
  else io.stderr(`team brief: ${seatName}: refused: ${why}\n`);
  if (status === 'held') {
    // exit: brief.held
    return 1;
  }
  if (status === 'unreachable') {
    // exit: brief.unreachable
    return 1;
  }
  // exit: brief.send-refused
  return 1;
}

function sendOutcome(captured: string, exit: number): { status: string; error?: string } {
  try {
    const parsed: unknown = JSON.parse(captured.trim().split('\n').pop() ?? '');
    if (typeof parsed === 'object' && parsed !== null) {
      const doc = parsed as { status?: unknown; error?: unknown };
      if (typeof doc.status === 'string') {
        return { status: doc.status, ...(typeof doc.error === 'string' ? { error: doc.error } : {}) };
      }
    }
  } catch {
    // Falls through: a send that printed no document is read by its exit alone.
  }
  return exit === 0 ? { status: 'delivered' } : { status: 'refused', error: 'team send printed no result' };
}

function markDone(
  io: Io,
  dir: string,
  team: TeamFile,
  caller: Caller,
  who: string,
  at: ReturnType<typeof standingOf>,
  named: string | undefined,
  summaryWords: string | undefined,
  host: SendHost,
  report: Report,
): number {
  const own = caller.kind === 'seat' ? caller.name : null;
  const seatName = named ?? own;
  if (!seatName) return usage(io, 'a seat is required: --seat <name>', report);
  report.seat = seatName;
  if (!team.seats.some((seat) => seat.name === seatName)) {
    return refuse(io, dir, who, `${seatName}: it is not a declared seat`, host, report);
  }
  const isSelf = callerVerdict(caller, seatName, at).kind === 'ok';
  const isLead = caller.kind === 'owner' || callerVerdict(caller, team.orchestrator, at).kind === 'ok';
  if (!isSelf && !isLead) {
    return refuse(io, dir, who, `${describeCaller(caller)} may not mark ${seatName}'s brief done: a seat marks its own, and the owner or the orchestrator may name another`, host, report);
  }
  const current = readCurrent(dir, team.session, seatName);
  if (!current || current.status === 'done') {
    return refuse(io, dir, who, `no active brief is recorded for ${seatName}`, host, report);
  }
  const summary = summaryWords === undefined ? undefined : plainLine(summaryWords).slice(0, SUMMARY_MAX);
  const finished: BriefRecord = {
    ...current,
    status: 'done',
    done_at: host.now().toISOString(),
    done_by: who,
    ...(summary ? { summary } : {}),
  };
  try {
    writeCurrent(dir, team.session, seatName, finished);
  } catch {
    return configuration(io, `the brief record under ${dir} cannot be written`, report);
  }
  logLine(dir, 'brief', who, `${seatName}: done ${current.id}${summary ? ` — ${summary}` : ''}`, host.now());
  io.stdout(report.json ? `${JSON.stringify({ seat: seatName, status: 'done', exit: 0, id: current.id })}\n` : `${seatName}: marked done\n`);
  // exit: brief.done
  return 0;
}

function listBriefs(io: Io, dir: string, team: TeamFile, host: SendHost, report: Report): number {
  const rows = team.seats.map((seat) => {
    const record = readCurrent(dir, team.session, seat.name);
    return { seat: seat.name, record };
  });
  if (report.json) {
    io.stdout(
      `${JSON.stringify(
        rows.map(({ seat, record }) => ({
          seat,
          status: record?.status ?? 'none',
          brief: record?.source ?? null,
          id: record?.id ?? null,
          assigned_at: record?.assigned_at ?? null,
          summary: record?.summary ?? null,
        })),
      )}\n`,
    );
  } else {
    const width = Math.max(4, ...rows.map((row) => row.seat.length));
    for (const { seat, record } of rows) {
      const age = record ? ageOf(record.done_at ?? record.assigned_at, host.now()) : '-';
      io.stdout(`${seat.padEnd(width)}  ${(record?.status ?? 'none').padEnd(11)}  ${record?.source ?? '-'}  ${age}${record?.summary ? `  ${record.summary}` : ''}\n`);
    }
  }
  // exit: brief.list
  return 0;
}

function ageOf(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 90) return `${String(seconds)}s`;
  if (seconds < 5400) return `${String(Math.round(seconds / 60))}m`;
  if (seconds < 172_800) return `${String(Math.round(seconds / 3600))}h`;
  return `${String(Math.round(seconds / 86_400))}d`;
}

function refuse(io: Io, dir: string, who: string, reason: string, host: SendHost, report: Report): number {
  logLine(dir, 'brief', who, `refused: ${reason}`, host.now());
  if (report.json) io.stdout(`${JSON.stringify({ seat: report.seat, status: 'refused', exit: 1, error: reason })}\n`);
  else io.stderr(`team brief: refused: ${reason}\n`);
  // exit: brief.refused
  return 1;
}

function usage(io: Io, message: string, report: Report): number {
  if (report.json) io.stdout(`${JSON.stringify({ seat: report.seat, status: 'usage', exit: 2, error: message })}\n`);
  else io.stderr(`team brief: ${message}\n${USAGE}`);
  // exit: brief.usage
  return 2;
}

function configuration(io: Io, message: string, report: Report): number {
  if (report.json) io.stdout(`${JSON.stringify({ seat: report.seat, status: 'configuration', exit: 2, error: message })}\n`);
  else io.stderr(`team brief: ${message}\n`);
  // exit: brief.configuration
  return 2;
}
