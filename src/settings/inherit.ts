// Settings (Layer 3): one value per seat, inherited machine → entity → project → team → seat. A
// level below may tighten a setting freely — closing is always legal — and may loosen it only
// where the setting itself allows that level to, so a project can open what an entity left
// closed, while a team inside it keeps the power to close the door again for itself. Every setting
// names an enforced policy of the 0.5.0 catalogue (Kernel amendment 02), and `resolve.ts` reads it
// through that policy's values, ordering and default; the declarations and defaults stay here,
// where the catalogue reads them too.

export type SettingLevel = 'machine' | 'entity' | 'project' | 'team' | 'seat';

/** The inheritance order, outermost first. */
export const SETTING_LEVELS: readonly SettingLevel[] = ['machine', 'entity', 'project', 'team', 'seat'];

/** One level's word on a setting: the level that holds it, the value it declares, and when the
 *  word stops counting (an expired word is unset at its level). */
export type Declaration = { level: SettingLevel; value: boolean; expiry?: string | null };

/**
 * A boolean setting, declared once per feature: the catalogue policy it is, the value when no
 * level declares one, and the levels allowed to loosen it. Which word tightens and which loosens
 * is the catalogue policy's to say (its `isWithin`); tightening is allowed at every level and
 * needs no listing.
 */
export type SettingSpec = {
  /** The spelling the setting is written under in a team file and a report — the policy's alias. */
  name: string;
  /** The catalogue policy this setting is, in canonical kebab-case. */
  policy: string;
  /** The value when nothing declares it. */
  fallback: boolean;
  /** The levels allowed to loosen this setting. */
  looseningLevels: readonly SettingLevel[];
};

/** The declarations a chain of per-level values holds, in inheritance order; a level the chain
 *  says nothing about is left out, and so is a level given `undefined`. */
export function declarationsOf(declared: Partial<Record<SettingLevel, boolean | undefined>>): Declaration[] {
  const out: Declaration[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * How a sender reads in TeamCLI's own headlines: `auto` (the seat's nickname inside its own
 * team, `seat@team` from another), `nickname`, `seat`, or `seat@team`. It is a presentation
 * word, not a permission one: the registry id stays in every record, and only the human
 * headline changes. A team file's own key and a seat's may stand nearer in the chain, and the
 * project a team sits in declares the word under them; the default is `auto`.
 */
export const SENDER_NAME_MODES = ['auto', 'nickname', 'seat', 'seat@team'] as const;
export type SenderNameMode = (typeof SENDER_NAME_MODES)[number];
export const DEFAULT_SENDER_NAME: SenderNameMode = 'auto';

/** Whether a declared word is one of the four. */
export function isSenderNameMode(value: unknown): value is SenderNameMode {
  return typeof value === 'string' && (SENDER_NAME_MODES as readonly string[]).includes(value);
}

/**
 * Seats of different teams inside one project may reach each other when this is on: the project
 * setting, default off. The project is the level that may open it; every level inside a project
 * may close it again. Resolve it for the seat that wants to reach out — admission reads the
 * asker's own chain, so a seat that closes it closes the door on itself alone.
 */
export const SEATS_CROSS_TEAMS: SettingSpec = {
  name: 'seats_cross_teams',
  policy: 'seats-cross-teams',
  fallback: false,
  looseningLevels: ['project'],
};

/**
 * A number setting, in the boolean one's shape: the catalogue policy it is, the value when no
 * level declares one, and the levels allowed to loosen it. Which side of the inherited value is
 * the looser one is the catalogue policy's to say (its `isWithin`); tightening is allowed at every
 * level and needs no listing. A word equal to the value in force is no word at all.
 */
export type NumberSettingSpec = {
  /** The spelling the setting is written under in a team file and a report — the policy's alias. */
  name: string;
  /** The catalogue policy this setting is, in canonical kebab-case. */
  policy: string;
  /** The value when nothing declares it. */
  fallback: number;
  /** The levels allowed to loosen this setting. */
  looseningLevels: readonly SettingLevel[];
};

/** One level's word on a number setting: the level that holds it, the value it declares, and when
 *  the word stops counting (an expired word is unset at its level). */
export type NumberDeclaration = { level: SettingLevel; value: number; expiry?: string | null };

/** The declarations a chain of per-level numbers holds, in inheritance order; a level the chain
 *  says nothing about is left out, like one given `undefined`. */
export function numberDeclarationsOf(declared: Partial<Record<SettingLevel, number | undefined>>): NumberDeclaration[] {
  const out: NumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * How long a seat may read unknown before it counts as not working — the reading `status` and
 * `check` flag `blind`. It is one of the liveness defaults, so it is declared once and read by
 * both groups below; a longer window tolerates more, so the permissive side is 'higher'. The
 * project may open it — the same level `seats_cross_teams` allows — and every level inside a
 * project may close it again. No other level may lengthen it.
 */
const BLIND_AFTER_SECONDS: NumberSettingSpec = {
  name: 'state_blind_after_seconds',
  policy: 'state-blind-after-seconds',
  fallback: 300,
  looseningLevels: ['project'],
};

/**
 * How long an idle seat waits before its lead is told. It is one of the liveness defaults and
 * never lengthens: every level may tighten it, and a longer word is set aside where the
 * thresholds resolve.
 */
const IDLE_LEAD_SECONDS: NumberSettingSpec = {
  name: 'liveness_idle_lead_seconds',
  policy: 'liveness-idle-lead-seconds',
  fallback: 300,
  looseningLevels: [],
};

/**
 * How long after that the seat's owner is told, once per idle period. Like the lead's window it
 * only ever tightens: an owner is escalated to no later for a longer word.
 */
const IDLE_OWNER_SECONDS: NumberSettingSpec = {
  name: 'liveness_idle_owner_seconds',
  policy: 'liveness-idle-owner-seconds',
  fallback: 900,
  looseningLevels: [],
};

/**
 * The thresholds a seat's state is read by, and the two idle windows the watch reports on:
 * how fresh a TeamCLI trace must be for the seat to read as working; how long a seat may read
 * unknown before it counts as not working (`status` and `check` flag it `blind`); how long the
 * CLI's own `working` word outranks the screen outright; and the two idle windows. Past the hook
 * threshold a screen that still reads — a prompt showing again after an interrupted turn —
 * answers instead; a screen it cannot read leaves the hook to answer for the day. A longer window
 * tolerates more, so the permissive side is 'higher' on all five. The project may open the trace,
 * hook and blind windows, the same level `seats_cross_teams` allows; the two idle windows only
 * ever tighten. Declared per level as a partial set, each field inherited on its own. Every
 * reader takes this set through `stateThresholds` below — there is no second view of them.
 */
export type StateThresholds = {
  idle_lead_seconds: number;
  idle_owner_seconds: number;
  blind_after_seconds: number;
  trace_window_seconds: number;
  hook_working_seconds: number;
};

export const STATE_THRESHOLDS: { [K in keyof StateThresholds]: NumberSettingSpec } = {
  idle_lead_seconds: IDLE_LEAD_SECONDS,
  idle_owner_seconds: IDLE_OWNER_SECONDS,
  blind_after_seconds: BLIND_AFTER_SECONDS,
  trace_window_seconds: {
    name: 'state_trace_window_seconds',
    policy: 'state-trace-window-seconds',
    fallback: 120,
    looseningLevels: ['project'],
  },
  hook_working_seconds: {
    name: 'state_hook_working_seconds',
    policy: 'state-hook-working-seconds',
    fallback: 120,
    looseningLevels: ['project'],
  },
};

/**
 * How long a queued model swap may wait for its boundary before it runs at the next pause between
 * two turns (Policies rule 11). It ships at 30 minutes; a shorter wait moves the
 * seat sooner, so the tighter side is 'lower'. The project may open it, as it may open the state
 * windows, and every level inside may close it again.
 */
export const SWAP_WAIT_SECONDS: NumberSettingSpec = {
  name: 'swap_wait_seconds',
  policy: 'swap-wait-seconds',
  fallback: 1800,
  looseningLevels: ['project'],
};

/** The three liveness defaults, in the order a report names them: the idle-to-lead, idle-to-owner
 *  and blind windows. They ship at 5 minutes, 15 minutes and 5 minutes. */
export type LivenessThresholds = Pick<StateThresholds, 'idle_lead_seconds' | 'idle_owner_seconds' | 'blind_after_seconds'>;

/** The liveness keys, in the order the writers emit them. */
export const LIVENESS_KEYS = ['idle_lead_seconds', 'idle_owner_seconds', 'blind_after_seconds'] as const;

/** The values when nothing declares any — the same fallbacks the specs carry. */
export const DEFAULT_STATE_THRESHOLDS: StateThresholds = {
  idle_lead_seconds: STATE_THRESHOLDS.idle_lead_seconds.fallback,
  idle_owner_seconds: STATE_THRESHOLDS.idle_owner_seconds.fallback,
  blind_after_seconds: STATE_THRESHOLDS.blind_after_seconds.fallback,
  trace_window_seconds: STATE_THRESHOLDS.trace_window_seconds.fallback,
  hook_working_seconds: STATE_THRESHOLDS.hook_working_seconds.fallback,
};

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = livenessOf(DEFAULT_STATE_THRESHOLDS);

/** The three liveness windows in a resolved set, handed to the watch's checks. */
export function livenessOf(thresholds: StateThresholds): LivenessThresholds {
  return {
    idle_lead_seconds: thresholds.idle_lead_seconds,
    idle_owner_seconds: thresholds.idle_owner_seconds,
    blind_after_seconds: thresholds.blind_after_seconds,
  };
}

/**
 * What a liveness word must be: a whole number of seconds, at least one. The resolver judges
 * every word by this rule, and the loaders that check a record name the same rule at the field;
 * a word that fails it is set aside, never reported as a loosening.
 */
export function isLivenessSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** A threshold said the way a report says it: 90s, 5m, 2h. */
export function sayThreshold(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** The rule a refused liveness word broke, as the report says it. */
export const LIVENESS_RULE = 'a liveness threshold may be tightened, never loosened, unless the level above allows it';

/**
 * An order setting: a list of legs, declared once per feature with the catalogue policy it is and
 * the order in force when no level declares one. An order only ever tightens: the catalogue
 * policy's `isWithin` honours a word that drops a leg or reorders the ones it keeps, sets aside
 * one that adds a leg other than the delivery order's own `native`, names one twice, or names
 * none — an order with no leg takes nothing at all. A word equal to the order in force is no word
 * at all.
 */
export type OrderSettingSpec<L extends string> = {
  /** The spelling the setting is written under in a team file and a report — the policy's alias. */
  name: string;
  /** The catalogue policy this setting is, in canonical kebab-case. */
  policy: string;
  /** The order when nothing declares it. */
  fallback: readonly L[];
};

/** One level's word on an order setting: the level that holds it, the order it declares, and when
 *  the word stops counting (an expired word is unset at its level). */
export type OrderDeclaration<L extends string = string> = { level: SettingLevel; value: readonly L[]; expiry?: string | null };

/** The declarations a chain of per-level orders holds, in inheritance order; a level the chain
 *  says nothing about is left out, and so is a level given `undefined`. */
export function orderDeclarationsOf<L extends string>(declared: Partial<Record<SettingLevel, readonly L[] | undefined>>): OrderDeclaration<L>[] {
  const out: OrderDeclaration<L>[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * The legs a send may walk, in the words the delivery order is written in: `socket`, the frame on
 * the receiving seat's cross-session socket (a signed copy is written first); `native`, the
 * sender's own cross-session SendMessage, recorded by the sender with `--confirm`; `mcp-inbox`,
 * the seat's own MCP inbox; `typed`, the 0600 drop file and one composer trigger line; `drop`, the
 * same 0600 drop file and no keystroke at all — for a receiver that watches its own drop folder,
 * or a pane that must not be typed into; `headless-resume`, the receiving seat's own CLI resumed
 * headlessly for one turn, with no TUI pane typed into. `socket` and `native` are distinct legs:
 * the socket leg is this build's own frame on the receiver's socket, the native leg the sender's
 * own call. `headless-resume` is nobody's default: only a word that names it reaches it, and this
 * build carries no headless runtime yet, so the walk records the leg as unavailable and moves on.
 * `channel` is the seat's own inbox server pushing the message into its CLI through the
 * development channel; it is implied only, never a declared word: a launch that carries the
 * development-channels flag and whose server is listening takes it, and every other receiver
 * walks its order exactly as written. Its delivery is the notification itself, ended as
 * `sent (channel)`; a push no signed receipt confirms in time is redelivered once by the watch.
 */
export type DeliveryLeg = 'socket' | 'native' | 'mcp-inbox' | 'typed' | 'drop' | 'headless-resume' | 'channel';

export const DELIVERY_LEGS: readonly DeliveryLeg[] = ['socket', 'native', 'mcp-inbox', 'typed', 'drop', 'headless-resume'];

/**
 * The order a send walks when no level of the receiving seat's chain declares one: mcp-inbox,
 * then typed, then drop. The mcp-inbox leg takes a send only while the seat's own inbox server is
 * listening, and writes the message to that inbox without typing; otherwise it is skipped as
 * `no live inbox listener` and the walk moves on. The typed leg is next because it is the leg
 * that wakes an idle seat: one trigger line, the seat's own drop read, and its signed receipt is
 * what makes the send `delivered (read)`. The drop leg is last: it writes the same 0600 file and
 * types nothing at all, so a receiver that watches its folder — the inbox server where its CLI
 * has an MCP front, the launch's start-of-turn read where it has a hook — takes the message
 * there, but nothing wakes a seat that is idle. A seat that watches nothing never walks this leg
 * (`src/send/delivery.ts` leaves it out of that seat's order). The `native` leg is not in the
 * default: a level that names it is the sender choosing the cross-session SendMessage and
 * recording the delivery itself, so `native` is a leg a declared word may add
 * (`src/policy/types.ts`). The `headless-resume` leg is not in the fallback and no implied default
 * adds it: a level that wants it names it, and a declared word may add it
 * (`src/policy/types.ts`); until the receiving seat's runtime carries one, the walk records the
 * leg as unavailable rather than typing into the seat for it. The `socket` leg is not in this
 * fallback either: `team send` walks it first only when the receiver's launch declares
 * `crossSessionInbound: accept` (a team-file `inbound: accept` authorizes any launch, an explicit
 * `hold` or `refuse` opts out, and with no word only a launch this build attested is authorized),
 * and no level of the chain names an order — the one implied default that adds it
 * (`src/commands/send.ts`).
 * A declared word may place `socket` anywhere or leave it out. The chain is the receiving seat's
 * own — entity, project, team, seat — because the order says how that seat's messages may travel.
 */
export const DELIVERY_ORDER: OrderSettingSpec<DeliveryLeg> = {
  name: 'delivery_order',
  policy: 'delivery-order',
  fallback: ['mcp-inbox', 'typed', 'drop'],
};

/**
 * How a seat's number is written at the front of its name: `width` is the digit count the number
 * is padded to — 1 to 4, or `'auto'` for the smallest width that holds the team's largest number —
 * and `separator` stands between the number and the rest of the name. The advised policy
 * `seat-numbering` carries the two fields as one canonical string, `width` then `separator` (`2-`
 * for the default), so every signed policy record holds one scalar; `seatNumberingOf` gives the
 * fields back. It is set at entity, project or team, and a lower level chooses the format: an
 * advised setting has no tighter numbering to judge against.
 */
export type SeatNumbering = { width: 1 | 2 | 3 | 4 | 'auto'; separator: string };

/** The numbering when no level declares one: two digits and a hyphen. */
export const SEAT_NUMBERING_DEFAULT: SeatNumbering = { width: 2, separator: '-' };

/** The catalogue's release default, in the policy value's canonical string form. */
export const SEAT_NUMBERING_DEFAULT_VALUE = '2-';

/** The canonical policy value for a numbering: the width, then the separator as it stands. */
export function seatNumberingValue(numbering: SeatNumbering): string {
  return `${numbering.width}${numbering.separator}`;
}

/** Reads a policy value into its two fields; null when it cannot be a numbering. */
export function seatNumberingOf(value: unknown): SeatNumbering | null {
  if (typeof value !== 'string' || value === '') return null;
  let width: SeatNumbering['width'];
  let rest: string;
  if (value.startsWith('auto')) {
    width = 'auto';
    rest = value.slice(4);
  } else if (value[0] !== undefined && value[0] >= '1' && value[0] <= '4') {
    width = Number(value[0]) as 1 | 2 | 3 | 4;
    rest = value.slice(1);
  } else {
    return null;
  }
  return { width, separator: rest };
}

/** The width a number is padded to: `'auto'` is the digit count of the team's largest number. */
export function seatWidthFor(numbering: SeatNumbering, largest: number): number {
  if (numbering.width !== 'auto') return numbering.width;
  return Math.max(1, String(Math.max(1, Math.floor(largest))).length);
}

/** The catalogue policy's value: the canonical string, or null when it is not a numbering. */
export function parseSeatNumberingValue(raw: unknown): string | null {
  const numbering = seatNumberingOf(raw);
  return numbering === null ? null : seatNumberingValue(numbering);
}
