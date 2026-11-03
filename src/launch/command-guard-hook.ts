// The PreToolUse hook a claude-code seat's settings file runs (`command-guard.ts` writes the
// command line): read the tool call on stdin, deny the command classes the guard knows, and
// raise `security.refused` for the refusal. Never asks, and never blocks a command it cannot
// read: an unreadable payload is left to the CLI, exactly as if this hook were not installed.
//
// The event names the rule and the seat, never the command line. It is best effort: the deny
// reaches the model whether or not the event log can be written.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';
import { ACTIONS_COMMANDS_DEFAULT, type ActionsCommand } from '../policy/types.ts';
import { refusedByGuard } from './command-guard.ts';

/** The one decision this hook can make about a tool call. */
export type GuardDecision =
  | { decision: 'deny'; rule: string; reason: string }
  | { decision: 'allow' };

/**
 * The decision for one parsed hook payload. Only a Bash call with a string command is read;
 * any other shape is allowed, so a CLI that changes its payload never freezes a seat.
 */
export function guardDecision(input: unknown, actions?: readonly ActionsCommand[]): GuardDecision {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { decision: 'allow' };
  const record = input as { tool_name?: unknown; tool_input?: unknown };
  if (record.tool_name !== 'Bash') return { decision: 'allow' };
  const tool = record.tool_input;
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return { decision: 'allow' };
  const command = (tool as { command?: unknown }).command;
  if (typeof command !== 'string' || command === '') return { decision: 'allow' };
  const match = actions === undefined ? refusedByGuard(command) : refusedByGuard(command, actions);
  return match === null ? { decision: 'allow' } : { decision: 'deny', rule: match.rule, reason: match.guidance };
}

/** The Actions allowlist in force for this hook: the resolved policy, the Floor default when
 *  nothing sets it, and nothing when the policy cannot be read. No seat is named. */
export function actionsAllowlist(home: string, teamRoot: string): readonly ActionsCommand[] {
  try {
    const chain = loadAndResolvePolicyChain({ home, teamRoot });
    if (!chain.ok) return [];
    const value = chain.policies['actions-commands']?.value;
    if (!Array.isArray(value)) return ACTIONS_COMMANDS_DEFAULT;
    return value as readonly ActionsCommand[];
  } catch {
    return [];
  }
}

function bashCommand(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const tool = (input as { tool_input?: unknown }).tool_input;
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return null;
  const command = (tool as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

/** The JSON the CLI reads for a deny: the documented PreToolUse object, nothing else. */
export function guardDenyOutput(reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`;
}

type RefusalContext = { project: string; root: string; home: string; session: string; seat: string };

const CONTEXT_FLAGS = ['--project', '--root', '--home', '--session', '--seat'] as const;

/** The context baked into the hook command line, or null when a flag is missing or empty. */
export function guardContext(argv: readonly string[]): RefusalContext | null {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    const value = argv[at + 1];
    if (flag === undefined || value === undefined || value === '') return null;
    if (!(CONTEXT_FLAGS as readonly string[]).includes(flag)) return null;
    values.set(flag, value);
  }
  const take = (flag: (typeof CONTEXT_FLAGS)[number]): string | null => values.get(flag) ?? null;
  const project = take('--project');
  const root = take('--root');
  const home = take('--home');
  const session = take('--session');
  const seat = take('--seat');
  if (project === null || root === null || home === null || session === null || seat === null) return null;
  return { project, root, home, session, seat };
}

/** Raises the refusal for one deny: the class as the rule, the seat as the object. */
export function raiseGuardRefusal(context: RefusalContext, rule: string): void {
  raiseRefusalEvent({
    project: context.project,
    root: context.root,
    home: context.home,
    session: context.session,
    kind: 'security.refused',
    rule,
    object: { seat: context.seat },
  });
}

function main(argv: readonly string[]): void {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const command = bashCommand(input);
  const gh = command !== null && /(?:^|[\s;&|/])gh(?:\s|$)/.test(command);
  const context = gh ? guardContext(argv) : null;
  const decision = !gh
    ? guardDecision(input)
    : guardDecision(input, context === null ? [] : actionsAllowlist(context.home, context.root));
  if (decision.decision !== 'deny') return;
  process.stdout.write(guardDenyOutput(decision.reason));
  const refusal = context ?? guardContext(argv);
  if (refusal !== null) raiseGuardRefusal(refusal, decision.rule);
}

const entry = fileURLToPath(import.meta.url);
const runAsScript = (import.meta as { main?: boolean }).main === true
  || (process.argv[1] !== undefined && process.argv[1] === entry);
if (runAsScript) main(process.argv.slice(2));
