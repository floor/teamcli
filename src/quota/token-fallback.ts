// Out-of-tokens (parts 1, 2 and 4). The daemon reads each shipped CLI's limit screens and
// the state is "out of tokens", never idle or done. One message goes to the seat's lead.
// The seat is marked unavailable so a send and a review skip it and tell the sender.
// A weekly figure under the warning tells the lead before the wall.
//
// Part 3, the automatic swap onto the team's fallback list, waits for team swap. `tokenSwapHook`
// is the only place that swap will be called. It writes nothing and restarts nothing.
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '../host/guarded-fs.ts';
import { join } from 'node:path';
import { stripSgr } from '../ansi.ts';

/** Shipped CLIs whose panes this reading knows. A CLI with no profile is not guessed. */
const CLIS = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse', 'jules'] as const;

// The live tail only. A sentence the pane has scrolled past, including one quoted inside a
// finished turn, sits above this window and is not the screen the seat is on.
const TAIL_LINES = 6;

const PHRASES: readonly RegExp[] = [
  /usage limit reached/i,
  /\b429\b/,
  /\brate limit\b/i,
  /weekly quota exhausted/i,
  /weekly limit reached/i,
];

// Not a limit: the CLI's turn failed on the model itself. On the 17 Nov restart every DeepSeek
// seat showed this sentence because the terminal host resumed the bare CLI without the endpoint
// and key its launcher sets; a provider refusing the model id reads the same. It is a launch or
// model fault, never quota: reading it as out of tokens marked the seats unavailable and told
// the lead to wait for a reset that would never fix them. `team up` relaunches a restored
// launcher seat the host restored bare (src/launch/restore-proof.ts restoredBypassesLauncher).
const MODEL_FAULT = /issue with the selected model/i;

/** The live tail of a shipped CLI's pane shows the turn failing on the model (a launch or model
 *  fault, not a limit). */
export function modelFaultTail(cli: string, text: string): boolean {
  if (!(CLIS as readonly string[]).includes(cli)) return false;
  const lines = stripSgr(text).split('\n').map((line) => line.trimEnd());
  return MODEL_FAULT.test(lines.slice(-TAIL_LINES).join('\n'));
}

/** Weekly quota left, in percent, under which the lead is warned. The file does not set another. */
export const TOKEN_WARN_PERCENT = 20;

/** What a refused send or review tells the sender. Nothing was written. */
export const TOKEN_SKIP = 'out of tokens and not taking a send or a review; nothing was sent';

export type HeldWork = 'task' | 'review';

export type TokenMark = { vendor: string; held: HeldWork; at: number };

export type TokenSwap = { kind: 'waiting'; why: string };

const FILE = 'out-of-tokens.json';

/** The live tail of a shipped CLI's pane is one of its out-of-tokens screens. */
export function outOfTokensTail(cli: string, text: string): boolean {
  if (!(CLIS as readonly string[]).includes(cli)) return false;
  const lines = stripSgr(text).split('\n').map((line) => line.trimEnd());
  const tail = lines.slice(-TAIL_LINES).join('\n');
  return PHRASES.some((phrase) => phrase.test(tail));
}

/** The reset a limit sentence prints, without its preposition: `until 2026-11-08 16:33` and
 *  `resets at 3pm` both yield the time. Null when the sentence names none. */
const LIMIT_RESET = /(?:resets?|resetting|try again|until)\s+(?:at\s+)?(.+?)\s*$/i;

export function outOfTokensReset(text: string): string | null {
  const lines = stripSgr(text).split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-TAIL_LINES);
  for (const line of lines) {
    if (!PHRASES.some((phrase) => phrase.test(line))) continue;
    const value = LIMIT_RESET.exec(line)?.[1]?.trim().replace(/^at\s+/i, '');
    if (value) return value;
  }
  return null;
}

/** The status word for that screen, or null for every other reading. Never idle, never done. */
export function outOfTokensState(screen: { kind: string; reason?: string }): string | null {
  if (screen.kind === 'rate limit' && screen.reason === 'out of tokens') return 'out of tokens';
  return null;
}

/** A reviewer was holding a review. Every other seat was holding a task. */
export function heldWork(role: string | undefined): HeldWork {
  return role === 'reviewer' ? 'review' : 'task';
}

/** The one line to the seat's lead: the seat, the vendor, and what it was holding. */
export function tokenLeadLine(seat: string, vendor: string, held: HeldWork): string {
  const maker = vendor === '' ? 'its vendor' : vendor;
  return `${seat} (${maker}) is out of tokens, holding a ${held}`;
}

/** True when the weekly figure has dropped below the warning. Exactly the threshold is not below it. */
export function weeklyBelowWarning(left: number): boolean {
  return left < TOKEN_WARN_PERCENT;
}

/** The early-warning line. `left` is the weekly percent still remaining. */
export function tokenWarnLine(account: string, left: number): string {
  return `${account} weekly quota is ${left}% left, below the ${TOKEN_WARN_PERCENT}% warning`;
}

/**
 * Part 3. The automatic swap waits for team swap. Callers invoke this when a seat is out of
 * tokens and then do not swap, restart, or re-send.
 */
export function tokenSwapHook(_input: { seat: string; vendor: string; held: HeldWork }): TokenSwap {
  return { kind: 'waiting', why: 'the automatic swap waits for team swap' };
}

function marksPath(agentsDir: string): string {
  return join(agentsDir, FILE);
}

function marksOf(agentsDir: string): Record<string, TokenMark> {
  try {
    const parsed = JSON.parse(readFileSync(marksPath(agentsDir), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const marks: Record<string, TokenMark> = {};
    for (const [seat, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const mark = value as { vendor?: unknown; held?: unknown; at?: unknown };
      if (typeof mark.vendor !== 'string' || (mark.held !== 'task' && mark.held !== 'review') || typeof mark.at !== 'number') continue;
      marks[seat] = { vendor: mark.vendor, held: mark.held, at: mark.at };
    }
    return marks;
  } catch {
    return {};
  }
}

function writeMarks(agentsDir: string, marks: Record<string, TokenMark>): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(marksPath(agentsDir), `${JSON.stringify(marks)}\n`);
}

/** Record the seat unavailable, or clear it once the screen has left the state. */
export function recordTokenMark(agentsDir: string, seat: string, mark: TokenMark | null): void {
  const marks = marksOf(agentsDir);
  if (mark === null) {
    if (marks[seat] === undefined) return;
    delete marks[seat];
  } else {
    marks[seat] = mark;
  }
  writeMarks(agentsDir, marks);
}

/** The sender's sentence when the seat is marked unavailable, or null when it is not. */
export function tokenUnavailable(agentsDir: string, seat: string): string | null {
  return marksOf(agentsDir)[seat] === undefined ? null : TOKEN_SKIP;
}
