// From the config's addresses to the targets one beat can send to: each `<seat>@<team>` is
// resolved through the registry to a team record, the record's checkout is loaded, and the seat
// it names must be a declared seat of that file — never a human's pane and never the owner. The
// text is filled per target, so `{team}` and `{seat}` say what the receiving seat reads rather
// than the sender's own team.
//
// A target that does not resolve refuses its whole reminder, named, and the other reminders
// read: a reminder that could reach only some of the seats it names would deliver a partial
// instruction with no sign that it was partial. Whether the checkout is hosted by the daemon is
// not decided here — the daemon's admission refuses a recipient its principal did not host, with
// the root named, at the fire rather than at the read.
import type { DaemonRecipient } from '../commands/send.ts';
import { canonicalRoot } from '../daemon/routes.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat } from '../file/types.ts';
import { findTeams } from '../registry/teams.ts';
import { parseSpec } from '../send/resolve.ts';
import { fillReminderText, type ReminderConfigEntry, type ReminderConfigProblem } from './config.ts';
import type { ReminderSpec, ReminderTarget } from './run.ts';

export type ReminderResolution = { specs: ReminderSpec[]; problems: ReminderConfigProblem[] };

/** Every entry resolved to the runtime's spec, or refused alone. */
export function resolveReminderEntries(home: string, entries: readonly ReminderConfigEntry[]): ReminderResolution {
  const specs: ReminderSpec[] = [];
  const problems: ReminderConfigProblem[] = [];
  for (const entry of entries) {
    const resolved = resolveEntry(home, entry);
    if ('why' in resolved) {
      problems.push({ entity: entry.entity, name: entry.name, why: resolved.why });
      continue;
    }
    specs.push({
      name: entry.name,
      at: entry.at,
      zone: entry.zone,
      ...(entry.catchUp === undefined ? {} : { catchUp: entry.catchUp }),
      targets: resolved.targets,
    });
  }
  return { specs, problems };
}

type ResolvedEntry = { targets: ReminderTarget[] } | { why: string };

function resolveEntry(home: string, entry: ReminderConfigEntry): ResolvedEntry {
  const targets: ReminderTarget[] = [];
  const seen = new Set<string>();
  for (const target of entry.targets) {
    const where = resolveAddress(home, entry, target.address);
    if ('why' in where) return where;
    const { recipient, team } = where;
    const key = `${recipient.root}\u0000${recipient.session}\u0000${recipient.seat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const template = target.text ?? entry.text;
    if (template === null) return { why: `${target.address}: the reminder writes no text to fill` };
    targets.push({
      recipient,
      text: fillReminderText(template, { team, seat: recipient.seat, name: entry.name }),
    });
  }
  return { targets };
}

type Addressed = { recipient: DaemonRecipient; team: string } | { why: string };

/** One address: the team record, its checkout's own file, and the seat that file declares. */
function resolveAddress(home: string, entry: ReminderConfigEntry, address: string): Addressed {
  const parsed = parseSpec(address);
  if ('error' in parsed || parsed.kind !== 'at') return { why: `${address}: not a <seat>@<team> address` };
  const teams = findTeams(home, parsed.scope);
  if (teams.length === 0) return { why: `${address}: no team registry record matches "${parsed.scope}" (by id, name or session)` };
  if (teams.length > 1) {
    const ids = teams.map((team) => team.id ?? '(no id)').join(', ');
    return { why: `${address}: "${parsed.scope}" names ${String(teams.length)} teams (${ids}); say which by its id` };
  }
  const record = teams[0]!;
  const root = canonicalRoot(record.root);
  if (root === null) return { why: `${address}: the checkout ${record.root} cannot be read` };
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) {
    const why = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return { why: `${address}: the team file at ${root} cannot be read${why === '' ? '' : ` (${why})`}` };
  }
  const team = loaded.team;
  const seat = namedSeat(team.seats, parsed.target, team.orchestrator);
  if (seat === null) return { why: `${address}: ${team.project} declares no seat or nickname "${parsed.target}"` };
  if (seat.name === 'owner') return { why: `${address}: the daemon addresses a declared seat, never the owner` };
  if (seat.human === true) return { why: `${address}: ${seat.name} is a human seat, and the daemon addresses seats with a delivery order` };
  return { recipient: { root, session: team.session, seat: seat.name }, team: team.project };
}

/** The seat an address names: `lead` is the team's own lead seat, otherwise a declared name and
 *  then a nickname. The nickname is the second pass so a seat named like another's nickname wins
 *  the name it holds. */
function namedSeat(seats: readonly Seat[], target: string, lead: string): Seat | null {
  if (target === 'lead') return seats.find((seat) => seat.name === lead) ?? null;
  const named = seats.find((seat) => seat.name === target);
  if (named !== undefined) return named;
  return seats.find((seat) => seat.nickname === target) ?? null;
}
