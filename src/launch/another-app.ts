// Codex's "open in another app" notice, met by a launch that resumes the seat's own
// conversation.
//
// Seen live on codex-cli 0.167.0 (2026-11-16, twice on one machine after a restart): `/exit` in
// a Codex pane only detaches the task ("Disconnected from this task. Any running work
// continues"), so the conversation stays held by Codex's own background task. The relaunch's
// `codex resume <id>` then draws, in place of the composer:
//
//   This conversation is open in another app.
//   Close it there and press R to continue here
//
// and sends nothing until it is answered. The profile reads that screen as a provider error and
// the launch stopped there, waiting for the owner.
//
// `R` takes the conversation over in this pane. That is right only when the other holder is the
// seat's own old task. It is wrong when another live pane holds the conversation, as when a
// duplicate seat was launched beside a live one: there `R` would take the conversation from
// the live seat. So the key is pressed only when every one of these holds:
//   - the CLI is Codex and the screen draws both notice rows;
//   - the launch line names the conversation it resumes;
//   - herdr's list of every running session can be read, and no pane in it (other than the
//     launch's own) reports that conversation.
// Anything less leaves the notice to the owner, as before. The key is pressed once per launch.

import type { HerdrAgent } from '../herdr.ts';

const NOTICE_ROWS = [
  /This conversation is open in another app/,
  /Close it there and press R to continue here/,
] as const;

/** Whether the pane text draws Codex's "open in another app" notice: both of its rows. */
export function codexOpenElsewhere(text: string): boolean {
  return NOTICE_ROWS.every((row) => row.test(text));
}

export type HolderSources = {
  /** Every herdr session, or null when herdr cannot list them. */
  sessions(): readonly { name: string; running: boolean }[] | null;
  /** One session's agents, or null when they cannot be read. */
  agents(session: string): readonly HerdrAgent[] | null;
};

/**
 * The panes of every running herdr session that report `id` as their conversation, or null when
 * any list that matters cannot be read. An unreadable session is not "no holder": it is unknown.
 */
export function conversationHolders(sources: HolderSources, id: string): { session: string; pane: string }[] | null {
  const listed = sources.sessions();
  if (listed === null) return null;
  const found: { session: string; pane: string }[] = [];
  for (const one of listed) {
    if (!one.running) continue;
    const agents = sources.agents(one.name);
    if (agents === null) return null;
    for (const agent of agents) {
      if (agent.session === id) found.push({ session: one.name, pane: agent.pane });
    }
  }
  return found;
}

/**
 * The decision for one reading: `press` when `R` may take the conversation over in this pane,
 * otherwise the reason it may not, for the log.
 */
export function anotherAppDecision(input: {
  cli: string;
  text: string | null;
  resumes: string | null;
  holders: { session: string; pane: string }[] | null;
  here: { session: string; pane: string };
}): { press: true } | { press: false; why: string } {
  if (input.cli !== 'codex') return { press: false, why: 'not a Codex seat' };
  if (input.text === null || !codexOpenElsewhere(input.text)) return { press: false, why: 'the notice is not drawn' };
  if (!input.resumes) return { press: false, why: 'the launch line names no conversation it resumes' };
  if (input.holders === null) return { press: false, why: 'the running sessions could not be read' };
  const others = input.holders.filter((one) => !(one.session === input.here.session && one.pane === input.here.pane));
  if (others.length > 0) {
    const where = others.map((one) => `${one.pane} in session ${one.session}`).join(', ');
    return { press: false, why: `another live pane holds the conversation (${where})` };
  }
  return { press: true };
}
