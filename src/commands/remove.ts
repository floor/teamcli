import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, rosterApprovalText, verifyClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { recordSeatDigestOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { charterGate } from '../charter/check.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { gateVerdict } from '../permissions/who.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
import { devModeCallerGate, devModeExpiryNote, devModeFileApproval, devModeOwnerLift, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { isLeadSeat } from '../file/sections/lead.ts';
import { plainLine } from '../launch/plain.ts';
import { entityGrantAdmits, grantGate, logGranted, readEntityCreateGrants } from '../grant.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { markStopped, takeOut } from '../file/lines.ts';
import type { Problem, Seat } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { agentRename, paneForeground, paneForegroundCwd } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { executePlan } from '../launch/execute.ts';
import type { Host } from '../launch/execute.ts';
import { downPlan, type DownSeat } from '../launch/plan.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { readCodexEndpointRecord } from '../daemon/presence/endpoint-record.ts';
import { emptySession, readState, updateState, withLock } from '../state.ts';
import { registerEnd } from '../registry/sync.ts';
import { keyExit, paneStillRunning, realSources as downSources, stateOf, stateOfPane, typeExit, type DownSources } from './down.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { removeRulesFile } from '../launch/rules-file.ts';
import { resetCliHookState } from '../launch/cli-hook.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { plainText } from '../launch/plain.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { readTeamText, writeTeamText } from '../file/team-text.ts';

export type RemoveSources = DownSources & {
  /** Foreground process names in the pane, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Best effort: rename the pane's agent to a free name, so it no longer answers the seat's.
   *  Used only by the unrecognised-screen removal below. Optional: a source that does not carry
   *  herdr's rename leaves the pane under the seat's name, and the run says so and proceeds. */
  renameAgent?(session: string, pane: string, name: string): boolean;
  /** Approval store home. The real command uses the owner's home. */
  home?: string;
  /** The credential store a charter signature is confirmed against. Absent: the system one. */
  ownerSeatStore?: OwnerSeatKeyStore;
  // The approval store's one read, done before anything is stopped or written and reused by the
  // amending branch, overridable so a test can count it or swap the record after the read.
  standing?(root: string): Standing;
  // The delegate gate, overridable so a test can hand a delegated run its verdict. Absent: the
  // real gate (`src/delegate.ts`).
  delegateGate?: typeof delegateGate;
  // The grant gate, overridable so a test can hand a granted swap its verdict. Absent: the real
  // gate (`src/grant.ts`).
  grantGate?: typeof grantGate;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: RemoveSources = {
  ...downSources,
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  renameAgent: (session, pane, name) => agentRename(pane, name, aim(session)),
  foregroundCwd: (session, pane) => paneForegroundCwd(pane, aim(session)),
};

export const USAGE = 'Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>] [--json]\n       team remove <name> --client <grant-file> --key <client-key> --team <team> [--json]\n\nThe --client form is for a client with no terminal that the owner signed a manager bundle grant carrying remove for one team (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle manager --request): it removes a seat of that one team, as signed, and nothing else. It never prompts, is never the owner, and takes no --keep, --abandon, --file or --session. It never removes a human\'s pane, the orchestrator or the operator, and does not touch the approval record: the roster change is for the owner to approve with the owner seat, and the run says so.\n\nExits 0 when the seat is removed (or stopped for a swap), 1 when removal is refused or fails, 2 when the invocation or team file can\'t be read.\n';

/** The gate's refusal as this command prints it: the verdict's own sentence behind the prefix,
 *  and the verdict's own contract row under `--json`. Both delegate branches print it — the
 *  caller rule's below and the owner-only flags' — so the exit ids sit at one site. */
function delegateRefused(io: Io, json: boolean, verdict: { id: string; text: string }): number {
  refuse(io, json, 'remove', { id: verdict.id, message: verdict.text, repair: null });
  // exit: remove.delegate-approval
  // exit: remove.delegate-evidence
  // exit: remove.delegate-placement
  // exit: remove.delegate
  // exit: remove.delegate-command
  // exit: remove.delegate-flag
  return 1;
}

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working; left as it is',
  blocked: 'is blocked at a prompt, which team never answers',
  unknown: 'shows a screen the profile does not recognise; left as it is',
  unsent: 'holds unsent text in its input box; left as it is',
  // Unreachable: an exited seat is closed, never refused, so no line reads this entry. It is
  // here because the type names a clause for every state.
  exited: 'its CLI had exited; closed without typing',
};

/** Whether the seat's state carries a readable managed Codex endpoint record. Shape alone is
 *  enough here: the record names an ownership claim, and this command either proves the claim
 *  before stopping the process or refuses to go on. */
function recordedEndpointOf(dir: string, session: string, seat: string): boolean {
  try {
    return readCodexEndpointRecord(readState(dir).sessions[session]?.seats[seat]?.codex_endpoint) !== null;
  } catch {
    return false;
  }
}

/** The one refusal a managed Codex seat's endpoint can end a removal with: a path that leaves
 *  the pane running cannot keep the record, and a stop that cannot prove the recorded process
 *  is never forced. Both leave the seat, its record and the endpoint as they are. */
function refuseEndpoint(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'remove', { id: 'remove.endpoint', message, repair: null });
  // exit: remove.endpoint
  return 1;
}

export const remove: Command = (argv, io) => runRemove(argv, io, realSources);
export default remove;

/** A free name for the agent a non-owner's removal leaves in its pane: `<name>-left`, then
 *  `-left-2`, `-left-3`, … The names in use are the file's seats, the session's state records and
 *  the live agents. herdr refuses a name that is taken (`agent_name_taken`), so one attempt on a
 *  name nothing holds is what makes the rename land; this only avoids a collision the caller can
 *  already see. */
function leftName(name: string, taken: Set<string>): string {
  let candidate = `${name}-left`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${name}-left-${n}`;
  return candidate;
}

/** Whether `name` is one the mint above can produce: `<base>-left`, or `<base>-left-<n>` with
 *  n ≥ 2 (`leftName` counts collisions from 2 up). Name-shaped on purpose: the base may no
 *  longer be a seat the file declares — the leftover outlives its seat — so the reads that meet
 *  these names outside the file can go on nothing else. */
export function leftoverName(name: string): boolean {
  const match = /^(.+)-left(?:-(\d+))?$/.exec(name);
  if (match === null) return false;
  return match[2] === undefined || Number(match[2]) >= 2;
}

/** The file edit `remove` would write, or null when that edit is valid or changes nothing. */
function editProblems(path: string, name: string, keep: boolean, home: string): Problem[] | null {
  const text = readTeamText(path, { home });
  const next = keep ? markStopped(text, name) : takeOut(text, name);
  if (next === text) return null;
  const parsed = validateTeamFile(next);
  return parsed.ok ? null : parsed.errors;
}

export async function runRemove(argv: string[], io: Io, sources: RemoveSources = realSources): Promise<number> {
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  // The one refusal of the client form, at every site.
  const clientRefused = (message: string): number => {
    refuse(io, json, 'remove', { id: 'remove.client-refused', message, repair: null });
    // exit: remove.client-refused
    return 1;
  };
  const args = readArgs(argv, ['session', 'file', 'client', 'key', 'team'], ['keep', 'abandon', 'json']);
  // The lines plain output writes while it works (the stop's own lines) ride on the document as
  // notes under `--json`; nothing provisional or working reaches the terminal in that mode.
  const jsonNotes: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) if (line !== '') jsonNotes.push(line);
  };
  let noteIo: Io = json
    ? { ...io, stdout: (text: string) => collect(text), stderr: (text: string) => collect(text) }
    : io;
  const clientProblem = args.error === undefined && args.rest.length === 1
    ? clientFormProblem(args.values, 'team remove <name> --client <grant-file> --key <client-key-file>')
      ?? (args.values.client !== undefined && args.values.team === undefined
        ? '--client needs --team <team>: a roster change names the one team it is for'
        : args.values.client !== undefined && (args.values.file !== undefined || args.values.session !== undefined || args.flags.has('keep') || args.flags.has('abandon'))
          ? "--client removes a seat of the one team its grant names: --file, --session, --keep and --abandon are the owner's and take no --client"
          : null)
    : null;
  if (args.error || args.rest.length !== 1 || clientProblem !== null) {
    refuse(io, json, 'remove', {
      id: 'remove.invocation',
      message: args.error ?? (args.rest.length > 1 ? `unexpected "${args.rest[0]}"` : args.rest.length === 0 ? 'a seat name is required' : clientProblem ?? 'the invocation cannot be read'),
      repair: null,
      usage: USAGE,
    });
    // exit: remove.invocation
    return 2;
  }
  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything else is read — before the terminal check below, which no
  // client has a record for. The verified run is the second door past the caller gates, never the owner's:
  // it is logged as `client:<id>`, takes no owner-only flag, and leaves the approval record as it is.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const verified = verifyClientForm({ home: sources.home ?? homedir(), now: at, io }, { op: 'remove', values: args.values, cwd: io.cwd });
    if (!verified.ok) {
      auditClientRefusal('remove', verified.named, verified.why, at);
      return clientRefused(plainLine(verified.why));
    }
    clientRun = verified.run;
    io = { ...io, cwd: verified.run.root };
    noteIo = json ? { ...io, stdout: (text: string) => collect(text), stderr: (text: string) => collect(text) } : io;
    if (!json) io.stderr(`client grant ${clientRun.grant.grantId}: ${clientRun.grant.clientId} for team ${clientRun.grant.up.project} at ${clientRun.root}, until ${clientRun.grant.expires}\n`);
  }
  // No create-grant admits a run with no terminal: the record matches the caller's own registry
  // record, and a caller outside herdr has none. This sentence is answered before any file is
  // read, as `down` and `init` ask it —
  // `test/owner-no-tty-boundaries.test.ts` throws at every read past a refusal and pins that
  // order.
  const charter = clientRun !== null ? { kind: 'absent' as const } : charterGate(sources.home ?? homedir(), { operation: 'remove', cwd: io.cwd }, sources.ownerSeatStore);
  if (charter.kind === 'block') {
    refuse(io, json, 'remove', { id: 'remove.charter', message: charter.message, repair: null });
    // exit: remove.charter
    return 1;
  }
  const charterAdmitted = charter.kind === 'admit';
  const detached = clientRun !== null || charterAdmitted ? undefined : detachedRefusal(walkCaller(io), { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    refuse(io, json, 'remove', { id: 'remove.detached', message: detached, repair: null });
    // exit: remove.detached
    return 1;
  }
  const name = args.rest[0] ?? '';
  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor leave
  // its `last_valid` in that project's state. The one place every command whose `--file` is the owner's
  // decides it is `fileOwnerRefusal` (caller.ts).
  //
  // A `delegates` section hands these owner-only flags to the gate as well: a non-owner aiming
  // either is still refused before the flagged file or the flag's session is read — never the
  // walk's sentence but the gate's verdict, which names the flag for the approved delegate and
  // the caller for anyone else. The eligibility that asks is the default live file's alone, so
  // the flagged file is not read at all; with no `delegates` section there, today's refusal
  // stands, byte for byte.
  const walked = args.values.session !== undefined ? walkCaller(io) : undefined;
  const fileFlagRefusal = fileOwnerRefusal(io, args.values.file);
  const flagRefusal = fileFlagRefusal
    ?? (walked !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) {
    const named = readTeamConfig(io.cwd, { ...(sources.home ? { home: sources.home } : {}) });
    if (named.ok && named.team.delegates) {
      const flagged = (sources.delegateGate ?? delegateGate)({
        command: 'remove',
        team: named.team,
        root: named.root,
        dir: dirname(named.path),
        flags: [...args.flags, ...Object.keys(args.values)],
        io,
      });
      if (flagged.kind === 'refused') return delegateRefused(io, json, flagged);
    }
    refuse(io, json, 'remove', {
      id: fileFlagRefusal !== undefined ? 'remove.file-owner' : 'remove.session-owner',
      message: flagRefusal,
      repair: null,
    });
    // exit: remove.file-owner
    // exit: remove.session-owner
    return 1;
  }
  const launched = args.values.file || clientRun !== null ? undefined : launchedTeamFile(io, sources.home);
  const loaded = readTeamConfig(io.cwd, { ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}), ...(sources.home ? { home: sources.home } : {}) });
  if (!loaded.ok) {
    const said = loaded.errors.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`);
    refuse(io, json, 'remove', {
      id: loaded.errors.some((problem) => problem.message.startsWith('not inside a git repository'))
        ? 'remove.not-a-repo'
        : loaded.errors.some((problem) => problem.line > 0) ? 'remove.file-invalid' : 'remove.file',
      message: said.join('\n'),
      repair: null,
    });
    // exit: remove.not-a-repo
    // exit: remove.file
    // exit: remove.file-invalid
    return 2;
  }
  const { team, path, root } = loaded;
  const dir = dirname(path);
  // A client never removes a lead seat (the orchestrator or the operator: swapping them is the owner's)
  // and never a human's pane. Refused before the caller gates, the run lock or any effect.
  if (clientRun !== null) {
    const target = team.seats.find((seat) => seat.name === args.rest[0]);
    const why = isLeadSeat(team, args.rest[0] ?? '')
      ? `${plainLine(args.rest[0] ?? '')} is the team's ${args.rest[0] === team.orchestrator ? 'orchestrator' : 'operator'}: a client grant never removes a lead seat`
      : target?.human === true
        ? `${plainLine(args.rest[0] ?? '')} is a human's pane: a client grant never removes it`
        : null;
    if (why !== null) {
      auditClientRefusal('remove', clientRun.grant, why, sources.now());
      return clientRefused(why);
    }
  }
  // A lead's `--keep` is a swap: the agent on the orchestrator's or the operator's seat
  // is stopped so `team add <lead>` can start its replacement. The file is never edited for it —
  // a lead is never `stopped:` (`file/sections/lead.ts`), and a file whose lead were stopped
  // would refuse every later command until hand-edited — so the seat stays declared and leading
  // through the gap, and the state records the swap (`swapping`) until the add clears it.
  const lead = isLeadSeat(team, name);
  const swap = lead && args.flags.has('keep');
  // The gate judges the caller placed in the session this command asks about — the proof its pane
  // is that session's. With no `--session` the session judged is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose. The refusal names the caller's own
  // placement, exactly as main described it.
  // The gate is the map's (`gateVerdict`), read in the verdict shape the branches below already
  // speak: owner or `leads` for this team, decided from records — the registry roster's line
  // where it stands, the file's own declaration where the registry holds no record of the team,
  // and the standing's pane proof for a seat the map admits.
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, sources.home ?? homedir(), 'remove', at, sources.now);
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team, verdictOf);
  const { caller, shown } = judged;
  // A client run is never the owner's, whatever terminal it stands in.
  const ownerRun = clientRun === null && caller.kind === 'owner';
  const whoText = clientRun === null ? describeCaller(caller) : `client:${clientRun.grant.clientId}`;
  const session = judged.session;
  // Dev mode, from the file this run edits: a `dev-mode` value anywhere in the caller's chain
  // governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value the variable set to
  // exactly `1` keeps its behaviour. The caller line and the approval are folded below, and the
  // delegate and swap gates' approval folds carry their own lines.
  const dev = resolveDevMode('remove', io, {
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    team,
    root,
    now: sources.now(),
  });
  logDevModeState(dir, 'remove', describeCaller(shown), dev, sources.now());
  const verdict = verdictOf(caller, standingOf(dir, session, caller));
  // The delegate branch, tried only when the ordinary rule just refused and the file names a
  // delegate at all: with no `delegates` section every refusal below stays exactly today's, and
  // the gate is never asked. A refused verdict takes the ordinary refusal's place; a passed one
  // sends this run on as the approved delegate's — the gate has by then verified the approval,
  // the approved copy, the drift and the placement, that this caller is the entry's pane, that
  // `remove` is in its list and that no flag of the owner's was passed. The rest of this command
  // is then a delegated run: an ordinary removal of a named seat, never `--keep` (the gate
  // refused it, so nothing re-signs the approval), the orchestrator and the operator still
  // refused below, and `logDelegated` attributing it at its effects.
  let delegatePane: string | null = null;
  // A create-grant the record holds for this root is the run's admission: the ordinary rule's
  // sentence is then not a refusal, and the delegate gate — which the ordinary refusal alone
  // summons — has nothing to replace. Asked only where the ordinary rule has just refused, and
  // only when a record exists, so a caller with none reads no clock for it, exactly as `down`
  // asks it. `--keep` is not granted: that run re-signs the approval, so only a lead's `--keep`
  // — a swap, which never edits the file — is the ordinary rule's own.
  const createGranted = clientRun !== null || charterAdmitted || (verdict.kind !== 'ok'
    && !(args.flags.has('keep') && !swap)
    && readEntityCreateGrants(sources.home).length > 0
    && entityGrantAdmits(root, io, { home: sources.home, now: sources.now(), cwd: io.cwd }));
  if (verdict.kind !== 'ok' && team.delegates && !createGranted) {
    const decided = (sources.delegateGate ?? delegateGate)({
      command: 'remove',
      team,
      root,
      dir,
      flags: [...args.flags, ...Object.keys(args.values)],
      io,
      // A swap is admitted by the entry's `swap` word alone, and its `--keep` is then the
      // delegate's: `remove` in an entry never reaches a lead.
      ...(swap ? { swap: true } : {}),
      // Dev mode folds the delegation's approval precondition, and the verdict carries the
      // warning naming the live file; the removal then goes on as a delegated one.
      dev,
      file: path,
    });
    if (decided.kind === 'refused') return delegateRefused(io, json, decided);
    delegatePane = decided.pane;
    if (decided.devApproval !== undefined) {
      if (json) collect(decided.devApproval);
      else io.stderr(`team remove: ${decided.devApproval}\n`);
      logDevMode(dir, 'remove', describeCaller(shown), decided.devApproval, sources.now());
    }
  }
  if (verdict.kind === 'no-pane' && delegatePane === null) {
    refuse(io, json, 'remove', { id: 'remove.no-pane', message: noPaneRefusal(verdict.name), repair: null });
    // exit: remove.no-pane
    return 1;
  }
  if (verdict.kind === 'another-pane' && delegatePane === null) {
    refuse(io, json, 'remove', {
      id: 'remove.another-pane',
      message: anotherPaneRefusal(verdict.name, verdict.recordedPane),
      repair: null,
    });
    // exit: remove.another-pane
    return 1;
  }
  if (verdict.kind === 'refused' && delegatePane === null && !createGranted) {
    // The caller gate, the one dev mode lifts for this command (`dev_mode.ts`): on, the
    // refusal's own words print as a warning, the run goes on, and the audit log records the
    // caller it admitted. Every later gate — the lead's seat, the placement in the session —
    // still refuses; the owner-only abandon below has its own dev-mode admission.
    const said = `only the owner or \`leads\` removes a seat; this call is ${describeCaller(shown)}${devModeExpiryNote(dev)}`;
    const folded = devModeCallerGate(dev, said);
    if (folded === null) {
      refuse(io, json, 'remove', { id: 'remove.caller', message: said, repair: null });
      // exit: remove.caller
      return 1;
    }
    if (json) collect(folded);
    else io.stderr(`team remove: ${folded}\n`);
    logDevMode(dir, 'remove', describeCaller(shown), folded, sources.now());
  }
  if (session === 'default') {
    refuse(io, json, 'remove', { id: 'remove.default-session', message: 'session can\'t be "default", herdr\'s own session', repair: null });
    // exit: remove.default-session
    return 1;
  }
  const abandon = args.flags.has('abandon');
  if (abandon && !ownerRun) {
    // The owner's dev-mode admission for exactly this gate: a placed lead or
    // orchestrator continues with the warning; every other caller keeps the refusal.
    const lift = devModeOwnerLift(io, {
      command: 'remove',
      refusal: 'only the owner abandons a seat, from a terminal outside herdr',
      ...(sources.home !== undefined ? { home: sources.home } : {}),
      team,
      root,
      dir,
      now: sources.now(),
    });
    if (!lift.lifted) {
      refuse(io, json, 'remove', { id: 'remove.abandon', message: 'only the owner abandons a seat, from a terminal outside herdr', repair: null });
      // exit: remove.abandon
      return 1;
    }
    io.stderr(`${lift.warning}\n`);
  }
  // A lead is taken out of the file by the owner alone. Its swap — `--keep` — is the owner's,
  // the granted seat's when the grant lists `swap`, or an approved delegate's whose entry lists
  // `swap` (the gate above already required it). Never the seat's own: closing its pane would end
  // this very call before anything starts the replacement, and leave the team without its lead.
  let grantSeat: string | null = null;
  if (lead && !ownerRun) {
    if (!swap) {
      refuse(io, json, 'remove', {
        id: 'remove.coordinator',
        message: `only the owner removes the orchestrator's or the operator's seat; this call is ${whoText}`,
        repair: null,
      });
      // exit: remove.coordinator
      return 1;
    }
    if (caller.kind === 'seat' && caller.name === name) {
      refuse(io, json, 'remove', {
        id: 'remove.swap-self',
        message: `${name} can't swap its own seat: closing its pane would end this call before the new agent starts; the owner, the granted seat or an approved delegate swaps it`,
        repair: null,
      });
      // exit: remove.swap-self
      return 1;
    }
    if (delegatePane === null) {
      const said = (sources.grantGate ?? grantGate)({ act: 'swap', io, home: sources.home, dev });
      if (said.kind === 'refused') {
        refuse(io, json, 'remove', {
          id: 'remove.swap-grant',
          message: `only the owner, the granted seat or an approved delegate swaps the orchestrator's or the operator's seat: ${said.text}`,
          repair: null,
        });
        // exit: remove.swap-grant
        return 1;
      }
      // The gate folded its approval in dev mode: the warning names the file, and the audit log
      // records the caller it admitted before the swap has effects.
      if (said.devApproval !== undefined) {
        if (json) collect(said.devApproval);
        else io.stderr(`team remove: ${said.devApproval}\n`);
        logDevMode(dir, 'remove', describeCaller(shown), said.devApproval, sources.now());
      }
      // The grant names the orchestrator, and the self-swap was refused above: what passes here
      // is the orchestrator swapping the operator's seat.
      grantSeat = said.grant.seat;
    }
  }

  const recorded = readState(dir).sessions[session]?.seats[name];
  const declared = team.seats.find((seat) => seat.name === name);
  if (!declared && !recorded) {
    refuse(io, json, 'remove', { id: 'remove.no-seat', message: `the team has no seat ${JSON.stringify(name)}`, repair: null });
    // exit: remove.no-seat
    return 1;
  }

  const live = sources.sessionRunning(session);
  if (live === null) {
    refuse(io, json, 'remove', { id: 'remove.herdr', message: "herdr doesn't answer; nothing was changed", repair: null });
    // exit: remove.herdr
    return 1;
  }
  const agents = live ? sources.agents(session) : [];
  if (agents === null) {
    refuse(io, json, 'remove', {
      id: 'remove.agents',
      message: `session ${session} runs, and its agents can't be read; nothing was changed`,
      repair: null,
    });
    // exit: remove.agents
    return 1;
  }
  // The seat is the approved copy's. A name that copy carries is declared even when the state
  // still marks it temporary, so an abandon does not take its rules file. A name the copy does
  // not carry is left, unless the owner abandons it.
  const home = sources.home ?? homedir();
  const standing = sources.standing?.(root) ?? approvalStanding(root, home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    // Dev mode's approval fold: on, the live team file this run edits counts as approved, the
    // warning names the file and the caller goes to the audit log; off, today's refusal. The
    // later gates below still refuse.
    const said = notInForce(standing);
    const folded = devModeFileApproval(dev, said, path);
    if (folded === null) {
      refuse(io, json, 'remove', { id: 'remove.never-approved', message: said, repair: null });
      // exit: remove.never-approved
      return 1;
    }
    if (json) collect(folded);
    else io.stderr(`team remove: ${folded}\n`);
    logDevMode(dir, 'remove', describeCaller(shown), folded, sources.now());
  }
  // The live file names the seat. A stored copy is not a second roster.
  const copySeat = team.seats.find((seat) => seat.name === name);
  const temporary = Boolean(recorded?.temporary) && copySeat === undefined;
  if (args.flags.has('keep') && temporary) {
    refuse(io, json, 'remove', { id: 'remove.keep-temporary', message: 'a temporary seat is not in the file; there is nothing to keep', repair: null });
    // exit: remove.keep-temporary
    return 1;
  }
  const listed = agents.filter((item) => item.name === name);
  // A name the live file does not declare. The owner
  // keeps today's refusal, and so does a record with no single live agent, a temporary record,
  // and a name the live file still declares. A caller who is not the owner, meeting one live
  // agent herdr reports idle or done whose screen — read with the cli the record carries — is
  // not a running turn, takes the leave below instead: nothing typed, nothing closed, and the
  // file is not edited. With no recorded cli the screen reads unknown, and idle or done still
  // leaves. A working leftover stays out, and the line names that caller's way.
  let leave = false;
  // Both busy refusals — a working leftover, and a seat this run will not take — print here,
  // so the exit marker has one site.
  let busy: string | undefined;
  if (!copySeat && !abandon) {
    const only = listed.length === 1 ? listed[0] : undefined;
    if (!temporary && declared === undefined && !ownerRun && only) {
      const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, only.pane) : null;
      const screen = sources.screen(session, only.pane, recorded?.cli ?? '', liveCwd);
      const where = stateOf(only.status, screen, recorded?.cli ?? '');
      if (where === 'working' || only.status === 'working') {
        busy = `${name} is working; left as it is (run this again once herdr reports the seat idle or done)`;
      } else if (only.status === 'idle' || only.status === 'done') {
        leave = true;
      }
    }
    if (!leave && busy === undefined) {
      refuse(io, json, 'remove', {
        id: 'remove.unverified',
        message: `${name}: its record is not a declared seat; left as it is (the owner cleans it: team remove ${name} --abandon)`,
        repair: `team remove ${name} --abandon`,
      });
      // exit: remove.unverified
      return 1;
    }
  }
  if (listed.length > 1) {
    refuse(io, json, 'remove', {
      id: 'remove.ambiguous',
      message: `${name}: herdr lists more than one agent of this name; left as it is`,
      repair: null,
    });
    // exit: remove.ambiguous
    return 1;
  }
  const agent = listed[0];
  const cli = copySeat?.cli ?? '';
  // A human's pane is never typed into: no exit line, no key, and no close. The removal takes
  // the seat out of the file and leaves the pane running, saying why in `down`'s words.
  const human = copySeat?.human === true;
  if (agent && human) leave = true;
  // A caller other than the owner, on a seat herdr reports idle or done that this flow cannot ask
  // to leave: `--abandon`'s kind of power scoped to a caller who may not run it — the seat is
  // taken out of the team, the pane is left as it is (nothing typed, nothing closed, and the agent
  // renamed out of the seat's name below), where no state ever frees it otherwise.
  //
  // herdr's own status is the gate, not the screen: idle or done says the seat is not mid-turn,
  // and that signal still reads where a profile cannot — an unrecognised screen, an unreadable
  // pane, a prompt the team never answers, unsent text. A seat herdr reports working, or one whose
  // screen shows a running turn (`stateOf` keeps that working even when herdr's word lags), is the
  // one thing a non-owner never takes out; every other status word keeps the old refusal too. A
  // recognised free seat removes as before, and a box holding exactly the CLI's exit text keeps
  // its clean stop. The owner keeps the refusal, byte for byte, with the way out it names.
  // A leftover leave decided above is already set, and is not recomputed: a free screen on a
  // name the copy does not carry has no profile to stop, so it leaves rather than types.
  // A leftover already marked busy is not recomputed either: this block would drop its way line.
  if (agent && !leave && busy === undefined) {
    const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
    const screen = sources.screen(session, agent.pane, cli, liveCwd);
    // A box that holds exactly the profile's exit text — an earlier run typed it and never
    // confirmed it — is cleared with the profile's one key inside the stop, and the removal
    // then proceeds as on an empty box. The same box on a CLI with no key is named for the
    // owner instead of refused with the generic unsent line.
    const profile = profileFor(cli);
    // The process reading decides "its CLI exited" before the screen is consulted (`down.ts`,
    // `stateOfPane`): the pane's own shell back in front, and no CLI process in its readable
    // foreground list. Such a seat is closed as a free one is — there is nothing in that pane
    // to ask and no key could reach it — by the owner and by an allowed caller alike.
    const where = stateOfPane(agent.status, screen, {
      foreground: sources.foreground(session, agent.pane),
      shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
      processNames: profile?.processNames ?? [],
      cli,
    });
    const holdsExit = where === 'unsent' && profile !== null
      && profile.exit !== null
      && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli), { cwd: liveCwd ?? undefined, home: sources.home });
    const clearable = holdsExit && profile?.exitClear !== null;
    // A lead is never left running under another name: its swap stops a free seat or nothing.
    leave = !lead && !ownerRun && where !== 'free' && where !== 'exited' && where !== 'working' && !clearable
      && (agent.status === 'idle' || agent.status === 'done');
    if (where !== 'free' && where !== 'exited' && !abandon && !clearable && !leave) {
      // A refusal here is the kept safety: herdr reports the seat working, its screen shows a
      // running turn, or the caller is the owner, who keeps these refusals whole — a caller other
      // than the owner meeting an idle or done seat never arrives, the leave took it above. The
      // way out named is the caller's own. A framed exit question already on screen is the same
      // kind of case: this run did not ask it, and the line names the close the caller has.
      const way = where !== 'unknown'
        ? ''
        : ownerRun
          ? ` (team remove ${name} --abandon closes its workspace without typing)`
          : ' (run this again once herdr reports the seat idle or done)';
      const held = screen.kind === 'exit question'
        ? `sits at its own exit question; left as it is (team remove ${name} --abandon closes it)`
        : where === 'unsent' && holdsExit
          ? `holds this CLI's exit text (${profile?.exit}) unsent in its input box; left as it is (the owner sends it or clears it in its pane)`
          : LEFT[where];
      busy = `${name} ${held}${way}`;
    } else if (!profile && !abandon && !leave) {
      refuse(io, json, 'remove', { id: 'remove.no-profile', message: `no launch profile for \`${cli}\`; left as it is`, repair: null });
      // exit: remove.no-profile
      return 1;
    }
  }
  if (busy !== undefined) {
    refuse(io, json, 'remove', { id: 'remove.busy', message: busy, repair: null });
    // exit: remove.busy
    return 1;
  }

  // A managed Codex seat records the endpoint its launch owns. A removal that leaves the pane
  // running keeps that client attached, so the record cannot go with the seat: this run has
  // nowhere else to keep it, and dropping it would orphan a live server. The seat is left as it
  // is, with its record and endpoint intact, rather than removed without them.
  if (leave && recordedEndpointOf(dir, session, name)) {
    return refuseEndpoint(
      io,
      json,
      `${name} records a managed Codex endpoint and this run would leave its pane running; the endpoint record cannot be kept with the seat removed, so it is left as it is`,
    );
  }

  // An edit that will not validate is refused before the seat is stopped. Stopping first would
  // end the live session and then report that nothing was written.
  if (!temporary && !swap) {
    const ahead = editProblems(path, name, args.flags.has('keep'), sources.home ?? homedir());
    if (ahead) {
      refuse(io, json, 'remove', {
        id: 'remove.edit',
        message: ahead.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`).join('\n'),
        repair: null,
      });
      // exit: remove.edit
      return 2;
    }
  }

  // The session mutator lock: this run has effects from here — the delegated audit line, the
  // stop of a running seat below, the file edit and the state drops — and no other session
  // command may interleave its own. Every refusal above is decided first; a `--keep` run never
  // got past the gate. The lock is released on every exit path (`launch/run-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    refuse(io, json, 'remove', { id: 'remove.run-lock', message: runLockText(runLock.held, session, dir), repair: null });
    // exit: remove.run-lock
    return 1;
  }
  try {
    // The client's grant, read once more under its own lock immediately before the first effect (the
    // endpoint stop, the pane's exit, the file edit and the state drops all come after), and its audit
    // line written while that lock is held.
    if (clientRun !== null) {
      const stood = authorizeClientRun(home, clientRun, 'remove', sources.now(), `seat ${name}`);
      if (stood !== null) {
        auditClientRefusal('remove', clientRun.grant, stood, sources.now());
        return clientRefused(plainLine(stood));
      }
    }
    // A seat herdr no longer lists has no CLI left to stop, but the endpoint its launch started
    // may still be alive. It is stopped before the file and state are written; a stop that
    // cannot prove the recorded process refuses the removal and keeps the record that names it.
    if (!agent && sources.codexEndpoint !== undefined && recordedEndpointOf(dir, session, name)) {
      const endpoint = sources.codexEndpoint.stop({ dir, session, seat: name });
      if (!endpoint.stopped) {
        return refuseEndpoint(io, json, `${name}: ${endpoint.why ?? 'its managed Codex endpoint could not be stopped'}; left as it is`);
      }
    }
    // The audit line, exactly at the effects boundary: a delegated run that reaches here is
    // committed to its effects — the stop below when the seat runs, the file edit after it. Every
    // refusal came sooner; a `--keep` run never got past the gate.
    if (delegatePane !== null) logDelegated(dir, delegatePane, swap ? 'swap' : 'remove', sources.now(), swap ? name : undefined);
    if (grantSeat !== null) logGranted(dir, grantSeat, 'swap', sources.now(), name);

    if (agent && !leave) {
      const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
      const screen = sources.screen(session, agent.pane, cli, liveCwd);
      const profile = profileFor(cli);
      // The same process reading as the block above: an exited seat reaches `downPlan` as
      // `exited` and is closed without a key — by the owner and by an allowed caller alike.
      const where = stateOfPane(agent.status, screen, {
        foreground: sources.foreground(session, agent.pane),
        shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
        processNames: profile?.processNames ?? [],
        cli,
      });
      const exitInBox = where === 'unsent' && profile !== null && profile.exitClear !== null && profile.exit !== null
        && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli), { cwd: liveCwd ?? undefined, home: sources.home });
      const stopped = await stopRunning({
        io: noteIo,
        dir, session, sources, logCommand: 'remove', caller: whoText,
        seat: {
          name, cli, pane: agent.pane, workspace: agent.workspace,
          state: copySeat ? (where === 'free' ? 'free' : where) : 'blocked',
          // The leave above already steps over a human's pane; the mark keeps this call from
          // typing into one even if a later path reaches it.
          ...(human ? { human: true as const } : {}),
          ...(exitInBox ? { exitInBox: true } : {}),
          ...(screen.kind === 'exit question' ? { atExitQuestion: true } : {}),
        },
        keep: args.flags.has('keep'),
        abandon: copySeat ? abandon && where !== 'free' : true,
        closeUnasked: abandon,
        unasked: `team remove ${name} --abandon closes it`,
      });
      if (!stopped) {
        // Plain output already carries the stop's own lines; the document names the row.
        if (json) {
          refuse(io, json, 'remove', {
            id: sources.launch ? 'remove.stop-failed' : 'remove.no-launch',
            message: sources.launch
              ? `${name} could not be stopped; left as it is`
              : 'this call has no way to reach herdr',
            repair: null,
          });
        }
        // exit: remove.no-launch
        // exit: remove.stop-failed
        return 1;
      }
    }

    let kept: string | null = null;
    let rewrote: string | null = null;
    if (!temporary && !swap) {
      const refused = withLock(dir, () => {
        const where = { home: sources.home ?? homedir(), command: 'remove' };
        const text = readTeamText(path, where);
        const next = args.flags.has('keep') ? markStopped(text, name) : takeOut(text, name);
        if (next === text) return null;
        const wrote = writeTeamText(path, next, where);
        if (!wrote.ok) return wrote.errors;
        rewrote = next;
        if (args.flags.has('keep')) kept = next;
        return null;
      });
      if (refused) {
        refuse(io, json, 'remove', {
          id: 'remove.locked',
          message: refused.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`).join('\n'),
          repair: null,
        });
        // exit: remove.locked
        return 2;
      }
    }
    if (rewrote !== null) {
      // The reach projection follows the file: a removed seat leaves `reach-roster.json` with it
      // (omission is the revocation signal), and a seat `--keep` stopped stays — the grant is
      // the file's, not the seat's runtime state. A projection problem is a log line, never a
      // refusal: the removal itself is done.
      const refreshed = validateTeamFile(rewrote);
      if (refreshed.ok && sources.home) {
        const projectionNote = reachProjectionNote(writeReachProjection(refreshed.team, sources.home));
        if (projectionNote) logLine(dir, 'remove', whoText, projectionNote, sources.now());
      }
    }
    if (kept !== null) {
      const parsed = validateTeamFile(kept);
      // A delegated remove never re-signs the approval: `--keep` is the gate's to refuse, and the
      // signing itself stays the owner's for a delegate whatever reached here.
      if (parsed.ok && standing.kind === 'verified' && delegatePane === null) recordSeatDigestOf(standing, parsed.team, root, name, home);
    }
    const hadRetained = Boolean(readState(dir).sessions[session]?.retained_seats?.[name]);
    if ((recorded && (!agent || leave)) || (!args.flags.has('keep') && hadRetained)) {
      updateState(dir, (file) => {
        const current = file.sessions[session];
        if (!current) return;
        const prior = current.seats[name];
        if (args.flags.has('keep') && prior?.id && !prior.temporary) {
          (current.retained_seats ??= {})[name] = {
            id: prior.id,
            ...(prior.last_active ? { last_active: prior.last_active } : {}),
          };
        } else if (!args.flags.has('keep') && current.retained_seats) {
          delete current.retained_seats[name];
        }
        delete current.seats[name];
      });
    }
    // The seat's own hook reading goes with its record: a `working` left by a turn the stop
    // interrupted must not answer for a seat this run stopped or removed — a `--keep` entry is
    // stopped too, so it is no longer mid-turn.
    resetCliHookState(dir, session, [name]);
    // The swap's record: the gap is a replacement in progress, not a lost lead. Written after the
    // stop, so a refused or failed stop leaves no record; `add` clears it once the seat runs.
    if (swap) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        (current.swapping ??= {})[name] = { by: whoText, at: sources.now().toISOString() };
      });
    }
    // A temporary seat's rules file goes with the seat: nothing of it is left in the state
    // folder. A declared seat's stays — a stopped seat comes back to its own file. No home set
    // is a test that stands in for no store at all. The remover builds the path itself, from the
    // live project and the seat's name, and walks the writer's checked chain.
    if (temporary && sources.home) {
      removeRulesFile(sources.standing?.(root) ?? approvalStanding(root, sources.home), name, root, sources.home, team.project);
    }
    // The leave's last act: rename the agent out of the seat's name, best effort, so the pane no
    // longer answers a `remove` or a stray-name report as this seat. One attempt on a name the
    // file, the state and the live agents do not hold; a refusal here (or no rename at all) costs
    // the removal nothing, and the line says the pane still carries the seat's name.
    let left: { pane: string; free: string; renamed: boolean } | null = null;
    if (leave && agent) {
      const taken = new Set<string>();
      for (const seat of team.seats) taken.add(seat.name);
      for (const other of Object.keys(readState(dir).sessions[session]?.seats ?? {})) taken.add(other);
      for (const item of agents) {
        const each = item.name;
        if (each) taken.add(each);
      }
      const free = leftName(name, taken);
      left = { pane: agent.pane, free, renamed: sources.renameAgent?.(session, agent.pane, free) ?? false };
    }
    // The registry: `--keep` stops the seat's agent, which the file still names and a later
    // `team add` or `team up` runs again as itself. A removal, a swap or a temporary seat ends the
    // agent for good (retired, out of the roster), so a seat added in its name is a new agent.
    if (sources.home) {
      const ended = registerEnd(
        { home: sources.home, team, root, by: whoText, session },
        name,
        args.flags.has('keep') ? 'stopped' : 'retired',
      );
      if (ended) logLine(dir, 'remove', whoText, ended.note, sources.now());
    }
    const who = whoText;
    const what = temporary ? `removed temporary ${name}` : swap ? `stopped ${name} for a swap` : args.flags.has('keep') ? `stopped ${name}` : `removed ${name}`;
    logLine(dir, 'remove', who, what, sources.now());
    // A client's roster change is the owner's to approve: the run says so, and logs it.
    const roster = clientRun !== null && copySeat !== undefined ? rosterApprovalText('remove', name, clientRun) : null;
    if (roster !== null) logLine(dir, 'remove', who, roster, sources.now());
    const closing0 = swap
      ? `${what}; the file still names it the ${name === team.orchestrator ? 'orchestrator' : 'operator'}: \`team add ${name}\` starts its new agent`
      : left
        ? `${what} (${human ? "the pane is a human's; nothing is typed into it; left running" : `its pane ${left.pane} was left running; nothing was typed`}; ${left.renamed ? `it now reads as ${left.free}` : "it still carries the seat's name"})`
        : what;
    const closing = roster === null ? closing0 : `${closing0}; ${roster}`;
    if (json) {
      // The status says what the run did; the closing line is the summary.
      writeJson(io, 'team.remove', {
        format: 1,
        dry_run: false,
        status: temporary ? 'temporary' : swap ? 'swapped' : args.flags.has('keep') ? 'kept' : 'removed',
        action_summary: closing,
        project: team.project,
        session,
        seat: name,
        notes: jsonNotes,
      });
    } else {
      io.stdout(`${closing}\n`);
    }
    // exit: remove.swapped
    // exit: remove.removed
    // exit: remove.kept
    // exit: remove.temporary
    return 0;
  } finally {
    runLock.release();
  }
}

/** Types the exit, waits for the shell, and closes the workspace. False leaves the seat as it is. */
export async function stopRunning(input: {
  io: Io;
  dir: string;
  session: string;
  seat: DownSeat;
  keep?: boolean;
  abandon: boolean;
  /** The owner's `--abandon`: a seat this call asked, whose exit could not be typed or confirmed, is closed. */
  closeUnasked?: boolean;
  /** Named on the line when that seat is left running. */
  unasked?: string;
  sources: RemoveSources;
  logCommand: string;
  caller: string;
}): Promise<boolean> {
  const launch = input.sources.launch;
  if (!launch) {
    input.io.stderr('team remove: this call has no way to reach herdr\n');
    return false;
  }
  const { seat, session, sources } = input;
  let stopped = false;
  let endpointRefused = false;
  const steps = downPlan({
    session,
    seats: [seat],
    extra: 1,
    watchPid: null,
    keep: [],
    abandon: input.abandon,
    closeUnasked: input.closeUnasked,
    unasked: input.unasked,
  }).filter((step) => step.kind !== 'skip');
  const host: Host = {
    startServer: () => false,
    sessionUp: () => true,
    createWorkspace: () => null,
    paneRun: () => false,
    async typeLine(sessionName, pane, text) {
      // As in `down`: the whole sequence — the pre-existing box, the typing, the read-back, the
      // Enter, and the clearing key an unconfirmed read-back can send — is `typeExit`'s.
      return typeExit({
        typeText: (line) => launch.typeText(sessionName, pane, line),
        sendKey: (key) => launch.sendKey(sessionName, pane, key),
        pressEnter: () => launch.pressEnter(sessionName, pane),
        screen: () => sources.screenText(sessionName, pane, seat.cli),
        status: () => sources.status(sessionName, pane),
        foreground: () => sources.foreground(sessionName, pane),
        foregroundCwd: () => (sources.foregroundCwd ? sources.foregroundCwd(sessionName, pane) : null),
        home: sources.home,
        sleep: sources.sleep ?? launch.sleep,
        now: () => sources.now().getTime(),
      }, seat.cli, text);
    },
    async pressKeys(sessionName, pane, cli, keys) {
      // As in `down`: the whole key sequence is `keyExit`'s.
      return keyExit({
        typeText: (line) => launch.typeText(sessionName, pane, line),
        sendKey: (key) => launch.sendKey(sessionName, pane, key),
        pressEnter: () => launch.pressEnter(sessionName, pane),
        screen: () => sources.screenText(sessionName, pane, cli),
        status: () => sources.status(sessionName, pane),
        foreground: () => sources.foreground(sessionName, pane),
        foregroundCwd: () => (sources.foregroundCwd ? sources.foregroundCwd(sessionName, pane) : null),
        home: sources.home,
        sleep: sources.sleep ?? launch.sleep,
        now: () => sources.now().getTime(),
      }, cli, keys);
    },
    renameAgent: () => false,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    kill: () => false,
    agentPanes(sessionName) {
      const listed = launch.agentPanes(sessionName);
      if (!listed) return null;
      // A pane back at its shell is no longer the seat. The wait keeps an unreadable list
      // (`paneStillRunning`); the watch's quota read asks the other way (`reportedLiveAgent`).
      const names = profileFor(seat.cli)?.processNames;
      if (!names) return listed;
      return listed.filter((pane) => paneStillRunning(sources.foreground(sessionName, pane), names));
    },
    classify: () => 'unknown',
    // The departure wait of a profile herdr cannot report reads the pane's own process.
    foreground: (sessionName, pane) => sources.foreground(sessionName, pane),
    sleep: sources.sleep ?? launch.sleep,
    now: () => sources.now().getTime(),
    allow: () => null,
    record() {},
    running() {},
    drop(dropped) {
      if (dropped !== seat.name) return;
      // The endpoint a managed launch recorded is the launch's, not the pane's: it is stopped
      // now that the CLI has exited, before the record that names it goes. A stop that cannot
      // prove the recorded process is never forced; the record stays and the removal fails.
      if (input.sources.codexEndpoint !== undefined && recordedEndpointOf(input.dir, session, dropped)) {
        const endpoint = input.sources.codexEndpoint.stop({ dir: input.dir, session, seat: dropped });
        if (!endpoint.stopped) {
          endpointRefused = true;
          input.io.stderr(`team remove: ${dropped}: ${endpoint.why ?? 'its managed Codex endpoint could not be stopped'}; left as it is\n`);
          return;
        }
      }
      stopped = true;
      updateState(input.dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[dropped];
        if (input.keep && prior?.id && !prior.temporary) {
          (current.retained_seats ??= {})[dropped] = {
            id: prior.id,
            ...(prior.last_active ? { last_active: prior.last_active } : {}),
          };
        } else if (!input.keep && current.retained_seats) {
          delete current.retained_seats[dropped];
        }
        delete current.seats[dropped];
      });
    },
    say: (line) => input.io.stdout(line),
    log: (who, what) => logLine(input.dir, input.logCommand, input.caller, `${who}: ${what}`, sources.now()),
  };
  await executePlan(steps, session, host);
  return stopped && !endpointRefused;
}
