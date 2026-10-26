import { declaredModel } from '../file/model.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { defaultLabel } from '../file/validate.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../herdr.ts';
import { herdrCommand } from '../herdr.ts';
import { paneHoldsShell, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { isLeadSeat, relaunchRepair, unidentifiedRepair } from '../file/sections/lead.ts';
import { observedEffort } from '../labels/observe.ts';
import { usesLauncher } from '../launch/line.ts';
import { defaultSocketsDirs, socketOfProcesses } from '../send/address.ts';
import { herdrUnreliable } from '../profiles/index.ts';
import type { SeatState, SessionState } from '../state.ts';
import { pluralCount, type DifferenceWho } from '../output/text.ts';
import { continuitySessionOf } from '../registry/resume.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen, screenWord, type Screen } from '../watch/screen.ts';
import { launchModelWhenUnread, modelDiffers, runningModel, seatModel } from './statusline.ts';

// What herdr shows of a session. `screens` holds a pane's visible text, where it could be read;
// `processes` each seat pane's process identity, where it was read, and null where herdr can't
// tell. A pane the map doesn't hold is not compared: exactly as a seat with no record.
export type Live = {
  running: boolean;
  agents: HerdrAgent[];
  workspaces: HerdrWorkspace[];
  screens: Record<string, string>;
  processes?: Record<string, PaneProcesses | null>;
};

export type Row = {
  name: string;
  id?: string;
  state: string;
  model: string;
  pane: string;
  stored?: string;
  start_cwd?: string;
  /** How a send would reach this seat: over the session's socket in its pane, else typed. */
  reach?: 'socket' | 'typed';
};

/** The repair of the one precondition `status` knows: the file's approval is not in force. The
 *  approval differences carry it, and a repair that waits on it is marked with it. */
export const APPROVAL_REPAIR = 'the live file is what the commands read';

/**
 * One disagreement, with the two facts about its repair that the renderer needs and must not
 * re-derive from the repair's wording, both set where the difference is created:
 *
 * - `needs`: the repair names a command that refuses while no approval is in force.
 *   Confirmed from the commands themselves: `team up` (`up.ts`), `team add` (`add.ts`),
 *   `team restart` (`restart.ts`) and `team worktree` (`worktree.ts`) each refuse on the
 *   standing before they do anything. Such a repair waits for `APPROVAL_REPAIR`, and is printed
 *   with `(after: …)` while the approval difference is there. A difference is never marked for
 *   a command that does not refuse.
 * - `owner`: the repair is one of the owner's commands (the summary line counts these).
 *
 * `approval` marks the approval difference itself: it is the precondition, printed first.
 */
export type Difference = {
  what: string;
  repair: string;
  needs?: 'approve';
  owner?: true;
  approval?: true;
  /** The seat this row's prompt belongs to. `team check` names that seat itself — one line with
   *  the prompt's kind, the command the screen shows and its age — and drops this row for it, so
   *  a held seat is named once. `status` prints the row as it stands, and nothing serializes the
   *  mark. */
  promptSeat?: string;
  /** Who runs the repair, where the repair's command alone would read it wrongly: `team swap
   *  queue` is in the grant scopes (`GRANT_SCOPES`), so `whoFromCommand` would call it a grant
   *  holder's, and the command admits the team's lead. Set where the difference is created and
   *  never re-derived from the wording. */
  who?: DifferenceWho;
};

export type Comparison = { rows: Row[]; differences: Difference[]; notes: string[] };

/** The one row a seat shows while it waits, ahead of the ordinary launch-stopped and unnamed rows. */
function waitingView(
  name: string,
  recorded: SeatState | undefined,
  trust: boolean,
): { state: string; stored: string; difference: Difference } | null {
  const waiting = recorded?.waiting;
  if (!waiting) return null;
  if (waiting.state === 'trust-sent-recovery') {
    return {
      state: 'trust sent; recovery required',
      stored: 'trust-sent-recovery',
      difference: {
        what: `${name}: trust sent; recovery required`,
        repair: 'team up',
        needs: 'approve',
      },
    };
  }
  const phrase = `waiting for owner (${waiting.classification})`;
  const isTrust = waiting.classification === 'trust';
  const answer = trust && isTrust;
  const repair = answer
    ? `team answer ${name} trust, or the owner answers the dialog in the pane, then team up`
    : isTrust
      ? 'the owner answers the dialog in the pane, then team up'
      : 'the owner runs team up';
  return {
    state: phrase,
    stored: 'waiting-owner',
    difference: {
      what: `${name}: ${phrase}`,
      repair,
      needs: 'approve',
    },
  };
}

/**
 * The approval differences first, then the repairs that wait on one marked `(after: …)`. The
 * order otherwise stays as the differences were created. Nothing here decides what blocks a
 * launch: that is `blocksLaunch` (`src/commands/doctor.ts`), and it is `team doctor`'s to report
 * — a missing watch does not block one, and no repair is marked for it.
 */
export function orderAndAnnotateDifferences(differences: Difference[]): Difference[] {
  const approval = differences.filter((diff) => diff.approval);
  if (approval.length === 0) return differences;
  const rest = differences
    .filter((diff) => !diff.approval)
    .map((diff) => (diff.needs === 'approve' ? { ...diff, repair: `${diff.repair} (after: ${APPROVAL_REPAIR})` } : diff));
  return [...approval, ...rest];
}

/** The word a quiet seat's screen earns for a usage limit: `blocked: quota`, with the reset
 *  exactly as the screen words it — `at` for a clock, `in` for a span — or an explicit "no
 *  reset time named" when it names none. Null for every other screen. The row shows this word
 *  instead of the host's: a wall is a blocked seat, never a bare done. */
function quotaOutText(screen: Screen): string | null {
  if (screen.kind !== 'rate limit') return null;
  if (screen.reset === null) return 'blocked: quota, no reset time named';
  return `blocked: quota, resets ${screen.reset.kind} ${screen.reset.value}`;
}

/**
 * Whether the process in a seat's pane is still the seat's, before a screen read is believed: the
 * gate `compare()` applies to a declared seat, in one place for the temporary branch and the
 * check's own reading. A pane back at its shell, or one running a process the record does not
 * name with no stored session showing continuity, is not the seat; a record with no identity
 * whose pane holds a bare shell is not either. Herdr unable to tell (`processes` null) keeps the
 * reading: there is no verdict to act on.
 */
export function paneShowsSeat(
  recorded: SeatState | undefined,
  agent: HerdrAgent,
  live: Live,
  recordedSession: string | undefined = recorded?.agent_session,
): boolean {
  const processes = live.processes?.[agent.pane] ?? null;
  const verdict = seatProcessVerdict(recorded?.launched, processes);
  const continuity = replacedSeat(verdict, {
    asked: true,
    namedOnPane: recorded?.pane === agent.pane,
    recordedSession,
    liveSession: agent.session,
  });
  if (continuity !== 'restored' && (verdict === 'gone' || verdict === 'replaced')) return false;
  if (recorded !== undefined && !recorded.launched && paneHoldsShell(processes)) return false;
  return true;
}

// Compares the file and the state with the live session. Pure over what is handed in, but for
// one probe: a seat reads `socket` only while the session's socket file is really there, so the
// filesystem decides that word. `watch` is the watch values in force — the live file's under a
// verified standing, the defaults under none — so the verdict reads one object. `trust` is
// whether the owner's live grant turns trust answering on for this team: the caller passes
// `dialogsTrustInForce`, so the repair line offers `team answer` only while the setting is on.
export function compare(
  team: TeamFile,
  session: string,
  state: SessionState,
  live: Live,
  now: Date = new Date(),
  watch: TeamFile['watch'] = team.watch,
  sockets: string | readonly string[] = defaultSocketsDirs(),
  trust = false,
  signing?: ReadonlyMap<string, { model: string; version: string }>,
  continuityIds?: ReadonlyMap<string, string | null>,
): Comparison {
  const rows: Row[] = [];
  const differences: Difference[] = [];
  const notes: string[] = [];
  const claimed = new Set<string>();
  const labels = new Map(live.workspaces.map((workspace) => [workspace.id, workspace.label]));
  const anyRunning = team.seats.some((seat) => live.agents.some((agent) => agent.name === seat.name));

  for (const declared of team.seats) {
    const agent = live.agents.find((candidate) => candidate.name === declared.name);
    const recorded = state.seats[declared.name];
    const priorSeat: Seat = recorded?.model && recorded?.version && recorded?.launch_line && recorded.launch_line !== declared.launch
      ? {
          ...declared,
          model: recorded.model,
          version: recorded.version,
          display: defaultLabel(recorded.model, recorded.version),
          ...(recorded.effort ? { effort: recorded.effort } : {}),
          launch: recorded.launch_line,
        }
      : declared;
    const registered = signing?.get(declared.name);
    const seat: Seat = registered
      ? { ...priorSeat, model: registered.model, version: registered.version, display: defaultLabel(registered.model, registered.version) }
      : priorSeat;
    const seatId = recorded?.id ?? state.retained_seats?.[seat.name]?.id;
    const idField = seatId ? { id: seatId } : {};
    if (agent) {
      claimed.add(agent.pane);
      // The pane is the seat only while the process team launched is still in it. A pane that
      // runs no CLI, or one whose process is not the recorded one, is not this seat: it is
      // never shown idle, working or ready, and never under its model as if it were running.
      const verdict = seatProcessVerdict(recorded?.launched, live.processes?.[agent.pane] ?? null);
      // The registry's binding speaks for the seat where a record exists; the state's own copy
      // is the fallback only for a seat no record covers.
      const recordedSession = continuitySessionOf(continuityIds, declared.name, recorded?.agent_session);
      const continuity = replacedSeat(verdict, {
        asked: true,
        namedOnPane: recorded?.pane === agent.pane,
        recordedSession,
        liveSession: agent.session,
      });
      // The stored session is on this pane: the seat is running, whatever its pids are now.
      if (continuity !== 'restored' && (verdict === 'gone' || verdict === 'replaced')) {
        const found = verdict === 'gone'
          ? notLaunched(seat, agent.pane, verdict, live.screens[agent.pane])
          : cannotTie(seat, agent.pane, live.screens[agent.pane], team, recorded?.pane === agent.pane);
        rows.push({ ...found.row, ...idField });
        if (found.difference) differences.push(found.difference);
        if (found.note) notes.push(found.note);
        continue;
      }
      // The conversation came back without the program the launch line names. Said here; the
      // seat is still the running one, and nothing in this report starts it. For a lead's own
      // seat no per-seat restart is offered (a lead is never removed or restarted alone), and
      // the whole-team restart it would take is never the repair: the note says what the
      // process is, and the lead reads it.
      if (continuity === 'restored' && usesLauncher(seat)) {
        if (isLeadSeat(team, seat.name)) {
          notes.push(`${seat.name}: started by a launcher; team cannot tell its process from the one it launched`);
        } else {
          differences.push({
            what: `${seat.name}: its launch line starts a launcher, and the process in its pane is not the one team launched`,
            repair: `team restart ${seat.name}`,
            needs: 'approve',
          });
        }
      }
      // A ready seat with no identity is not relaunched by `up` when its model differs. A seat
      // still at launch is: `up` finishes it, so that repair stays `team up`. A bare shell is
      // not finished at any stage: there is no CLI to resume.
      const noIdentity = recorded !== undefined && !recorded.launched;
      const unidentified = noIdentity && recorded.stage === 'ready';
      const shell = noIdentity && paneHoldsShell(live.processes?.[agent.pane] ?? null);
      // A shell has no model to compare. Reading it would add an "unread" note beside the
      // repair that already says the pane runs no CLI.
      const model = shell ? seat.display : modelOf(seat, agent, live, differences, notes, team, unidentified, registered !== undefined);
      const held = waitingView(seat.name, recorded, trust);
      if (held) {
        rows.push({
          name: seat.name,
          ...idField,
          state: held.state,
          stored: held.stored,
          model,
          pane: agent.pane,
          ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
        });
        differences.push(held.difference);
        if (seat.stopped) {
          differences.push({
            what: `${seat.name} is marked stopped in the file and is running`,
            repair: `team remove ${seat.name} --keep, or take "stopped: true" off the seat`,
          });
        }
        continue;
      }
      // No recorded process: a shell in this pane is not a seat `up` will relaunch, and it is
      // not shown idle. The repair is the one that works, never `team up`. A waiting record
      // was reported above; `up` resumes that into the pause, which has its own refusal.
      if (shell) {
        const found = unidentifiedShell(seat, agent.pane, team);
        rows.push({ ...found.row, ...idField, ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}) });
        differences.push(found.difference);
        continue;
      }
      const screenText = live.screens[agent.pane];
      const screen = readScreen(seat.cli, screenText);
      // A profile herdr cannot report is read from its own screen: the row's word is the
      // screen's, and herdr's `unknown` is not a state to show or a note to print. A screen no
      // profile reads leaves herdr's word standing, and the note with it.
      const theirWord = herdrUnreliable(seat.cli);
      const word = theirWord ? screenWord(screen) : agent.status;
      // `done` is as free as `idle`: delivery types into either one (`deliver.ts`), and the
      // watch's unsent check covers both (`pass.ts`). The report reads them the same way.
      const quiet = word === 'idle' || word === 'done';
      const isUnsent = quiet && screen.kind === 'unsent';
      // A quiet seat on a screen no profile reads: herdr's word alone would show a bare done (the
      // watch reports the same reading, pass.ts). The row says what herdr could not, and nothing
      // else about the seat moves — no verdict, no difference.
      const unread = quiet && screen.kind === 'unknown';
      const quotaOut = quiet ? quotaOutText(screen) : null;
      const mark = isUnsent ? ' (unsent text)' : unread ? ' (screen not recognised)' : '';
      const stateText = quotaOut !== null
        ? `${quotaOut}${seat.parked ? ', parked' : ''}`
        : `${word}${mark}${seat.parked ? ', parked' : ''}`;
      rows.push({
        name: seat.name,
        ...idField,
        state: stateText,
        model,
        pane: agent.pane,
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      if (
        !(theirWord && screen.kind !== 'unknown') &&
        agent.status !== '' &&
        agent.status !== 'idle' &&
        agent.status !== 'done' &&
        agent.status !== 'working' &&
        agent.status !== 'blocked'
      ) {
        notes.push(`${seat.name}: herdr reports the status "${agent.status}"`);
      }
      if (seat.stopped) {
        differences.push({
          what: `${seat.name} is marked stopped in the file and is running`,
          repair: `team remove ${seat.name} --keep, or take "stopped: true" off the seat`,
        });
      }
      // A model mismatch on a record with no identity is repaired by abandon, not by resuming
      // the launch: `up` will not relaunch a pane it cannot prove is the seat's.
      const unidentifiedMismatch = unidentified && modelDiffers(seatModel(seat, screenText), seat);
      if (isUnsent && recorded?.stage === 'named' && !unidentifiedMismatch) {
        differences.push({
          what: `${seat.name}: its launch stopped at "named", and it holds text in its input box that was never sent`,
          repair: 'clear or send it in the pane, then team up (it resumes the launch)',
          needs: 'approve',
        });
      } else {
        if (recorded && recorded.stage !== 'ready' && !unidentifiedMismatch) {
          // `team up` is the map's `owner-or-leads` row, so a lead runs this repair as well as the
          // owner; the difference is not counted among the owner's. A relaunch that closed its
          // seat and never reached ready leaves exactly this record, and the lead who watches the
          // team is the one who repairs it.
          differences.push({
            what: `${seat.name}: its launch stopped at "${recorded.stage}"`,
            repair: 'team up (it resumes the launch)',
            needs: 'approve',
          });
        }
        if (isUnsent) {
          differences.push({
            what: `${seat.name} holds text in its input box that was never sent`,
            repair: "the owner clears or sends it in the pane; team does not type into a box it can't verify",
            owner: true,
          });
        }
      }
      if (screen.kind === 'permission' || screen.kind === 'trust') {
        // A permission prompt is the pane's lead's to answer, in the pane; a trust prompt stays
        // the owner's alone (its live `dialogs.trust` grant).
        differences.push(screen.kind === 'permission'
          ? {
              what: `${seat.name} waits at a permission prompt: its lead's to answer, or its owner's`,
              repair: 'its lead answers it in the pane',
              promptSeat: seat.name,
            }
          : {
              what: `${seat.name} waits at a trust prompt: the owner's to answer`,
              repair: 'the owner answers it in the pane',
              owner: true,
              promptSeat: seat.name,
            });
      }
      if (recorded?.rules === 'undelivered') {
        differences.push({
          what: `${seat.name}: its rules were not delivered`,
          repair: `team remove ${seat.name} --keep, then team add ${seat.name}`,
          needs: 'approve',
        });
      }
      continue;
    }
    if (seat.stopped) {
      rows.push({
        name: seat.name,
        ...idField,
        state: 'stopped',
        model: seat.display,
        pane: '-',
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      continue;
    }
    // The pane the state recorded for this seat, with no agent herdr lists under its name: the
    // pane is the seat only while the recorded process is still in it. One left holding its shell,
    // or one whose foreground CLI is not the recorded one, is not this seat — and it is not a
    // stray to rename: the launch ended, and only `up` puts a fresh one there.
    const held = recorded?.pane;
    const paneProc = held ? live.processes?.[held] ?? null : null;
    const verdict = seatProcessVerdict(recorded?.launched, paneProc);
    if (held && verdict === 'gone') {
      claimed.add(held);
      const { row, difference, note } = notLaunched(seat, held, verdict, live.screens[held]);
      rows.push({ ...row, ...idField });
      differences.push(difference);
      if (note) notes.push(note);
      continue;
    }
    if (held && verdict === 'replaced') {
      claimed.add(held);
      // Herdr lists no agent of this name: no pane it names is the recorded one, so no
      // per-seat command takes this process — the repair is to look at it.
      const found = cannotTie(seat, held, live.screens[held], team, false);
      rows.push({ ...found.row, ...idField });
      if (found.difference) differences.push(found.difference);
      if (found.note) notes.push(found.note);
      continue;
    }
    if (held && recorded && !recorded.launched && paneHoldsShell(paneProc)) {
      claimed.add(held);
      const found = unidentifiedShell(seat, held, team);
      rows.push({ ...found.row, ...idField, ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}) });
      differences.push(found.difference);
      continue;
    }
    // A waiting record is read only of a pane that may still hold the seat: one that lost the
    // launched process reads `missing` or `restored, not launched by team` above — never
    // `waiting for owner`, and never under the declared model for a replaced one.
    const waiting = recorded?.pane ? waitingView(seat.name, recorded, trust) : null;
    if (waiting && recorded?.pane) {
      rows.push({
        name: seat.name,
        ...idField,
        state: waiting.state,
        stored: waiting.stored,
        model: seat.display,
        pane: recorded.pane,
        ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      differences.push(waiting.difference);
      continue;
    }
    // An agent sits in the workspace recorded for this name, under another name or under none.
    // The display label is not a key: two seats may share it.
    const stray = recorded?.workspace
      ? live.agents.find((candidate) => !claimed.has(candidate.pane) && candidate.workspace === recorded.workspace
        && !team.seats.some((other) => other.name === candidate.name))
      : undefined;
    if (stray) {
      claimed.add(stray.pane);
      rows.push({
        name: seat.name,
        ...idField,
        state: 'wrong name',
        model: unverifiedModel(seat, live.screens[stray.pane]),
        pane: stray.pane,
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      differences.push({
        what: `${seat.name}: the agent in ${stray.pane} is ${stray.name ? `named "${stray.name}"` : 'unnamed'}`,
        repair: herdrCommand(session, 'agent', 'rename', stray.pane, seat.name),
      });
      continue;
    }
    rows.push({
      name: seat.name,
      ...idField,
      state: 'missing',
      model: seat.display,
      pane: '-',
      ...(recorded?.start_cwd ? { start_cwd: recorded?.start_cwd } : {}),
    });
    differences.push({
      what: `${seat.name} is in the file and is not running`,
      // With the session up, `team restart <seat>` is the per-seat repair the map admits to the
      // owner and the team's leads alike; `team add` is the owner's alone, and a lead that reads
      // this line must be handed a command it can run. With nothing running the session itself is
      // down, a lead cannot prove its pane, and the owner's `team up` is what starts it.
      repair: anyRunning ? `team restart ${seat.name}` : 'team up',
      needs: 'approve',
      ...(anyRunning ? {} : { owner: true as const }),
    });
  }

  for (const [name, recorded] of Object.entries(state.seats)) {
    if (!recorded.temporary) continue;
    const idField = recorded.id ? { id: recorded.id } : {};
    const like = recorded.temporary.like;
    const likeSeat = team.seats.find((seat) => seat.name === like);
    const tempModel = recorded.model && recorded.version && (!likeSeat || recorded.model !== likeSeat.model || recorded.version !== likeSeat.version)
      ? `${defaultLabel(recorded.model, recorded.version)} (like ${like})`
      : `like ${like}`;
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (agent) {
      claimed.add(agent.pane);
      const held = waitingView(name, recorded, trust);
      if (held) {
        rows.push({
          name,
          ...idField,
          state: held.state,
          stored: held.stored,
          model: tempModel,
          pane: agent.pane,
          ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
        });
        differences.push(held.difference);
        notes.push(`${name} is temporary, until ${recorded.temporary.until}`);
        continue;
      }
      // A quiet temporary seat on a screen no profile reads: this row must not show a bare done
      // either. The cli comes from the like-seat, as the model string does; a like-seat gone reads
      // nothing, and the suffix is true then too.
      const likeCli = likeSeat?.cli ?? '';
      const tempScreen = readScreen(likeCli, live.screens[agent.pane]);
      const tempWord = herdrUnreliable(likeCli) ? screenWord(tempScreen) : agent.status;
      const quiet = tempWord === 'idle' || tempWord === 'done';
      const unread = quiet && tempScreen.kind === 'unknown';
      // The pool a temporary seat spends is the like-seat's, as its cli and model string are.
      const quotaOut = quiet ? quotaOutText(tempScreen) : null;
      rows.push({
        name,
        ...idField,
        state: `${quotaOut ?? `${tempWord}${unread ? ' (screen not recognised)' : ''}`}, temporary`,
        model: tempModel,
        pane: agent.pane,
        ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      // A dialog the pane's scrollback still shows is not a prompt while the pane no longer
      // holds the seat's process: the same gate a declared seat's prompt row answers to. The
      // row's word above is unchanged — this decides only whether the screen is read as a
      // prompt the seat waits at.
      if (paneShowsSeat(recorded, agent, live) && (tempScreen.kind === 'permission' || tempScreen.kind === 'trust')) {
        differences.push(tempScreen.kind === 'permission'
          ? {
              what: `${name} waits at a permission prompt: its lead's to answer, or its owner's`,
              repair: 'its lead answers it in the pane',
              promptSeat: name,
            }
          : {
              what: `${name} waits at a trust prompt: the owner's to answer`,
              repair: 'the owner answers it in the pane',
              owner: true,
              promptSeat: name,
            });
      }
      notes.push(`${name} is temporary, until ${recorded.temporary.until}`);
    } else {
      differences.push({ what: `${name}: a temporary seat is recorded and is not running`, repair: `team remove ${name}` });
    }
  }

  for (const agent of live.agents) {
    if (claimed.has(agent.pane) || labels.get(agent.workspace) === watchLabel(team.project)) continue;
    differences.push({
      what: `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`,
      repair: 'add the seat to the file, or close it',
    });
  }

  for (const [task, worktree] of Object.entries(state.worktrees)) {
    if (worktree.setup === 'failed') {
      differences.push({ what: `worktree ${task}: its setup failed`, repair: `team worktree remove ${task}`, needs: 'approve' });
    }
  }

  // The watch the state records, as one line: where it runs, whose process it is once a pass has
  // recorded one, and how old its last heartbeat is. The difference below says when that is too
  // old; this note is what stands either way.
  if (state.watch) {
    const beat = Date.parse(state.watch.heartbeat);
    const seconds = Number.isFinite(beat) ? Math.max(0, Math.round((now.getTime() - beat) / 1000)) : null;
    const age = seconds === null
      ? 'never recorded'
      : seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
    const where = state.watch.pane ? `pane ${state.watch.pane}` : 'pane not recorded';
    const whose = state.watch.pid !== undefined ? `pid ${state.watch.pid}` : 'pid not recorded yet';
    notes.push(`watch: ${where}, ${whose}, last heartbeat ${age}`);
  }

  if (live.running && anyRunning) {
    const beat = state.watch ? Date.parse(state.watch.heartbeat) : NaN;
    if (!state.watch) {
      differences.push({ what: 'no watch has run for this session', repair: `team watch --session ${session}` });
    } else if (!(now.getTime() - beat <= 2 * watch.interval * 1000)) {
      const minutes = Number.isFinite(beat) ? Math.round((now.getTime() - beat) / 60_000) : null;
      differences.push({
        what: `the watch's last pass was ${minutes === null ? 'never recorded' : `${pluralCount(minutes, 'minute')} ago`}`,
        repair: `team watch --session ${session}`,
      });
    }
  }

  // How a send would reach each seat, read over the processes herdr already reported: `socket`
  // while the pane's own processes carry a session socket (the rule the launch records with,
  // address.ts), `typed` otherwise — a seat that is not a Claude Code one, a pane that is gone,
  // or one herdr could not read. No extra herdr call: the reading is the row's own pane.
  for (const row of rows) {
    const declared = team.seats.find((seat) => seat.name === row.name);
    const processes = live.processes?.[row.pane] ?? null;
    row.reach = declared?.cli === 'claude-code' && socketOfProcesses(processes, sockets) ? 'socket' : 'typed';
  }

  return { rows, differences, notes };
}

// A pane that no longer holds the process team launched: no CLI at all, or a foreground CLI that
// is not the recorded one. The row and the difference read the same wherever the pane is found —
// a pane herdr still lists an agent in, and one the agent went with its CLI.
/** A program is in front and the stored session does not tie it to the launch. The repair is to
 *  look. `up` does not close this pane. */
function cannotTie(
  seat: Seat,
  pane: string,
  screen: string | undefined,
  team: TeamFile,
  /** Herdr still names this seat on the pane the state recorded: `--abandon` is the form that
   *  takes that process. The flag without it only leaves the pane as it is. */
  namedOnPane: boolean,
): { row: Row; difference?: Difference; note?: string } {
  const running = runningModel(seat.cli, screen ?? '');
  const launcher = usesLauncher(seat);
  // The command that would actually run: a program in front is taken only by `--abandon`, and
  // only while herdr names the seat on the recorded pane. Where it does not, the repair is to
  // look, never a command that refuses.
  const repair = namedOnPane ? `team restart ${seat.name} --abandon` : 'look at the pane';
  const shown = running
    ? `${seat.name}: its pane runs ${running.model} ${running.version}; that process is not the one team launched`
    : undefined;
  const differs = running !== null && modelDiffers(running, seat);
  const row: Row = {
    name: seat.name,
    state: 'restored, not launched by team',
    model: '-',
    pane,
  };
  // A model that is not the file's, or a launch line that names a launcher, is the report.
  // The row stays `-`: the declared model is not shown as the one running. Nothing starts the seat.
  if (differs || launcher) {
    // A lead's own seat is never restarted alone, and the whole-team restart is not the repair:
    // the note says what the process is, with no command that stops the team. An ordinary seat's
    // restart relaunches it in a fresh workspace, so it does not need this pane.
    if (isLeadSeat(team, seat.name)) {
      return {
        row,
        note: launcher && !differs
          ? `${seat.name}: started by a launcher; team cannot tell its process from the one it launched`
          : restoredProcessWhat(seat, running, launcher),
      };
    }
    return {
      row,
      difference: {
        what: restoredProcessWhat(seat, running, launcher),
        repair,
        ...(repair === 'look at the pane' ? {} : { needs: 'approve' as const }),
      },
    };
  }
  return {
    row,
    difference: {
      what: `${seat.name}: its pane holds a process this record cannot tie to the launch`,
      repair: 'look at the pane',
    },
    ...(shown ? { note: shown } : {}),
  };
}

/** What a pane team did not launch is doing: a model that is not the file's, a launcher the
 *  process is not, or both. */
function restoredProcessWhat(
  seat: Seat,
  running: { model: string; version: string } | null,
  launcher: boolean,
): string {
  const tail = 'the process in its pane is not the one team launched';
  const differs = running !== null && modelDiffers(running, seat);
  if (differs && running && launcher) {
    return `${seat.name} runs ${running.model} ${running.version}; the file says ${declaredModel(seat)}; its launch line starts a launcher; ${tail}`;
  }
  if (differs && running) {
    return `${seat.name} runs ${running.model} ${running.version}; the file says ${declaredModel(seat)}; ${tail}`;
  }
  return `${seat.name}: its launch line starts a launcher, and ${tail}`;
}

function notLaunched(
  seat: Seat,
  pane: string,
  verdict: 'gone' | 'replaced',
  screen: string | undefined,
): { row: Row; difference: Difference; note?: string } {
  const running = seatModel(seat, screen);
  return {
    row: {
      name: seat.name,
      state: verdict === 'gone' ? 'missing' : 'restored, not launched by team',
      // A replaced pane runs a CLI team did not launch: its model is unknown, so it is never
      // shown under the declared one as if it were running. A pane with no CLI holds no model
      // either, but `missing` rows carry the declared one as they always have.
      model: verdict === 'gone' ? seat.display : '-',
      pane,
    },
    difference: {
      what: verdict === 'gone'
        ? `${seat.name}: its pane runs no CLI (the CLI ended or the session was restored)`
        : `${seat.name}: the process in its pane is not the one team launched; nothing checks its model, account or rules`,
      // The same repair `up` makes: it closes the pane without typing and launches the seat
      // fresh. Admitted by the map's `up` row for the owner and the team's leads alike, so it is
      // not counted among the owner's.
      repair: 'team up',
      needs: 'approve',
    },
    // A note, not a difference: it names what the screen shows and does not change the exit.
    ...(running
      ? { note: `${seat.name}: its pane runs ${running.model} ${running.version}; that process is not the one team launched` }
      : {}),
  };
}

/** What an unverified pane may show in the model column: the model its screen names, or the
 *  seat's declared display marked `(declared, unread)`. Never a difference — this is not a
 *  comparison. */
function unverifiedModel(seat: Seat, screen: string | undefined): string {
  const running = seatModel(seat, screen);
  return running ? `${running.model} ${running.version}` : `${seat.display} (declared, unread)`;
}

function modelOf(
  seat: Seat,
  agent: HerdrAgent,
  live: Live,
  differences: Difference[],
  notes: string[],
  team: TeamFile,
  /** The seat's record has no process identity and is ready: the repair is abandon, then up. */
  unidentified: boolean,
  registered: boolean,
): string {
  const screen = live.screens[agent.pane];
  const running = registered ? runningModel(seat.cli, screen ?? '') : seatModel(seat, screen);
  if (!running) {
    // A profile may say the launch line's model stands when the screen names none: its column
    // shows it labelled, and the note says where the name comes from.
    if (launchModelWhenUnread(seat.cli)) {
      notes.push(`${seat.name}: its screen shows no model; the launch line's ${seat.display} stands`);
      return `${seat.display} (from launch)`;
    }
    // A screen that names no model is never shown as though it had been read: the column keeps
    // the seat's declared display and marks both halves — declared, and unread. A registry
    // record's declaration is named as the registry's; without one the file's (or the state's
    // retained) declaration stands, still marked as a declaration and never as a reading.
    if (registered) {
      notes.push(`${seat.name}: its screen shows no model; the registry declares ${seat.display}, and the screen reading is unread`);
    } else {
      notes.push(`${seat.name}: its screen shows no model; the declared ${seat.display} stands, and the screen reading is unread`);
    }
    return `${seat.display} (declared, unread)`;
  }
  // What the pane shows against what the file promises, effort included: the word the screen
  // prints is the observed one, and a screen printing none leaves the file's word standing —
  // the rule the label's own line follows — so only a word actually seen can differ from it.
  // When the file declares no effort, a seen word is not a drift. When only the effort drifts,
  // the line names the effort alone so it never echoes the model in another word order.
  const seen = observedEffort(seat.cli, screen);
  const modelDrifts = modelDiffers(running, seat);
  const effortDrifts = seen !== undefined && seat.effort !== undefined && seen !== seat.effort;
  if (!modelDrifts && !effortDrifts) return seat.display;
  const declared = declaredModel(seat);
  const observed = `${running.model} ${running.version}${seen ? ` ${seen}` : ''}`;
  const file = `${declared}${seat.effort ? ` ${seat.effort}` : ''}`;
  const detail = modelDrifts
    ? `running ${observed}, ${registered ? 'registry' : 'file'} says ${file}`
    : `effort ${seen}, file says ${seat.effort}`;
  differences.push(unidentified
    ? {
        what: `${seat.name}: ${detail}; its process was never recorded`,
        repair: unidentifiedRepair(team, seat.name),
        needs: 'approve',
        owner: true,
      }
    : {
        what: `${seat.name}: ${detail}`,
        repair: modelMismatchRepair(team, seat.name),
        needs: 'approve',
      });
  // The column is the running model's when that is what drifted; an effort alone does not
  // change it, the model on the pane is still the file's.
  return modelDrifts ? `${running.model} ${running.version} (file: ${seat.display})` : seat.display;
}

/** The model-mismatch repair. A lead cannot be removed, so it gets the same whole-team
 *  wording `up` prints (`relaunchRepair`). An ordinary seat keeps remove --keep, then add.
 *  Correcting the file and approving it is still a repair for either seat. */
function modelMismatchRepair(team: TeamFile, name: string): string {
  const command = isLeadSeat(team, name)
    ? relaunchRepair(team, name, 'plain')
    : `team remove ${name} --keep, then team add ${name}`;
  return `restart the seat on the file's model (${command}), or correct the file`;
}

/** A pane that holds only a shell, on a record that never stored the process team launched.
 *  `up` will not relaunch it. The row matches a gone pane; the repair does not name `team up`. */
function unidentifiedShell(
  seat: Seat,
  pane: string,
  team: TeamFile,
): { row: Row; difference: Difference } {
  return {
    row: { name: seat.name, state: 'missing', model: seat.display, pane },
    difference: {
      what: `${seat.name}: its pane runs no CLI and its process was never recorded`,
      repair: unidentifiedRepair(team, seat.name),
      needs: 'approve',
      owner: true,
    },
  };
}
