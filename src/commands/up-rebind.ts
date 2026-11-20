// Correction 2026-11-11: rebind one recorded CLI even during its turn,
// without planning any launch or closure. Reuse the address-refresh pane/process/socket
// proof and the existing fenced dual-store writer; this module admits no caller itself.
import { evictHerdrAgentList, evictHerdrPaneProcessInfo } from '../herdr.ts';
import { reportedAgentIsCli } from '../launch/agent.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { profileFor } from '../profiles/index.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { logLine } from '../log.ts';
import { refuse, writeJson } from '../output/index.ts';
import { findAgent, recordProvenSeatConversation, recordRebootRebind } from '../registry/agents.ts';
import { launchTreeStands, rebootRebindProof, restartedGeneration, sameGeneration, type RebootRebind } from '../launch/reboot-rebind.ts';
import { readProcessParent } from '../process-parent-adapter.ts';
import { processStartOf } from '../watch/pane.ts';
import { teamIdOf } from '../registry/teams.ts';
import { liveSocketOf, defaultSocketsDirs } from '../send/address.ts';
import { declaredInboundOf, inboundStaleReason } from '../send/inbound.ts';
import { livePlacement } from '../send/placement.ts';
import { readState } from '../state.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import type { UpSources } from './up.ts';

export function proveSeatRebind(input: {
  root: string; dir: string; session: string; seat: Seat; sources: UpSources;
}) {
  const { root, dir, session, seat, sources } = input;
  const fail = (why: string) => ({ ok: false as const, why });
  if (seat.human || seat.stopped) return fail('only a running seat can be rebound');
  const agent = findAgent(sources.home, { team: teamIdOf(root), seat: seat.name });
  if (!agent || agent.lifecycle !== 'running' || agent.cli !== seat.cli || agent.reach.session !== session || agent.reach.pane === null) {
    return fail('the running agent record does not hold this seat in this session');
  }
  const held = readState(dir).sessions[session]?.seats[seat.name];
  if (!held || held.pane !== agent.reach.pane || !held.agent_session || held.agent_session !== agent.reach.agent_session) {
    return fail('the state and registry do not agree on the recorded pane and conversation');
  }
  const launch = sources.launch;
  if (launch === undefined) return fail('this call has no live pane reader');
  const aim = session === 'default' ? undefined : session;
  evictHerdrAgentList(aim);
  const live = launch.agents(session);
  const placed = livePlacement({ agents: () => live?.map((one) => ({ name: one.name, pane: one.pane, cli: one.agent })) ?? null }, agent);
  const reports = live?.filter((one) => one.pane === held.pane) ?? [];
  // A host restore keeps the places and clears the names: the recorded pane comes back with an
  // agent the host names for nobody. It is placed when it is the only entry on that pane, the
  // host names no other pane for this seat, and herdr's CLI on it is the recorded one. The name
  // is then given back after the record is written; the proofs below decide whether it is the
  // seat at all.
  const unnamed = 'error' in placed
    && reports.length === 1 && reports[0]?.name === null
    && !(live ?? []).some((one) => one.name === seat.name)
    && reportedAgentIsCli(reports[0]?.agent ?? null, seat.cli, profileFor(seat.cli)?.processNames ?? []);
  if (!unnamed && ('error' in placed || placed.pane !== held.pane)) return fail('the live agent is not uniquely placed on its recorded pane');
  const conversation = reports.length === 1 ? reports[0]?.session : undefined;
  if (conversation === undefined || !conversation.trim() || /\s/.test(conversation)) return fail('the pane does not report one readable conversation');
  evictHerdrPaneProcessInfo(held.pane, aim);
  const measured = launch.processInfo?.(session, held.pane) ?? null;
  // Working is not a refusal: no input, exit, close or launch is being attempted.
  let reboot: Extract<RebootRebind, { ok: true }> | null = null;
  const startOf = launch.processStartOf ?? processStartOf;
  const restarted = restartedGeneration(held.launched, held.pane_shell_start, measured, startOf);
  // Outside a restart the recorded CLI must positively be in front: a bare shell, an unreadable
  // pane or another process never reaches the socket refresh below.
  if (!restarted && !sameGeneration(held.launched, held.pane_shell_start, measured, startOf)) {
    return fail('the pane holds neither the recorded launched CLI process nor a later generation of it');
  }
  if (restarted) {
    // A restart (of the machine, or of the terminal host's session) leaves no recorded pid in
    // front. The restored pane is the seat only when it is a later start than the recorded launch
    // and holds exactly the recorded conversation, reported by no other pane.
    const proof = rebootRebindProof({
      cli: seat.cli,
      launched: held.launched,
      paneShellStart: held.pane_shell_start,
      recordedSession: held.agent_session,
      processes: measured,
      foreground: launch.foreground(session, held.pane),
      liveSession: conversation,
      sessionReports: (live ?? []).filter((one) => one.session === conversation).length,
      startOf,
      parentOf: launch.processParent ?? readProcessParent,
    });
    if (!proof.ok) return fail(proof.why);
    reboot = proof;
  }
  // Outside a machine restart the rebind is the address refresh: a Claude Code seat's socket. Any
  // other CLI (Codex, Cursor, Grok, a Claude Code seat on another provider is still claude-code)
  // has no socket to prove, so only the restart proof — the recorded conversation, the pre-boot
  // launch and the declared CLI in front — ties its pane. A pane that lost its name needs that
  // same strength: the recorded pid in front is not shown to be this seat's pane by a name.
  if (reboot === null && seat.cli !== 'claude-code') {
    return fail('only a Claude Code seat with a socket can be rebound outside a machine restart; this pane does not show the restart proof');
  }
  if (reboot === null && unnamed) {
    return fail('the pane the host restored carries no name, and its process is not shown to be the seat across a machine restart');
  }
  const address = liveSocketOf(agent.reach.address, measured, sources.sockets ?? defaultSocketsDirs());
  const inbound = declaredInboundOf({ dir, root, session, seat: seat.name, launch: agent.launch });
  const socketOk = address !== null && inboundStaleReason(inbound, address) === null;
  // A restored pane may not have its channel back yet: the rebind ties the pane and clears the
  // dead address, and the next register or send re-reads the socket. A live pid needs a socket.
  if (!socketOk && reboot === null) return fail('the pane has no live socket with a current inbound declaration');
  const final: FinalPane = { session, pane: held.pane, seat: seat.name, unnamed, agentKind: reports[0]?.agent ?? null, conversation, reboot };
  const changed = finalPaneHolds(final, sources);
  if (changed !== null) return fail(changed);
  return { ok: true as const, agent, held, conversation, address: socketOk && seat.cli === 'claude-code' ? address : null, reboot, unnamed, final };
}

type FinalPane = {
  session: string; pane: string; seat: string; unnamed: boolean; agentKind: string | null; conversation: string;
  reboot: Extract<RebootRebind, { ok: true }> | null;
};

/**
 * The one final check, taken fresh, before the fenced write and again before a rename: exactly
 * one agent entry on the pane, with the CLI and the name state the proof saw (named for this
 * seat and no other pane so named; or unnamed and no pane named for the seat); the conversation
 * reported by that entry alone in the whole session; and, after a restart, the pane's shell,
 * foreground, births and process tree exactly as about to be recorded. Null when it all holds,
 * else why not.
 */
function finalPaneHolds(input: FinalPane, sources: UpSources): string | null {
  const launch = sources.launch;
  if (launch === undefined) return 'this call has no live pane reader';
  const aim = input.session === 'default' ? undefined : input.session;
  evictHerdrAgentList(aim);
  const agents = launch.agents(input.session);
  if (agents === null) return 'the terminal host agent list cannot be read';
  const onPane = agents.filter((one) => one.pane === input.pane);
  const named = agents.filter((one) => one.name === input.seat);
  const entry = onPane[0];
  if (onPane.length !== 1 || entry === undefined || entry.agent !== input.agentKind || entry.session !== input.conversation
    || (input.unnamed ? entry.name !== null || named.length !== 0 : entry.name !== input.seat || named.length !== 1)) {
    return 'the live conversation changed while its pane proof was being read';
  }
  if (agents.filter((one) => one.session === input.conversation).length !== 1) return 'the conversation is reported by another pane too';
  const reboot = input.reboot;
  if (reboot === null) return null;
  evictHerdrPaneProcessInfo(input.pane, aim);
  const now = launch.processInfo?.(input.session, input.pane) ?? null;
  if (now === null || now.shell !== reboot.launched.shell) return 'the pane\'s processes changed while its restart proof was being read';
  const front = now.foreground.filter((pid) => pid !== now.shell);
  if (front.length !== reboot.launched.cli.length || !front.every((pid) => reboot.launched.cli.includes(pid))) return 'the pane\'s processes changed while its restart proof was being read';
  const startOf = launch.processStartOf ?? processStartOf;
  const starts = reboot.launched.cli_start;
  if (starts === undefined || startOf(now.shell) !== reboot.shellStart || !reboot.launched.cli.every((pid, at) => startOf(pid) === starts[at])) {
    return 'the pane\'s process births changed while its restart proof was being read';
  }
  if (!launchTreeStands(reboot.tree, launch.processParent ?? readProcessParent)) return 'the pane\'s process tree changed while its restart proof was being read';
  return null;
}

type SeatRebindProof = Extract<ReturnType<typeof proveSeatRebind>, { ok: true }>;

/** Whether a proven rebind changes anything the records hold. */
function rebindChanges(proof: SeatRebindProof): boolean {
  return proof.reboot !== null || proof.unnamed || proof.conversation !== proof.agent.reach.agent_session || proof.address !== proof.agent.reach.address;
}

/** Writes a proven rebind through the fenced dual-store writers, then gives an unnamed pane its
 *  name back. The caller holds the session's run lock. `written: false` means a snapshot moved
 *  and nothing was written. */
function applySeatRebind(proof: SeatRebindProof, input: { dir: string; session: string; seat: Seat; sources: UpSources }): { written: boolean; named: string } {
  const { dir, session, seat, sources } = input;
  // The final check runs inside the writer, under the registry and state locks, after both
  // snapshots match and before the first change: a pane that changed while a lock was waited
  // for writes nothing.
  const stillLive = (): boolean => finalPaneHolds(proof.final, sources) === null;
  const written = proof.reboot !== null
    ? recordRebootRebind(sources.home, proof.agent, dir, proof.held, {
      launched: proof.reboot.launched, paneShell: proof.reboot.shell, paneShellStart: proof.reboot.shellStart, address: proof.address,
    }, stillLive)
    : proof.address !== null && recordProvenSeatConversation(sources.home, proof.agent, dir, proof.held, proof.conversation, proof.address, stillLive);
  if (!written) return { written: false, named: '' };
  // The host cleared the pane's name: it is given back once the record names the pane, so a
  // send and the next `up` find the seat by it. A failed rename is said; the record stands.
  if (!proof.unnamed) return { written: true, named: '' };
  // The name is given back only while the readings the record was written from still stand.
  if (finalPaneHolds(proof.final, sources) !== null) {
    return { written: true, named: '; its pane was not named back (its readings changed after the record was written)' };
  }
  const launch = sources.launch;
  return {
    written: true,
    named: launch !== undefined && launch.renameAgent(session, proof.held.pane as string, seat.name)
      ? '; its pane is named back'
      : '; its pane could not be named back (herdr agent rename)',
  };
}

/**
 * `team up`'s own re-anchor, run under the session's run lock before anything is planned or
 * launched (the daemon's boot restore and its attach watch run `team up` too): every running,
 * declared seat whose recorded launch is no longer in front of its pane is rebound when the
 * restart proof holds for it, so a seat a restart carried across is reachable again with nobody
 * typing. Only the restart proof writes here; a seat it refuses is said once and left as it is.
 * No pane is typed into, stopped or launched.
 */
export function rebindRestartedSeats(input: {
  root: string; dir: string; session: string; seats: readonly Seat[]; sources: UpSources; actor: string;
}): string[] {
  const { root, dir, session, sources } = input;
  const launch = sources.launch;
  if (launch?.processInfo === undefined) return [];
  const notes: string[] = [];
  const state = readState(dir).sessions[session]?.seats ?? {};
  for (const seat of input.seats) {
    if (seat.human === true || seat.stopped === true) continue;
    const held = state[seat.name];
    if (held?.pane === undefined || held.launched === undefined || !held.agent_session) continue;
    evictHerdrPaneProcessInfo(held.pane, session === 'default' ? undefined : session);
    if (!restartedGeneration(held.launched, held.pane_shell_start, launch.processInfo(session, held.pane), launch.processStartOf ?? processStartOf)) continue;
    let line: string;
    try {
      const proof = proveSeatRebind({ root, dir, session, seat, sources });
      if (!proof.ok) line = `${seat.name}: not rebound after a restart: ${proof.why}; left as it is`;
      else if (proof.reboot === null) continue;
      else {
        const applied = applySeatRebind(proof, { dir, session, seat, sources });
        line = applied.written
          ? `${seat.name}: rebound to the live conversation on its recorded pane after a restart (its pane is a later start than the recorded launch)${applied.named}; no process was stopped or launched`
          : `${seat.name}: its state or registry snapshot changed; not rebound after a restart`;
      }
    } catch (error) {
      line = `${seat.name}: could not be rebound after a restart (${error instanceof Error ? error.message : String(error)})`;
    }
    logLine(dir, 'up', input.actor, line, sources.now?.() ?? new Date());
    notes.push(line);
  }
  return notes;
}

export function runSeatRebind(input: {
  root: string; dir: string; session: string; team: TeamFile; seat: Seat; sources: UpSources;
  dry: boolean; json: boolean; io: Io; actor: string;
}): number {
  const { seat, sources, dry, json, io } = input;
  const lock = dry ? null : acquireRunLock(input.dir, input.session);
  if (lock !== null && !('release' in lock)) {
    refuse(io, json, 'up', { id: 'up.run-lock', message: runLockText(lock.held, input.session, input.dir, lock.startedAt), repair: null });
    return 1;
  }
  try {
    const proof = proveSeatRebind(input);
    if (!proof.ok) {
      refuse(io, json, 'up', { id: 'up.rebind-proof', message: `${seat.name}: ${proof.why}; nothing was changed`, repair: null });
      return 1;
    }
    const changed = rebindChanges(proof);
    let named = '';
    if (!dry && changed) {
      const applied = applySeatRebind(proof, input);
      if (!applied.written) {
        refuse(io, json, 'up', { id: 'up.rebind-changed', message: `${seat.name}: its state or registry snapshot changed; nothing was rebound`, repair: null });
        return 1;
      }
      named = applied.named;
    } else if (dry && proof.unnamed) named = '; would name its pane back';
    const across = proof.reboot !== null ? ' across a restart (its pane is a later start than the recorded launch)' : '';
    const detail = `${seat.name}: ${dry ? changed ? 'would rebind' : 'already bound' : changed ? 'rebound' : 'already bound'} to the live conversation on its recorded pane${across}${named}; no process was stopped or launched`;
    if (!dry && changed) logLine(input.dir, 'up', input.actor, detail, sources.now?.() ?? new Date());
    if (json) writeJson(io, 'team.up', { format: 1, dry_run: dry, status: dry ? 'dry-run' : 'ready',
      action_summary: detail, project: input.team.project, session: input.session, seats: [seat.name],
      plan: [], notes: [detail], rebind: { seat: seat.name, changed, applied: !dry && changed, ...(proof.reboot !== null ? { reboot: true } : {}) } });
    else io.stdout(`${detail}\n`);
    return 0;
  } catch (error) {
    refuse(io, json, 'up', { id: 'up.rebind-write', message: `${seat.name}: could not complete the rebind (${error instanceof Error ? error.message : String(error)})`, repair: null });
    return 1;
  } finally { if (lock !== null && 'release' in lock) lock.release(); }
}
