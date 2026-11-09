// One reading of a seat that cannot take work. The screen readers and the register
// process verdict (the pane still runs the seat's own CLI) decide the first two
// reasons. Out of tokens is an injected observation until that state is merged;
// the default is none. A wake is not taken unless the screen shows the text
// submitted and the seat working, or the drop's read receipt is already there.
import type { PaneProcesses } from '../herdr.ts';
import { paneHoldsOnlyShell, seatProcessVerdict, type LaunchedIdentity } from '../launch/identity.ts';
import { readScreen, type Screen } from './screen.ts';

/** How long the lead is still told after a seat stops being able to work. A later
 *  pass in the same episode stays quiet. */
export const SEAT_WORK_REPORT_MS = 3 * 60 * 1000;

export type CantWorkReason = 'no CLI' | 'model failing' | 'out of tokens' | 'wake not taken';

export type SeatWorkInput = {
  seat: string;
  cli: string;
  /** The pane's visible text, or a screen the readers already classified. */
  screen: string | { kind: Screen['kind']; reason?: string };
  /** The process identity `team register` recorded, when this seat has one. */
  recorded?: LaunchedIdentity;
  /** The pane's process table. Null when it cannot be read, which is not "no CLI". */
  processes?: PaneProcesses | null;
  /** Milliseconds since this episode started. Absent is the moment it was seen. */
  elapsedMs?: number;
  /** The lead was already told in this episode. This does not by itself mean the restart ran. */
  told?: boolean;
  /** The no-CLI restart already ran in this episode. Absent follows `told`, so a caller that
   *  only records the report still suppresses the restart. The watch passes false until the
   *  restart actually runs, so a hold can mark the lead told and still restart once it lifts. */
  restarted?: boolean;
  /** The out-of-tokens observation. Absent is none. */
  tokens?: { reason: string };
  /** A wake this send already asked for. Absent means no wake was asked. */
  wake?: { submitted: boolean; working: boolean; receipt: boolean };
};

export type SeatWorkRestart = {
  /** `team restart <seat>`, resumed. Never `--abandon` and never `--fresh`. */
  argv: string[];
  resumed: true;
  audit: string;
};

export type SeatWork =
  | { ok: true }
  | {
      ok: false;
      reason: CantWorkReason;
      line: string;
      tellLead: boolean;
      retry: boolean;
      restart?: SeatWorkRestart;
    };

/** FLO-961's state on a classified screen: a rate limit whose reason is out of tokens. */
function tokensOnScreen(screen: SeatWorkInput['screen']): boolean {
  return typeof screen !== 'string' && screen.kind === 'rate limit' && screen.reason === 'out of tokens';
}

function screenKind(cli: string, screen: SeatWorkInput['screen']): Screen['kind'] {
  if (typeof screen === 'string') return readScreen(cli, screen).kind;
  return screen.kind;
}

/** The pane is back at its shell: the recorded CLI is gone, or the only process
 *  in front is the pane's own shell. An unread table is not that. */
function cliIsGone(recorded: LaunchedIdentity | undefined, processes: PaneProcesses | null | undefined): boolean {
  if (!processes) return false;
  if (seatProcessVerdict(recorded, processes) === 'gone') return true;
  return recorded === undefined && paneHoldsOnlyShell(processes);
}

function stopped(seat: string, reason: CantWorkReason, input: SeatWorkInput): SeatWork {
  const told = input.told === true;
  const elapsed = input.elapsedMs ?? 0;
  const restartDone = input.restarted === true || (input.restarted === undefined && told);
  const restart = reason === 'no CLI' && !restartDone
    ? {
        argv: [seat],
        resumed: true as const,
        audit: `restart ${seat} from its record, resumed`,
      }
    : undefined;
  return {
    ok: false,
    reason,
    line: `not delivered: ${reason}`,
    tellLead: !told && elapsed <= SEAT_WORK_REPORT_MS,
    retry: reason === 'wake not taken',
    ...(restart ? { restart } : {}),
  };
}

export function seatCanWork(input: SeatWorkInput): SeatWork {
  if (cliIsGone(input.recorded, input.processes ?? null)) return stopped(input.seat, 'no CLI', input);
  if (screenKind(input.cli, input.screen) === 'provider error') return stopped(input.seat, 'model failing', input);
  if (input.tokens?.reason === 'out of tokens' || tokensOnScreen(input.screen)) {
    return stopped(input.seat, 'out of tokens', input);
  }
  const wake = input.wake;
  if (wake !== undefined && !wake.receipt && !(wake.submitted && wake.working)) {
    return stopped(input.seat, 'wake not taken', input);
  }
  return { ok: true };
}
