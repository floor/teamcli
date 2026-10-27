import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { renderSignature } from '../file/signature.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { profileFor } from '../profiles/index.ts';
import { readPolicyChain } from '../policy/sources.ts';
import { landingRule, resolveWorkSettings, vaultRule, type WorkSettings } from '../policy/work-settings.ts';
import { ofTeam as projectOfTeam } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';

/** Where the rules' wording comes from. A registry read names the team's registry config;
 *  a read of a real team.yaml (`--file`, `team migrate`, the file fallback) names the file. */
export type RulesOrigin = 'registry' | 'file';

/** The load source as a rules origin. Absent, or a team-file read, keeps the file wording. */
export function rulesOriginOf(source: 'registry' | 'team-file' | undefined): RulesOrigin {
  return source === 'registry' ? 'registry' : 'file';
}

/** The headline a seat's rules open with. */
export const RULES_HEAD: Record<RulesOrigin, string> = {
  file: 'Rules for this session, from the team file:',
  registry: "Rules for this session, from the team's registry config:",
};

/** The trust rule. The file wording stays only while a real team.yaml is what was read. */
export const TRUST_RULE: Record<RulesOrigin, string> = {
  file: 'Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` in the team file.',
  registry: 'Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` with `team config`.',
};

/** What a rules file that does not match is said to differ from. */
export const RULES_DIFFER_FROM: Record<RulesOrigin, string> = {
  file: "the team file's rules",
  registry: "the team's registry config",
};

/** What the rules of a seat are written from. */
export interface RulesInput {
  orchestrator: string;
  /** The definition's own `rules`. */
  rules: readonly string[];
  /** Registry wording when the team was read from the registry; file wording otherwise. */
  origin?: RulesOrigin;
  /** The seat's profile's own rules, over the file's: a safety line the CLI makes necessary.
   *  Empty when the profile carries none. */
  profileRules?: readonly string[];
  /** Whether the seat's CLI registers the team inbox at launch (its profile carries a measured
   *  `mcp_inbox` route). Only such a seat has the `inbox_check` tool the sentence names, so only
   *  such a seat is asked to call it. Absent reads as false. */
  inbox?: boolean;
  /** The seat's signature lines, already rendered. */
  signature: { commit: string; pullRequest: string; commitPosition: 'last-line' | 'trailer' | 'anywhere' };
  workspace: {
    mode: 'worktree' | 'shared';
    protected: readonly string[];
    branch?: string;
    cwd?: string;
  };
  /** Work-setting lines (landing mode, memory vault), present only when a policy sets them. */
  work?: readonly string[];
}

const COMMIT_PLACE: Record<RulesInput['signature']['commitPosition'], string> = {
  trailer: 'as a trailer, in a last paragraph of its own that holds trailers only',
  'last-line': 'as its last line',
  anywhere: 'on a line of its own',
};

/**
 * The rules a seat gets at launch, one per line, in this order: the profile's
 * own (what `team` itself depends on), the rules the profile carries for
 * every seat of its CLI, the file's, the seat's signature, the workspace's.
 */
export function seatRules(input: RulesInput): string[] {
  const { signature, workspace } = input;
  const own = [
    'End every commit message and every pull request body with your signature, given below.',
    `Never stop at a question: tell the orchestrator (${input.orchestrator}) in one line and keep working.`,
    // The inbox is client-pull: a seat sees a message only when it asks. The sentence follows the
    // CLI: only a profile with a measured `mcp_inbox` route gives the seat the tools it names, so
    // every other seat's rules stay exactly as earlier builds wrote them.
    ...(input.inbox === true
      ? ['If your tools include `inbox_check`, call it at the start of every turn and `inbox_read` for each message it lists, and act on what you read.']
      : []),
    TRUST_RULE[input.origin ?? 'file'],
    'In a protected checkout, never switch the branch, reset or commit.',
  ];
  const signing = [
    `Your signature in a commit message, ${COMMIT_PLACE[signature.commitPosition]}: ${signature.commit}`,
    `Your signature in a pull request body, as its last line: ${signature.pullRequest}`,
  ];
  const working: string[] = [];
  if (workspace.protected.length > 0) {
    working.push(`Protected checkouts, relative to the project root: ${workspace.protected.join(', ')}`);
  }
  if (workspace.mode === 'worktree') {
    working.push(
      'Work on the code in the worktree your brief names, never in the checkout you started in.' +
        (workspace.branch ? ` Branches are named ${workspace.branch}.` : ''),
    );
  } else if (workspace.mode === 'shared' && workspace.cwd) {
    working.push(`Change to ${workspace.cwd} before any project work.`);
  }
  return [...own, ...(input.profileRules ?? []), ...input.rules, ...signing, ...working, ...(input.work ?? [])];
}

/** How the rules reach a seat: typed as its first message, carried as a launch option, or
 *  prepended to every brief a send types into its pane. */
export type RulesDelivery = 'message' | 'option' | 'prepend';

/**
 * The line each form ends with. The message says what the rules are and never that they are not a
 * task, so some models start complying by investigating instead of waiting for a brief. A first
 * message is answered once, so it can ask for the ready reply; a system prompt (a launch option)
 * stays in force on every later turn, so it must not: a Claude seat could answer "ready" to its
 * real brief. Prepended rules ride every brief — there is no standing session to keep them —
 * so they carry no ready reply either, and say the brief follows.
 */
const CLOSING: Record<RulesDelivery, string> = {
  message: 'These are standing rules, not a task: reply ready and wait for your brief.',
  option: 'These are standing rules, not a task.',
  prepend: 'These are standing rules for this session. The brief follows.',
};

/** The rules as the one text a launch option or a first message carries, the closing line last. */
export function rulesText(input: RulesInput, delivery: RulesDelivery): string {
  // A file whose own rules already carry the form's closing line gets it once: as the closing line.
  const closing = CLOSING[delivery];
  const rules = seatRules(input).filter((rule) => rule !== closing);
  return [RULES_HEAD[input.origin ?? 'file'], ...rules.map((rule) => `- ${rule}`), closing].join('\n');
}

/** The rules one seat gets at launch, with its own signature lines, as its delivery carries them:
 *  the text a launch option embeds and the text the seat's rules file holds, byte for byte. A
 *  shared seat starts in the machine lobby like every seat, so the text names its folder from
 *  the project root — the same text every caller that checks the file must build. */
export function rulesOf(
  team: TeamFile,
  seat: Seat,
  root: string,
  work: WorkSettings | null = workSettingsFor(team, root),
  origin: RulesOrigin = 'file',
): string {
  const { commits, pullRequests } = team.identity.signature;
  const profile = profileFor(seat.cli);
  const delivery: RulesDelivery = profile?.rulesMode ?? 'message';
  return rulesText(
    {
      orchestrator: team.orchestrator,
      rules: team.rules,
      profileRules: profile?.standingRules ?? [],
      // The route the launch registers is the profile's measured one (`src/mcp/register.ts`);
      // a CLI whose profile carries none gets no inbox, and no line about one.
      inbox: profile?.mcpInbox != null,
      signature: {
        commit: renderSignature(commits.template, seat),
        pullRequest: renderSignature(pullRequests.template, seat),
        commitPosition: commits.position,
      },
      workspace: {
        mode: seat.mode,
        protected: team.workspace.protected,
        branch: team.workspace.branch,
        cwd: resolve(root, seat.cwd),
      },
      work: workLines(work, team.project),
      origin,
    },
    delivery,
  );
}

/** The work settings a seat's rules read: the signed chain for this team, or null when it cannot be read. */
export function workSettingsFor(team: TeamFile, root: string, home: string = homedir()): WorkSettings | null {
  try {
    let projectId: string | null = null;
    try {
      projectId = projectOfTeam(home, teamIdOf(root))?.id ?? null;
    } catch {}
    const work = resolveWorkSettings(readPolicyChain({ home, teamRoot: root, team, projectId }), {}, { home });
    return work.unreadable === undefined ? work : null;
  } catch {
    return null;
  }
}

/** The lines a set work setting adds; a setting left at its release default adds none, so a team
 *  that sets nothing keeps its rules byte for byte. */
export function workLines(work: WorkSettings | null, project: string): string[] {
  if (work === null) return [];
  const lines: string[] = [];
  if (work.landingMode.from !== 'default') lines.push(landingRule(work.landingMode.value));
  if (work.vaultRoot.value !== null) lines.push(vaultRule(work.vaultRoot.value, project));
  return lines;
}
