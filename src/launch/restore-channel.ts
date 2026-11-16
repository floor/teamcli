// Bring back a lead's channel pair that went missing from its project folder.
//
// `team mcp setup <lead>` writes `.mcp.json` and its approval into the project checkout and puts
// the channel flag on the lead's launch line. Those files are local and untracked, so a clean of
// untracked files can take them away (material, vlist and jedi lost theirs before 2026-11-16).
// The lead then launches without its channel: `team up` says "its project folder has no channel
// pair for this seat" and the inbox shows team-inbox ✗ in /mcp until someone runs setup again.
//
// The restore pass repairs exactly that, through setup itself, with its own gates: only a running
// Claude lead whose start folder is the project root, whose launch line already carries the
// channel flag (setup put it there, so a pair existed), and whose pair is now absent. A seat whose
// line never carried the flag never had a pair and gets none. After a repair the lead is told to
// reconnect /mcp, in one signed notice per seat per day.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { channelLaunchEnabled } from '../mcp/channel.ts';
import { channelPairPresent } from '../mcp/launch-config.ts';
import { runMcpSetup } from '../mcp/setup.ts';
import { writeRuntimeNotice } from '../send/endpoint-notice.ts';

export type ChannelRepair = { seat: string; outcome: 'recreated' | 'refused'; detail: string };

export type RestoreChannelDeps = {
  present?: (dir: string, seat: string) => boolean;
  setup?: (seat: string, io: Io) => Promise<number>;
  notify?: (input: { lead: string; body: string; id: string }) => boolean;
  now?: () => Date;
};

/** The lead seats whose pair the restore may recreate: the evidence of an earlier setup is the
 *  channel flag on the declared launch line. */
export function channelRepairCandidates(team: Pick<TeamFile, 'orchestrator' | 'operator' | 'seats'>, root: string, present: (dir: string, seat: string) => boolean): string[] {
  const leads = [...new Set([team.orchestrator, team.operator])];
  return leads.filter((name) => {
    const seat = team.seats.find((one) => one.name === name);
    if (seat === undefined || seat.stopped || seat.human || seat.cli !== 'claude-code') return false;
    if (resolve(root, seat.cwd) !== resolve(root)) return false;
    if (!channelLaunchEnabled(seat.launch)) return false;
    return !present(root, name);
  });
}

export async function restoreLeadChannels(input: {
  home: string; root: string; team: Pick<TeamFile, 'orchestrator' | 'operator' | 'seats' | 'session'>; caller: Caller;
  deps?: RestoreChannelDeps;
}): Promise<ChannelRepair[]> {
  const { home, root, team, caller } = input;
  const deps = input.deps ?? {};
  const present = deps.present ?? channelPairPresent;
  const now = deps.now ?? (() => new Date());
  const repairs: ChannelRepair[] = [];
  for (const seat of channelRepairCandidates(team, root, present)) {
    const said: string[] = [];
    // The owner's pane variable is left out: setup keeps the pane the seat's record holds and
    // registers nothing, exactly as an owner run from outside the seat's pane does.
    const env = { ...process.env };
    delete env.HERDR_PANE_ID;
    const io: Io = {
      cwd: root, env, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, caller,
      stdout: (text) => said.push(text), stderr: (text) => said.push(text),
    };
    const run = deps.setup ?? ((name: string, one: Io) => runMcpSetup({ values: {}, flags: new Set(['json']), rest: [name] }, true, one, home));
    const exit = await run(seat, io);
    const detail = said.join('').trim().split('\n').filter((line) => line.trim() !== '').at(-1) ?? '';
    if (exit !== 0 || !present(root, seat)) {
      repairs.push({ seat, outcome: 'refused', detail: detail === '' ? `setup exited ${String(exit)}` : detail });
      continue;
    }
    const at = now();
    const day = at.toISOString().slice(0, 10).replaceAll('-', '');
    const body = `${seat}: your channel pair (.mcp.json) was missing from ${root} and the restore recreated it through team mcp setup. Open /mcp and reconnect team-inbox; until then messages reach you at your next turn.`;
    const notify = deps.notify ?? ((one) => writeRuntimeNotice({
      home, root, session: team.session, lead: one.lead, id: one.id, body: one.body, at: at.toISOString(),
    }).ok);
    const told = notify({ lead: seat, body, id: noticeId(root, team.session, seat, day) });
    repairs.push({ seat, outcome: 'recreated', detail: told ? 'the lead was told to reconnect /mcp' : 'the notice to the lead could not be written' });
  }
  return repairs;
}

/** A stable, UUID-shaped id per root, session, seat and day: a second pass the same day finds
 *  the first notice instead of writing another. */
export function noticeId(root: string, session: string, seat: string, day: string): string {
  const hex = createHash('sha256').update(`channel-pair-restored\0${root}\0${session}\0${seat}\0${day}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One line for the daemon log. */
export function channelRepairLine(repairs: readonly ChannelRepair[]): string | null {
  if (repairs.length === 0) return null;
  return repairs.map((one) => `${one.seat}: channel pair ${one.outcome} (${one.detail})`).join('; ');
}
