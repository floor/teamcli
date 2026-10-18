import { EVENT_THRESHOLDS } from '../../policy/events.ts';
import { minutes, type Report, type SeatObservation, type TeamCheck } from '../check.ts';

// A prompt that does not clear is a team that stops: the seat waits, nobody below the lead can
// answer, and the lead's own report is one line in a pass. This check keeps the promise that a
// prompt never goes silent: a non-lead's prompt starts a clock, and when the lead has not
// cleared it within `prompt_escalation_seconds` the watch raises `seat.prompt-escalated`, which
// the routing table sends to the entity's own lead and the owner at once. A prompt that clears
// before the window is the lead acting: the clock goes, and no climb is raised. A lead's own
// prompt is the first rung skipped — `recipientsForEvent` sends that at-prompt to the entity's
// lead and the owner from the start — so no timer is kept for it. One climb per prompt spell; a
// watch restarted mid-spell starts the clock again, and reports again rather than staying quiet.
// Nothing here types into a pane: a climb is a report and an event, never a keystroke.
type Prompt = 'permission' | 'vendor notice' | 'rate limit';

type Spell = { prompt: Prompt; since: number; escalated: boolean };

/** The prompt a seat is held at, in the words of the at-prompt event the watch publishes: a
 *  permission or trust dialog, the CLI's own vendor notice, and a usage limit the screen draws.
 *  The provider error is a block, not a prompt, and is not this check's. */
function promptOf(seat: SeatObservation): Prompt | null {
  if (!seat.running) return null;
  if (seat.attention === 'permission') return 'permission';
  if (seat.attention === 'vendor notice') return 'vendor notice';
  if (!seat.working && seat.screen.kind === 'rate limit') return 'rate limit';
  return null;
}

export const promptEscalation: TeamCheck = {
  name: 'prompt-escalation',
  run(team, ctx) {
    const spells = ctx.memory<Record<string, Spell>>('prompt-escalation', () => ({}));
    const window = EVENT_THRESHOLDS.prompt_escalation_seconds * 1000;
    const leads = new Set<string>();
    // The team's lead as routing names it (`leadSeatsOf`): the file's orchestrator. The operator
    // is a lead for idle counting, not the rung above a worker's prompt, so it climbs on time.
    if (team.team.orchestrator !== '') leads.add(team.team.orchestrator);
    const reports: Report[] = [];
    const current = new Set<string>();
    for (const seat of team.seats) {
      const prompt = promptOf(seat);
      if (prompt === null || leads.has(seat.name)) {
        delete spells[seat.name];
        continue;
      }
      current.add(seat.name);
      let spell = spells[seat.name];
      if (spell === undefined || spell.prompt !== prompt) {
        spell = { prompt, since: ctx.now, escalated: false };
        spells[seat.name] = spell;
      }
      if (spell.escalated || ctx.now - spell.since < window) continue;
      spell.escalated = true;
      reports.push({
        key: `prompt-escalated:${seat.name}`,
        text: `${seat.name} is still at a ${prompt} prompt after ${minutes(window)} minutes: the team's lead has not cleared it, and the entity's lead and the owner are told`,
        to: 'owner',
      });
    }
    // A seat gone from the pass cannot still hold a prompt: its spell goes with it.
    for (const name of Object.keys(spells)) {
      if (!current.has(name)) delete spells[name];
    }
    return reports;
  },
};
