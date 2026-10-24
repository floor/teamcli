// Client grant bundles: the closed vocabulary. A bundle is a named, fixed list of commands grouped
// in one owner-signed client grant, so one Touch ID covers a team's everyday operations for one
// client. It complements the per-command grants (vocabularies 1 to 4); it never replaces them.
//
// This module holds only what must be true whatever a policy says, so it imports nothing and the
// record decoder, the policy parser and the CLI can all depend on it without a cycle:
//
// - the ops a bundle may EVER carry, a closed list per bundle: `BUNDLE_ELIGIBLE_OPS` for `observer`
//   and `operator`, `MANAGER_ELIGIBLE_OPS` (a superset) for `manager` alone, and
//   `DEVELOPER_ELIGIBLE_OPS` (a superset of the manager's) for `developer` alone;
// - the commands that can NEVER be in a bundle (`BUNDLE_FORBIDDEN_COMMANDS`), derived from the
//   invariant that a client must not change permissions, seats, teams, the owner's settings or the
//   machine's daemons: structurally ineligible, exactly like the team-grant forbidden list. A
//   policy can only choose among eligible ops; it can never add one, and it can never name one of
//   these;
// - the four bundle names and the defaults a policy starts from.
//
// The record stores the EXPLICIT op list the owner signed (`allowed_ops`); the bundle name is a
// display label and decides nothing. So a command added to a bundle in a later build, or a policy
// that is loosened later, never widens a grant that was signed before.

/** The ops the `observer` and `operator` bundles may carry, in the one canonical order a record
 *  lists them. `status`, `list`, `check`, `feed` and `messages` read; `send` writes to the granted
 *  seats; `up` and `down` start and stop the one team. Not every op has a client route yet: see
 *  `BUNDLE_OP_ROUTES`. A bundle never carries more than its own list (`bundleOpsOf`). */
export const BUNDLE_ELIGIBLE_OPS = ['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down'] as const;

/**
 * The ops the `manager` bundle may carry, in the one canonical order a record lists them: the
 * observer's and operator's, and what a team's day-to-day manager also does.
 *
 * - READ: `status`, `list`, `check`, `feed`, `messages`, `seats`, `seat` (the read form), `sessions`,
 *   `usage`, `drops`, `projects`, `issues`, `plan`, `next`, `brief`, `watch`, `doctor`, `commits`.
 * - TALK: `send`, `reply`, `ack`, `ask-show`.
 * - TEAM LIFECYCLE: `up`, `down`, `restart`, `reload`.
 * - SEAT LIFECYCLE: `add` (with `--like` and `--temporary`) and `remove`. These two are the only
 *   commands of `BUNDLE_FORBIDDEN_COMMANDS` that the manager bundle narrows, and no other bundle does.
 *
 * `rename`, `swap`, `pause`, `resume`, `hold` and `release` are not the manager's: they stay on the
 * forbidden list for it. The `developer` bundle (`DEVELOPER_ELIGIBLE_OPS`) carries them.
 */
export const MANAGER_ELIGIBLE_OPS = [
  'status', 'list', 'check', 'feed', 'messages', 'seats', 'seat', 'sessions', 'usage', 'drops', 'projects', 'issues', 'plan', 'next', 'brief', 'watch', 'doctor', 'commits',
  'send', 'reply', 'ack', 'ask-show',
  'up', 'down', 'restart', 'reload',
  'add', 'remove',
] as const;

/**
 * The ops the `developer` bundle may carry, in the one canonical order a record lists them: every
 * manager op, and what a developer working a team also does.
 *
 * - PACE AND HOLD: `pause` and `resume` (graceful: seats finish what they are doing; only NEW work is
 *   withheld until `resume`, no pane is interrupted), `hold`, `tempo`.
 * - ROSTER NAMES: `rename`, `swap`.
 * - WORK: `queue`, `lock`, `unlock`, `worktree`, `raise`, `route`.
 * - CHECKS: `pr`, `release`, `workflow`, `proc`.
 *
 * The commands that change who may do what stay out for good, whatever else is here: `grant`,
 * `revoke`, `delegate`, `owner-seat`, `policy`, `settings`, `development-mode`, `answer`, `config`,
 * `broker`, `bus`, `daemon`, `register`, `client` (key creation) and `init`.
 */
export const DEVELOPER_ELIGIBLE_OPS = [
  ...MANAGER_ELIGIBLE_OPS,
  'rename', 'swap', 'pause', 'resume', 'hold', 'release', 'tempo', 'queue', 'lock', 'unlock', 'worktree', 'raise', 'route', 'pr', 'workflow', 'proc',
] as const;

/** Every op any bundle may carry: the developer's list is the superset. */
export type BundleOp = (typeof DEVELOPER_ELIGIBLE_OPS)[number];

/** The ops only the manager and developer bundles carry (the manager's own list, less the base). */
export const MANAGER_ONLY_OPS: readonly BundleOp[] = MANAGER_ELIGIBLE_OPS.filter((op) => !(BUNDLE_ELIGIBLE_OPS as readonly string[]).includes(op));

/** The ops only the developer bundle carries. */
export const DEVELOPER_ONLY_OPS: readonly BundleOp[] = DEVELOPER_ELIGIBLE_OPS.filter((op) => !(MANAGER_ELIGIBLE_OPS as readonly string[]).includes(op));

/** Whether each eligible op has a `--client <grant> --key <key>` form in this build. A record may
 *  carry an op whose route does not exist yet (it admits nothing today and says so); the route
 *  arrives without any grant being widened or re-signed.
 *
 *  Not routed yet, and why: `list`, `check`, `feed`, `messages`, `usage`, `drops`, `projects`, `issues`,
 *  `plan`, `next`, `brief`, `watch`, `doctor`, `commits` and `ask-show` read machine-wide state, mutate
 *  something the name hides (`next --release`, `brief rollout --apply`, `drops --read`, `watch`'s
 *  nudges) or have no per-team narrowing to carry yet; `reply` and `ack` answer as the owner or a seat
 *  and a client has no identity in those records (the one that exists is the client inbox's).
 *
 *  The developer's own ops that are routed: `pause`, `resume` and `hold`, the commands whose only gate
 *  is "the owner, the orchestrator or a lead may" and whose whole effect is one record in the one team's
 *  own state: the client form is that gate's second door, for the one team the grant names, and refuses
 *  `<team>` and `--all`. Not routed, and why: `tempo` (it rewrites the team file, which only the owner
 *  does), `lock` and `unlock` (machine-wide named locks, not a team's), `rename` and `swap` (they move a
 *  seat's identity and its pane across the roster), `worktree`, `raise` and `queue` (they act as the seat
 *  that calls them, and a client has none), `route` (it addresses a seat of any team), and `pr`,
 *  `release`, `workflow` and `proc` (they read or record outside the one team's own folder). */
export const BUNDLE_OP_ROUTES: Readonly<Record<BundleOp, boolean>> = {
  status: true,
  list: false,
  check: false,
  feed: false,
  messages: false,
  seats: true,
  seat: true,
  sessions: true,
  usage: false,
  drops: false,
  projects: false,
  issues: false,
  plan: false,
  next: false,
  brief: false,
  watch: false,
  doctor: false,
  commits: false,
  send: true,
  reply: false,
  ack: false,
  'ask-show': false,
  up: true,
  down: true,
  restart: true,
  reload: true,
  add: true,
  remove: true,
  rename: false,
  swap: false,
  pause: true,
  resume: true,
  hold: true,
  release: false,
  tempo: false,
  queue: false,
  lock: false,
  unlock: false,
  worktree: false,
  raise: false,
  route: false,
  pr: false,
  workflow: false,
  proc: false,
};

/**
 * The commands no bundle can ever carry, whatever the policy says and whatever a hand-built record
 * lists: sub-grants and revocation, the owner's identity and seat, policy and settings changes,
 * adding, removing, renaming or swapping seats, answering, pacing, the broker, the bus, the
 * daemons, registering, the queue, holds, worktrees, raising, creating a team, client key creation,
 * configuration, locking, and pausing or resuming. Spelled both bare and with the subcommand
 * (`policy`, `policy set`, `seat add`).
 *
 * This list is authoritative. The narrowings are `MANAGER_NARROWED_COMMANDS` (the `manager` and
 * `developer` bundles) and `DEVELOPER_NARROWED_COMMANDS` (the `developer` bundle alone): `observer`
 * and `operator` never carry any of them, and what stays on the list for every bundle is the
 * developer's NEVER list (`DEVELOPER_NEVER_COMMANDS`).
 */
export const BUNDLE_FORBIDDEN_COMMANDS: readonly string[] = [
  'grant',
  'revoke',
  'delegate',
  'init',
  'owner-seat',
  'policy',
  'policy-set',
  'policy-unset',
  'settings',
  'settings-set',
  'settings-unset',
  'development-mode',
  'development-mode-set',
  'add',
  'remove',
  'seat-add',
  'seat-remove',
  'rename',
  'seat-rename',
  'swap',
  'answer',
  'tempo',
  'broker',
  'bus',
  'daemon',
  'register',
  'queue',
  'hold',
  'release',
  'worktree',
  'raise',
  'client',
  'client-keygen',
  'pause',
  'resume',
  'config',
  'lock',
  'unlock',
];

/** The only commands of the forbidden list a bundle may carry, and only the `manager` bundle: the
 *  seat lifecycle. (`seat add` and `seat remove` are the same two commands, spelled in the group.)
 *  Nothing else on the list is ever narrowed, so `rename`, `swap`, `pause`, `resume` and `hold` stay
 *  out of the manager until a later build chooses to add them here. */
export const MANAGER_NARROWED_COMMANDS: readonly string[] = ['add', 'remove', 'seat-add', 'seat-remove'];

/** What the `developer` bundle narrows besides the seat lifecycle: pacing, names, work records. Only the
 *  `developer` bundle: the manager does not carry any of these. */
export const DEVELOPER_NARROWED_COMMANDS: readonly string[] = ['rename', 'seat-rename', 'swap', 'pause', 'resume', 'hold', 'release', 'tempo', 'queue', 'lock', 'unlock', 'worktree', 'raise'];

/** The commands NO bundle ever carries, the developer's included: the ones that change who may do
 *  what, hold the owner's identity, or run the machine. The forbidden list minus every narrowing. */
export const DEVELOPER_NEVER_COMMANDS: readonly string[] = BUNDLE_FORBIDDEN_COMMANDS.filter(
  (name) => !MANAGER_NARROWED_COMMANDS.includes(name) && !DEVELOPER_NARROWED_COMMANDS.includes(name),
);

/** One word as the lists spell it: lower case, spaces and underscores as hyphens. */
function spelled(word: string): string {
  return word.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Whether a command name is one a bundle can never carry: the name itself, or any command whose
 *  first word is one (`policy set --force` is `policy`). For the `manager` bundle alone, the seat
 *  lifecycle commands (`add`, `remove`, `seat add`, `seat remove`) are not forbidden; every other bundle,
 *  and a call that names none, refuses them. */
export function isForbiddenBundleCommand(name: string, bundle?: BundleName): boolean {
  const word = spelled(name);
  if ((bundle === 'manager' || bundle === 'developer') && MANAGER_NARROWED_COMMANDS.includes(word)) return false;
  if (bundle === 'developer' && DEVELOPER_NARROWED_COMMANDS.includes(word)) return false;
  if (BUNDLE_FORBIDDEN_COMMANDS.includes(word)) return true;
  const first = word.split('-')[0] ?? '';
  return first !== '' && BUNDLE_FORBIDDEN_COMMANDS.includes(first) && !(BUNDLE_ELIGIBLE_OPS as readonly string[]).includes(word);
}

/** The ops one bundle may ever carry: the developer's list for `developer`, the manager's for `manager`,
 *  the base list otherwise. */
export function bundleOpsOf(bundle: BundleName): readonly BundleOp[] {
  return bundle === 'developer' ? DEVELOPER_ELIGIBLE_OPS : bundle === 'manager' ? MANAGER_ELIGIBLE_OPS : BUNDLE_ELIGIBLE_OPS;
}

/** Whether a name is an op a bundle may carry: eligible for that bundle AND not forbidden for it.
 *  With no bundle named, the base list (`observer` and `operator`) is meant. */
export function isEligibleBundleOp(name: unknown, bundle: BundleName = 'operator'): name is BundleOp {
  return typeof name === 'string' && (bundleOpsOf(bundle) as readonly string[]).includes(name) && !isForbiddenBundleCommand(name, bundle);
}

/** The ops as a record writes them: each once, in canonical order. Null when any name is not an
 *  eligible op of that bundle, or none is given. */
export function canonicalBundleOps(ops: readonly unknown[], bundle: BundleName = 'operator'): BundleOp[] | null {
  if (ops.length === 0) return null;
  if (!ops.every((op) => isEligibleBundleOp(op, bundle))) return null;
  return bundleOpsOf(bundle).filter((op) => (ops as readonly string[]).includes(op));
}

/** Whether a grant of this bundle and these ops signs the team file's fingerprints: when `up` is an
 *  op, and only `up` reads them (a file edit ends no other op). The one decision point, so the
 *  request, the record, its decoder and the run agree. For the `manager` bundle the roster the owner
 *  signed is the file at signing: a seat its own `add` puts in the file is a roster change the owner
 *  has not signed, so its `up` stops (the owner re-signs) while every other op goes on; a seat its
 *  `remove` takes out needs no new signature, as for the owner (`compare` in `approve/fingerprint.ts`). */
export function bundleSignsFile(_bundle: BundleName, ops: readonly string[]): boolean {
  return ops.includes('up');
}

/** The four bundle names. The name is a display label; the signed op list decides. (The vocabulary
 *  tells the readers which list to hold the record to: 5 for `observer` and `operator`, 6 for `manager`,
 *  7 for `developer`.) */
export const BUNDLE_NAMES = ['observer', 'operator', 'manager', 'developer'] as const;
export type BundleName = (typeof BUNDLE_NAMES)[number];

export function isBundleName(name: unknown): name is BundleName {
  return typeof name === 'string' && (BUNDLE_NAMES as readonly string[]).includes(name);
}

/** What the `observer` bundle expands to unless a policy says otherwise. The study's list; ONE
 *  constant, so the owner's decision (status and usage, or this list) is a one-line change. */
export const OBSERVER_DEFAULT_OPS: readonly BundleOp[] = ['status', 'list', 'check', 'feed', 'messages'];

/** What the `operator` bundle expands to unless a policy says otherwise: the observer's ops, plus
 *  `send` to the granted seats, `up` and `down` for the one team. */
export const OPERATOR_DEFAULT_OPS: readonly BundleOp[] = [...OBSERVER_DEFAULT_OPS, 'send', 'up', 'down'];

/** What the `manager` bundle expands to unless a policy says otherwise: every op it may ever carry,
 *  the ones with no client route yet included (they admit nothing until their route arrives, and the
 *  grant never has to be re-signed for it). */
export const MANAGER_DEFAULT_OPS: readonly BundleOp[] = [...MANAGER_ELIGIBLE_OPS];

/** What the `developer` bundle expands to unless a policy says otherwise: every op it may ever carry. */
export const DEVELOPER_DEFAULT_OPS: readonly BundleOp[] = [...DEVELOPER_ELIGIBLE_OPS];

/** How long a bundle grant lasts by default, and the most the `client-bundles` policy may write
 *  after `@` (1 to 90 days): ninety days, the same as the one-op `up` grant. It is no longer the
 *  ceiling of a grant: how long a NEW bundle may last is the `client-grant-max-duration` policy's
 *  `bundle` cap, which defaults to these ninety days and which the owner may raise or set to `none`.
 *  `@<days>d` in `client-bundles` only shortens, below that cap. */
export const BUNDLE_DEFAULT_DAYS = 90;

/** The old name of {@link BUNDLE_DEFAULT_DAYS}, kept so a caller that read it as the release default still does. */
export const BUNDLE_HARD_MAX_DAYS = BUNDLE_DEFAULT_DAYS;

/** One bundle's policy values: the ops it expands to, and the days a grant of it lasts (the default
 *  when `--expires` is absent, and the cap). */
export type BundleSpec = {
  ops: BundleOp[];
  expiryDays: number;
  /** True when the `client-bundles` policy wrote `@<days>d` for this bundle: then the days also
   *  bound the grant (a narrowing); otherwise they are only the default length. */
  expiryExplicit?: boolean;
};

/** The release defaults, used where no policy says otherwise. */
export const DEFAULT_BUNDLE_SPECS: Readonly<Record<BundleName, BundleSpec>> = {
  observer: { ops: [...OBSERVER_DEFAULT_OPS], expiryDays: BUNDLE_DEFAULT_DAYS },
  operator: { ops: [...OPERATOR_DEFAULT_OPS], expiryDays: BUNDLE_DEFAULT_DAYS },
  manager: { ops: [...MANAGER_DEFAULT_OPS], expiryDays: BUNDLE_DEFAULT_DAYS },
  developer: { ops: [...DEVELOPER_DEFAULT_OPS], expiryDays: BUNDLE_DEFAULT_DAYS },
};

export type BundleSpecs = Record<BundleName, BundleSpec>;

/** A fresh copy of the release defaults. */
export function defaultBundleSpecs(): BundleSpecs {
  return {
    observer: { ...DEFAULT_BUNDLE_SPECS.observer, ops: [...DEFAULT_BUNDLE_SPECS.observer.ops] },
    operator: { ...DEFAULT_BUNDLE_SPECS.operator, ops: [...DEFAULT_BUNDLE_SPECS.operator.ops] },
    manager: { ...DEFAULT_BUNDLE_SPECS.manager, ops: [...DEFAULT_BUNDLE_SPECS.manager.ops] },
    developer: { ...DEFAULT_BUNDLE_SPECS.developer, ops: [...DEFAULT_BUNDLE_SPECS.developer.ops] },
  };
}

/**
 * The `client-bundles` policy text: entries separated by `;`, each `name=op,op,…[@<days>d]`, for
 * example `operator=status,send,up,down@30d;observer=status`. A bundle the text leaves out keeps
 * its release default; one it names replaces that bundle's ops (and days, when it writes them).
 * Returns the sparse specs it names, or the one sentence that says what is wrong.
 */
export function parseBundlePolicy(text: string): { ok: true; specs: Partial<Record<BundleName, { ops: BundleOp[]; expiryDays?: number }>> } | { ok: false; why: string } {
  const specs: Partial<Record<BundleName, { ops: BundleOp[]; expiryDays?: number }>> = {};
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, specs };
  for (const entry of trimmed.split(';').map((part) => part.trim()).filter((part) => part !== '')) {
    const match = /^([a-z]+)=([a-z-]+(?:,[a-z-]+)*)(?:@([1-9][0-9]{0,2})d)?$/.exec(entry);
    if (match === null) return { ok: false, why: `"${entry}" is not a bundle entry: name=op,op[@<days>d]` };
    const name = match[1]!;
    if (!isBundleName(name)) return { ok: false, why: `"${name}" is not a bundle: ${BUNDLE_NAMES.join(' or ')}` };
    if (specs[name] !== undefined) return { ok: false, why: `bundle ${name} is named twice` };
    const listed = match[2]!.split(',');
    for (const op of listed) {
      if (isForbiddenBundleCommand(op, name)) return { ok: false, why: `"${op}" can never be in a bundle, the ${name} bundle among them (it changes who may do what)` };
      if (!isEligibleBundleOp(op, name)) return { ok: false, why: `"${op}" is not a ${name} bundle op: ${bundleOpsOf(name).join(', ')}` };
    }
    if (new Set(listed).size !== listed.length) return { ok: false, why: `bundle ${name} names an op twice` };
    const ops = canonicalBundleOps(listed, name)!;
    let expiryDays: number | undefined;
    if (match[3] !== undefined) {
      expiryDays = Number.parseInt(match[3], 10);
      if (expiryDays < 1 || expiryDays > BUNDLE_DEFAULT_DAYS) return { ok: false, why: `${String(expiryDays)} days is out of range: 1 to ${String(BUNDLE_DEFAULT_DAYS)} (a longer bundle is the client-grant-max-duration policy's bundle cap, with --expires)` };
    }
    specs[name] = { ops, ...(expiryDays !== undefined ? { expiryDays } : {}) };
  }
  return { ok: true, specs };
}

/** The effective specs: the release defaults with what a parsed policy names laid over them. */
export function bundleSpecsFrom(named: Partial<Record<BundleName, { ops: BundleOp[]; expiryDays?: number }>>): BundleSpecs {
  const base = defaultBundleSpecs();
  for (const name of BUNDLE_NAMES) {
    const over = named[name];
    if (over !== undefined) base[name] = { ops: [...over.ops], expiryDays: over.expiryDays ?? base[name].expiryDays, ...(over.expiryDays !== undefined ? { expiryExplicit: true } : {}) };
  }
  return base;
}

/** The policy text for specs, normalized: bundles in name order, ops canonical, days always written. */
export function formatBundlePolicy(named: Partial<Record<BundleName, { ops: BundleOp[]; expiryDays?: number }>>): string {
  return BUNDLE_NAMES.filter((name) => named[name] !== undefined)
    .map((name) => {
      const spec = named[name]!;
      return `${name}=${spec.ops.join(',')}${spec.expiryDays !== undefined ? `@${String(spec.expiryDays)}d` : ''}`;
    })
    .join(';');
}

/** Whether `lower` is no looser than `higher`: every bundle it names keeps to the ops and days the
 *  higher effective specs allow. Used for the policy chain (a project cannot widen an entity). */
export function bundlePolicyWithin(lower: string, higher: string): boolean {
  const low = parseBundlePolicy(lower);
  const high = parseBundlePolicy(higher);
  if (!low.ok || !high.ok) return false;
  const lowSpecs = bundleSpecsFrom(low.specs);
  const highSpecs = bundleSpecsFrom(high.specs);
  return BUNDLE_NAMES.every((name) => lowSpecs[name].ops.every((op) => highSpecs[name].ops.includes(op)) && lowSpecs[name].expiryDays <= highSpecs[name].expiryDays);
}
