import { resolve } from 'node:path';
import { renderSignature } from '../file/signature.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { profileFor } from '../profiles/index.ts';

/** What the rules of a seat are written from. */
export interface RulesInput {
  orchestrator: string;
  /** The file's own `rules`. */
  rules: readonly string[];
  /** The seat's signature lines, already rendered. */
  signature: { commit: string; pullRequest: string; commitPosition: 'last-line' | 'trailer' | 'anywhere' };
  workspace: {
    mode: 'worktree' | 'shared';
    protected: readonly string[];
    branch?: string;
    cwd?: string;
  };
}

const COMMIT_PLACE: Record<RulesInput['signature']['commitPosition'], string> = {
  trailer: 'as a trailer, in a last paragraph of its own that holds trailers only',
  'last-line': 'as its last line',
  anywhere: 'on a line of its own',
};

/**
 * The rules a seat gets at launch, one per line, in this order: the profile's
 * own (what `team` itself depends on), the file's, the seat's signature, the
 * workspace's.
 */
export function seatRules(input: RulesInput): string[] {
  const { signature, workspace } = input;
  const own = [
    'End every commit message and every pull request body with your signature, given below.',
    `Never stop at a question: tell the orchestrator (${input.orchestrator}) in one line and keep working.`,
    'Never run `team trust` or `team approve`, and never edit `trust:` in the team file.',
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
  return [...own, ...input.rules, ...signing, ...working];
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
  return ['Rules for this session, from the team file:', ...rules.map((rule) => `- ${rule}`), closing].join('\n');
}

/** The rules one seat gets at launch, with its own signature lines, as its delivery carries them:
 *  the text a launch option embeds and the text the seat's rules file holds, byte for byte. A
 *  shared seat starts in the machine lobby like every seat, so the text names its folder from
 *  the project root — the same text every caller that checks the file must build. */
export function rulesOf(team: TeamFile, seat: Seat, root: string): string {
  const { commits, pullRequests } = team.identity.signature;
  const profile = profileFor(seat.cli);
  const delivery: RulesDelivery = profile?.rulesMode ?? 'message';
  return rulesText(
    {
      orchestrator: team.orchestrator,
      rules: team.rules,
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
    },
    delivery,
  );
}
