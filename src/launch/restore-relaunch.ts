// After a restore pass: bring each restored Claude seat back through its launch line, then
// confirm it can receive.
//
// The terminal host resumes a seat's conversation without its launch line, so the restore
// re-tie records `channel_launch: false` and the seat's channel push reaches nothing. Here, after
// the pass released its run lock, each such seat whose declared line carries the channel flag is
// restarted with `team restart <seat> --resume <its conversation>` through the restart command
// itself, one at a time, only while the load guard lets a launch through and only when herdr
// reads it idle with an empty prompt (no unsent text, no dialog). A working seat is left for a
// later pass. A person's pane is never restarted, and neither is the entity's main orchestrator,
// which runs in the owner's own pane: the owner is told the one restart to approve.
//
// The reach check follows: a restored seat counts as reachable once its channel is proven (a
// proving ack from its live listener, src/queue/resend.ts). A relaunched seat with no ack yet
// gets the channel proof probe (src/queue/channel-probe.ts). One still unproven
// `CHANNEL_OVERDUE_MS` after its relaunch (or after the pass first found it, when it was not
// relaunched) is said once to the team's lead as "unreachable after restore: <reason>", and
// `team doctor` fails it until it is proven.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Caller } from '../caller.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { readStateFile, writeStateFile } from '../file-write.ts';
import { mkdirSync } from '../host/guarded-fs.ts';
import type { Io } from '../io.ts';
import { readState, updateState } from '../state.ts';
import { seatProcessVerdict } from './identity.ts';
import { readScreen } from '../watch/screen.ts';
import { launchLimit } from '../watch/machine.ts';
import { CHANNEL_OVERDUE_MS, type ChannelUnproven } from '../queue/resend.ts';
import { channelOptionProven } from './restore-channel.ts';
import type { UpSources } from '../commands/up.ts';

/** One seat's restore mark: the launch identity it describes, since when, and what was done. */
type Mark = { launched: string; at: string; relaunched: boolean; reported?: true };
type Marks = Record<string, Mark>;

export type RestoreRelaunchDeps = {
  /** Runs `team restart` with these words; the exit code. */
  restart: (argv: string[], io: Io) => Promise<number>;
  /** Why the seat's channel is not proven, or null when it is. */
  unproven: (seat: string) => ChannelUnproven | 'no message key' | null;
  /** Places one channel proof probe for the seat, unless one is already waiting. */
  probe: (seat: string) => void;
  /** Writes one signed notice to the lead; a second write with the same id finds the first. */
  notify: (input: { lead: string; body: string; id: string }) => boolean;
};

export type RelaunchPass = {
  /** What was done and said, for the pass's summary line. */
  lines: string[];
  /** Why the route should be passed again (a seat working, the load, a proof still awaited). */
  pending: string | null;
};

const marksPath = (dir: string, session: string): string => join(dir, 'restore-reach', `${session}.json`);

function readMarks(dir: string, session: string): Marks {
  try {
    const text = readStateFile(marksPath(dir, session));
    const parsed = text === null ? null : JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Marks : {};
  } catch {
    return {};
  }
}

function writeMarks(dir: string, session: string, marks: Marks): void {
  mkdirSync(join(dir, 'restore-reach'), { recursive: true });
  writeStateFile(marksPath(dir, session), `${JSON.stringify(marks, null, 2)}\n`);
}

const identity = (launched: unknown): string => JSON.stringify(launched ?? null);

/** A UUID-shaped id, stable for this seat's mark: a retry finds the first notice. */
function markNoticeId(root: string, session: string, seat: string, at: string): string {
  const hex = createHash('sha256').update(`unreachable-after-restore\0${root}\0${session}\0${seat}\0${at}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The entity's main orchestrator, which runs in the owner's own pane (send.ts permittedEventLegs). */
export function mainOrchestratorSeat(team: Pick<TeamFile, 'entity' | 'project' | 'orchestrator'>, seat: string): boolean {
  return team.entity !== null && team.project === team.entity && seat === team.orchestrator;
}

/** The doctor's fail line for a restored seat still unproven past the bound, or null. */
export function unreachableAfterRestore(dir: string, session: string, seat: string, unproven: string | null, now: Date): string | null {
  if (unproven === null) return null;
  const mark = readMarks(dir, session)[seat];
  if (mark === undefined) return null;
  let held: unknown;
  try { held = readState(dir).sessions[session]?.seats[seat]?.launched; } catch { return null; }
  if (mark.launched !== identity(held)) return null;
  if (now.getTime() - Date.parse(mark.at) <= CHANNEL_OVERDUE_MS) return null;
  return `${seat}: unreachable after restore: ${unproven}`;
}

/** Whether herdr reads the seat's pane idle with an empty prompt: no turn, no text, no dialog. */
function idleNow(sources: UpSources, session: string, pane: string, cli: string): boolean {
  const agent = sources.agents(session)?.find((one) => one.pane === pane);
  if (agent === undefined || (agent.status !== 'idle' && agent.status !== 'done')) return false;
  const text = sources.launch?.paneText(session, pane) ?? null;
  return text !== null && text !== '' && readScreen(cli, text).kind === 'idle';
}

export async function relaunchRestoredSeats(input: {
  root: string; dir: string; session: string; team: TeamFile; sources: UpSources; caller: Caller;
  launchFile?: string; deps: RestoreRelaunchDeps;
}): Promise<RelaunchPass> {
  const { root, dir, session, team, sources, deps } = input;
  const now = (): Date => sources.now?.() ?? new Date();
  const lines: string[] = [];
  const waits: string[] = [];
  const marks = readMarks(dir, session);
  let changed = false;
  const mark = (seat: string, next: Mark | undefined): void => {
    if (next === undefined) delete marks[seat];
    else marks[seat] = next;
    changed = true;
  };
  let loadHeld: string | null = null;
  const seats = team.seats.filter((seat): seat is Seat => seat.cli === 'claude-code' && seat.stopped !== true && seat.human !== true);
  for (const seat of seats) {
    // Re-read right before each decision: the restart before it changed the state.
    const held = readState(dir).sessions[session]?.seats[seat.name];
    if (held?.pane === undefined || held.launched === undefined || !held.agent_session) continue;
    let own = marks[seat.name];
    if (own !== undefined && own.launched !== identity(held.launched)) {
      // A mark for an earlier launch: the seat was launched since, so it says nothing now.
      mark(seat.name, undefined);
      own = undefined;
    }
    // A pane whose live process is not the recorded launch (a resume the restart rebind could not
    // prove) runs no launch line either: its record says so, as the re-tie would have, so the
    // send walk, the reach check and this relaunch take it the same way.
    if (held.channel_launch !== false && channelOptionProven(seat.launch)
      && seatProcessVerdict(held.launched, sources.launch?.processInfo?.(session, held.pane) ?? null) === 'replaced') {
      updateState(dir, (state) => {
        const one = state.sessions[session]?.seats[seat.name];
        if (one !== undefined && identity(one.launched) === identity(held.launched)) one.channel_launch = false;
      });
      held.channel_launch = readState(dir).sessions[session]?.seats[seat.name]?.channel_launch;
    }
    const restored = held.channel_launch === false && channelOptionProven(seat.launch);
    if (restored && own?.relaunched !== true) {
      if (own === undefined) {
        own = { launched: identity(held.launched), at: now().toISOString(), relaunched: false };
        mark(seat.name, own);
      }
      if (mainOrchestratorSeat(team, seat.name)) {
        if (own.reported !== true) {
          const line = `${seat.name}: restored without its launch line, so its channel push is off; it runs in the owner's pane and is not restarted from here: the owner approves \`team restart ${seat.name} --resume ${held.agent_session}\``;
          lines.push(line);
          if (team.orchestrator !== '') deps.notify({ lead: team.orchestrator, body: line, id: markNoticeId(root, session, seat.name, own.at) });
          mark(seat.name, { ...own, reported: true });
        }
        continue;
      }
      const machine = loadHeld === null ? sources.machine?.(root) : undefined;
      if (machine !== undefined) loadHeld = launchLimit(machine, team.machine, [], now().getTime());
      if (loadHeld !== null) {
        waits.push(`${seat.name} waits for the load guard (${loadHeld})`);
      } else if (!idleNow(sources, session, held.pane, seat.cli)) {
        waits.push(`${seat.name} is not idle at an empty prompt; relaunched on a later pass`);
      } else {
        const said: string[] = [];
        const env = { ...process.env };
        delete env.HERDR_PANE_ID;
        const io: Io = {
          cwd: root, env, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, caller: input.caller,
          stdout: (text) => said.push(text), stderr: (text) => said.push(text),
        };
        const argv = [seat.name, '--resume', held.agent_session, '--session', session, ...(input.launchFile === undefined ? [] : ['--file', input.launchFile])];
        const exit = await deps.restart(argv, io);
        const after = readState(dir).sessions[session]?.seats[seat.name];
        if (exit === 0 && after?.launched !== undefined) {
          own = { launched: identity(after.launched), at: now().toISOString(), relaunched: true };
          mark(seat.name, own);
          // Through the line only when the new process carries the channel flag; a launch that fell
          // back without it is said as such, and the reach check reports it if it stays unproven.
          lines.push(after.channel_launch === true
            ? `${seat.name}: relaunched through its launch line with its conversation ${held.agent_session}`
            : `${seat.name}: restarted with its conversation ${held.agent_session}, but its new process carries no channel flag; the reach check reports it if it stays unreachable`);
        } else {
          const last = said.join('').split('\n').map((one) => one.trim()).filter((one) => one !== '').at(-1) ?? `exit ${String(exit)}`;
          waits.push(`${seat.name} not relaunched yet (${last})`);
        }
      }
    }
    if (own === undefined || own.reported === true) continue;
    // The reach check: a proven channel ends the mark; otherwise the bound decides.
    const why = deps.unproven(seat.name);
    if (why === null) {
      mark(seat.name, undefined);
      continue;
    }
    if (own.relaunched && why === 'unproven since launch') deps.probe(seat.name);
    if (now().getTime() - Date.parse(own.at) <= CHANNEL_OVERDUE_MS) {
      if (own.relaunched) waits.push(`${seat.name} waits for its channel proof`);
      continue;
    }
    const line = `${seat.name}: unreachable after restore: ${why}`;
    lines.push(line);
    if (team.orchestrator !== '') deps.notify({ lead: team.orchestrator, body: line, id: markNoticeId(root, session, seat.name, own.at) });
    mark(seat.name, { ...own, reported: true });
  }
  if (changed) {
    try { writeMarks(dir, session, marks); } catch { lines.push('the restore reach marks could not be written'); }
  }
  return { lines, pending: waits.length === 0 ? null : waits.join('; ') };
}
