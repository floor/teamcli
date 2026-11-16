// Correction 2026-11-11: rebind one recorded CLI even during its turn,
// without planning any launch or closure. Reuse the address-refresh pane/process/socket
// proof and the existing fenced dual-store writer; this module admits no caller itself.
import { evictHerdrAgentList, evictHerdrPaneProcessInfo } from '../herdr.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { logLine } from '../log.ts';
import { refuse, writeJson } from '../output/index.ts';
import { findAgent, recordProvenSeatConversation, recordRebootRebind } from '../registry/agents.ts';
import { rebootRebindProof, type RebootRebind } from '../launch/reboot-rebind.ts';
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
  if (seat.human || seat.stopped || seat.cli !== 'claude-code') return fail('only a running Claude Code seat with a socket can be rebound');
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
  if ('error' in placed || placed.pane !== held.pane) return fail('the live agent is not uniquely placed on its recorded pane');
  const reports = live?.filter((one) => one.pane === held.pane) ?? [];
  const conversation = reports.length === 1 ? reports[0]?.session : undefined;
  if (conversation === undefined || !conversation.trim() || /\s/.test(conversation)) return fail('the pane does not report one readable conversation');
  evictHerdrPaneProcessInfo(held.pane, aim);
  const measured = launch.processInfo?.(session, held.pane) ?? null;
  // Working is not a refusal: no input, exit, close or launch is being attempted.
  let reboot: Extract<RebootRebind, { ok: true }> | null = null;
  if (seatProcessVerdict(held.launched, measured) !== 'same') {
    // A machine restart leaves no recorded pid alive. The restored pane is the seat only when the
    // record's launch predates this boot and the pane holds exactly the recorded conversation.
    const proof = rebootRebindProof({
      cli: seat.cli,
      launched: held.launched,
      paneShellStart: held.pane_shell_start,
      recordedSession: held.agent_session,
      processes: measured,
      foreground: launch.foreground(session, held.pane),
      liveSession: conversation,
      startOf: launch.processStartOf ?? processStartOf,
    });
    if (!proof.ok) return fail(proof.why);
    reboot = proof;
  }
  const address = liveSocketOf(agent.reach.address, measured, sources.sockets ?? defaultSocketsDirs());
  const inbound = declaredInboundOf({ dir, root, session, seat: seat.name, launch: agent.launch });
  const socketOk = address !== null && inboundStaleReason(inbound, address) === null;
  // A restored pane may not have its channel back yet: the rebind ties the pane and clears the
  // dead address, and the next register or send re-reads the socket. A live pid needs a socket.
  if (!socketOk && reboot === null) return fail('the pane has no live socket with a current inbound declaration');
  evictHerdrAgentList(aim);
  const fresh = launch.agents(session);
  const samePane = fresh?.filter((one) => one.pane === held.pane) ?? [];
  if (fresh?.filter((one) => one.name === seat.name).length !== 1 || samePane.length !== 1
    || samePane[0]?.name !== seat.name || samePane[0]?.agent !== reports[0]?.agent || samePane[0]?.session !== conversation) {
    return fail('the live conversation changed while its pane proof was being read');
  }
  return { ok: true as const, agent, held, conversation, address: socketOk ? address : null, reboot };
}

export function runSeatRebind(input: {
  root: string; dir: string; session: string; team: TeamFile; seat: Seat; sources: UpSources;
  dry: boolean; json: boolean; io: Io; actor: string;
}): number {
  const { root, dir, session, seat, sources, dry, json, io } = input;
  const lock = dry ? null : acquireRunLock(dir, session);
  if (lock !== null && !('release' in lock)) {
    refuse(io, json, 'up', { id: 'up.run-lock', message: runLockText(lock.held, session, dir, lock.startedAt), repair: null });
    return 1;
  }
  try {
    const proof = proveSeatRebind(input);
    if (!proof.ok) {
      refuse(io, json, 'up', { id: 'up.rebind-proof', message: `${seat.name}: ${proof.why}; nothing was changed`, repair: null });
      return 1;
    }
    const changed = proof.reboot !== null || proof.conversation !== proof.agent.reach.agent_session || proof.address !== proof.agent.reach.address;
    const written = dry || !changed ? true : proof.reboot !== null
      ? recordRebootRebind(sources.home, proof.agent, dir, proof.held, {
        launched: proof.reboot.launched, paneShell: proof.reboot.shell, paneShellStart: proof.reboot.shellStart, address: proof.address,
      })
      : proof.address !== null && recordProvenSeatConversation(sources.home, proof.agent, dir, proof.held, proof.conversation, proof.address);
    if (!written) {
      refuse(io, json, 'up', { id: 'up.rebind-changed', message: `${seat.name}: its state or registry snapshot changed; nothing was rebound`, repair: null });
      return 1;
    }
    const across = proof.reboot !== null ? ' across the machine restart (its launch predates this boot)' : '';
    const detail = `${seat.name}: ${dry ? changed ? 'would rebind' : 'already bound' : changed ? 'rebound' : 'already bound'} to the live conversation on its recorded pane${across}; no process was stopped or launched`;
    if (!dry && changed) logLine(dir, 'up', input.actor, detail, sources.now?.() ?? new Date());
    if (json) writeJson(io, 'team.up', { format: 1, dry_run: dry, status: dry ? 'dry-run' : 'ready',
      action_summary: detail, project: input.team.project, session, seats: [seat.name],
      plan: [], notes: [detail], rebind: { seat: seat.name, changed, applied: !dry && changed, ...(proof.reboot !== null ? { reboot: true } : {}) } });
    else io.stdout(`${detail}\n`);
    return 0;
  } catch (error) {
    refuse(io, json, 'up', { id: 'up.rebind-write', message: `${seat.name}: could not complete the rebind (${error instanceof Error ? error.message : String(error)})`, repair: null });
    return 1;
  } finally { if (lock !== null && 'release' in lock) lock.release(); }
}
