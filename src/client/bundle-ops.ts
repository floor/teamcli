// Client grant bundles: the closed vocabulary. A bundle is a named, fixed list of commands grouped
// in one owner-signed client grant, so one Touch ID covers a team's everyday operations for one
// client. It complements the per-command grants (vocabularies 1 to 4); it never replaces them.
//
// This module holds only what must be true whatever a policy says, so it imports nothing and the
// record decoder, the policy parser and the CLI can all depend on it without a cycle:
//
// - the ops a bundle may EVER carry (`BUNDLE_ELIGIBLE_OPS`), a closed list;
// - the commands that can NEVER be in a bundle (`BUNDLE_FORBIDDEN_COMMANDS`), derived from the
//   invariant that a client must not change permissions, seats, teams, the owner's settings or the
//   machine's daemons: structurally ineligible, exactly like the team-grant forbidden list. A
//   policy can only choose among eligible ops; it can never add one, and it can never name one of
//   these;
// - the two bundle names and the defaults a policy starts from.
//
// The record stores the EXPLICIT op list the owner signed (`allowed_ops`); the bundle name is a
// display label and decides nothing. So a command added to a bundle in a later build, or a policy
// that is loosened later, never widens a grant that was signed before.

/** The ops a bundle may carry, in the one canonical order a record lists them. `status`, `list`,
 *  `check`, `feed` and `messages` read; `send` writes to the granted seats; `up` and `down` start
 *  and stop the one team. Not every op has a client route yet: see `BUNDLE_OP_ROUTES`. */
export const BUNDLE_ELIGIBLE_OPS = ['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down'] as const;
export type BundleOp = (typeof BUNDLE_ELIGIBLE_OPS)[number];

/** Whether each eligible op has a `--client <grant> --key <key>` form in this build. A record may
 *  carry an op whose route does not exist yet (it admits nothing today and says so); the route
 *  arrives without any grant being widened or re-signed. */
export const BUNDLE_OP_ROUTES: Readonly<Record<BundleOp, boolean>> = {
  status: true,
  list: false,
  check: false,
  feed: false,
  messages: false,
  send: true,
  up: true,
  down: true,
};

/**
 * The commands no bundle can ever carry, whatever the policy says and whatever a hand-built record
 * lists: sub-grants and revocation, the owner's identity and seat, policy and settings changes,
 * adding, removing, renaming or swapping seats, answering, pacing, the broker, the bus, the
 * daemons, registering, the queue, holds, worktrees, raising, creating a team, client key creation,
 * and pausing or resuming. Spelled both bare and with the subcommand (`policy`, `policy set`).
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
  'rename',
  'swap',
  'answer',
  'tempo',
  'broker',
  'bus',
  'daemon',
  'register',
  'queue',
  'hold',
  'worktree',
  'raise',
  'client',
  'client-keygen',
  'pause',
  'resume',
];

/** One word as the lists spell it: lower case, spaces and underscores as hyphens. */
function spelled(word: string): string {
  return word.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Whether a command name is one a bundle can never carry: the name itself, or any command whose
 *  first word is one (`policy set --force` is `policy`). */
export function isForbiddenBundleCommand(name: string): boolean {
  const word = spelled(name);
  if (BUNDLE_FORBIDDEN_COMMANDS.includes(word)) return true;
  const first = word.split('-')[0] ?? '';
  return first !== '' && BUNDLE_FORBIDDEN_COMMANDS.includes(first) && !(BUNDLE_ELIGIBLE_OPS as readonly string[]).includes(word);
}

/** Whether a name is an op a bundle may carry: eligible AND not forbidden. */
export function isEligibleBundleOp(name: unknown): name is BundleOp {
  return typeof name === 'string' && (BUNDLE_ELIGIBLE_OPS as readonly string[]).includes(name) && !isForbiddenBundleCommand(name);
}

/** The ops as a record writes them: each once, in canonical order. Null when any name is not an
 *  eligible op, or none is given. */
export function canonicalBundleOps(ops: readonly unknown[]): BundleOp[] | null {
  if (ops.length === 0) return null;
  if (!ops.every(isEligibleBundleOp)) return null;
  return BUNDLE_ELIGIBLE_OPS.filter((op) => (ops as readonly string[]).includes(op));
}

/** The two bundle names. The name is a display label; the signed op list decides. */
export const BUNDLE_NAMES = ['observer', 'operator'] as const;
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

/** The longest a bundle grant may last, whatever a policy says: ninety days, the cap the one-op
 *  `up` grant already has. A policy shortens it; nothing lengthens it. */
export const BUNDLE_HARD_MAX_DAYS = 90;

/** One bundle's policy values: the ops it expands to, and the days a grant of it lasts (the default
 *  when `--expires` is absent, and the cap). */
export type BundleSpec = { ops: BundleOp[]; expiryDays: number };

/** The release defaults, used where no policy says otherwise. */
export const DEFAULT_BUNDLE_SPECS: Readonly<Record<BundleName, BundleSpec>> = {
  observer: { ops: [...OBSERVER_DEFAULT_OPS], expiryDays: BUNDLE_HARD_MAX_DAYS },
  operator: { ops: [...OPERATOR_DEFAULT_OPS], expiryDays: BUNDLE_HARD_MAX_DAYS },
};

export type BundleSpecs = Record<BundleName, BundleSpec>;

/** A fresh copy of the release defaults. */
export function defaultBundleSpecs(): BundleSpecs {
  return { observer: { ...DEFAULT_BUNDLE_SPECS.observer, ops: [...DEFAULT_BUNDLE_SPECS.observer.ops] }, operator: { ...DEFAULT_BUNDLE_SPECS.operator, ops: [...DEFAULT_BUNDLE_SPECS.operator.ops] } };
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
      if (isForbiddenBundleCommand(op)) return { ok: false, why: `"${op}" can never be in a bundle (it changes who may do what)` };
      if (!isEligibleBundleOp(op)) return { ok: false, why: `"${op}" is not a bundle op: ${BUNDLE_ELIGIBLE_OPS.join(', ')}` };
    }
    if (new Set(listed).size !== listed.length) return { ok: false, why: `bundle ${name} names an op twice` };
    const ops = canonicalBundleOps(listed)!;
    let expiryDays: number | undefined;
    if (match[3] !== undefined) {
      expiryDays = Number.parseInt(match[3], 10);
      if (expiryDays < 1 || expiryDays > BUNDLE_HARD_MAX_DAYS) return { ok: false, why: `${String(expiryDays)} days is out of range: 1 to ${String(BUNDLE_HARD_MAX_DAYS)}` };
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
    if (over !== undefined) base[name] = { ops: [...over.ops], expiryDays: over.expiryDays ?? base[name].expiryDays };
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
