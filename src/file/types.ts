export type Problem = { line: number; message: string };

import type { TaskPolicy } from '../broker/policy.ts';
import type { Delegates } from '../delegate-types.ts';
import type { ReleaseDecl } from './sections/releases.ts';

/** The acts `grant.scope` may name. Closed: a word outside this list is refused at validation.
 *  `swap` lets the granted seat stop another lead seat for a replacement (`team remove <lead>
 *  --keep`, then `team add <lead>`); never its own seat. */
export const GRANT_SCOPES = ['up', 'down', 'approve', 'init', 'reload', 'swap'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

/**
 * The orchestrator seat's grant, or null when the file has no `grant` section. `session` is the
 * file's own session, `seat` is the orchestrator's name, and `scope` is the acts a later check
 * may admit, in the order the file wrote them.
 */
export type Grant = { session: string; seat: string; scope: GrantScope[] } | null;

export type Position = 'last-line' | 'trailer' | 'anywhere';
export type Mode = 'worktree' | 'shared';

export type BudgetSource = 'check' | 'status_line';

export type BudgetAccount = {
  kind: 'subscription' | 'spend';
  shared: boolean;
  /** Percent left that is held back. Null on a spend account. */
  reserve: number | null;
  /** Money still required on a spend account. Null on a subscription. */
  floor: { amount: number; currency: string } | null;
  sources: BudgetSource[];
  /** The command `check` names, or null when the account has no check. */
  check: string | null;
};

/**
 * A seat's `reach` block, the owner's grant that this seat's signed replies may be served to the
 * named fronts (the seat auto-discovery seam). Kept exactly as the file wrote it — alias, route,
 * key_id and guard_dir are derived at projection time, one default each in
 * `src/reach/projection.ts` — and it is part of the seat's digest, so writing or editing a grant
 * needs a new approval.
 */
export type SeatReach = {
  to: string[];
  alias?: string;
  route?: string;
  keyId?: string;
  guardDir?: string;
};

export type Seat = {
  role: string;
  name: string;
  cli: string;
  vendor: string;
  /**
   * The account whose budget this seat spends, when one vendor has two (RFC 0003 § 3b). Absent
   * means the vendor is the account; a seat that names one spends it instead of the vendor.
   */
  account?: string;
  /**
   * Says the model is chosen by the seat's launcher — a script or program that runs the CLI and
   * picks the model itself. Absent, `doctor` decides from the launch line's first words. Only
   * `launcher` exists; it is part of the seat's digest, so setting it needs a new approval.
   */
  modelFrom?: 'launcher';
  model: string;
  version: string;
  display: string;
  launch: string;
  cwd: string;
  /**
   * The file's label: written, or `<model> <version>` in lowercase. Hashed with the seat.
   * A written one is the workspace title; `workspaceLabel` uses the name and role when it was omitted.
   */
  label: string;
  /**
   * Set when the file wrote `label:`. Not hashed: the stored `label` string is what an approval
   * seals, and this mark only tells a written label from the lowercase default.
   */
  labelWritten?: true;
  /**
   * The seat's effort word, when the file sets one. Absent otherwise, so a file that omits it
   * keeps the digest it had. A lab with a vocabulary warns when the word is outside it; the
   * warning does not fail the file. The launch line does not pass the word to the CLI. The
   * idle record stores it, and `team reload` compares it with the file.
   */
  effort?: string;
  mode: Mode;
  parked: boolean;
  stopped: boolean;
  /** The seat's reach grant, when the file writes one. Absent means not reachable — unchanged. */
  reach?: SeatReach;
  // The entry's `name` and `count` as written, and this seat's place in it (1 for the first).
  declared: string;
  count: number;
  instance: number;
  line: number;
};

export type TeamFile = {
  format: 1;
  project: string;
  /** The entity the team belongs to, or null. Sets the team's lobby to
   *  `~/.config/team/lobbies/<slug>` unless `lobby` names one outright. */
  entity: string | null;
  /** The folder the team's seats start and wait in, as written (a `~` prefix is the home), or
   *  null. Overrides `entity`. Null with a null `entity` means the machine-global lobby. */
  lobby: string | null;
  visibility: 'public' | 'private';
  session: string;
  /** The lead's seat, however the file spelled it: the `coordinator:` key or `leads: true`. */
  orchestrator: string;
  operator: string;
  tools: Record<string, Record<string, string>>;
  identity: {
    signature: {
      commits: { template: string; position: Position; exempt: 'merge'[] };
      pullRequests: { template: string; position: Position };
    };
    humans: string[];
    since: string | null;
    // The two defaults first, then the file's own.
    forbidden: string[];
    forbiddenPublic: string[];
  };
  rules: string[];
  trust: string[];
  /**
   * Who may answer a folder-trust dialog. Omitted in the file means owner. The file may spell the
   * second value `orchestrator`; it normalises to `coordinator` here, the value every record's
   * digest was written with, so a file rewritten to the new word keeps its approval.
   */
  dialogs: { trust: 'owner' | 'coordinator' };
  workspace: {
    mode: Mode;
    path: string | null;
    branch: string;
    base: string | null;
    setup: string[];
    remove: 'on-merge' | 'manual';
    protected: string[];
    limit: number;
  };
  // Durations in seconds.
  watch: {
    interval: number;
    idleFirst: number;
    /** How often to repeat an idle report; absent when repeats are off (the default). */
    idleRepeat?: number;
    teamIdle: number;
    nudgeWait: number;
    unsentAfter: number;
    quotaMarks: number[];
    // The checks this file turns off, by name. The four that can't be turned off never appear.
    checks: string[];
    /** Text sent to each idle worker. Absent: the watch's report line. */
    nudge?: string;
  };
  budgets: {
    staleAfter: number;
    checkEvery: number;
    marks: number[];
    accounts: Record<string, BudgetAccount>;
  };
  // Load per core, memory in percent free, disk and swap in bytes, the window in seconds.
  machine: {
    loadStart: number;
    loadMax: number;
    memoryStart: number;
    memoryMin: number;
    diskMin: number;
    swapFreeMin: number;
    swapGrowthMax: number;
    swapGrowthWindow: number;
  };
  limits: { seats: number; temporary: number; vendors: Record<string, number> };
  /** The packages `team release check` verifies; empty when the file declares none. */
  releases: ReleaseDecl[];
  /**
   * The one task source, or null when the file has no `tasks` section. An owner section:
   * changing it needs a new approval. `file` is the list the owner committed; `linear` is read
   * by the broker with the owner's Keychain credential — the `linear` block names the project
   * and the Keychain service, and `policy` names which fields cross the broker's boundary.
   */
  tasks:
    | { source: 'file'; path: string; pull?: 'self' | 'any'; fallback?: 'file' | 'id'; cadence?: number }
    | {
        source: 'linear';
        linear: { project: string; keychainService: string };
        pull?: 'self' | 'any';
        fallback?: 'file' | 'id';
        cadence?: number;
        policy?: TaskPolicy;
      }
    | null;
  /**
   * How the watch's five waits are scaled: `relaxed` doubles them, `urgent` halves them, and
   * `normal` leaves them as written. Omitted in the file reads as `normal`. An owner section.
   */
  tempo: 'relaxed' | 'normal' | 'urgent';
  /**
   * The orchestrator seat's grant, or null when the file has no `grant` section. An owner
   * section: changing it needs a new approval. `approve` in `scope` is an ordinary approval;
   * this section itself stays the owner's.
   */
  grant: Grant;
  /**
   * The panes outside the team's session that may run named operational commands, or null when
   * the file has no `delegates` section. An owner section: changing it needs a new approval.
   */
  delegates: Delegates;
  // After `count` is expanded.
  seats: Seat[];
};

export type ValidateResult =
  | { ok: true; team: TeamFile; warnings: Problem[] }
  | { ok: false; errors: Problem[] };

export type LoadResult =
  | { ok: true; team: TeamFile; root: string; path: string; warnings: Problem[]; text: string }
  | { ok: false; errors: Problem[]; path?: string };
