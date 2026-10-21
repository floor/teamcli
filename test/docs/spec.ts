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
//   briefs: none             none | delivered | delivered-and-read (delivered: every seeded seat
//                            holds the general brief's signed record, as a launch leaves it;
//                            delivered-and-read: every CLI seat also holds the read receipt its
//                            turn-start reader leaves)
//   tools:                   per cli: fine | missing | old | logged-out | unread
//     claude-code: fine
//   state:                   merged into the session's record in .agents/team.state.json
//     seats: {claude-keeper: {stage: named}}
//   checks:                  repo files symlinked into the fixture, for a check the page names:
//     - examples/checks/codex-quota  `team approve` resolves and hashes the repo's own script
//   sessions:                 records for the session registry under the fixture's home, written
//     - seat: claude-keeper    before the examples run. The seat's cli, lab, model, version and
//       ended: 2026-10-04T08:30:00Z   account come from the team file; a field the record names
//       reason: owner-stop            replaces it. An `ended` writes the end event, with `reason`
//                                     or `owner-stop`.
import { parseYaml, toValue, type YamlValue } from '../../src/yaml.ts';
import type { Block } from './blocks.ts';

export type ScreenKind = 'idle' | 'working' | 'permission' | 'trust' | 'question' | 'unsent' | 'unknown';
export type ToolState = 'fine' | 'missing' | 'old' | 'logged-out' | 'unread';

/** One session the fixture's registry holds. Everything but `seat` and `started` is optional. */
export type SpecSession = {
  id?: string;
  seat: string;
  started: string;
  ended?: string;
  reason?: string;
  pane?: string;
  workspace?: string;
  cli_session?: string;
  model?: string;
  version?: string;
  effort?: string;
  tokens?: { in?: number; out?: number; cached?: number; source: string };
  cost?: { amount: number; currency: string; source: string };
  links?: { commits?: string[]; prs?: string[]; releases?: string[] };
};

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
  briefs: 'none' | 'delivered' | 'delivered-and-read';
  tools: Record<string, ToolState>;
  state: Record<string, unknown>;
  checks: string[];
  sessions: SpecSession[];
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
  sessions: [],
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

function mapping(value: YamlValue | undefined, key: string): Record<string, YamlValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`fixture: ${key} must be a mapping`);
  return value as Record<string, YamlValue>;
}

function numbers(value: YamlValue, key: string): { in?: number; out?: number; cached?: number; source: 'measured' | 'estimated' } {
  const at = mapping(value, key);
  const read = (name: string): number | undefined => {
    const held = at[name];
    if (held === undefined) return undefined;
    if (typeof held !== 'number' || !Number.isFinite(held) || held < 0) throw new Error(`fixture: ${key}.${name} must be a number`);
    return held;
  };
  const source = at.source;
  if (source !== 'measured' && source !== 'estimated') throw new Error(`fixture: ${key}.source must be measured or estimated`);
  return {
    ...(read('in') === undefined ? {} : { in: read('in') }),
    ...(read('out') === undefined ? {} : { out: read('out') }),
    ...(read('cached') === undefined ? {} : { cached: read('cached') }),
    source,
  };
}

function amounts(value: YamlValue | undefined, key: string): { amount: number; currency: string; source: 'measured' | 'estimated' } {
  const at = mapping(value, key);
  const amount = at.amount;
  const currency = at.currency;
  const source = at.source;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error(`fixture: ${key}.amount must be a number`);
  if (typeof currency !== 'string' || currency === '') throw new Error(`fixture: ${key}.currency must be a string`);
  if (source !== 'measured' && source !== 'estimated') throw new Error(`fixture: ${key}.source must be measured or estimated`);
  return { amount, currency, source };
}

function linksOf(value: YamlValue | undefined, key: string): { commits?: string[]; prs?: string[]; releases?: string[] } | undefined {
  if (value === undefined) return undefined;
  const at = mapping(value, key);
  const list = (name: string): string[] | undefined => {
    const held = at[name];
    if (held === undefined) return undefined;
    if (!Array.isArray(held) || !held.every((one) => typeof one === 'string')) throw new Error(`fixture: ${key}.${name} must be a list of strings`);
    return held as string[];
  };
  return {
    ...(list('commits') === undefined ? {} : { commits: list('commits') }),
    ...(list('prs') === undefined ? {} : { prs: list('prs') }),
    ...(list('releases') === undefined ? {} : { releases: list('releases') }),
  };
}

function sessionRecords(value: YamlValue | undefined, key: string): SpecSession[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`fixture: ${key} must be a list`);
  return value.map((one, index) => {
    const at = mapping(one, `${key}[${index}]`);
    const where = `${key}[${index}]`;
    const seat = text(at.seat, '', `${where}.seat`);
    if (seat === '') throw new Error(`fixture: ${where}.seat is required`);
    const optional = (name: string): string | undefined => (at[name] === undefined ? undefined : text(at[name], '', `${where}.${name}`));
    const started = optional('started') ?? DEFAULT_SPEC.now;
    const reason = optional('reason');
    return {
      ...(optional('id') === undefined ? {} : { id: optional('id') as string }),
      seat,
      started,
      ...(optional('ended') === undefined ? {} : { ended: optional('ended') as string }),
      ...(reason === undefined ? {} : { reason }),
      ...(optional('pane') === undefined ? {} : { pane: optional('pane') as string }),
      ...(optional('workspace') === undefined ? {} : { workspace: optional('workspace') as string }),
      ...(optional('cli_session') === undefined ? {} : { cli_session: optional('cli_session') as string }),
      ...(optional('model') === undefined ? {} : { model: optional('model') as string }),
      ...(optional('version') === undefined ? {} : { version: optional('version') as string }),
      ...(optional('effort') === undefined ? {} : { effort: optional('effort') as string }),
      ...(at.tokens === undefined ? {} : { tokens: numbers(at.tokens, `${where}.tokens`) }),
      ...(at.cost === undefined ? {} : { cost: amounts(at.cost, `${where}.cost`) }),
      ...(at.links === undefined ? {} : { links: linksOf(at.links, `${where}.links`) }),
    };
  });
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
    briefs: oneOf(map.briefs, ['none', 'delivered', 'delivered-and-read'] as const, DEFAULT_SPEC.briefs, 'briefs'),
    tools: mapped(map.tools, TOOLS, 'tools'),
    state: object(map.state, 'state'),
    checks: paths(map.checks, 'checks'),
    sessions: sessionRecords(map.sessions, 'sessions'),
  };
}
