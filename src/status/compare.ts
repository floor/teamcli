import { trustPolicy } from '../file/dialogs.ts';
import { declaredModel } from '../file/model.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../herdr.ts';
import { herdrCommand } from '../herdr.ts';
import { paneHoldsShell, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { isLeadSeat, relaunchRepair, seatRestartRepair, unidentifiedRepair } from '../file/sections/lead.ts';
import { usesLauncher } from '../launch/line.ts';
import type { SeatState, SessionState } from '../state.ts';
import { readScreen } from '../watch/screen.ts';
import { modelDiffers, seatModel } from './statusline.ts';

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

export type Row = { name: string; state: string; model: string; pane: string; stored?: string; start_cwd?: string };

/** The repair of the one precondition `status` knows: the file is not the approved one. The
 *  approval differences carry it, and a repair that waits on it is marked with it. */
export const APPROVAL_REPAIR = 'the owner runs team approve';

/**
 * One disagreement, with the two facts about its repair that the renderer needs and must not
 * re-derive from the repair's wording, both set where the difference is created:
 *
 * - `needs`: the repair names a command that refuses while the file is not the approved one.
 *   Confirmed from the commands themselves: `team up` (`up.ts`), `team add` (`add.ts`), and
 *   `team worktree` (`worktree.ts`) each refuse on the standing before they do anything. Such a
 *   repair waits for `APPROVAL_REPAIR`, and is printed with `(after: …)` while the approval
 *   difference is there. A difference is never marked for a command that does not refuse.
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
};

export type Comparison = { rows: Row[]; differences: Difference[]; notes: string[] };

export const WATCH_LABEL = 'watchdog';

/** The one row a seat shows while it waits, ahead of the ordinary launch-stopped and unnamed rows. */
function waitingView(
  name: string,
  recorded: SeatState | undefined,
  team: TeamFile,
): { state: string; stored: string; difference: Difference } | null {
  const waiting = recorded?.waiting;
  if (!waiting) return null;
  if (waiting.state === 'trust-sent-recovery') {
    return {
      state: 'trust sent; recovery required',
      stored: 'trust-sent-recovery',
      difference: {
        what: `${name}: trust sent; recovery required`,
        repair: 'the owner runs team up',
        needs: 'approve',
        owner: true,
      },
    };
  }
  const phrase = `waiting for owner (${waiting.classification})`;
  const answer = trustPolicy(team) === 'coordinator' && waiting.classification === 'trust';
  return {
    state: phrase,
    stored: 'waiting-owner',
    difference: {
      what: `${name}: ${phrase}`,
      repair: answer ? `team answer ${name} trust` : 'the owner runs team up',
      needs: 'approve',
      ...(answer ? {} : { owner: true as const }),
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

// Compares the file and the state with the live session. Pure: every input is handed in.
// `watch` is the watch values in force — the approved ones — so an unapproved edit can't move a verdict.
export function compare(
  team: TeamFile,
  session: string,
  state: SessionState,
  live: Live,
  now: Date = new Date(),
  watch: TeamFile['watch'] = team.watch,
): Comparison {
  const rows: Row[] = [];
  const differences: Difference[] = [];
  const notes: string[] = [];
  const claimed = new Set<string>();
  const labels = new Map(live.workspaces.map((workspace) => [workspace.id, workspace.label]));
  const anyRunning = team.seats.some((seat) => live.agents.some((agent) => agent.name === seat.name));

  for (const seat of team.seats) {
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    const recorded = state.seats[seat.name];
    if (agent) {
      claimed.add(agent.pane);
      // The pane is the seat only while the process team launched is still in it. A pane that
      // runs no CLI, or one whose process is not the recorded one, is not this seat: it is
      // never shown idle, working or ready, and never under its model as if it were running.
      const verdict = seatProcessVerdict(recorded?.launched, live.processes?.[agent.pane] ?? null);
      const continuity = replacedSeat(verdict, {
        asked: true,
        namedOnPane: recorded?.pane === agent.pane,
        recordedSession: recorded?.agent_session,
        liveSession: agent.session,
      });
      // The stored session is on this pane: the seat is running, whatever its pids are now.
      if (continuity !== 'restored' && (verdict === 'gone' || verdict === 'replaced')) {
        const found = verdict === 'gone'
          ? notLaunched(seat, agent.pane, verdict, live.screens[agent.pane])
          : cannotTie(seat, agent.pane, live.screens[agent.pane], team);
        rows.push(found.row);
        differences.push(found.difference);
        if (found.note) notes.push(found.note);
        continue;
      }
      // The conversation came back without the program the launch line names. Said here; the
      // seat is still the running one, and nothing in this report starts it.
      if (continuity === 'restored' && usesLauncher(seat)) {
        differences.push({
          what: `${seat.name}: its launch line starts a launcher, and the process in its pane is not the one team launched`,
          repair: seatRestartRepair(team, seat.name),
          needs: 'approve',
          owner: true,
        });
      }
      // A ready seat with no identity is not relaunched by `up` when its model differs. A seat
      // still at launch is: `up` finishes it, so that repair stays `team up`. A bare shell is
      // not finished at any stage: there is no CLI to resume.
      const noIdentity = recorded !== undefined && !recorded.launched;
      const unidentified = noIdentity && recorded.stage === 'ready';
      const shell = noIdentity && paneHoldsShell(live.processes?.[agent.pane] ?? null);
      // A shell has no model to compare. Reading it would add an "unread" note beside the
      // repair that already says the pane runs no CLI.
      const model = shell ? seat.display : modelOf(seat, agent, live, differences, notes, team, unidentified);
      const held = waitingView(seat.name, recorded, team);
      if (held) {
        rows.push({
          name: seat.name,
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
        rows.push({ ...found.row, ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}) });
        differences.push(found.difference);
        continue;
      }
      const screenText = live.screens[agent.pane];
      const screen = readScreen(seat.cli, screenText);
      // `done` is as free as `idle`: delivery types into either one (`deliver.ts`), and the
      // watch's unsent check covers both (`pass.ts`). The report reads them the same way.
      const quiet = agent.status === 'idle' || agent.status === 'done';
      const isUnsent = quiet && screen.kind === 'unsent';
      // A quiet seat on a screen no profile reads: herdr's word alone would show a bare done (the
      // watch reports the same reading, pass.ts). The row says what herdr could not, and nothing
      // else about the seat moves — no verdict, no difference.
      const unread = quiet && screen.kind === 'unknown';
      const mark = isUnsent ? ' (unsent text)' : unread ? ' (screen not recognised)' : '';
      const stateText = `${agent.status}${mark}${seat.parked ? ', parked' : ''}`;
      rows.push({
        name: seat.name,
        state: stateText,
        model,
        pane: agent.pane,
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
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
          repair: 'the owner clears or sends it in the pane, then runs team up (it resumes the launch)',
          needs: 'approve',
          owner: true,
        });
      } else {
        if (recorded && recorded.stage !== 'ready' && !unidentifiedMismatch) {
          differences.push({
            what: `${seat.name}: its launch stopped at "${recorded.stage}"`,
            repair: 'the owner runs team up (it resumes the launch)',
            needs: 'approve',
            owner: true,
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
      rows.push(row);
      differences.push(difference);
      if (note) notes.push(note);
      continue;
    }
    if (held && verdict === 'replaced') {
      claimed.add(held);
      const found = cannotTie(seat, held, live.screens[held], team);
      rows.push(found.row);
      differences.push(found.difference);
      if (found.note) notes.push(found.note);
      continue;
    }
    if (held && recorded && !recorded.launched && paneHoldsShell(paneProc)) {
      claimed.add(held);
      const found = unidentifiedShell(seat, held, team);
      rows.push({ ...found.row, ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}) });
      differences.push(found.difference);
      continue;
    }
    // A waiting record is read only of a pane that may still hold the seat: one that lost the
    // launched process reads `missing` or `restored, not launched by team` above — never
    // `waiting for owner`, and never under the declared model for a replaced one.
    const waiting = recorded?.pane ? waitingView(seat.name, recorded, team) : null;
    if (waiting && recorded?.pane) {
      rows.push({
        name: seat.name,
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
      state: 'missing',
      model: seat.display,
      pane: '-',
      ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
    });
    differences.push({
      what: `${seat.name} is in the file and is not running`,
      repair: anyRunning ? `team add ${seat.name}` : 'the owner runs team up',
      needs: 'approve',
      ...(anyRunning ? {} : { owner: true as const }),
    });
  }

  for (const [name, recorded] of Object.entries(state.seats)) {
    if (!recorded.temporary) continue;
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (agent) {
      claimed.add(agent.pane);
      const held = waitingView(name, recorded, team);
      if (held) {
        rows.push({
          name,
          state: held.state,
          stored: held.stored,
          model: `like ${recorded.temporary.like}`,
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
      const like = recorded.temporary.like;
      const likeCli = team.seats.find((seat) => seat.name === like)?.cli ?? '';
      const quiet = agent.status === 'idle' || agent.status === 'done';
      const unread = quiet && readScreen(likeCli, live.screens[agent.pane]).kind === 'unknown';
      rows.push({
        name,
        state: `${agent.status}${unread ? ' (screen not recognised)' : ''}, temporary`,
        model: `like ${recorded.temporary.like}`,
        pane: agent.pane,
        ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      notes.push(`${name} is temporary, until ${recorded.temporary.until}`);
    } else {
      differences.push({ what: `${name}: a temporary seat is recorded and is not running`, repair: `team remove ${name}` });
    }
  }

  for (const agent of live.agents) {
    if (claimed.has(agent.pane) || labels.get(agent.workspace) === WATCH_LABEL) continue;
    differences.push({
      what: `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`,
      repair: 'add the seat to the file and run team approve, or close it',
    });
  }

  for (const [task, worktree] of Object.entries(state.worktrees)) {
    if (worktree.setup === 'failed') {
      differences.push({ what: `worktree ${task}: its setup failed`, repair: `team worktree remove ${task}`, needs: 'approve' });
    }
  }

  if (live.running && anyRunning) {
    const beat = state.watch ? Date.parse(state.watch.heartbeat) : NaN;
    if (!state.watch) {
      differences.push({ what: 'no watch has run for this session', repair: `team watch --session ${session}` });
    } else if (!(now.getTime() - beat <= 2 * watch.interval * 1000)) {
      const minutes = Number.isFinite(beat) ? Math.round((now.getTime() - beat) / 60_000) : null;
      differences.push({
        what: `the watch's last pass was ${minutes === null ? 'never recorded' : `${minutes} minute(s) ago`}`,
        repair: `team watch --session ${session}`,
      });
    }
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
): { row: Row; difference: Difference; note?: string } {
  const running = seatModel(seat, screen);
  const launcher = usesLauncher(seat);
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
    return {
      row,
      difference: {
        what: restoredProcessWhat(seat, running, launcher),
        repair: seatRestartRepair(team, seat.name),
        needs: 'approve',
        owner: true,
      },
    };
  }
  return {
    row,
    difference: {
      what: `${seat.name}: its pane holds a process this record cannot tie to the launch`,
      repair: 'look at the pane',
    },
    ...(running
      ? { note: `${seat.name}: its pane runs ${running.model} ${running.version}; that process is not the one team launched` }
      : {}),
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
      repair: 'the owner runs team up',
      needs: 'approve',
      owner: true,
    },
    // A note, not a difference: it names what the screen shows and does not change the exit.
    ...(running
      ? { note: `${seat.name}: its pane runs ${running.model} ${running.version}; that process is not the one team launched` }
      : {}),
  };
}

/** What an unverified pane may show in the model column: the model its screen names, or
 *  `(unread)`. Never the file's model, and never a difference — this is not a comparison. */
function unverifiedModel(seat: Seat, screen: string | undefined): string {
  const running = seatModel(seat, screen);
  return running ? `${running.model} ${running.version}` : '(unread)';
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
): string {
  const running = seatModel(seat, live.screens[agent.pane]);
  if (!running) {
    notes.push(`${seat.name}: version unread (its screen doesn't show the model)`);
    return `${seat.display} (unread)`;
  }
  if (!modelDiffers(running, seat)) return seat.display;
  const declared = declaredModel(seat);
  differences.push(unidentified
    ? {
        what: `${seat.name} runs ${running.model} ${running.version}; the file says ${declared}; its process was never recorded`,
        repair: unidentifiedRepair(team, seat.name),
        needs: 'approve',
        owner: true,
      }
    : {
        what: `${seat.name} runs ${running.model} ${running.version}; the file says ${declared}`,
        repair: modelMismatchRepair(team, seat.name),
        needs: 'approve',
      });
  return `${running.model} ${running.version} (file: ${seat.display})`;
}

/** The model-mismatch repair. A lead cannot be removed, so it gets the same whole-team
 *  wording `up` prints (`relaunchRepair`). An ordinary seat keeps remove --keep, then add.
 *  Correcting the file and approving it is still a repair for either seat. */
function modelMismatchRepair(team: TeamFile, name: string): string {
  const command = isLeadSeat(team, name)
    ? relaunchRepair(team, name, 'plain')
    : `team remove ${name} --keep, then team add ${name}`;
  return `restart the seat on the file's model (${command}), or correct the file and run team approve`;
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
