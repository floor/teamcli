/** A problem in the team file: the line it is on (0 when no line names it) and the message a
 *  reader prints. `unreadable` marks the one failure no text names — the read itself failed —
 *  so a caller that tells a file that cannot be read from one that does not load keeps the two
 *  apart now that the loader returns this refusal instead of throwing it. */
export type Problem = { line: number; message: string; unreadable?: true };

import type { TaskPolicy } from '../broker/policy.ts';
import type { Delegates } from '../delegate-types.ts';
import type { CrossSessionInbound } from '../launch/declaration.ts';
import type { DeliveryLeg, LivenessThresholds, SenderNameMode } from '../settings/inherit.ts';
import type { YamlValue } from '../yaml.ts';
import type { ReleaseDecl } from './sections/releases.ts';

/**
 * A field the file still reads and no longer acts on. Kept apart from `warnings`, which every
 * command that loads the file prints: a deprecation is printed by `team check` alone, with the
 * repair its record carries.
 */
export type Deprecation = { line: number; message: string; repair: string };

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
  /**
   * The human name for this seat, when the file writes one: unique in its team, never another
   * seat's name, and conferring nothing — the role keeps the grants. A send may address it as a
   * bare name in its own team or `<nickname>@<team>` elsewhere (src/send/resolve.ts). A field of
   * the built seat like every other, so it is part of the seat's digest and omitted when the
   * file omits the key — every file that writes none keeps the digest it had.
   */
  nickname?: string;
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
  /**
   * The entity's assistant: the seat the file marks with `assistant: true`. At most one seat
   * carries it, and admission reads it as a place in the chain — the entity's first assistant,
   * the one seat admitted to its coordinator — never a role's name. Absent means the seat is not
   * the assistant, so a file that marks none keeps every digest it had; marking one is a change
   * the owner approves, because the capability admits a send.
   */
  assistant?: true;
  /**
   * The pane is a person's: the file marks it with `human: true`. A send to it walks the drop
   * leg alone, whatever its order or the default says — every other leg and the watch's retry
   * and nudges are all skipped — so the message arrives in the drop file and nothing is typed.
   * Absent otherwise, so a file that marks none keeps every digest it had.
   */
  human?: true;
  /**
   * The seat's own word on cross-session socket frames, when the file writes one: `accept`
   * authorizes the socket leg, `hold` and `refuse` never let it dial. The launch must always
   * declare `crossSessionInbound: accept` itself — what the receiving CLI needs to take the
   * frame. With no `inbound` word, a seat TeamCLI launched (its generated settings file is on
   * the line) is authorized by that launch alone; a session launched some other way is not
   * dialed without `accept` here. A field of the built seat like every other, so it is part of
   * the seat's digest and omitted when the file omits the key — every file that writes none
   * keeps the digest it had.
   */
  inbound?: CrossSessionInbound;
  /** The seat's reach grant, when the file writes one. Absent means not reachable — unchanged. */
  reach?: SeatReach;
  /**
   * The seat's own word on the delivery order, when the file writes one: the legs a send to this
   * seat may walk, in order. Absent otherwise, so a file that writes none keeps the digest it
   * had. Only the word's shape is settled here; whether it drops or reorders the order in force,
   * or would add a leg, is settled when a send resolves the chain (`src/settings/inherit.ts`).
   */
  deliveryOrder?: DeliveryLeg[];
  /**
   * The seat's own word on how a sender reads in its own headlines, when the file writes one:
   * the presentation word a command run for this seat prints senders with. Absent otherwise, so
   * a file that writes none keeps the digest it had. Presentation only: every record keeps the
   * registry id.
   */
  senderName?: SenderNameMode;
  /**
   * The seat's own word on the liveness defaults, when the file writes one: the idle-to-lead and
   * idle-to-owner windows its reports run by, and the blind window its state is read by. Absent
   * otherwise, so a file that writes none keeps the digest it had. Like every other field, a word
   * written here is part of the seat's digest — writing one is a change the owner approves.
   */
  liveness?: Partial<LivenessThresholds>;
  // The entry's `name` and `count` as written, and this seat's place in it (1 for the first).
  declared: string;
  count: number;
  instance: number;
  line: number;
};

export type TeamFile = {
  format: 1;
  project: string;
  /**
   * The project this team sits in, by the name the file wrote, or null when it names none — a
   * team with no project is its own. `project:` above is still the team's own name.
   */
  inProject: string | null;
  /**
   * Whether this team leads the project it sits in — the team-side `leads: true`. One team per
   * project sets it (`team check` refuses two), and the file must name the project it leads.
   */
  projectLead: boolean;
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
  /**
   * The file's own word on the delivery order, or null when it writes none: the order a send to
   * any of its seats walks when the seat and the levels above say nothing. Non-owner and
   * additive — it changes no approval fingerprint, so a file written before it keeps its digests.
   */
  deliveryOrder: DeliveryLeg[] | null;
  /**
   * The file's own word on how a sender reads in TeamCLI's headlines, or null when it writes
   * none. Non-owner and additive — it changes no approval fingerprint, so a file written before
   * it keeps its digests. A seat's own word is on the seat; the project's is the registry
   * record's.
   */
  senderName: SenderNameMode | null;
  /**
   * Owner-signed team-level policy declarations (Kernel amendment 02 §2.12), when present.
   */
  policies?: YamlValue;
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
    /** The idle lead threshold: how long a quiet seat waits before its lead is told. */
    idleFirst: number;
    /** The idle owner threshold: how long after that the owner is told, once per idle period. */
    idleOwner: number;
    /** How long a seat no source has heard from may read unknown before it is blind. */
    blindAfter: number;
    /** How often to repeat an idle report; absent when repeats are off (the default). */
    idleRepeat?: number;
    teamIdle: number;
    nudgeWait: number;
    unsentAfter: number;
    /** How long a delivered message may go without the seat's signed read receipt before the
     *  watch retries it once; the report follows at twice this window. */
    unreadAfter: number;
    quotaMarks: number[];
    // The checks this file turns off, by name. The four that can't be turned off never appear.
    checks: string[];
    /** Text sent to each idle worker. Absent: the watch's report line. */
    nudge?: string;
    /** Directory containing one Markdown queue per seat, relative to the project or absolute. */
    queueDir?: string;
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
   * The one seat that may record a green-slice install beside the owner, or null when the file
   * names none — then only the owner records an install. An owner section: naming or changing
   * the seat needs a new approval, and an unapproved designation never admits an install.
   */
  installer: string | null;
  /**
   * The seats an external client grant may address, by client id, or null when the file names
   * none — then a client reaches only the orchestrator. An owner section: naming or widening a
   * client's seats needs a new approval.
   */
  clients: Record<string, { seats: string[] }> | null;
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
  | { ok: true; team: TeamFile; warnings: Problem[]; deprecations: Deprecation[] }
  // `parse` marks a failure of the YAML parse itself, told apart from a file that parses and
  // then fails validation: only the parse can fail transiently on a file replaced under the
  // reader, so only the parse is worth one more read (see `loadTeamFile`).
  | { ok: false; errors: Problem[]; parse?: true };

export type LoadResult =
  | {
      ok: true;
      team: TeamFile;
      root: string;
      path: string;
      warnings: Problem[];
      deprecations?: Deprecation[];
      text: string;
      /** Where the configuration was read from. The registry record when it exists; the team
       *  file only when the registry holds no config record for this root. */
      source?: 'registry' | 'team-file';
      /** One sentence, when this read used `.agents/team.yaml` because the registry holds no
       *  config record. Absent when the registry record was read, or when the file was named. */
      notice?: string;
      /** A `.agents/team.yaml` left beside a team read from the registry, and whether it still
       *  says what the registry's record says. The file is not read as the team either way. */
      leftover?: { path: string; matches: boolean };
    }
  | { ok: false; errors: Problem[]; path?: string };
