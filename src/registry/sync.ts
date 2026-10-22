// The registry's writers for the launch commands. `up`, `add`,
// `restart` and `reload` register a seat's agent at its first launch and re-point it on every
// relaunch; `remove` and the stop of a seat end it. The agent's id is assigned once and never
// re-derived from the seat's name: a relaunch finds the live agent of (team, seat) and keeps it.
//
// A registry that cannot be written is a note for the command's log, never a refusal: the launch
// or the stop is done, and the next launch writes the record again. Every function here catches.
import { findAgent, readAgents, registerAgent, updateAgent, type AgentDelegation, type AgentProvenancePatch } from '../registry/agents.ts';
import { getTeam, noteTeam, setRoster, setTeamLifecycle, teamIdOf } from '../registry/teams.ts';
import * as projects from '../registry/projects.ts';
import { loadTeamFile } from '../file/load.ts';
import { endSession, type SessionEndReason } from '../sessions/registry.ts';
import type { ActingCommand } from '../delegate-types.ts';
import type { Seat, TeamFile } from '../file/types.ts';

/** What every writer here is told about the team it writes for. */
export type RegistryTeam = {
  home: string;
  team: TeamFile;
  root: string;
  by: string;
  /** The herdr session the command launched in or stopped. Absent: the file's. `up --session x`
   *  launches under `x`, and the registry must address the panes where they are. */
  session?: string;
  /** The run had dev mode on: the caller gate was folded into a warning. The record keeps the
   *  mark in its provenance while the write stands. A run without the mark takes it off only
   *  when it is the owner's: the finding the mark raises is the owner's to answer. */
  devMode?: boolean;
  /** The run is the owner's, at a terminal outside herdr. Only its write in force takes an
   *  earlier dev-mode mark off the record; a seat's, a lead's or a delegate's write in force
   *  leaves the mark where it is, for the owner's own register or relaunch. */
  owner?: boolean;
  /** The delegation a delegated run was admitted by: the pane the gate passed, and the one
   *  command the mark speaks for. The file's `delegates` section is the authority, so the record
   *  names the owner as signer and this pane as actor; a delegate authorizes nothing by itself.
   *  Absent: this write ran under no delegation. */
  delegated?: { actor: string; command: ActingCommand };
};

/** How a seat's agent ends: `stopped` comes back to the same agent, `retired` never does. */
export type Ending = 'stopped' | 'retired';

const SEAT_HANDLE = /^seat_[0-9a-f]{12}$/;

function noteOf(error: unknown): string {
  return `registry not written: ${error instanceof Error ? error.message : String(error)}`;
}

/** The team's record, made when the registry has none, and set running: a seat is launching in it.
 *  `noteTeam` never throws; the line it returns is why the record was not written. */
function ensureTeam(input: RegistryTeam): string | null {
  const { team, root, home, by } = input;
  // `up --session alt` records the session it launches; the file's own session records the same
  // lobby beside it, so a plain `team check` still reads it back.
  const seed = {
    project: team.project,
    entity: team.entity,
    session: input.session ?? team.session,
    lobby: team.lobby,
    inProject: team.inProject,
    aliasSession: team.session,
  };
  return noteTeam(home, root, seed, 'running', by);
}

/** One roster entry set (an agent) or taken out (null). Every line's `nickname`, `leads` and
 *  `assistant` are re-resolved to the file's own word — the human name the file writes on that
 *  seat, the lead seat `team.orchestrator`, whatever `leads: true` or `coordinator:` it was
 *  spelled with, and the seat the file marks `assistant: true` — the capabilities and the name,
 *  never a role name. So a mark that moved between launches does not linger on a line that no
 *  longer holds it. */
function writeRoster(input: RegistryTeam, teamId: string, seat: string, entry: { agent: string; role: string } | null): void {
  const leadSeat = input.team.orchestrator;
  const assistantSeat = input.team.seats.find((candidate) => candidate.assistant === true)?.name ?? null;
  const nicknames = new Map(input.team.seats.flatMap((candidate) => candidate.nickname === undefined ? [] : [[candidate.name, candidate.nickname] as const]));
  const mark = (line: { agent: string; seat: string; role: string }): { agent: string; seat: string; role: string; nickname?: string; leads?: boolean; assistant?: boolean } => {
    const nickname = nicknames.get(line.seat);
    return {
      ...line,
      ...(nickname !== undefined ? { nickname } : {}),
      ...(line.seat === leadSeat ? { leads: true } : {}),
      ...(line.seat === assistantSeat ? { assistant: true } : {}),
    };
  };
  const roster = (getTeam(input.home, teamId)?.roster ?? [])
    .filter((item) => item.seat !== seat)
    .map(({ leads: _stale, assistant: _staleAssistant, nickname: _staleNickname, ...item }) => mark(item));
  if (entry) roster.push(mark({ agent: entry.agent, seat, role: entry.role }));
  setRoster(input.home, teamId, roster);
}

/** This team leads the project its file names: the project's `lead` is the agent of the seat the
 *  file marks as the team's lead — the `leads: true` seat, or the older `coordinator:` key, both
 *  resolved to `team.orchestrator`; the capability, never a role name. Re-resolved on every
 *  launch, from the roster just written, so it follows the mark when the file moves it. A lead
 *  seat with no agent yet leaves the project with none, which teams read as ordinary. A file that
 *  drops `project_lead` clears the lead this team set, so no reader keeps admitting a seat the
 *  team no longer leads with: only an agent of this team's roster, so another team's lead is
 *  that team's to move. A team that leaves the project clears its lead in `projectLeave`
 *  (src/registry/teams.ts), with the project it left. */
function recordProjectLead(input: RegistryTeam, teamId: string): void {
  const { team, home } = input;
  if (team.inProject === null) return;
  const projectId = projects.projectIdOf(team.inProject);
  const roster = getTeam(home, teamId)?.roster ?? [];
  if (!team.projectLead) {
    const held = projects.get(home, projectId);
    if (held !== null && held.lead !== null && roster.some((line) => line.agent === held.lead)) {
      projects.upsertProject(home, projectId, { lead: null });
    }
    return;
  }
  const lead = roster.find((item) => item.seat === team.orchestrator)?.agent ?? null;
  projects.upsertProject(home, projectId, { lead });
}

/**
 * A seat launched in `pane`: its agent is registered when the (team, seat) has none, else it is
 * re-pointed (same id, new pane, running). The signing triple, the lab, the cli and the launch
 * line are the launch's own, so a reload that changes the model rewrites them on the same agent.
 * The run's provenance is stated too: every launch-command writer that can run with dev mode on
 * (`register`, `up`, `add`, `restart`) says with the write whether it did — and, when it did,
 * the `by` caller it was run by, so a record the owner registered and a folded run re-wrote
 * names the caller that run admitted, not the owner — and `reload`, the launch-command writer
 * with no dev mode to state, writes one in force. A write in force takes an earlier mark off
 * the record only when the owner makes it; anyone else's leaves the mark for the owner's own
 * register or relaunch to answer. A delegated run states its delegation beside the mark — the
 * owner as signer, the pane as actor, the one command it speaks for — and the owner's own write
 * in force takes that off too; another caller's routine write leaves it.
 * `agentSession` is the agent session herdr reported, the same id the launch wrote in the seat
 * state: when the reading has one it re-points `reach.agent_session` beside the pane, and when
 * it has none the record keeps the id it already holds.
 * Returns the agent's id, or the note to log.
 */
export function registerLaunch(
  input: RegistryTeam,
  seat: Seat,
  pane: string,
  handle?: string,
  agentSession?: string,
): { id: string } | { note: string } {
  try {
    const { home, team, by } = input;
    const teamId = teamIdOf(input.root);
    const unrecorded = ensureTeam(input);
    if (unrecorded) return { note: unrecorded };
    const known = findAgent(home, {
      team: teamId,
      seat: seat.name,
      seatHandle: SEAT_HANDLE.test(handle ?? '') ? handle : null,
    });
    const priorSeat = known && known.reach.seat !== seat.name ? known.reach.seat : null;
    // The seat's stable handle, kept on the agent for continuity: set when the agent has none, and
    // never changed after, so a handle the state minted later does not rewrite the record.
    const seatHandle = SEAT_HANDLE.test(handle ?? '') && !known?.seat_handle ? { seat_handle: handle as string } : {};
    const reach = {
      team: teamId,
      seat: seat.name,
      session: input.session ?? team.session,
      pane,
      address: known?.reach.address ?? null,
      ...(agentSession ? { agent_session: agentSession } : {}),
    };
    const signing = { model: seat.model, version: seat.version, role: seat.role };
    const devMode = input.devMode === true;
    // A write's provenance: a dev-mode run states its mark and the caller it admitted; a run in
    // force takes an earlier mark off only when the owner makes it. Another caller's write in
    // force changes nothing about the mark — a seat's `reload` or a lead's `restart` is routine,
    // and it does not answer the finding the mark raises.
    //
    // The delegation is stated beside it: a delegated run records the owner as the signer (the
    // approved `delegates` section is the authority) and the pane the gate passed as the actor,
    // bounded to the command it names. The owner's own write in force takes an earlier mark off —
    // the last write was not a delegate's; another caller's routine write leaves it, as it leaves
    // the dev-mode mark.
    const delegation: AgentDelegation | null | undefined = input.delegated === undefined
      ? input.owner === true ? null : undefined
      : { signer: 'owner', actor: input.delegated.actor, command: input.delegated.command };
    const provenance: AgentProvenancePatch = {
      ...(devMode ? { dev_mode: true, dev_mode_by: by } : input.owner === true ? { dev_mode: false } : {}),
      ...(delegation === undefined ? {} : { delegated: delegation }),
    };
    const stated = Object.keys(provenance).length === 0 ? undefined : provenance;
    const agent = known
      ? updateAgent(home, known.id, {
        name: seat.name, signing, lab: seat.vendor, cli: seat.cli, launch: seat.launch, lifecycle: 'running', reach,
        // The declaration and this launch both name the seat again: the current orphan marker
        // comes off the live record with its id and signed settings kept. Only the current mark
        // is cleared; the record and its signed entries stay.
        orphaned_at: null,
        ...(stated === undefined ? {} : { provenance: stated }), ...seatHandle,
      })
      : registerAgent(home, {
        name: seat.name, signing, lab: seat.vendor, cli: seat.cli, launcher: null, launch: seat.launch,
        reach, mcp: [], skills: [], lifecycle: 'running', by, devMode,
        ...(delegation === undefined || delegation === null ? {} : { delegated: delegation }), ...seatHandle,
      });
    if (priorSeat) writeRoster(input, teamId, priorSeat, null);
    writeRoster(input, teamId, seat.name, { agent: agent.id, role: seat.role });
    recordProjectLead(input, teamId);
    return { id: agent.id };
  } catch (error) {
    return { note: noteOf(error) };
  }
}

/**
 * Creates the record of a seat the team file declares but that has never launched: the first
 * write the bootstrap ruling names. The identity words come from the declaration, so nothing is
 * invented; the record is `registered` with no pane, session address or state touched, so no
 * launch, attach or typed key happens here. A later launch finds this record by (team, seat) and
 * keeps its id, so the settings signed before it are the ones the seat runs with.
 */
export function registerDeclaredSeat(input: RegistryTeam, seat: Seat): { id: string } | { note: string } {
  try {
    const agent = registerAgent(input.home, {
      name: seat.name,
      signing: { model: seat.model, version: seat.version, role: seat.role },
      lab: seat.vendor,
      cli: seat.cli,
      launcher: null,
      launch: seat.launch,
      reach: { team: teamIdOf(input.root), seat: seat.name, session: input.team.session, pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      by: input.by,
    });
    return { id: agent.id };
  } catch (error) {
    return { note: noteOf(error) };
  }
}

/**
 * Marks the retained record of a seat the team file no longer declares: the bootstrap ruling's
 * orphan marker. Nothing is deleted and no signed entry is touched, so every setting stays
 * readable; a record already marked is left as it is. A team file that does not load declares
 * nothing here, so no file this build cannot read can orphan a record.
 */
export function markOrphanedSeats(home: string, root: string, now: Date): string[] {
  const marked: string[] = [];
  let declared: Set<string>;
  try {
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) return marked;
    declared = new Set(loaded.team.seats.map((seat) => seat.name));
  } catch {
    return marked;
  }
  const teamId = teamIdOf(root);
  for (const agent of readAgents(home)) {
    if (agent.reach.team !== teamId || declared.has(agent.reach.seat) || agent.orphaned_at != null) continue;
    try {
      updateAgent(home, agent.id, { orphaned_at: now.toISOString() });
      marked.push(agent.id);
    } catch {
      // The next pass retries; a record this build cannot write marks nothing now.
    }
  }
  return marked;
}

/**
 * A seat was renamed from `fromSeat` to `toSeat`: its agent record keeps the same `agt_…` id
 * (so grants keyed by agent id continue to cover the seat) while `name` and `reach.seat` move
 * to `toSeat` and the team's roster is re-keyed. Returns `{ id }` when an agent record was
 * updated, `{ id: null }` when no live agent record existed yet, or `{ note }` on failure.
 */
export function registerRename(
  input: RegistryTeam,
  fromSeat: string,
  toSeat: string,
  handle?: string,
): { id: string | null } | { note: string } {
  try {
    const { home, team } = input;
    const teamId = teamIdOf(input.root);
    const known = findAgent(home, {
      team: teamId,
      seat: fromSeat,
      seatHandle: SEAT_HANDLE.test(handle ?? '') ? handle : null,
    });
    if (!known) return { id: null };
    const seat = team.seats.find((candidate) => candidate.name === toSeat);
    const seatHandle = SEAT_HANDLE.test(handle ?? '') && !known.seat_handle ? { seat_handle: handle as string } : {};
    const updated = updateAgent(home, known.id, {
      name: toSeat,
      reach: { ...known.reach, seat: toSeat },
      ...seatHandle,
    });
    writeRoster(input, teamId, fromSeat, null);
    writeRoster(input, teamId, toSeat, { agent: updated.id, role: seat?.role ?? updated.signing.role });
    recordProjectLead(input, teamId);
    return { id: updated.id };
  } catch (error) {
    return { note: noteOf(error) };
  }
}

/**
 * A seat's agent ended. `stopped` keeps the seat in the roster (the file still names it, and it
 * comes back as the same agent); `retired` ends the agent and takes the seat out of the roster.
 * Its pane is cleared either way: the pane is gone, and a later `send` must not type into whatever
 * the host reuses its id for. Nothing is written for a seat the registry never knew, nor for one
 * whose agent lives in another session than the one the command acted on.
 *
 * The session registry's record ends first, whatever the agent registry knows: the session is
 * the CLI process this command stopped, and its record names why (`why`, the word the design
 * note fixes). A registry that cannot be written is a note, as above; the end still happened.
 */
export function registerEnd(
  input: RegistryTeam,
  seat: string,
  ending: Ending,
  why: SessionEndReason = 'owner-stop',
): { note: string } | null {
  const notes: string[] = [];
  const closed = endSession({
    home: input.home,
    root: input.root,
    team: input.team,
    session: input.session ?? input.team.session,
    seat,
    reason: why,
  });
  if ('note' in closed) notes.push(closed.note);
  try {
    const teamId = teamIdOf(input.root);
    const known = findAgent(input.home, { team: teamId, seat });
    if (!known) return notes.length === 0 ? null : { note: notes.join('; ') };
    // A stop in one session never ends the agent that now lives in another: the (team, seat) is
    // one agent, and its `reach.session` says where it is. Absent, the command acted on the file's.
    if (known.reach.session !== (input.session ?? input.team.session)) {
      return notes.length === 0 ? null : { note: notes.join('; ') };
    }
    // A retired seat's declaration is gone with its roster line: the record is retained and
    // marked orphaned, never deleted, so its signed settings stay readable.
    updateAgent(input.home, known.id, {
      lifecycle: ending,
      reach: { ...known.reach, pane: null },
      ...(ending === 'retired' ? { orphaned_at: new Date().toISOString() } : {}),
    });
    if (ending === 'retired') writeRoster(input, teamId, seat, null);
    return notes.length === 0 ? null : { note: notes.join('; ') };
  } catch (error) {
    notes.push(noteOf(error));
    return { note: notes.join('; ') };
  }
}

/**
 * A session that is not running: every agent of the team that was launched in it is stopped and
 * its pane cleared, whether or not the state still knew its seat. Used by `down` for a session
 * found already dead. Agents of the team in another session are left as they are.
 *
 * Every open session record the registry holds for this team and herdr session ends too, as
 * `owner-stop`: the command stopped a session whose processes are gone.
 */
export function registerSessionEnd(input: RegistryTeam, why: SessionEndReason = 'owner-stop'): { note: string } | null {
  const notes: string[] = [];
  const closed = endSession({
    home: input.home,
    root: input.root,
    team: input.team,
    session: input.session ?? input.team.session,
    reason: why,
  });
  if ('note' in closed) notes.push(closed.note);
  try {
    const teamId = teamIdOf(input.root);
    const session = input.session ?? input.team.session;
    for (const agent of readAgents(input.home)) {
      if (agent.reach.team !== teamId || agent.reach.session !== session || agent.lifecycle !== 'running') continue;
      updateAgent(input.home, agent.id, { lifecycle: 'stopped', reach: { ...agent.reach, pane: null } });
    }
    return notes.length === 0 ? null : { note: notes.join('; ') };
  } catch (error) {
    notes.push(noteOf(error));
    return { note: notes.join('; ') };
  }
}

/** One seat `up` left standing, as this run read its outcome. */
export type RunSeat = {
  seat: Seat;
  /** The pane of a seat this run left ready: it is registered, or re-pointed there. */
  pane: string | null;
  handle?: string;
  agent_session?: string;
  /** The pane a launch this run positively started (its session began) and then left short of
   *  ready, without this run closing it: the record follows that pane, never claiming ready. */
  partial?: { pane: string };
  /** This run confirmed a close and no launch it started survives on a pane: the route the
   *  record held is dead. Only the scoped route goes; the agent id, signed settings and
   *  conversation stay. */
  closed?: true;
};

/** The seats `up` left standing, written once at the end of its run. A seat the file stops is
 *  ended as `stopped`; a ready one is registered or re-pointed, and so is one a launch this run
 *  positively started and left short of ready on a pane that survives. A seat not yet ready with
 *  no such outcome keeps the record its launch wrote: only a real stop or `down` ends a session,
 *  and a bare stage word never moves a route. A seat this run confirmed closed, with no started
 *  successor on a pane, has that dead route ended while its agent id, signed settings and
 *  conversation stay readable. The team record is stopped when no seat is left running. */
export function registerRun(
  input: RegistryTeam,
  seats: ReadonlyArray<RunSeat>,
): string[] {
  const notes: string[] = [];
  let running = 0;
  for (const { seat, pane, handle, agent_session, partial, closed } of seats) {
    if (seat.stopped) {
      const ended = registerEnd(input, seat.name, 'stopped');
      if (ended) notes.push(ended.note);
      continue;
    }
    // A seat still finding its feet has a live session, even when this run did not see it ready:
    // ending it here would close a record the process still fills, with no start to reopen it.
    // The plan's own outcome decides the pane; a null one alone still ends nothing.
    const route = pane ?? partial?.pane;
    if (route !== null && route !== undefined) {
      const made = registerLaunch(input, seat, route, handle, agent_session);
      if ('note' in made) notes.push(made.note);
      // A started partial launch is a live session: it counts as running even without readiness.
      else running += 1;
      continue;
    }
    // The close was confirmed and no started successor survives: the record's route is dead.
    if (closed === true) {
      const ended = registerEnd(input, seat.name, 'stopped');
      if (ended) notes.push(ended.note);
    }
  }
  try {
    const teamId = teamIdOf(input.root);
    if (running === 0 && getTeam(input.home, teamId)) setTeamLifecycle(input.home, teamId, 'stopped');
  } catch (error) {
    notes.push(noteOf(error));
  }
  return notes;
}
