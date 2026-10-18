// The ```fixture block of a command reference page: the world its examples run in. Every key has a
// default, so a page declares only what it cares about:
//
//   approved: true           the owner approved the file before the examples run
//   answer: "5"              what the owner types at `team approve`'s question (default: the seat count)
//   herdr: running           running | absent | stopped | none (none: herdr doesn't answer)
//   agents: all              all | none | a list of seat names that are running
//   screens:                 what each seat's pane shows: idle | working | permission | trust |
//     claude-keeper: working   question | unsent | unknown
//   caller: owner            owner | a seat's name | agent (run by a CLI outside herdr)
//   now: 2026-10-04T09:00:00Z
//   machine: calm            calm | tight | small-swap
//   watch: alive             alive | none | stale (a heartbeat older than two intervals)
//   briefs: none             none | delivered (delivered: every seeded seat holds the general
//                            brief's signed record, as a launch leaves it)
//   tools:                   per cli: fine | missing | old | logged-out | unread
//     claude-code: fine
//   state:                   merged into the session's record in .agents/team.state.json
//     seats: {claude-keeper: {stage: named}}
//   checks:                  repo files symlinked into the fixture, for a check the page names:
//     - examples/checks/codex-quota  `team approve` resolves and hashes the repo's own script
import { parseYaml, toValue, type YamlValue } from '../../src/yaml.ts';
import type { Block } from './blocks.ts';

export type ScreenKind = 'idle' | 'working' | 'permission' | 'trust' | 'question' | 'unsent' | 'unknown';
export type ToolState = 'fine' | 'missing' | 'old' | 'logged-out' | 'unread';

export type Spec = {
  approved: boolean;
  answer: string | null;
  herdr: 'running' | 'absent' | 'stopped' | 'none';
  agents: 'all' | 'none' | string[];
  screens: Record<string, ScreenKind>;
  caller: string;
  now: string;
  machine: 'calm' | 'tight' | 'small-swap';
  watch: 'alive' | 'none' | 'stale';
  briefs: 'none' | 'delivered';
  tools: Record<string, ToolState>;
  state: Record<string, unknown>;
  checks: string[];
};

export const DEFAULT_SPEC: Spec = {
  approved: true,
  answer: null,
  herdr: 'running',
  agents: 'all',
  screens: {},
  caller: 'owner',
  now: '2026-10-04T09:00:00Z',
  machine: 'calm',
  watch: 'alive',
  briefs: 'none',
  tools: {},
  state: {},
  checks: [],
};

const SCREENS: readonly ScreenKind[] = ['idle', 'working', 'permission', 'trust', 'question', 'unsent', 'unknown'];
const TOOLS: readonly ToolState[] = ['fine', 'missing', 'old', 'logged-out', 'unread'];
const HERDR: readonly Spec['herdr'][] = ['running', 'absent', 'stopped', 'none'];

function text(value: YamlValue | undefined, fallback: string, key: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`fixture: ${key} must be a string`);
  return value;
}

function flag(value: YamlValue | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`fixture: ${key} must be true or false`);
  return value;
}

function oneOf<T extends string>(value: YamlValue | undefined, allowed: readonly T[], fallback: T, key: string): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`fixture: ${key} must be one of ${allowed.join(', ')}`);
}

function listed(value: YamlValue | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((one) => typeof one === 'string')) return value as string[];
  throw new Error('fixture: agents must be all, none, or a list of names');
}

function mapped<T extends string>(value: YamlValue | undefined, allowed: readonly T[], key: string): Record<string, T> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`fixture: ${key} must be a mapping`);
  const out: Record<string, T> = {};
  for (const [name, state] of Object.entries(value)) {
    if (typeof state !== 'string' || !(allowed as readonly string[]).includes(state)) {
      throw new Error(`fixture: ${key}.${name} must be one of ${allowed.join(', ')}`);
    }
    out[name] = state as T;
  }
  return out;
}

function paths(value: YamlValue | undefined, key: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((one) => typeof one === 'string')) return value as string[];
  throw new Error(`fixture: ${key} must be a list of paths`);
}

function object(value: YamlValue | undefined, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`fixture: ${key} must be a mapping`);
  return value as Record<string, unknown>;
}

export function specOf(block: Block | undefined): Spec {
  if (!block) return { ...DEFAULT_SPEC };
  const value = toValue(parseYaml(block.text));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`fixture at line ${block.line}: the block must be a mapping`);
  }
  const map = value as Record<string, YamlValue>;
  const agents = map.agents;
  const chosen =
    agents === undefined
      ? DEFAULT_SPEC.agents
      : agents === 'all' || agents === 'none'
        ? agents
        : listed(agents, []);
  return {
    approved: flag(map.approved, DEFAULT_SPEC.approved, 'approved'),
    answer: map.answer === undefined || map.answer === null ? null : text(map.answer, '', 'answer'),
    herdr: oneOf(map.herdr, HERDR, DEFAULT_SPEC.herdr, 'herdr'),
    agents: chosen,
    screens: mapped(map.screens, SCREENS, 'screens'),
    caller: text(map.caller, DEFAULT_SPEC.caller, 'caller'),
    now: text(map.now, DEFAULT_SPEC.now, 'now'),
    machine: oneOf(map.machine, ['calm', 'tight', 'small-swap'] as const, DEFAULT_SPEC.machine, 'machine'),
    watch: oneOf(map.watch, ['alive', 'none', 'stale'] as const, DEFAULT_SPEC.watch, 'watch'),
    briefs: oneOf(map.briefs, ['none', 'delivered'] as const, DEFAULT_SPEC.briefs, 'briefs'),
    tools: mapped(map.tools, TOOLS, 'tools'),
    state: object(map.state, 'state'),
    checks: paths(map.checks, 'checks'),
  };
}
