import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
// A send that finds the receiving seat's lock held by another command is queued, not refused:
// the reachable legs store the signed record and the marker the watch already delivers, type
// nothing, and answer `queued (receiver busy)` with the id the delivery keeps. The scenes here
// hold the lock with this very process's own pid, then free it and run the watch's pass over a
// scripted pane: one trigger, one history line per step, and a receipt that turns the queued
// message into `delivered (read)` exactly once. Nothing here reads a live session and no real
// socket, pane or key is touched.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { readMessage, writeListener } from '../src/mcp/inbox.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { readHistory } from '../src/send/history.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { readPending } from '../src/send/pending.ts';
import type { Live } from '../src/status/compare.ts';
import { promoteInboxDrops, retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';
import { claudeBox, recordBody } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { dropDir, fake, filed, NOW, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** A pane the watch's pass scripts: the screen it shows, the status it reports, the calls it
 *  received, and — for a scene whose seat runs the read — what submitting does. Submitting moves
 *  the status to working and clears the box, as a real seat does. */
type Pane = { screen: string | null; status: string; typed: string[]; enters: number; onSubmit?: () => void };

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      // A bracketed paste redraws the box as its rows; a trigger is the box's text.
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      one.screen = claudeBox(pasted ? pasted[1] ?? '' : text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      one.status = 'working';
      one.screen = claudeBox('');
      one.onSubmit?.();
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(name: string, paneId: string): Live {
  const agents: HerdrAgent[] = [
    { name, agent: 'claude', pane: paneId, workspace: 'first', status: 'idle', cwd: null },
    // A busy coordinator, so the pass has no idle stretch of its own to report.
    { name: null, agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function teamOf(made: World) {
  const result = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** The watch's scene around a scripted pane, at one reading of the clock. */
function scene(made: World, one: Pane, said: string[], at: Date = NOW) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made),
    live: liveWith('lead', 'w1:p1'),
    ownPane: null,
    sources: scripts(one),
    now: at,
    say: (text: string) => said.push(text),
  };
}

type QueuedDoc = {
  status: string;
  channel: string;
  ids: { sent: string | null };
  delivery: { leg: string; state: string; reason?: string }[];
};
