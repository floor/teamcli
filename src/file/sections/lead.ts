import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { LeadMark } from './section.ts';
import type { DraftSeat } from './seats.ts';

export function readLead(
  entry: YamlEntry | undefined, field: 'coordinator' | 'operator', seats: DraftSeat[], broken: Set<string>, check: Check,
): string {
  const name = check.required(entry, field, 1);
  if (!name || !entry) return '';
  seatProblems(name, `${field} "${name}"`, entry.value.line, seats, broken, check);
  return name;
}

/**
 * The file's lead, from its two spellings: the top-level `coordinator:` key, still read, and
 * `leads: true` on exactly one seat. One lead, or none: a file with neither spelling is refused,
 * a file with the mark on two seats is refused, and a key naming one seat beside a mark on
 * another is refused. A marked file and a keyed file of the same team carry the same lead's name
 * and nothing else apart — the mark never reaches a seat object — so the two read as one team.
 */
export function readLeadField(
  entry: YamlEntry | undefined, marks: readonly LeadMark[], seats: DraftSeat[], broken: Set<string>, check: Check,
): string {
  if (marks.length > 1) {
    // Refused at the second mark's line: the one that makes it more than one. Every marked seat
    // is named, so the sentence repairs the file on its own.
    const holding = marks.map((mark) => `"${mark.name}"`).join(', ');
    check.fail(marks[1]!.line, `\`leads\` is on ${marks.length} seats: ${holding}; a team has one lead`);
    return '';
  }
  const mark = marks[0];
  if (!mark) {
    if (entry) return readLead(entry, 'coordinator', seats, broken, check);
    check.fail(1, 'the file has no seat that leads: put `leads: true` on one seat');
    return '';
  }
  if (entry) {
    const key = check.required(entry, 'coordinator', 1);
    if (key !== undefined && key !== mark.name) {
      check.fail(entry.value.line, `\`coordinator:\` names ${key} and \`leads\` is on ${mark.name}: a file names one lead`);
    }
  }
  // The marked seat's own checks run whichever way the key spelled it: a mark on a seat that
  // cannot lead is refused, and that refusal never lets the key point the lead at someone else.
  seatProblems(mark.name, `\`leads\` on "${mark.name}"`, mark.line, seats, broken, check);
  return mark.name;
}

/** The ways a seat the file names cannot lead, in the words the file used to name it. A stopped
 *  lead stays refused: `team remove <lead> --keep` is a swap and never writes `stopped:` on the
 *  lead (`commands/remove.ts`), so this line only meets a hand-edited file. */
function seatProblems(name: string, at: string, line: number, seats: DraftSeat[], broken: Set<string>, check: Check): void {
  const seat = seats.find((candidate) => candidate.name === name);
  if (!seat) {
    if (!broken.has(name)) check.fail(line, `${at} names no declared seat`);
  } else if (seat.count > 1) check.fail(line, `${at} can't be a seat with count`);
  else if (seat.parked) check.fail(line, `${at} can't be a parked seat`);
  else if (seat.stopped) check.fail(line, `${at} can't be a stopped seat`);
}

/** Whether a seat is the orchestrator or the operator, by the name the file resolved.
 *  The role is not read: `coordinator` and `orchestrator` are that lead when the name matches.
 *  `up` will not cycle this seat. `add` and `remove` admit the same names. */
export function isLeadSeat(
  team: { orchestrator: string; operator: string },
  name: string,
): boolean {
  return name === team.orchestrator || name === team.operator;
}

/**
 * The relaunch repair command for a seat `up` leaves as it is:
 * for the orchestrator or the operator, `remove --keep` is a swap only the owner, the grant's
 * `swap` or a delegate's `swap` admits, so the line offers `team down` then `team up`
 * (to restart the whole team).
 * For ordinary seats, both the per-seat and whole-team sequence are offered.
 */
export function relaunchRepair(
  team: { orchestrator: string; operator: string },
  name: string,
  mode: 'markdown' | 'plain' = 'markdown',
): string {
  const lead = isLeadSeat(team, name);
  if (mode === 'markdown') {
    return lead
      ? '`team down` then `team up` (to restart the whole team)'
      : `\`team remove ${name} --keep\` then \`team add ${name}\` (or \`team down\` then \`team up\` for the whole team)`;
  }
  return lead
    ? 'team down, then team up (to restart the whole team)'
    : `team remove ${name} --keep, then team add ${name} (or team down, then team up, for the whole team)`;
}

/** The restart a report names. An ordinary seat is removed and added again. A lead cannot
 *  be removed, so the whole team is started again. Nothing here starts the seat. */
export function seatRestartRepair(
  team: { orchestrator: string; operator: string },
  name: string,
): string {
  return isLeadSeat(team, name)
    ? 'team down, then team up (to restart the whole team)'
    : `team remove ${name} --keep, then team add ${name}`;
}

/**
 * The repair for a seat recorded with no process identity whose pane is a bare shell or
 * another model. `up` will not close that pane: the record cannot prove it is the seat's.
 * `remove --keep` refuses a screen the profile does not recognise. A lead is never removed;
 * the whole team is abandoned and started again.
 */
export function unidentifiedRepair(
  team: { orchestrator: string; operator: string },
  name: string,
): string {
  return isLeadSeat(team, name)
    ? 'team down --abandon, then team up'
    : `team remove ${name} --abandon, then team up`;
}
