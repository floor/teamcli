// `team settings` — one seat's settings and where each value comes from, and the two write verbs
// that record one. The read composes the live team file with the signed settings records in the
// registry (`src/config/compose.ts`); `set` and `unset` sign a record into the seat's agent file,
// raise `config.changed`, and log the change. Only the owner writes: a lead's write within its
// team waits for the role policy the approved minimum leaves out, and this build refuses rather
// than admit a write no policy authorized.
//
// The write guard runs in three layers, each refusing in its own terms: the store plan
// (`settings.key`, `settings.value`, `settings.source`), the per-seat check in
// `src/config/value.ts` (the seat's launch profile and the roster) and the policy guard in
// `src/config/guard.ts` (`settings.policy`).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { describeCaller, fileOwnerRefusal, isOwner, walkCaller } from '../caller.ts';
import { appendConfigChanged } from '../config/events.ts';
import { resolveSeatOverrides } from '../config/apply.ts';
import type { ConfigRow } from '../config/compose.ts';
import { agentIdOf, readSeatSettings } from '../config/read.ts';
import { CONFIG_KEYS, getConfigSpec } from '../config/registry.ts';
import type { ApplyKind, ConfigKey, ConfigValue } from '../config/registry.ts';
import { planConfigSet, planConfigUnset, seatRecordForWrite, writeConfigSet, writeConfigUnset } from '../config/sources.ts';
import type { SignedConfigRecord } from '../config/record.ts';
import type { PlannedConfigSetting } from '../config/sources.ts';
import { sayApply, sayConfigOrigin, sayConfigValue } from '../config/text.ts';
import { checkSeatSetting } from '../config/value.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import type { Current } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import { defaultLabel } from '../file/validate.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import { loadAndResolvePolicyChain, logExpiredPoliciesOnce } from '../policy/index.ts';
import { labOfModel } from '../policy/model-rule.ts';
import { profileFor, resolveModelOverride, supportsEffortLaunch, withLaunchOverrides } from '../profiles/profile.ts';
import { mayReadTeam } from '../read-gate.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { readState, updateState, type QueuedSwap } from '../state.ts';
import { WAIT_FOR, waitSecondsFor } from '../swap/auto.ts';
import { handoverPath, needsHandover, swapModelOf } from '../swap/queue.ts';

export const USAGE = `Usage: team settings <seat> [--file <path>] [--json]
       team settings set <seat> <key> <value> [--file <path>] [--dry-run] [--json]
       team settings set <seat> <key=value> [--dry-run] [--json]
       team settings unset <seat> <key> [--file <path>] [--dry-run] [--json]

Prints the seat's settings and where each value comes from: a signed record at the seat, team, project or entity level, the team file, the team's own order, the release default, or unset. The write forms record a signed setting for one seat, one key and value or several key=value words; only the owner runs them, and a change is signed, logged and raised as config.changed. A model is recorded as the launch id it names in the seat's profile, so a later launch reads the same model.

Exits 0 when the settings are printed or the change is written, 1 when the seat is not declared or its agent record cannot be created, the caller is not the owner, a policy forbids the value, or an unset names a setting that is not set, 2 when the invocation, the team file, or a signed record cannot be read, a value is outside what the seat's profile accepts, or the record cannot be written.
`;

export type SettingsCommandOptions = {
  home?: string;
  now?: Date;
  /** The read gate's own sources, when a test stands in for the machine: the same shape
   *  `team seats` takes, so a scene can place the caller without a real herdr. */
  gate?: DelegateSources;
};

export const settings: Command = (argv, io) => runSettings(argv, io);
export default settings;

export async function runSettings(
  argv: string[],
  rawIo: Io,
  options: SettingsCommandOptions = {},
): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['file'], ['json', 'dry-run']);
  if (args.error !== undefined) {
    return invocation(io, json, args.error);
  }
  const verb = args.rest[0];
  if (verb === 'set' || verb === 'unset') {
    return executeWrite(verb, args.rest.slice(1), args.flags, args.values.file, io, json, options);
  }
  if (args.flags.has('dry-run')) {
    return invocation(io, json, '--dry-run is for the write forms (set, unset)');
  }
  if (args.rest.length !== 1) {
    const why = args.rest.length === 0 ? 'a seat name is required' : `unexpected "${args.rest[1]}"`;
    return invocation(io, json, why);
  }
  return executeRead(args, io, json, options);
}

function invocation(io: Io, json: boolean, why: string): number {
  if (json) {
    writeJsonError(io, 'settings.invocation', why, null);
  } else {
    io.stderr(`team settings: ${why}\n${USAGE}`);
  }
  // exit: settings.invocation
  return 2;
}

/** The read form: the team file and the four signed records, composed, with each value's source. */
function executeRead(
  args: ReturnType<typeof readArgs>,
  io: Io,
  json: boolean,
  options: SettingsCommandOptions,
): number {
  const seatName = args.rest[0] as string;

  const walked = walkCaller(io);
  const owner = isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) return fileOwnerExit(io, json, refusal);
  }

  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, now, home, owner);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, options.gate !== undefined ? { home, gate: options.gate } : { home })) {
      if (json) {
        writeJsonError(io, 'settings.not-yours', 'this team is not yours to read', null);
      } else {
        io.stderr('team settings: this team is not yours to read\n');
      }
      // exit: settings.not-yours
      return 2;
    }
  } else if (!current.ok) {
    return refuseFile(io, json, current);
  }

  const { team } = current;
  const seat = team.seats.find((one) => one.name === seatName);
  if (seat === undefined) return noSeatExit(io, json, seatName, team.project);

  if (!json && current.notice !== undefined) io.stdout(`${current.notice}\n`);

  const read = readSeatSettings({
    home,
    root: current.root,
    project: team.project,
    seat,
    teamDeliveryOrder: team.deliveryOrder,
    entity: team.entity,
  });
  if (!read.ok) return sourceExit(io, json, read.refusals.map((one) => one.why));
  const rows = read.rows;
  if (json) {
    writeJson(io, 'team.settings', {
      format: 1,
      project: team.project,
      seat: seat.name,
      settings: rows.map((row) => ({
        key: row.key,
        value: row.value,
        source: row.origin,
        applies: row.applies,
        ...(row.sourceFile !== undefined ? { source_file: row.sourceFile } : {}),
      })),
    });
  } else {
    const style = ttyStyle(io, { json });
    const lines = renderTable({
      headers: ['KEY', 'VALUE', 'SOURCE', 'APPLIES'],
      rows: rows.map((row) => [row.key, sayConfigValue(row.value), sayConfigOrigin(row.origin), sayApply(row.applies)]),
      style,
    });
    io.stdout(`${lines.join('\n')}\n`);
  }
  // exit: settings.shown
  return 0;
}

/** The team file's refusal, shared by the read and the writes: the id names the failure, the
 *  lines print it. */
function refuseFile(io: Io, json: boolean, current: Extract<Current, { ok: false }>): number {
  const id = current.errors[0]?.message.includes('not inside a git repository')
    ? 'settings.not-a-repo'
    : current.errors.some(isParseError)
      ? 'settings.file-invalid'
      : 'settings.file';
  if (json) {
    const msg = current.errors.map((p) => `${p.line ? `team config line ${p.line}: ` : ''}${p.message}`).join('; ');
    writeJsonError(io, id, msg, null);
  } else {
    printProblems(io, current.errors);
  }
  // exit: settings.not-a-repo
  // exit: settings.file
  // exit: settings.file-invalid
  return 2;
}

const PLAN_IDS: Record<'key' | 'value' | 'source' | 'write', string> = {
  key: 'settings.key',
  value: 'settings.value',
  source: 'settings.source',
  write: 'settings.write',
};

function printRefusal(io: Io, json: boolean, id: string, why: string): void {
  if (json) writeJsonError(io, id, why, null);
  else io.stderr(`team settings: ${why}\n`);
}

// The refusals and successes both verbs share. The exit-code contract allows an id on one site
// only, so each answer prints and returns from here whichever caller met it.

function fileOwnerExit(io: Io, json: boolean, refusal: string): number {
  if (json) {
    writeJsonError(io, 'settings.file-owner', refusal, 'the owner runs `team settings --file <path>` from a terminal outside herdr', 1, 'owner-only');
  } else {
    io.stderr(`team settings: ${refusal}\n`);
  }
  // exit: settings.file-owner
  return 1;
}

function noSeatExit(io: Io, json: boolean, seatName: string, project: string): number {
  const message = `no seat "${seatName}" is declared in ${project}`;
  if (json) {
    writeJsonError(io, 'settings.no-seat', message, null);
  } else {
    io.stderr(`team settings: ${message}\n`);
  }
  // exit: settings.no-seat
  return 1;
}

function sourceExit(io: Io, json: boolean, why: string | readonly string[]): number {
  const lines = typeof why === 'string' ? [why] : why;
  if (json) {
    writeJsonError(io, 'settings.source', lines.join('; '), null);
  } else {
    for (const line of lines) io.stderr(`team settings: ${line}\n`);
  }
  // exit: settings.source
  return 2;
}

function planExit(io: Io, json: boolean, kind: 'key' | 'value' | 'source' | 'write', why: string): number {
  if (kind === 'source') return sourceExit(io, json, why);
  printRefusal(io, json, PLAN_IDS[kind], why);
  // exit: settings.key
  // exit: settings.value
  // exit: settings.write
  return 2;
}

function policyExit(io: Io, json: boolean, why: string): number {
  printRefusal(io, json, 'settings.policy', why);
  // exit: settings.policy
  return 1;
}

function notSetExit(io: Io, json: boolean, why: string): number {
  printRefusal(io, json, 'settings.not-set', why);
  // exit: settings.not-set
  return 1;
}

function dryRunExit(): number {
  // exit: settings.dry-run
  return 0;
}

function setExit(): number {
  // exit: settings.set
  return 0;
}

function unsetExit(): number {
  // exit: settings.unset
  return 0;
}

/** One `<key> <value>` pair, or `key=value` words, or the one key an unset names. */
type ParsedWrite =
  | { ok: true; seat: string; pairs: { key: string; value: string }[] }
  | { ok: true; seat: string; keys: string[] }
  | { ok: false; why: string };

function parseSetWords(words: readonly string[]): ParsedWrite {
  const seat = words[0];
  if (seat === undefined) return { ok: false, why: 'usage: team settings set <seat> <key> <value> | <key>=<value> …' };
  const rest = words.slice(1);
  if (rest.length === 0) return { ok: false, why: 'a setting is required after the seat name' };
  if (!(rest[0] as string).includes('=')) {
    if (rest.length === 1) return { ok: false, why: `setting "${rest[0]}" needs a value` };
    if (rest.length > 2) return { ok: false, why: `unexpected "${rest[2]}"` };
    return { ok: true, seat, pairs: [{ key: rest[0] as string, value: rest[1] as string }] };
  }
  const pairs: { key: string; value: string }[] = [];
  for (const word of rest) {
    const at = word.indexOf('=');
    if (at <= 0) return { ok: false, why: `setting "${word}" needs <key>=<value>` };
    pairs.push({ key: word.slice(0, at), value: word.slice(at + 1) });
  }
  return { ok: true, seat, pairs };
}

function parseUnsetWords(words: readonly string[]): ParsedWrite {
  const seat = words[0];
  if (seat === undefined) return { ok: false, why: 'usage: team settings unset <seat> <key>' };
  const key = words[1];
  if (key === undefined) return { ok: false, why: 'a setting key is required' };
  if (words.length > 2) return { ok: false, why: `unexpected "${words[2]}"` };
  return { ok: true, seat, keys: [key] };
}

function appliesOf(key: ConfigKey): ApplyKind {
  return getConfigSpec(key)?.applies ?? 'at-once';
}

function orderedSettings(settings: readonly PlannedConfigSetting[]): PlannedConfigSetting[] {
  return [...settings].sort((a, b) => CONFIG_KEYS.indexOf(a.key) - CONFIG_KEYS.indexOf(b.key));
}

/** What a model or effort change asks of the swap queue: nothing, a config record to queue (or
 *  replace), the config record to take back, a request another command queued that this one will
 *  not overwrite, or a refusal before anything is signed. */
type ConfigSwapPlan =
  | { kind: 'none' }
  | { kind: 'cancel' }
  | { kind: 'queue'; to: QueuedSwap['to'] }
  | { kind: 'conflict'; why: string }
  | { kind: 'refuse'; exit: 'source' | 'value' | 'write'; why: string };

/** The signed words one model or effort write leaves: `set` carries the checked values, `unset`
 *  the keys taken back. A key neither names keeps the signed word it already holds. */
type ConfigSwapChange = {
  set: ReadonlyMap<ConfigKey, ConfigValue>;
  unset: ReadonlySet<ConfigKey>;
};

/** The two records' targets hold the same words. Optional fields compare as absent. */
function sameTarget(left: QueuedSwap['to'], right: QueuedSwap['to']): boolean {
  return left.cli === right.cli
    && left.vendor === right.vendor
    && left.model === right.model
    && left.version === right.version
    && left.display === right.display
    && left.launch === right.launch
    && left.modelFrom === right.modelFrom
    && left.effort === right.effort
    && left.account === right.account;
}

/** The seat's composed settings rows, verified: the declaration plus every signed record that
 *  wins its key. A chain that does not verify refuses; a restart target is never derived from an
 *  unproved word. */
function readSeatRows(
  home: string,
  root: string,
  team: TeamFile,
  seat: Seat,
): { ok: true; rows: ConfigRow[] } | { ok: false; why: string } {
  const read = readSeatSettings({
    home,
    root,
    project: team.project,
    seat,
    teamDeliveryOrder: team.deliveryOrder,
    entity: team.entity,
  });
  if (read.ok) return { ok: true, rows: read.rows };
  return {
    ok: false,
    why: read.refusals
      .map((refusal) => `${refusal.level}${refusal.target === null ? '' : ` ${refusal.target}`}: ${refusal.why}`)
      .join('; '),
  };
}

/** The signed word a seat's composed chain holds for `key`, or undefined when the file (or
 *  nothing) decides it. A record at any level is the governed word; the file's own entry is the
 *  declaration the target falls back to. */
function signedWord(rows: readonly ConfigRow[], key: 'model' | 'effort'): string | undefined {
  const row = rows.find((entry) => entry.key === key);
  if (row === undefined || row.value === null) return undefined;
  if (!row.origin.endsWith(' record')) return undefined;
  return typeof row.value === 'string' ? row.value : undefined;
}

/** Whether the seat is a human's pane once this change is signed: a human's pane is never
 *  launched over, so no swap is queued for it. */
function humanAfter(rows: readonly ConfigRow[], change: ConfigSwapChange): boolean {
  if (change.set.has('human')) return change.set.get('human') === true;
  if (change.unset.has('human')) return false;
  return rows.find((entry) => entry.key === 'human')?.value === true;
}

/** The swap record the queue holds for the seat, or why it cannot be read. Read without the
 *  lock, for the plan; the write itself re-checks under the lock. */
function heldSwap(
  dir: string,
  seat: string,
): { ok: true; held: QueuedSwap | undefined } | { ok: false; why: string } {
  try {
    return { ok: true, held: readState(dir).swaps?.[seat] };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, why: `the queued swap record cannot be read (${why}); nothing was written` };
  }
}

/**
 * The config swap a set or unset of `model` and/or `effort` asks for, derived from the WHOLE
 * signed chain after the change: a value this write records, plus each key it does not name
 * holding the signed word it already has (or the file's declaration where it has none). An unset
 * therefore takes back only its own key — a queued model change survives an effort unset while
 * the model remains in force, and a remaining effort intent survives a model unset.
 *
 * The change is judged against the file's declaration — the words the launch reads — and against
 * the queue: a target already in force, or one already queued with exactly that target, asks for
 * no restart; a config record whose target is no longer wanted is taken back; a record another
 * command queued (`owner` or `model-rule`) is never replaced by this one — it is preserved and
 * the conflict is reported. The target recipe is the one `team add --model/--effort` builds: the
 * declaration's fields with the checked values applied, the model's resolved lab as the vendor,
 * and the account kept only when it names that lab.
 */
function configSwapPlan(input: {
  dir: string;
  seat: Seat;
  rows: readonly ConfigRow[];
  change: ConfigSwapChange;
}): ConfigSwapPlan {
  const { change, seat } = input;
  const touches = change.set.has('model') || change.unset.has('model')
    || change.set.has('effort') || change.unset.has('effort');
  if (!touches) return { kind: 'none' };
  if (humanAfter(input.rows, change)) return { kind: 'none' };
  const profile = profileFor(seat.cli);
  if (profile === null) {
    return {
      kind: 'refuse',
      exit: 'value',
      why: `${seat.name}: no launch profile for \`${seat.cli}\` in this version, so the restart target cannot be built`,
    };
  }
  // The signed words after the change: the value this write records, nothing for a key it takes
  // back, and the word the chain already holds for a key it does not name.
  const modelAfter = change.set.has('model')
    ? String(change.set.get('model'))
    : change.unset.has('model') ? undefined : signedWord(input.rows, 'model');
  const effortAfter = change.set.has('effort')
    ? String(change.set.get('effort'))
    : change.unset.has('effort') ? undefined : signedWord(input.rows, 'effort');
  const declared = resolveModelOverride(profile, `${seat.model} ${seat.version}`, seat.version);
  // A signed model equal to the declaration (by its launch id) is the model already in force; a
  // declaration this version cannot resolve cannot be proved unchanged, so a signed model counts.
  const modelChanges = modelAfter !== undefined && modelAfter !== declared?.id;
  const effort = effortAfter ?? seat.effort;
  const effortChanges = effort !== seat.effort;
  const heldRead = heldSwap(input.dir, seat.name);
  if (!heldRead.ok) return { kind: 'refuse', exit: 'write', why: heldRead.why };
  const held = heldRead.held;
  if (!modelChanges && !effortChanges) {
    return held !== undefined && held.reason === 'config' ? { kind: 'cancel' } : { kind: 'none' };
  }
  const resolved = modelAfter === undefined
    ? undefined
    : resolveModelOverride(profile, modelAfter, seat.version);
  if (modelAfter !== undefined && resolved === null) {
    return {
      kind: 'refuse',
      exit: 'source',
      why: `${seat.name}: the signed model ${JSON.stringify(modelAfter)} no longer resolves in this version's profile, so the restart target cannot be derived; unset model first`,
    };
  }
  const model = resolved ? resolved.model : seat.model;
  const version = resolved ? resolved.version : seat.version;
  const display = resolved ? defaultLabel(resolved.model, resolved.version) : seat.display;
  // The file's vendor is the lab the seat runs under; a model that moves lab moves it too.
  const vendor = labOfModel(model) ?? seat.vendor;
  const launch = withLaunchOverrides(profile, seat.launch, {
    ...(modelChanges && resolved ? { modelId: resolved.id } : {}),
    ...(effort !== undefined && supportsEffortLaunch(seat.cli) ? { effort } : {}),
  });
  // The account outlives only the lab it pays: a model that stays on the same lab keeps it, and
  // one that moves drops it rather than spend a budget the new model's lab does not pay.
  const account = modelChanges && seat.account !== vendor ? undefined : seat.account;
  const to: QueuedSwap['to'] = {
    cli: seat.cli,
    vendor,
    model,
    version,
    display,
    launch,
    ...(seat.modelFrom !== undefined ? { modelFrom: seat.modelFrom } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(account !== undefined ? { account } : {}),
  };
  const from = swapModelOf(seat);
  if (held === undefined) return { kind: 'queue', to };
  if (held.reason !== 'config') {
    return sameTarget(held.to, to)
      ? { kind: 'none' }
      : {
          kind: 'conflict',
          why: `the restart swap that would apply it was not queued because the queue holds a request queued by ${held.reason} for this seat (${held.from.vendor} ${held.from.model} -> ${held.to.vendor} ${held.to.model}); it was left in place`,
        };
  }
  const exact = held.from.cli === from.cli
    && held.from.vendor === from.vendor
    && held.from.model === from.model
    && held.from.version === from.version
    && held.from.display === from.display
    && sameTarget(held.to, to);
  return exact ? { kind: 'none' } : { kind: 'queue', to };
}

/**
 * Applies the queue action a written change asked for, atomically against the queue: a config
 * record may be queued, replaced or taken back, and a record another command queued (`owner` or
 * `model-rule`) is left in place. Runs only once the signed setting is in force — written by
 * this command, or by the interrupted attempt whose retry repairs the queue; a queue write that
 * fails here leaves that setting in force and is reported as a partial, never as a full success.
 * Nothing here launches or types.
 */
function applyConfigSwap(
  dir: string,
  seat: Seat,
  plan: Extract<ConfigSwapPlan, { kind: 'queue' | 'cancel' | 'conflict' }>,
  verb: 'set' | 'unset',
  waitSeconds: number,
  now: Date,
): { ok: true; action: 'cancel' | 'queue' } | { ok: false; why: string } {
  if (plan.kind === 'conflict') {
    logLine(dir, 'settings', 'owner', `seat ${seat.name}: ${plan.why}`, now);
    return { ok: false, why: plan.why };
  }
  try {
    if (plan.kind === 'cancel') {
      const removed = updateState(dir, (state) => {
        const held = state.swaps?.[seat.name];
        if (held === undefined || held.reason !== 'config') return null;
        delete state.swaps?.[seat.name];
        if (state.swaps && Object.keys(state.swaps).length === 0) delete state.swaps;
        return held;
      });
      if (removed !== null) {
        logLine(
          dir,
          'swap',
          'owner',
          `${seat.name}: the queued config swap was cancelled because the setting it applied was unset`,
          now,
        );
      }
      return { ok: true, action: 'cancel' };
    }
    const written = updateState(dir, (state) => {
      const held = state.swaps?.[seat.name];
      if (held !== undefined && held.reason !== 'config' && !sameTarget(held.to, plan.to)) {
        return { kind: 'held' as const, held };
      }
      const from = swapModelOf(seat);
      const record: QueuedSwap = {
        from,
        to: plan.to,
        reason: 'config',
        queuedAt: now.toISOString(),
        deadline: new Date(now.getTime() + waitSeconds * 1000).toISOString(),
        waitFor: WAIT_FOR,
        ...(needsHandover(from, plan.to) ? { handover: handoverPath(dir, seat.name, now) } : {}),
      };
      state.swaps = { ...(state.swaps ?? {}), [seat.name]: record };
      return { kind: 'written' as const, record };
    });
    if (written.kind === 'held') {
      const why = `the restart swap that would apply it was not queued because the queue holds a request queued by ${written.held.reason} for this seat (${written.held.from.vendor} ${written.held.from.model} -> ${written.held.to.vendor} ${written.held.to.model}); it was left in place`;
      logLine(dir, 'settings', 'owner', `seat ${seat.name}: ${why}`, now);
      return { ok: false, why };
    }
    logLine(
      dir,
      'swap',
      'owner',
      `${seat.name}: queued by settings ${verb}: ${written.record.from.vendor} ${written.record.from.model} -> ${written.record.to.vendor} ${written.record.to.model} (runs by ${written.record.deadline})`,
      now,
    );
    return { ok: true, action: 'queue' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const why = plan.kind === 'cancel'
      ? `the restart swap that applied it could not be cancelled (${detail}); the signed change stands`
      : `the restart swap that applies it could not be queued (${detail}); the signed change stands${verb === 'set' ? ' and retrying the same setting repairs the queue' : ''}`;
    logLine(dir, 'settings', 'owner', `seat ${seat.name}: ${why}`, now);
    return { ok: false, why };
  }
}

/** What a repeated unset found with its key already gone: nothing to repair, the queue brought
 *  back in line with the signed chain, a refusal before anything is written, or a queue write
 *  that failed after the earlier removal stood. */
type AbsentUnsetRepair =
  | { kind: 'nothing' }
  | { kind: 'repaired'; action: 'cancel' | 'queue' }
  | { kind: 'refused'; exit: 'source' | 'value' | 'write'; why: string }
  | { kind: 'partial'; why: string };

/**
 * An unset whose key is already gone still owns the restart record an interrupted predecessor
 * left. The queue is judged against the whole signed chain AFTER the removal, exactly as a
 * removal that signed here would judge it: a stale config record is taken back when nothing is
 * left to apply, and updated when a remaining signed word still asks for a change. A record
 * another command queued (`owner` or `model-rule`) is never replaced — a request that differs
 * from the target the signed chain still needs is reported as a conflict and left in place —
 * and a queue that already carries the exact target asks for nothing. Nothing here signs a
 * setting, launches or types.
 */
function repairAbsentUnset(
  home: string,
  current: Extract<Current, { ok: true }>,
  seat: Seat,
  keys: readonly string[],
  now: Date,
): AbsentUnsetRepair {
  const unset = new Set<ConfigKey>(keys.filter((key): key is ConfigKey => key === 'model' || key === 'effort'));
  if (unset.size === 0) return { kind: 'nothing' };
  const heldRead = heldSwap(current.dir, seat.name);
  if (!heldRead.ok) return { kind: 'refused', exit: 'write', why: heldRead.why };
  if (heldRead.held === undefined) return { kind: 'nothing' };
  const rows = readSeatRows(home, current.root, current.team, seat);
  if (!rows.ok) return { kind: 'refused', exit: 'source', why: rows.why };
  const plan = configSwapPlan({
    dir: current.dir,
    seat,
    rows: rows.rows,
    change: { set: new Map(), unset },
  });
  if (plan.kind === 'none') return { kind: 'nothing' };
  if (plan.kind === 'refuse') return { kind: 'refused', exit: plan.exit, why: plan.why };
  let wait = 0;
  if (plan.kind === 'queue') {
    const seconds = waitSecondsFor(home, current.root, current.team, seat, now);
    if ('why' in seconds) {
      return {
        kind: 'refused',
        exit: 'write',
        why: `${seat.name}: the restart swap the interrupted unset left cannot be updated because its wait cannot be resolved: ${seconds.why}`,
      };
    }
    wait = seconds.seconds;
  }
  const applied = applyConfigSwap(current.dir, seat, plan, 'unset', wait, now);
  if (!applied.ok) return { kind: 'partial', why: applied.why };
  return { kind: 'repaired', action: applied.action };
}

/**
 * The seats a nickname write collides with: the file's seats with each seat's effective signed
 * nickname standing where the file's word did, plus every roster seat the file no longer
 * declares, whose signed word a send still addresses. A record that exists and does not verify
 * refuses the check: the effective set is unknown, and a word checked against the declaration
 * alone could hand two seats one address.
 */
function addressedRoster(
  home: string,
  root: string,
  team: TeamFile,
): { seats: ReadonlyArray<{ name: string; nickname?: string; line: number }> } | { error: string } {
  const seats: Array<{ name: string; nickname?: string; line: number }> = [];
  for (const seat of team.seats) {
    const read = resolveSeatOverrides({ home, root, seat: seat.name });
    if (!read.ok) return { error: read.why };
    seats.push(read.overrides.nickname === undefined ? seat : { ...seat, nickname: read.overrides.nickname });
  }
  const record = getTeam(home, teamIdOf(root));
  for (const entry of record?.roster ?? []) {
    if (team.seats.some((seat) => seat.name === entry.seat)) continue;
    const read = resolveSeatOverrides({ home, root, seat: entry.seat });
    if (!read.ok) return { error: read.why };
    const nickname = read.overrides.nickname ?? entry.nickname;
    if (nickname !== undefined) seats.push({ name: entry.seat, nickname, line: 0 });
  }
  return { seats };
}

function pairsWord(settings: readonly PlannedConfigSetting[]): string {
  return settings.map((setting) => `${setting.key}=${sayConfigValue(setting.value)}`).join(', ');
}

/**
 * `set` and `unset` in one body: both walk the same gate (owner, file, team, seat) and differ only
 * in what they plan and record. Neither needs an agent record to start: a declared seat plans
 * against its declaration, and only a real set that passed every check registers it. Every exit
 * is a literal of its own so the exit-code contract can check each id against its row.
 */
function executeWrite(
  verb: 'set' | 'unset',
  words: readonly string[],
  flags: ReadonlySet<string>,
  file: string | undefined,
  io: Io,
  json: boolean,
  options: SettingsCommandOptions,
): number {
  const parsed = verb === 'set' ? parseSetWords(words) : parseUnsetWords(words);
  if (!parsed.ok) return invocation(io, json, parsed.why);

  const walked = walkCaller(io);
  if (!isOwner(walked)) {
    const message = `only the owner sets a seat's settings, from a terminal outside herdr; this call is ${describeCaller(walked)}`;
    if (json) {
      writeJsonError(io, 'settings.not-owner', message, 'the owner runs `team settings set` from a terminal outside herdr', 1, 'owner-only');
    } else {
      io.stderr(`team settings: ${message}\n`);
    }
    // exit: settings.not-owner
    return 1;
  }
  if (file !== undefined) {
    const refusal = fileOwnerRefusal(io, file);
    if (refusal !== undefined) return fileOwnerExit(io, json, refusal);
  }

  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  const current = currentTeam(io.cwd, file, now, home, true);
  if (!current.ok) return refuseFile(io, json, current);
  const { team } = current;
  const seat = team.seats.find((one) => one.name === parsed.seat);
  if (seat === undefined) return noSeatExit(io, json, parsed.seat, team.project);
  const found = agentIdOf(home, current.root, seat.name);
  // A declared seat that has never launched has no agent record. Nothing is registered here: a
  // dry run, a refused write and an unset with nothing to remove all create nothing. The first
  // successful real set registers the record below, seeded from the declaration, and signs the
  // setting there. A launch would create the same record; nothing here starts a pane or types.
  let agentId = found.agentId;
  const declaration = { root: current.root, team, seat };
  const dryRun = flags.has('dry-run');

  if (verb === 'set') {
    const pairs = (parsed as { pairs: { key: string; value: string }[] }).pairs;
    // A seat that never launched plans against its declaration: the name stands in for the record
    // the plan is meant to precede, and the plan reads no settings under it.
    const plan = planConfigSet(home, { level: 'seat', target: agentId ?? seat.name, settings: pairs, declaration });
    if (!plan.ok) return planExit(io, json, plan.kind, plan.why);
    const chain = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity ?? found.entity,
        projectId: found.projectId,
        teamRoot: current.root,
        team,
        agentId,
        seat,
      },
      { now },
    );
    // A policy whose expiry has passed at this command's own clock does not govern the write,
    // and the log says so once instead of leaving the reader to guess why it stopped applying.
    logExpiredPoliciesOnce(join(current.root, '.agents'), chain.expired, now);
    const roster = addressedRoster(home, current.root, team);
    if ('error' in roster) return planExit(io, json, 'source', roster.error);
    const checked: PlannedConfigSetting[] = [];
    for (const setting of plan.settings) {
      const check = checkSeatSetting(setting.key, setting.value, seat, roster.seats, chain);
      if (!check.ok) {
        if (check.refusal.id === 'settings.policy') return policyExit(io, json, check.refusal.why);
        return planExit(io, json, 'value', check.refusal.why);
      }
      checked.push({ ...setting, value: check.value });
    }
    const settings = orderedSettings(checked);
    const summary = `settings: ${dryRun ? 'would set' : 'set'} ${pairsWord(settings)} at seat (${seat.name})`;

    if (dryRun) {
      if (json) {
        writeJson(io, 'team.settings-change', {
          format: 1 as const,
          dry_run: true,
          status: 'dry-run',
          action_summary: summary,
          project: team.project,
          session: team.session,
          level: 'seat' as const,
          target: agentId ?? seat.name,
          seat: seat.name,
          settings: settings.map((setting) => ({
            key: setting.key,
            value: setting.value,
            old: setting.previous?.value ?? null,
            applies: appliesOf(setting.key),
          })),
          plan: settings.map((setting) => ({
            step: 'setting',
            detail: `${setting.key}=${sayConfigValue(setting.value)}`,
            seat: seat.name,
            prefix: '+' as const,
          })),
        });
      } else {
        io.stdout(`${summary}\n`);
      }
      return dryRunExit();
    }

    // A model or effort setting applies by restart, so a real change must be queueable before the
    // record is signed: the swap is queued at the seat's boundary and the settings command never
    // launches or types. The target is derived from the whole signed chain AFTER this change — a
    // key this write does not name keeps the signed word it already holds — so an unset takes
    // back only its own key. A target already in force, or already queued with exactly that
    // target, asks for nothing; a wait that cannot be resolved refuses the write before anything
    // is recorded.
    let swapPlan: ConfigSwapPlan = { kind: 'none' };
    let swapWait = 0;
    if (settings.some((setting) => setting.key === 'model' || setting.key === 'effort')) {
      const rows = readSeatRows(home, current.root, team, seat);
      if (!rows.ok) return sourceExit(io, json, rows.why);
      const change: ConfigSwapChange = {
        set: new Map(settings.map((setting) => [setting.key, setting.value])),
        unset: new Set(),
      };
      swapPlan = configSwapPlan({ dir: current.dir, seat, rows: rows.rows, change });
      if (swapPlan.kind === 'refuse') return planExit(io, json, swapPlan.exit, swapPlan.why);
      if (swapPlan.kind === 'queue') {
        const wait = waitSecondsFor(home, current.root, team, seat, now);
        if ('why' in wait) {
          return policyExit(io, json, `${seat.name}: the swap that applies this change cannot be given its wait: ${wait.why}`);
        }
        swapWait = wait.seconds;
      }
    }

    // Only a real write that passed every check reaches this point. The record a declared seat
    // never had is created here, before the generation is bumped and before any setting is signed:
    // a dry run, a refused key or value, a policy refusal and a collision all leave the registry
    // as they found it. If the create fails, nothing is written and the refusal says so.
    if (agentId === null) {
      const boot = seatRecordForWrite(home, seat.name, declaration);
      if (!boot.ok) {
        const message = `seat "${seat.name}" has no registered agent record to hold its settings and none could be created: ${boot.why}; run \`team up\` first`;
        if (json) {
          writeJsonError(io, 'settings.no-agent', message, 'run `team up` to register the seat');
        } else {
          io.stderr(`team settings: ${message}\n`);
        }
        // exit: settings.no-agent
        return 1;
      }
      agentId = boot.agentId;
    }
    const written = writeConfigSet(home, { ...plan, target: agentId, settings: checked }, { now });
    if (!written.ok) return planExit(io, json, written.kind, written.why);
    const changesNotice = recordChanges(current, home, seat.name, agentId, settings, written.written);
    logLine(
      join(current.root, '.agents'),
      'settings',
      'owner',
      `seat ${seat.name} (${agentId}) ${settings.map((setting) => `${setting.key}: ${sayConfigValue(setting.previous?.value ?? null)} -> ${sayConfigValue(setting.value)}`).join('; ')}`,
      now,
    );
    const applied = swapPlan.kind === 'queue' || swapPlan.kind === 'cancel' || swapPlan.kind === 'conflict'
      ? applyConfigSwap(current.dir, seat, swapPlan, 'set', swapWait, now)
      : { ok: true as const };
    if (!applied.ok) {
      // The setting is signed; only the restart record is missing. A full success would claim a
      // restart the queue never holds, so the partial is reported as a failure of its own.
      const why = `the setting was written; ${applied.why}${changesNotice !== null ? `; ${changesNotice}` : ''}`;
      if (!json) io.stdout(`${summary}\n`);
      return planExit(io, json, 'write', why);
    }
    const notice = changesNotice;
    if (json) {
      writeJson(io, 'team.settings-change', {
        format: 1 as const,
        dry_run: false,
        status: 'updated',
        action_summary: summary,
        project: team.project,
        session: team.session,
        level: 'seat' as const,
        target: agentId,
        seat: seat.name,
        settings: settings.map((setting) => ({
          key: setting.key,
          value: setting.value,
          old: setting.previous?.value ?? null,
          applies: appliesOf(setting.key),
        })),
        ...(notice !== null ? { notice } : {}),
      });
    } else {
      io.stdout(`${summary}\n`);
      if (notice !== null) io.stderr(`team settings: ${notice}\n`);
    }
    return setExit();
  }

  const keys = (parsed as { keys: string[] }).keys;
  // An unset removes what a record holds, so a seat with no record has nothing to remove: the
  // plan reads the name as no settings and reports the key not set. Nothing is registered.
  const targetId = agentId ?? seat.name;
  const request = { level: 'seat' as const, target: targetId, keys };
  const plan = planConfigUnset(home, request);
  if (!plan.ok) {
    // A key an interrupted unset already took away is still this command's to finish: the
    // restart record its failed cancel or update left is judged against the whole signed chain
    // after that removal, exactly as the first attempt judged it. A dry run writes nothing and
    // still reports the key as not set.
    if (plan.kind === 'value' && !dryRun) {
      const repair = repairAbsentUnset(home, current, seat, keys, now);
      if (repair.kind === 'refused') return planExit(io, json, repair.exit, repair.why);
      if (repair.kind === 'partial') {
        return planExit(io, json, 'write', `the setting is already unset; ${repair.why}`);
      }
      if (repair.kind === 'repaired') {
        const word = repair.action === 'cancel'
          ? 'the stale restart swap it left was taken back'
          : 'the queued restart swap now applies the change that remains signed';
        const summary = `settings: ${keys.join(', ')} already unset at seat (${seat.name}); ${word}`;
        if (json) {
          writeJson(io, 'team.settings-change', {
            format: 1 as const,
            dry_run: false,
            status: 'unset',
            action_summary: summary,
            project: team.project,
            session: team.session,
            level: 'seat' as const,
            target: targetId,
            seat: seat.name,
            settings: [],
            notice: `${keys.join(', ')} was already unset; ${word}`,
          });
        } else {
          io.stdout(`${summary}\n`);
        }
        return unsetExit();
      }
    }
    if (plan.kind === 'value') return notSetExit(io, json, plan.why);
    return planExit(io, json, plan.kind, plan.why);
  }
  const removed = orderedSettings(plan.removed);
  const summary = `settings: ${dryRun ? 'would unset' : 'unset'} ${removed.map((setting) => setting.key).join(', ')} at seat (${seat.name})`;

  if (dryRun) {
    if (json) {
      writeJson(io, 'team.settings-change', {
        format: 1 as const,
        dry_run: true,
        status: 'dry-run',
        action_summary: summary,
        project: team.project,
        session: team.session,
        level: 'seat' as const,
        target: targetId,
        seat: seat.name,
        settings: removed.map((setting) => ({
          key: setting.key,
          value: null,
          old: setting.previous?.value ?? setting.value,
          applies: appliesOf(setting.key),
        })),
        plan: removed.map((setting) => ({
          step: 'setting',
          detail: setting.key,
          seat: seat.name,
          prefix: '+' as const,
        })),
      });
    } else {
      io.stdout(`${summary}\n`);
    }
    return dryRunExit();
  }

  // A removal of a model or effort value is judged the same way as a set: the target is derived
  // from the whole signed chain AFTER the removal, so a remaining signed key keeps its intent
  // instead of the record being taken back wholesale. A queue that must be updated is resolved
  // before the record is removed, so a wait that cannot be given refuses the write; a cancel
  // needs none.
  let swapPlan: ConfigSwapPlan = { kind: 'none' };
  let swapWait = 0;
  if (removed.some((setting) => setting.key === 'model' || setting.key === 'effort')) {
    const rows = readSeatRows(home, current.root, team, seat);
    if (!rows.ok) return sourceExit(io, json, rows.why);
    const change: ConfigSwapChange = {
      set: new Map(),
      unset: new Set(removed.map((setting) => setting.key)),
    };
    swapPlan = configSwapPlan({ dir: current.dir, seat, rows: rows.rows, change });
    if (swapPlan.kind === 'refuse') return planExit(io, json, swapPlan.exit, swapPlan.why);
    if (swapPlan.kind === 'queue') {
      const wait = waitSecondsFor(home, current.root, team, seat, now);
      if ('why' in wait) {
        return policyExit(io, json, `${seat.name}: the swap that applies this change cannot be given its wait: ${wait.why}`);
      }
      swapWait = wait.seconds;
    }
  }
  const written = writeConfigUnset(home, request);
  if (!written.ok) {
    if (written.kind === 'value') return notSetExit(io, json, written.why);
    return planExit(io, json, written.kind, written.why);
  }
  // A removal reports the record it removed from: the seat's agent id when it has one, and the
  // seat's name when the plan found nothing to remove under a declared name.
  const changesNotice = recordRemovals(current, home, seat.name, targetId, removed, now);
  logLine(
    join(current.root, '.agents'),
    'settings',
    'owner',
    `seat ${seat.name} (${targetId}) ${removed.map((setting) => `${setting.key}: ${sayConfigValue(setting.previous?.value ?? setting.value)} -> unset`).join('; ')}`,
    now,
  );
  // A withdrawn model or effort value takes back a queued config record only when nothing is
  // left to apply; a remaining signed key updates it instead, and a record another command
  // queued stands. A queue write that fails here leaves the removal signed and is a partial.
  const applied = swapPlan.kind === 'queue' || swapPlan.kind === 'cancel' || swapPlan.kind === 'conflict'
    ? applyConfigSwap(current.dir, seat, swapPlan, 'unset', swapWait, now)
    : { ok: true as const };
  if (!applied.ok) {
    const why = `the setting was unset; ${applied.why}${changesNotice !== null ? `; ${changesNotice}` : ''}`;
    if (!json) io.stdout(`${summary}\n`);
    return planExit(io, json, 'write', why);
  }
  const notice = changesNotice;
  if (json) {
    writeJson(io, 'team.settings-change', {
      format: 1 as const,
      dry_run: false,
      status: 'unset',
      action_summary: summary,
      project: team.project,
      session: team.session,
      level: 'seat' as const,
      target: targetId,
      seat: seat.name,
      settings: removed.map((setting) => ({
        key: setting.key,
        value: null,
        old: setting.previous?.value ?? setting.value,
        applies: appliesOf(setting.key),
      })),
      ...(notice !== null ? { notice } : {}),
    });
  } else {
    io.stdout(`${summary}\n`);
    if (notice !== null) io.stderr(`team settings: ${notice}\n`);
  }
  return unsetExit();
}

/** Appends one config.changed per signed record; returns the notice for a failure, or null. A
 *  failed append leaves the written record in place — the reconcile pass adds the missing event. */
function recordChanges(
  current: Extract<Current, { ok: true }>,
  home: string,
  seatName: string,
  agentId: string,
  settings: readonly PlannedConfigSetting[],
  written: readonly SignedConfigRecord[],
): string | null {
  const failures: string[] = [];
  for (const record of written) {
    const previous = settings.find((setting) => setting.key === record.key)?.previous ?? null;
    const appended = appendConfigChanged(current.team.project, current.root, home, {
      ts: record.date,
      session: current.team.session,
      level: 'seat',
      target: agentId,
      key: record.key,
      old: previous?.value ?? null,
      value: record.value,
      generation: record.generation,
      from: 'owner',
      seat: seatName,
      subject: seatName,
    });
    if (!appended.ok) failures.push(`${record.key}: ${appended.reason}`);
  }
  if (failures.length === 0) return null;
  return `the change was written; its config.changed event could not be appended (${failures.join('; ')}); the reconcile pass adds it`;
}

function recordRemovals(
  current: Extract<Current, { ok: true }>,
  home: string,
  seatName: string,
  agentId: string,
  removed: readonly PlannedConfigSetting[],
  now: Date,
): string | null {
  const failures: string[] = [];
  for (const setting of removed) {
    const appended = appendConfigChanged(current.team.project, current.root, home, {
      // An unset leaves no signed record behind, so the clock is the command's own: the date the
      // removed record carried says when the value was set, not when it was taken away.
      ts: now.toISOString(),
      session: current.team.session,
      level: 'seat',
      target: agentId,
      key: setting.key,
      old: setting.previous?.value ?? setting.value,
      value: null,
      generation: setting.previous?.generation ?? 0,
      from: 'owner',
      seat: seatName,
      subject: seatName,
    });
    if (!appended.ok) failures.push(`${setting.key}: ${appended.reason}`);
  }
  if (failures.length === 0) return null;
  return `the change was written; its config.changed event could not be appended (${failures.join('; ')}); the reconcile pass adds it`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team settings: ${problem.line ? `team config line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
