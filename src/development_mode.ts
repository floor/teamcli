// The machine-scoped development mode: one signed record under the home, above every team and
// project. The owner's dispatch makes this the one switch: the
// `development-mode` word, `local-fast`, `pr-per-change`, or an explicit `off`, written once for
// the whole machine. While the record is present it governs — `local-fast` lifts the caller gate
// of the `DEV_MODE_OPERATIONS` commands exactly as `TEAMCLI_DEV_MODE=1` does today, and admits
// the same verified cross-team roles to the owner-only gates; `pr-per-change` keeps the process
// half and lifts no caller gate; `off` lifts none and beats the legacy variable and every
// per-team word. An absent record is today's behaviour untouched: the policy chain first, then
// the variable. The legacy `dev-mode` policy is compatibility and migration only from here on;
// it is never a second authority beside this record.
//
// The record is signed with the owner's approval key under its own domain tag, the one rule the
// policy sources already use: the setter is `owner`, the date is the signing moment, and the
// generation comes from the machine's own counter (`bumpGeneration` rooted at the config folder,
// never at a team root — the machine scope cannot borrow a team's wildcard). Reading verifies
// the signature against the key this machine holds and checks the counter:
//
// - a record whose signature does not verify, whose shape is not this format, whose key is
//   missing or unreadable, or whose generation disagrees with the counter is REFUSED. Dev mode
//   is not applied on it: the gates stay down, because a record the tool cannot trust must not
//   lift anything. The owner repairs it by switching again.
// - a record that is absent while the generation counter exists is refused too: a set record
//   was removed or rolled back, and silently returning to the legacy variable would be
//   fail-open. A machine that never carried a record has no counter, and keeps today's
//   behaviour.
//
// The non-terminal owner step is the existing out-of-band authorization, not a new one: the
// agent prints `Owner-authorization fingerprint: <hex>` (the digest of this machine, the exact
// mode and the prior generation), the owner reads it back, and the agent reruns with
// `TEAM_OWNER_APPROVAL=<hex>`. `ownerAuthorized` compares it exactly; an empty or arbitrary
// token never matches. A token is bound to the prior generation, so a replayed token after any
// switch recomputes to a different fingerprint and is refused. The token is never logged and
// never written into the record. Writing never creates a key: a machine with no owner key
// refuses the switch and names the owner terminal's signed-write path.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonical } from './approve/fingerprint.ts';
import { logLine } from './log.ts';
import {
  bumpGeneration,
  keyState,
  recordedGeneration,
  SAFE_GENERATION,
  signDomain,
  verifyDomain,
  type Json,
} from './store/keys.ts';

/** Domain tag for the machine development-mode record. Its signatures are not policy,
 *  message or approval signatures, whatever their bytes. */
export const DEVELOPMENT_MODE_DOMAIN = 'team-development-mode-v1\n';

/** The three words the machine setting takes. `off` is explicit: it beats the legacy variable
 *  and every per-team word, where an absent record leaves them alone. */
export const DEVELOPMENT_MODE_VALUES = ['local-fast', 'pr-per-change', 'off'] as const;
export type DevelopmentMode = (typeof DEVELOPMENT_MODE_VALUES)[number];

export function isDevelopmentMode(value: unknown): value is DevelopmentMode {
  return value === 'local-fast' || value === 'pr-per-change' || value === 'off';
}

/** The signed record as the file holds it, without its signature. */
export type DevelopmentModeRecord = {
  format: 1;
  mode: DevelopmentMode;
  scope: 'machine';
  setter: 'owner';
  since: string;
  generation: number;
};

export type SignedDevelopmentModeRecord = DevelopmentModeRecord & { signature: string };

/** What the record says, or why it cannot be used: absent is the untouched legacy machine. */
export type DevelopmentModeRead =
  | { kind: 'absent' }
  | { kind: 'set'; record: DevelopmentModeRecord }
  | { kind: 'refused'; why: string };

/** `<home>/.config/team/development-mode.json`, beside the machine settings file. */
export function developmentModePath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'development-mode.json');
}

/** The generation counter's root: the machine config folder, never a team root, so the
 *  machine scope cannot inherit or collide with a project's or team's generation. */
function generationRoot(home: string): string {
  return join(home, '.config', 'team');
}

/** The exact bytes the owner's signature covers. */
function payloadOf(record: DevelopmentModeRecord): Json {
  return {
    format: 1,
    mode: record.mode,
    scope: 'machine',
    setter: 'owner',
    since: record.since,
    generation: record.generation,
  };
}

const RECORD_KEYS = ['format', 'mode', 'scope', 'setter', 'since', 'generation', 'signature'] as const;

function refused(why: string): DevelopmentModeRead {
  return { kind: 'refused', why };
}

/**
 * The record as this machine can use it. Nothing here writes, creates a key or repairs: a
 * reader answers absent, set, or refused, and only a refusal explains itself.
 */
export function readDevelopmentMode(home: string = homedir()): DevelopmentModeRead {
  let text: string;
  try {
    text = readFileSync(developmentModePath(home), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return refused(`the record cannot be read (${code ?? 'unreadable'}); restore it or switch again`);
    }
    // No record. A counter that exists means a record was set and then removed: returning to
    // the legacy variable here would be fail-open, so the absence is refused.
    const counter = recordedGeneration(generationRoot(home), home);
    if (counter !== null) {
      return refused(
        `the record is missing but its generation counter is at ${counter.generation}; the setting was removed or rolled back — switch again to repair`,
      );
    }
    return { kind: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused('the record is not whole JSON; switch again to repair');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refused('the record is not a map; switch again to repair');
  }
  const raw = parsed as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !(RECORD_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) return refused(`the record carries an unknown field "${unknown}"; switch again to repair`);

  if (raw.format !== 1) return refused('the record is not format 1; switch again to repair');
  if (!isDevelopmentMode(raw.mode)) return refused('the record names a mode this build does not know; switch again to repair');
  if (raw.scope !== 'machine') return refused('the record is not scoped to the machine; switch again to repair');
  if (raw.setter !== 'owner') return refused('the record is not marked as set by the owner; switch again to repair');
  if (typeof raw.since !== 'string' || !Number.isFinite(Date.parse(raw.since))) {
    return refused('the record has no readable signing date; switch again to repair');
  }
  if (
    typeof raw.generation !== 'number' ||
    !Number.isInteger(raw.generation) ||
    raw.generation < 1 ||
    raw.generation > SAFE_GENERATION
  ) {
    return refused('the record has no valid generation; switch again to repair');
  }
  if (typeof raw.signature !== 'string' || raw.signature.length === 0) {
    return refused('the record is not signed; switch again to repair');
  }

  const record: DevelopmentModeRecord = {
    format: 1,
    mode: raw.mode,
    scope: 'machine',
    setter: 'owner',
    since: raw.since,
    generation: raw.generation,
  };

  const state = keyState(home);
  if (state.kind !== 'key') {
    return refused(
      state.kind === 'missing'
        ? 'the owner signing key is not on this machine, so the record cannot be verified'
        : state.why,
    );
  }
  if (!verifyDomain(DEVELOPMENT_MODE_DOMAIN, payloadOf(record), raw.signature, state.key)) {
    return refused('the record does not verify under this machine\'s owner key; switch again to repair');
  }

  const counter = recordedGeneration(generationRoot(home), home);
  if (counter === null) {
    return refused('the record has no generation counter; switch again to repair');
  }
  if (counter.generation !== record.generation) {
    return refused(
      `the record is stale: generation ${record.generation}, counter ${counter.generation}; switch again to repair`,
    );
  }
  return { kind: 'set', record };
}

/** The generation a switch starts from: the counter's value, or 0 when this machine never
 *  carried a record. The fingerprint binds it, so a token for an older state cannot replay. */
export function developmentModeGeneration(home: string = homedir()): number {
  return recordedGeneration(generationRoot(home), home)?.generation ?? 0;
}

/**
 * The hex the owner authorizes for exactly this switch: this machine, the mode asked for, and
 * the generation the record stands at now (0 when absent). It changes after every switch, so a
 * token shown for one change never authorizes another.
 */
export function developmentModeFingerprint(
  home: string,
  mode: DevelopmentMode,
  priorGeneration: number,
): string {
  let machine = home;
  try {
    machine = realpathSync(home);
  } catch {
    // A home that does not resolve keeps its path as given.
  }
  return createHash('sha256')
    .update(`development-mode\n${canonical({ machine, mode, prior_generation: priorGeneration })}`)
    .digest('hex');
}

export type DevelopmentModeWrite =
  | { ok: true; record: DevelopmentModeRecord; previous: DevelopmentModeRecord | null }
  | { ok: false; why: string };

/**
 * Writes the machine switch, signed with the existing owner key. `expectGeneration` is the
 * generation the authorization was computed against; a switch that finds the counter moved
 * refuses — that is the replay guard. A refused or absent record is repaired by the same write:
 * the owner's explicit switch is the repair path.
 *
 * Nothing here creates a key: if the machine has none, the switch refuses and names the owner
 * terminal's signed-write path. The audit line records the mode, the previous mode and the
 * caller; it never carries the token or the fingerprint.
 */
export function writeDevelopmentMode(input: {
  home: string;
  mode: DevelopmentMode;
  now: Date;
  caller: string;
  expectGeneration?: number;
}): DevelopmentModeWrite {
  const at = developmentModeGeneration(input.home);
  if (input.expectGeneration !== undefined && at !== input.expectGeneration) {
    return {
      ok: false,
      why: `the machine setting moved to generation ${at} since the fingerprint was shown; show it again`,
    };
  }
  const state = keyState(input.home);
  if (state.kind === 'missing') {
    return {
      ok: false,
      why: 'the owner signing key is not on this machine; the switch needs the key the owner terminal already uses',
    };
  }
  if (state.kind === 'unreadable') return { ok: false, why: state.why };

  const current = readDevelopmentMode(input.home);
  const previous = current.kind === 'set' ? current.record : null;
  // A refused record is overwritten by the owner's repair; its content is never reused.
  const generation = bumpGeneration(generationRoot(input.home), input.home, input.now);
  const record: DevelopmentModeRecord = {
    format: 1,
    mode: input.mode,
    scope: 'machine',
    setter: 'owner',
    since: input.now.toISOString(),
    generation,
  };
  const signed: SignedDevelopmentModeRecord = {
    ...record,
    signature: signDomain(DEVELOPMENT_MODE_DOMAIN, payloadOf(record), state.key),
  };
  const path = developmentModePath(input.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);

  const readBack = readDevelopmentMode(input.home);
  if (readBack.kind !== 'set' || readBack.record.mode !== input.mode || readBack.record.generation !== generation) {
    return { ok: false, why: 'the record did not read back after the write; the machine setting is not in force' };
  }
  logLine(
    generationRoot(input.home),
    'development-mode',
    input.caller,
    `machine development mode set to ${input.mode}${previous === null ? ' (was not set)' : ` (was ${previous.mode})`}; set by the owner`,
    input.now,
  );
  return { ok: true, record, previous };
}

/** The state line `status`, `check` and `team development-mode` print, one line, in the
 *  reading's own words. Absent is no note for the readings (today's behaviour is unchanged), and
 *  the explicit refusal is a note: a broken record is visible where the gates are read. */
export function developmentModeNote(read: DevelopmentModeRead): string | null {
  if (read.kind === 'absent') return null;
  if (read.kind === 'refused') {
    return `dev mode: the machine setting cannot be read (${read.why}); no caller gate is lifted`;
  }
  return `dev mode: ${read.record.mode}, since ${read.record.since}, set by the owner`;
}

/** The same fact for the command's own view, where an absent record is still worth saying. */
export function developmentModeStateLine(read: DevelopmentModeRead): string {
  if (read.kind === 'absent') {
    return 'dev mode: not set; the legacy behaviour applies (the dev-mode policy chain, then TEAMCLI_DEV_MODE=1)';
  }
  return developmentModeNote(read) as string;
}
