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
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../mcp/channel.ts';
import { cliWordListOf } from './cli-scope.ts';
import { channelPairPresent } from '../mcp/launch-config.ts';
import { CHANNEL_LOCAL_FILES, runMcpSetup } from '../mcp/setup.ts';
import { excludeLocally } from '../mcp/local-exclude.ts';
import { writeRuntimeNotice } from '../send/endpoint-notice.ts';

export type ChannelRepair = { seat: string; outcome: 'recreated' | 'refused'; detail: string };

export type RestoreChannelDeps = {
  present?: (dir: string, seat: string) => boolean;
  setup?: (seat: string, io: Io) => Promise<number>;
  notify?: (input: { lead: string; body: string; id: string }) => boolean;
  now?: () => Date;
  /** Keeps a present pair out of the checkout's untracked files; production: `excludeLocally`. */
  exclude?: (root: string, names: readonly string[]) => void;
};

// Claude Code's options that take the next word as their value (`claude --help`): a word after
// one of these is its value, prompt text included, never an option.
const CLAUDE_VALUE_OPTIONS = new Set([
  '--model', '--fallback-model', '--resume', '-r', '--session-id', '--name', '-n', '--settings',
  '--setting-sources', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt',
  '--system-prompt-file', '--mcp-config', '--add-dir', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--tools', '--permission-mode', '--output-format',
  '--input-format', '--agents', '--agent', '--plugin-dir', '--max-turns', '--effort', '--betas',
  '--debug-file', '--permission-prompt-tool', '--json-schema', '--max-budget-usd',
]);
// The options that take no value. An option on neither list is not known well enough to say
// whether the word after it is a value, so a line holding one is not proof.
const CLAUDE_BOOLEAN_OPTIONS = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose',
  '--continue', '-c', '--print', '-p', '--ide', '--strict-mcp-config', '--fork-session',
  '--no-session-persistence', '--include-partial-messages', '--replay-user-messages', '--chrome',
  '--no-chrome', '--disable-slash-commands',
]);

/** The forwarding wrapper the team's launch lines run Claude through (docs/guides/tools): it
 *  runs its first argument as the program, with the rest as that program's argv. */
const FORWARDING_WRAPPERS = new Set(['as-floor.sh']);
const SHELLS = new Set(['zsh', 'bash', 'sh']);

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);
const isClaude = (word: string | undefined): boolean => word !== undefined && baseName(word) === 'claude';

/**
 * The index of the `claude` word when it is the program the line executes, or null: argv[0]
 * after leading environment assignments, or the program a known forwarding wrapper runs
 * (`as-floor.sh claude …`, `zsh <path>/as-floor.sh claude …`). A `claude` anywhere else is an
 * argument (`echo claude …`) and proves nothing.
 */
export function claudeArgvZero(words: readonly string[]): number | null {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[at]!)) at += 1;
  if (isClaude(words[at])) return at;
  if (SHELLS.has(baseName(words[at] ?? '')) && FORWARDING_WRAPPERS.has(baseName(words[at + 1] ?? ''))) at += 1;
  if (FORWARDING_WRAPPERS.has(baseName(words[at] ?? '')) && isClaude(words[at + 1])) return at + 1;
  return null;
}

/**
 * Whether the launch line passes the development-channel option naming the team server to the
 * Claude CLI itself, as its argv: the line's words decoded as the shell hands them over, read from
 * the `claude` word on, every option's value skipped, and stopped at `--`. A flag-shaped word
 * inside a quoted prompt or after `--` is no option. A line whose words cannot be proved, that has
 * no `claude` word, or that holds an option this reader cannot place is not proof either.
 */
export function channelOptionProven(launch: string | undefined): boolean {
  if (typeof launch !== 'string' || launch.trim() === '') return false;
  const words = cliWordListOf('claude', launch);
  if (words === null) return false;
  const start = claudeArgvZero(words);
  if (start === null) return false;
  const chosen = `server:${CHANNEL_SERVER}`;
  const names = (value: string | undefined) => value !== undefined && value.split(',').includes(chosen);
  let proven = false;
  for (let at = start + 1; at < words.length; at += 1) {
    const word = words[at]!;
    if (word === '--') break;
    if (word === CHANNEL_FLAG) {
      const value = words[at + 1];
      if (value === undefined || value.startsWith('-')) return false;
      if (names(value)) proven = true;
      at += 1;
      continue;
    }
    if (word.startsWith(`${CHANNEL_FLAG}=`)) {
      if (names(word.slice(CHANNEL_FLAG.length + 1))) proven = true;
      continue;
    }
    if (!word.startsWith('-') || word === '-') continue;
    if (word.startsWith('--') && word.includes('=')) continue;
    if (CLAUDE_VALUE_OPTIONS.has(word)) { at += 1; continue; }
    if (CLAUDE_BOOLEAN_OPTIONS.has(word)) continue;
    // An option this reader cannot place: the next word may be its value or an option.
    return false;
  }
  return proven;
}

/** The lead seats whose pair the restore may recreate: the evidence of an earlier setup is the
 *  channel option on the declared launch line, proved as the CLI's own argv. */
export function channelRepairCandidates(team: Pick<TeamFile, 'orchestrator' | 'operator' | 'seats'>, root: string, present: (dir: string, seat: string) => boolean): string[] {
  const leads = [...new Set([team.orchestrator, team.operator])];
  return leads.filter((name) => {
    const seat = team.seats.find((one) => one.name === name);
    if (seat === undefined || seat.stopped || seat.human || seat.cli !== 'claude-code') return false;
    if (resolve(root, seat.cwd) !== resolve(root)) return false;
    if (!channelOptionProven(seat.launch)) return false;
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
  // A pair written before `team mcp setup` kept it out of the untracked files (material, set up
  // on 2026-11-16 before that build) is still removed by a `git clean` or a `git stash -u`. The
  // pass adds the local exclude lines for a lead whose pair is present; it writes nothing else.
  excludePresentPairs(team, root, present, deps.exclude ?? ((at, names) => { excludeLocally(at, names); }));
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

/** The local exclude lines for each Claude lead whose channel pair is present in the project root.
 *  A failure to write them is left for the next pass: the pair itself is untouched. */
export function excludePresentPairs(
  team: Pick<TeamFile, 'orchestrator' | 'operator' | 'seats'>,
  root: string,
  present: (dir: string, seat: string) => boolean,
  exclude: (root: string, names: readonly string[]) => void,
): boolean {
  const leads = [...new Set([team.orchestrator, team.operator])];
  const held = leads.some((name) => {
    const seat = team.seats.find((one) => one.name === name);
    return seat !== undefined && seat.cli === 'claude-code' && resolve(root, seat.cwd) === resolve(root) && present(root, name);
  });
  if (!held) return false;
  try { exclude(root, CHANNEL_LOCAL_FILES); } catch { return false; }
  return true;
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
