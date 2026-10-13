import { readArgs } from '../args.ts';
import { approvalCase, budgetsInForceOf, watchInForceOf } from '../approve/approval.ts';
import { callerOf, describeCaller, fileOwnerRefusal, isOwner } from '../caller.ts';
import { loadReadings, saveSpendReadings, updateReadings, type Seen, type SpendReading } from '../budgets/readings.ts';
import { runChecksOf, type CheckOutcome } from '../budgets/run.ts';
import { currentTeam, rememberCurrent } from '../file/current.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { homedir } from 'node:os';
import { agentStatus, PANE_WINDOW, paneForeground, paneProcesses, paneRead, pressEnter, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { waitOrStop } from '../wait.ts';
import type { Live } from '../status/compare.ts';
import { readMachine, readingsText } from '../watch/machine.ts';
import type { Machine } from '../watch/machine.ts';
import { beatWatch, ownWatchPane, placedWatch } from '../watch/pane.ts';
import { notify } from '../watch/notify.ts';
import { listUnacked } from './messages.ts';
import { newMemory, ownUnsent, pass, type MailboxWaiting } from '../watch/pass.ts';
import { readScreen } from '../watch/screen.ts';
import { judgeTemporary, judgeWorktree } from '../watch/close.ts';
import { readEnd, type EndView } from '../watch/end.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { boxHoldsText, DRAW_WAIT_MS } from '../launch/deliver.ts';
import { removeWorktree } from './worktree.ts';
import { stateOf } from './down.ts';
import type { DownSeat } from '../launch/plan.ts';
import { profileFor } from '../profiles/index.ts';
import { classifyWith, overridesInForceOf, quotaWith, type OverrideForce } from '../profiles/overrides.ts';
import type { Standing } from '../store/store.ts';
import { realSources, standingSource } from './status.ts';

// What the watch reads and does outside its own process, so tests can stand in for it.
export type WatchSources = {
  live(session: string, team: TeamFile): Live | null;
  machine(root: string): Machine;
  // The approval store's one snapshot per pass: the drift line, the watch and
  // budget values in force and the checks all derive from it, so no later read
  // in the same pass can disagree with the first.
  standing(root: string): Standing;
  // What each checked account reads this pass (RFC 0003 § 5). Runs outside the pass, like the
  // machine figures: a command's raw output never leaves this call, and a failure reads unknown.
  readChecks(standing: Standing, team: TeamFile, now: number): CheckOutcome[];
  // The operator's screen, read again just before a nudge is typed.
  screen(pane: string, session: string): string | null;
  // The operator's status, asked again with its screen.
  status(pane: string, session: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(pane: string, session: string): string[] | null;
  /** The pane's process identity, compared with the one the state records for its seat; null
   *  when herdr can't tell. */
  processes?(pane: string, session: string): PaneProcesses | null;
  typeText(pane: string, text: string, session: string): boolean;
  pressEnter(pane: string, session: string): boolean;
  // Sleeps between the typing of the nudge and the read-back that decides the Enter — the
  // bounded draw wait the exit typing and delivery make (settleScreen). Required: a watch whose
  // delivery reads back the instant it typed, with nothing to wait on, is the fault itself.
  sleep(ms: number): Promise<void>;
  notify(text: string): void;
  now(): Date;
  // Waits between passes; false ends the watch.
  wait(seconds: number): Promise<boolean>;
  alive(pid: number): boolean;
  pid: number;
  /** This process's pane, `'gone'` when herdr answered and none has it, null when herdr can't say. */
  ownPane?(session: string, pid: number): { pane: string; workspace: string } | 'gone' | null;
  /** How an end is read. The real watch uses git and the filesystem. */
  readEnd?(root: string, until: string, base: string | null, ownBefore: boolean, seat?: string): EndView;
  /** Stops one free seat. The real watch uses the same steps as `remove`. */
  stopSeat?(session: string, seat: DownSeat): Promise<boolean>;
  /** Removes one merged worktree. The real watch calls `worktree remove`. */
  removeWorktree?(task: string): number;
  /** The home whose store holds the override file. Absent in a test that does not set one. */
  home?: string;
};

export const realWatchSources: WatchSources = {
  // The status live read, handed no state: the watch compares each live pane's process with its
  // seat's record itself, through `processes` below — only `status` needs the panes the state
  // recorded for seats no agent is listed under, so none is read here.
  live: (session, team) => realSources.live(session, team, emptySession()),
  machine: readMachine,
  standing: standingSource(homedir()),
  readChecks: (standing, team, now) => runChecksOf(standing, team, now),
  screen: (pane, session) => paneRead(pane, PANE_WINDOW, session),
  status: agentStatus,
  foreground: (pane, session) => paneForeground(pane, session),
  processes: (pane, session) => paneProcesses(pane, session),
  typeText,
  pressEnter,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  notify,
  now: () => new Date(),
  wait: waitOrStop,
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  pid: process.pid,
  ownPane: ownWatchPane,
  home: homedir(),
};

export const watch: Command = (argv, io) => runWatch(argv, io, realWatchSources);
export default watch;

export const USAGE = 'Usage: team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]\n';

/** The file `up` recorded for this session's watchdog pane, or a refusal for any other non-owner.
 *  Absent when this folder records no watchdog: a flagless watch then reads what it always did. */
function watchdogGrant(
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>,
): { file: string } | { refuse: string } | undefined {
  const recorded = recordedWatchdog(cwd, session ?? 'default');
  if (!recorded) return undefined;
  if (caller.kind === 'pane' && caller.pane === recorded.pane) return { file: recorded.file };
  if (isOwner(caller)) return undefined;
  return {
    refuse: `only the watchdog pane this session records may read the file up recorded; this call is ${describeCaller(caller)}`,
  };
}

function recordedWatchdog(cwd: string, session: string): { file: string; pane: string } | undefined {
  return readState(cwd).sessions[session]?.watchdog;
}

// How often the watch writes the machine's readings to the log, in seconds. Not the pass rate:
// the default pass is 120s and the machine moves on an hourly scale, so a line per pass would be
// 720 a day saying what one every ten minutes says.
const READINGS_EVERY = 600;

export async function runWatch(argv: string[], io: Io, sources: WatchSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['no-nudge', 'no-notify']);
  if (args.error || args.rest.length) {
    io.stderr(`team watch: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: watch.invocation
    return 2;
  }
  // The `--file` check is the walk's too, and it runs before `currentTeam` reads that file or
  // writes beside it: a non-owner aiming `--file` must not make this command read and validate
  // another project's team file, nor leave its `last_valid`, its log line or its heartbeat in
  // that project's state. The one place every command whose `--file` is the owner's decides it is
  // `fileOwnerRefusal` (caller.ts). The watch `up` starts carries no `--file`: a non-owner pane
  // would be refused. The file is recorded on the session instead, and only that pane may read it.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    io.stderr(`team watch: ${fileRefusal}\n`);
    // exit: watch.file-owner
    return 1;
  }
  const caller = callerOf(io, args.values.session);
  const grant = args.values.file ? undefined : watchdogGrant(io.cwd, args.values.session, caller);
  if (grant && 'refuse' in grant) {
    io.stderr(`team watch: ${grant.refuse}\n`);
    // exit: watch.watchdog
    return 1;
  }
  const aimed = args.values.file ?? (grant && 'file' in grant ? grant.file : undefined);
  const first = currentTeam(io.cwd, aimed, sources.now(), sources.home, false);
  if (!first.ok) {
    for (const problem of first.errors) io.stderr(`team watch: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
    // exit: watch.not-a-repo
    // exit: watch.file
    // exit: watch.file-invalid
    return 2;
  }
  const session = args.values.session ?? first.team.session;
  const { dir } = first;

  // A seat that starts the session's only watch must not be able to drop the operator's nudge
  // or the operator's desktop notices. The owner's own `--no-notify` still cannot silence a
  // report addressed to the owner: those are routed below.
  if (args.flags.has('no-nudge') || args.flags.has('no-notify')) {
    const placed = callerOf(io, session);
    if (!isOwner(placed)) {
      io.stderr(`team watch: --no-nudge and --no-notify are the owner's, from a terminal outside herdr; this call is ${describeCaller(placed)}\n`);
      // exit: watch.no-nudge
      // exit: watch.no-notify
      return 1;
    }
  }

  // The load above wrote nothing, and a flag refusal returned above. A watch that is already
  // running leaves the state file as it was. An allowed run remembers once that check has
  // passed, before the loop. The loop's own read remembers again when the file changes.
  const other = readState(dir).sessions[session]?.watch;
  if (other && other.pid !== sources.pid && sources.alive(other.pid)) {
    io.stderr(`team watch: a watch already runs for the session "${session}" (pid ${other.pid})\n`);
    // exit: watch.already
    return 1;
  }
  if (first.path !== undefined) rememberCurrent(first.dir, first.path, sources.now());

  // The log line is written for every report. `--no-notify` never removes it, and it never
  // removes a desktop notice addressed to the owner. It does silence every other notice.
  const tell = (text: string, notify: boolean) => {
    io.stdout(`${sources.now().toISOString()} ${text}\n`);
    logLine(dir, 'watch', 'watch', text, sources.now());
    if (notify) sources.notify(text);
  };
  const say = (text: string, desktop: boolean) => tell(text, desktop && !args.flags.has('no-notify'));

  const memory = newMemory();
  const told = new Set<string>();
  let outcomes: CheckOutcome[] = [];
  let checksAt: number | null = null;
  let readingsAt: number | null = null;
  let notice: string | undefined;
  let silent = false;
  let announced = false;
  // The first 'gone' for a pane this pid recorded is remembered here, and the heartbeat
  // continues. The watch ends only when the next pass says 'gone' again. A pass that finds the
  // pane, or where herdr cannot say, forgets it.
  let paneGoneOnce = false;
  try {
    for (;;) {
      // The file is read again on every pass, so a seat parked or stopped since is seen.
      const current = currentTeam(io.cwd, aimed, sources.now(), sources.home);
      const team = current.ok ? current.team : first.team;
      const root = current.ok ? current.root : first.root;
      // The one read of the approval store for the whole pass: the drift line, the
      // values in force and the checks below all derive from it.
      const standing = sources.standing(root);
      const overrides: OverrideForce = sources.home
        ? overridesInForceOf(standing, team.project, root, sources.home)
        : { profiles: [], differences: [], problems: [] };
      if (!announced) {
        announced = true;
        say(`watching the session "${session}" every ${watchInForceOf(standing, team).interval}s${args.flags.has('no-nudge') ? ', without nudges' : ''}`, false);
      }
      for (const line of [
        ...overrides.problems,
        ...overrides.differences.map((difference) => `the overrides differ from the approved copy: ${difference}`),
      ]) {
        if (told.has(line)) continue;
        told.add(line);
        say(line, false);
      }
      // A record that is not an approval in force — legacy, or one the verification refused —
      // is said once, in its own words. The watch keeps watching either way: it never stops a
      // seat over this, and the owner-only checks simply read unapproved.
      const approval = approvalCase(standing, team);
      if (approval.reason !== null && !told.has(`approval:${approval.reason}`)) {
        told.add(`approval:${approval.reason}`);
        say(approval.reason, false);
      }
      const problem = current.ok ? current.notice : `team.yaml can't be read (${current.errors[0]?.message ?? 'unknown'}); watching with the team as it was`;
      if (problem !== notice) {
        notice = problem;
        if (problem) tell(problem, true);
      }

      // Only the watch of the file's own session saves readings. A watch on another session —
      // anyone may run one, from any terminal — reads and reports, but the figures it sees are
      // not the project's cache that `up` and `add` count (§ 4.4): it says so once and writes
      // none, budget or spend.
      const foreign = session !== team.session;
      if (foreign && !told.has('foreign-session')) {
        told.add('foreign-session');
        say(`the session "${session}" is not this file's "${team.session}": its readings are not saved`, false);
      }

      // The values in force, from the pass's own snapshot: until the owner approves an edit to
      // `watch`, the watch keeps running with what was approved, or with the defaults.
      const inForce = watchInForceOf(standing, team);
      // The budget values in force, from the same snapshot: an unapproved edit to the marks, the
      // accounts or the cadence silences nothing here until the owner approves it.
      const budget = budgetsInForceOf(standing, team);
      const live = sources.live(session, team);
      if (!live) {
        if (!silent) tell('herdr doesn\'t answer; the watch keeps trying', true);
        silent = true;
      } else {
        silent = false;
        noteWorked(dir, session, live);
        const state = readState(dir).sessions[session] ?? emptySession();
        const now = sources.now().getTime();
        // The check commands run here, outside the pass, at most every `check_every` (§ 5): the
        // pass reads what they read, and nothing else. Only their state is ever said — a
        // contract failure or a timeout says `unreadable`, never a line of what they printed.
        if (checksAt === null || now - checksAt >= budget.checkEvery * 1000) {
          checksAt = now;
          outcomes = sources.readChecks(standing, team, now);
          // The money a spend check counted is kept, like the pass's screen readings: the launch
          // gate of `up` and `add` reads it later, and one that is stale by then reads unknown
          // (§ 5). An account whose check did not run keeps its stored reading.
          if (!foreign) saveSpendReadings(dir, spendOf(outcomes));
          for (const outcome of outcomes) {
            const key = `check:${outcome.account}`;
            if (outcome.state === 'read') {
              told.delete(key);
              continue;
            }
            if (told.has(key)) continue;
            told.add(key);
            say(outcome.state === 'unreadable'
              ? `${outcome.account}: its check is unreadable`
              : `the check for ${outcome.account} is unapproved; that account reads unknown`, false);
          }
        }
        // Herdr's process list per pane, read with the screen: a figure is only read off a pane
        // where herdr reports the seat's CLI. A pane it can't read is null, and a null is not a
        // CLI: no figure.
        const foreground: Record<string, string[] | null> = {};
        // The pane's process identity, read with the same screen: a pane that no longer holds
        // the process team launched for its seat is not the seat, and the restored check says so.
        const processes: Record<string, PaneProcesses | null> = {};
        for (const agent of live.agents) {
          foreground[agent.pane] = sources.foreground(agent.pane, session);
          processes[agent.pane] = sources.processes?.(agent.pane, session) ?? null;
        }
        // The machine's own readings, written to the log at the slow rate: the same figures the
        // pass below reads, whether or not anything is wrong, so the night the incident was is
        // on record in the tool's own files. `unread` where a figure couldn't be read; the gate
        // that acts on these figures is elsewhere and unchanged.
        const machine = sources.machine(root);
        if (readingsAt === null || now - readingsAt >= READINGS_EVERY * 1000) {
          readingsAt = now;
          logLine(dir, 'watch', 'watch', `readings: ${readingsText(machine)}`, sources.now());
        }
        const run = (stored: readonly Seen[]) => pass({
          team, state, live, machine, now, memory,
          approval: approval.differences, approvalReason: approval.reason, watch: inForce, outcomes, budgets: budget,
          quotaFor: (cli) => quotaWith(cli, overrides.profiles),
          readScreen: (cli, pane) => classifyWith(cli, pane, overrides.profiles),
          readings: stored, foreground, processes,
          nudgeOperator: approvedOperator(standing),
          // A record is bound to the file's session. A watch of another session neither rings
          // nor raises the owner line; the file's own watch still does both.
          mailbox: !foreign && sources.home ? mailboxWaiting(root, team, live, sources.home) : [],
        });
        // The pass folds its figures where the state is held: two watches of the project fold one
        // after the other, not over each other. A watch on a foreign session still folds, for its
        // reports, and saves nothing.
        const result = foreign
          ? run(loadReadings(dir))
          : updateReadings(dir, now, (stored) => {
            const folded = run(stored);
            return { readings: folded.readings, value: folded };
          });
        for (const report of result.reports) tell(report.text, report.to === 'owner' || !args.flags.has('no-notify'));
        if (result.nudge) {
          if (args.flags.has('no-nudge')) say(`nudge not typed (--no-nudge): ${result.nudge.text}`, false);
          else await deliver(result.nudge, team, session, sources, memory, say, tell, told);
        } else if (result.ring) {
          if (args.flags.has('no-nudge')) say(`ring not typed (--no-nudge): ${result.ring.text}`, false);
          else await deliver({
            pane: result.ring.pane,
            text: result.ring.text,
            pending: [],
            cli: result.ring.cli,
            ring: { to: result.ring.to },
          }, team, session, sources, memory, say, tell, told);
        }
        if (result.fallback) tell(result.fallback, true);
        if (result.mailboxNote) tell(result.mailboxNote, true);
        await closeEnded({ team, root, dir, session, live, sources, say, io, told });
      }
      const place = placedWatch(dir, session, sources.pid, sources.ownPane);
      if (place === 'end' && paneGoneOnce) {
        tell(`the watch's pane is gone; the watch ends with it`, true);
        break;
      }
      paneGoneOnce = place === 'end';
      beatWatch(dir, session, sources.pid, sources.now().toISOString(), place === 'end' ? 'keep' : place);
      if (!(await sources.wait(inForce.interval))) break;
    }
  } finally {
    updateState(dir, (state) => {
      const record = state.sessions[session];
      if (record?.watch?.pid === sources.pid) delete record.watch;
    });
    tell(`the watch of "${session}" stopped`, true);
  }
  // exit: watch.stopped
  return 0;
}

/** The operator the nudge may type to: the approved copy's, and only while that copy verifies. */
function approvedOperator(standing: Standing): { name: string; cli: string } | null {
  if (standing.kind !== 'verified') return null;
  const approved = validateTeamFile(standing.record.file);
  if (!approved.ok) return null;
  const seat = approved.team.seats.find((item) => item.name === approved.team.operator);
  return seat ? { name: seat.name, cli: seat.cli } : null;
}

/** The spend readings among a pass's check outcomes, for the state. */
function spendOf(outcomes: readonly CheckOutcome[]): SpendReading[] {
  const list: SpendReading[] = [];
  for (const outcome of outcomes) {
    if (outcome.state !== 'read' || outcome.reading.kind !== 'spend') continue;
    list.push({
      account: outcome.account,
      amount: outcome.reading.amount,
      currency: outcome.reading.currency,
      at: outcome.reading.at,
    });
  }
  return list;
}

// Types the nudge, after reading the operator's screen once more: the pass saw it free, and a
// prompt may have appeared since. An empty idle prompt is typed into; a box still holding the
// line this same process typed itself and never sent is sent instead of typed into; anything
// else — another person's or agent's text, or the same text found after a restart — stays.
function mailboxWaiting(root: string, team: TeamFile, live: Live, home: string): MailboxWaiting[] {
  return listUnacked(root, team.session, home).map((record) => {
    const named = live.agents.filter((agent) => agent.name === record.to);
    const agent = named.length === 1 ? named[0] : undefined;
    const seat = team.seats.find((item) => item.name === record.to);
    return {
      id: record.id,
      to: record.to,
      at: Date.parse(record.at),
      pane: agent?.pane ?? null,
      status: agent?.status ?? null,
      cli: seat?.cli ?? '',
      screen: agent ? live.screens[agent.pane] : undefined,
    };
  });
}

async function deliver(
  nudge: { pane: string; text: string; pending: string[]; cli?: string; ring?: { to: string } }, team: TeamFile, session: string, sources: WatchSources,
  memory: ReturnType<typeof newMemory>, say: (text: string, desktop: boolean) => void,
  tell: (text: string, notify: boolean) => void, told: Set<string>,
): Promise<void> {
  const cli = nudge.cli ?? team.seats.find((seat) => seat.name === team.operator)?.cli ?? '';
  const look = () => readScreen(cli, sources.screen(nudge.pane, session) ?? undefined).kind;
  const holds = () => boxHoldsText(cli, nudge.text, sources.screen(nudge.pane, session) ?? undefined);
  const status = sources.status(nudge.pane, session);
  const keep = () => {
    // The nudge's text carries no report, so the reports it was raised for go back to pending:
    // the fallback notification and the next passes need them. A ring carries none, and must
    // not start the report clock.
    memory.pending.push(...nudge.pending);
    if (nudge.pending.length > 0) memory.pendingSince ??= sources.now().getTime();
  };
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(sources.foreground(nudge.pane, session), names);
  const noAgent = 'nudge:no-agent';
  if (!live()) {
    tellOnce(told, noAgent, 'a nudge was not typed: no live agent in the operator\'s pane', tell);
    keep();
    return;
  }
  told.delete(noAgent);
  // The box may already hold this line — but only the record of this process's own typing, in
  // this same pane, can make it the watch's. The line is one fixed public constant, so the same
  // text typed by a person or an agent, or found by a restarted watch, is theirs: never typed
  // over, sent or cleared. One read settles both the kind and the claim.
  const raw = sources.screen(nudge.pane, session);
  const kind = readScreen(cli, raw ?? undefined).kind;
  const mine = kind === 'unsent' && ownUnsent(memory, nudge.pane, nudge.text, cli, raw ?? undefined);
  // A legible box shows what stands: a record that no longer matches it — the line was sent,
  // cleared or written over — is forgotten here, before anything is typed or sent.
  if ((kind === 'idle' || kind === 'unsent') && memory.ownNudge?.pane === nudge.pane && !mine) {
    memory.ownNudge = null;
  }
  if ((status !== 'idle' && status !== 'done') || (!mine && (kind !== 'idle' || !sources.typeText(nudge.pane, nudge.text, session)))) {
    keep();
    return;
  }
  // The typing, and the record of whose it is: from here this process can claim the line, and a
  // later pass may send it. Nothing of this survives a restart — a new process starts with none.
  if (!mine) memory.ownNudge = { pane: nudge.pane, text: nudge.text };
  // The text is in the box. The agent is read again before Enter: it may have exited
  // since the text was typed, and an unframed line is not a box to send.
  if (!live()) {
    tellOnce(told, noAgent, 'a nudge was not typed: no live agent in the operator\'s pane', tell);
    keep();
    return;
  }
  // The box is read back before the Enter: it must hold exactly the nudge's own text. The pane
  // draws late — the reading right after the typing is still the idle prompt, and the box
  // appears a moment later (the nudge-typing captures) — so the reading that decides the Enter
  // waits for it, the same bounded wait the exit typing makes, and a screen still idle at the
  // deadline is the text never drawn. Unsent text alone is not this nudge.
  let drawn = mine || holds();
  if (!drawn) {
    const deadline = sources.now().getTime() + DRAW_WAIT_MS;
    for (;;) {
      if (holds()) {
        drawn = true;
        break;
      }
      const currentStatus = sources.status(nudge.pane, session);
      if (currentStatus !== 'idle' && currentStatus !== 'done') {
        tell('a nudge was typed and not sent: the operator was not free when the box was read back', true);
        keep();
        return;
      }
      const kind = look();
      if (kind !== 'idle' && kind !== 'unsent') {
        tell('a nudge was typed and not sent: the operator\'s box does not hold it', true);
        keep();
        return;
      }
      if (sources.now().getTime() >= deadline) break;
      const before = sources.now().getTime();
      await sources.sleep(100);
      if (sources.now().getTime() <= before) break;
    }
  }
  // The wait is a window the pane's state can change in: the agent can go, and the operator can
  // start a turn. Every check the Enter needs — the live agent, the status as it reads now, the
  // box — is taken here, with no await between them, so nothing that changed while the box drew
  // can have a key sent into it. The status read at the top of this function is not reused: it
  // predates the wait, and a turn that began under it must fail closed.
  if (!live()) {
    tellOnce(told, noAgent, 'a nudge was not typed: no live agent in the operator\'s pane', tell);
    keep();
    return;
  }
  if (!drawn) {
    tell('a nudge was typed and not sent: the operator\'s box does not hold it', true);
    keep();
    return;
  }
  const free = sources.status(nudge.pane, session);
  if (free !== 'idle' && free !== 'done') {
    tell('a nudge was typed and not sent: the operator was not free when the box was read back', true);
    keep();
    return;
  }
  if (sources.pressEnter(nudge.pane, session)) {
    // Sent: the line has left the box, so nothing here can claim it any more.
    memory.ownNudge = null;
    say(nudge.ring
      ? `rang ${nudge.ring.to}: ${nudge.text}`
      : mine
        ? `nudged the operator (its own unsent line was already in its box): ${nudge.text}`
        : `nudged the operator: ${nudge.text}`, false);
  } else keep();
}

function tellOnce(told: Set<string>, key: string, text: string, tell: (text: string, notify: boolean) => void): void {
  if (told.has(key)) return;
  told.add(key);
  tell(text, true);
}

function noteWorked(dir: string, session: string, live: Live): void {
  const recorded = readState(dir).sessions[session];
  if (!recorded) return;
  const due = live.agents.some((agent) => {
    const seat = agent.name ? recorded.seats[agent.name] : undefined;
    return seat?.temporary && seat.stage === 'ready' && !seat.worked && agent.status === 'working';
  });
  if (!due) return;
  updateState(dir, (file) => {
    const seats = (file.sessions[session] ??= emptySession()).seats;
    for (const agent of live.agents) {
      const seat = agent.name ? seats[agent.name] : undefined;
      if (seat?.temporary && seat.stage === 'ready' && agent.status === 'working') seat.worked = true;
    }
  });
}

function sayOnce(told: Set<string>, key: string, text: string | undefined, say: (text: string, desktop: boolean) => void): void {
  if (!text || told.has(key)) return;
  told.add(key);
  say(text, true);
}

// Closes a temporary seat whose end holds, and removes an on-merge worktree whose branch is merged.
// Anything that is not free, or not proved, is left as it is.
async function closeEnded(input: {
  team: TeamFile;
  root: string;
  dir: string;
  session: string;
  live: Live;
  sources: WatchSources;
  say: (text: string, desktop: boolean) => void;
  io: Io;
  told: Set<string>;
}): Promise<void> {
  const { team, root, dir, session, live, sources, say, io, told } = input;
  const endOf = sources.readEnd ?? readEnd;
  const state = readState(dir).sessions[session] ?? emptySession();
  for (const [name, recorded] of Object.entries(state.seats)) {
    const temporary = recorded.temporary;
    if (!temporary) continue;
    const task = temporary.task;
    const work = task ? state.worktrees[task] : undefined;
    const ownBefore = work ? work.own_commits === true : temporary.own_commits === true;
    const end = endOf(root, temporary.until, team.workspace.base, ownBefore, name);
    const agent = live.agents.find((item) => item.name === name);
    const cli = team.seats.find((seat) => seat.name === temporary.like)?.cli ?? '';
    const free = agent
      ? stateOf(sources.status(agent.pane, session) ?? agent.status, readScreen(cli, sources.screen(agent.pane, session) ?? undefined)) === 'free'
      : false;
    const decision = judgeTemporary({ worked: recorded.worked === true, free, ownBefore, end });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        if (work && task) {
          const tree = current.worktrees[task];
          if (tree) tree.own_commits = true;
        } else {
          const seat = current.seats[name];
          if (seat?.temporary) seat.temporary.own_commits = true;
        }
      });
    }
    sayOnce(told, `end:${name}`, decision.report, say);
    if (!decision.close || !agent) continue;
    // A temporary seat is not in the approved copy. The watch leaves it; the owner removes it.
    sayOnce(
      told,
      `unverified:${name}`,
      `${name}: its record is not an approved seat; left as it is (the owner cleans it: team remove ${name} --abandon)`,
      say,
    );
  }

  const again = readState(dir);
  const here = again.sessions[session] ?? emptySession();
  for (const [task, work] of Object.entries(here.worktrees)) {
    const occupied = Object.values(again.sessions).some((recorded) =>
      Object.values(recorded.seats).some((seat) => seat.temporary?.task === task));
    const end = endOf(root, `merged:${work.branch}`, team.workspace.base, work.own_commits === true);
    const decision = judgeWorktree({
      policy: team.workspace.remove, occupied, ownBefore: work.own_commits === true, end,
    });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const tree = file.sessions[session]?.worktrees[task];
        if (tree) tree.own_commits = true;
      });
    }
    sayOnce(told, `worktree:${task}`, decision.report, say);
    if (!decision.close) continue;
    const code = sources.removeWorktree
      ? sources.removeWorktree(task)
      : removeWorktree(io, { home: homedir(), now: sources.now }, team, root, dir, session, task, 'watch');
    if (code !== 0) say(`worktree ${task} was not removed`, true);
  }
}

