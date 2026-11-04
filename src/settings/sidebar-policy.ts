// The five sidebar words as the machine's chain resolves them (the sidebar-metadata design of
// 2026-11-04): the rows layout, the manage switch, the status indicators, the metadata ttl and
// the refresh interval. One chain read fills all five. A chain that cannot be read, verified or
// ordered leaves the release defaults in force — the sidebar is presentation, and an unreadable
// word never blocks a launch or a chores pass.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { DEFAULT_SIDEBAR_ROWS, SIDEBAR_TTL_CAP_MS, STATUS_INDICATOR_VALUES } from '../herdr.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { sidebarRowsOf } from '../policy/types.ts';

export type SidebarPolicyContext = {
  /** The home the signed policy sources live under. */
  home: string;
  /** The team root the chain's team level reads `.agents/team.yaml` from. */
  root: string;
  /** The team whose `policies:` section is the team level's word; null declares none. */
  team: TeamFile | null;
  /** When the chain is read: an expired declaration is unset at its level. */
  now?: Date;
};

/** Which status indicator the host draws: the host's own closed vocabulary. */
export type SidebarIndicator = (typeof STATUS_INDICATOR_VALUES)[number];

/** The sidebar's two layout words, resolved. */
export type SidebarLayout = {
  rows: readonly (readonly string[])[];
  indicators: SidebarIndicator;
};

/** The sidebar's two timing words, resolved. */
export type SidebarTiming = {
  /** How long a pane's reported metadata lives before it lapses, already clamped to the host cap. */
  ttlMs: number;
  /** How often the line is re-reported to stay inside the ttl. */
  refreshMs: number;
};

/** All five sidebar words in force, with the release defaults filled in. */
export type SidebarPolicy = SidebarLayout & SidebarTiming & { manage: boolean };

/** Resolves the five sidebar words up to the team level. Anything that cannot be read leaves
 *  the release default: the default rows layout, symbols, managing on, the one-day ttl and the
 *  six-hour refresh. */
export function sidebarPolicy(context: SidebarPolicyContext): SidebarPolicy {
  const policy: SidebarPolicy = {
    rows: DEFAULT_SIDEBAR_ROWS,
    indicators: 'symbols',
    manage: true,
    ttlMs: SIDEBAR_TTL_CAP_MS,
    refreshMs: 21_600_000,
  };
  if (context.team === null) return policy;

  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, context.team, context.root),
      teamRoot: context.root,
      team: context.team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
  if (!chain.ok) return policy;

  const rowsWord = chain.policies['workspace.sidebar.rows']?.value;
  const rows = rowsWord === undefined ? null : sidebarRowsOf(rowsWord);
  if (rows !== null) policy.rows = rows;

  const indicatorsWord = chain.policies['workspace.sidebar.status_indicators']?.value;
  if (typeof indicatorsWord === 'string' && (STATUS_INDICATOR_VALUES as readonly string[]).includes(indicatorsWord)) {
    policy.indicators = indicatorsWord as SidebarIndicator;
  }

  // Only an explicit off switches managing off; anything unreadable keeps the default on.
  if (chain.policies['workspace.sidebar.manage']?.value === 'off') policy.manage = false;

  const ttlWord = chain.policies['daemon.sidebar-ttl-ms']?.value;
  if (typeof ttlWord === 'number') policy.ttlMs = Math.min(ttlWord, SIDEBAR_TTL_CAP_MS);

  const refreshWord = chain.policies['daemon.sidebar-refresh-ms']?.value;
  if (typeof refreshWord === 'number') policy.refreshMs = refreshWord;

  return policy;
}
