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
import { agentIdOf, readSeatSettings } from '../config/read.ts';
import { CONFIG_KEYS, getConfigSpec } from '../config/registry.ts';
import type { ApplyKind, ConfigKey } from '../config/registry.ts';
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
import { cleanedIo, type Command, type Io } from '../io.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import { loadAndResolvePolicyChain, logExpiredPoliciesOnce } from '../policy/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';

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
    const msg = current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${p.message}`).join('; ');
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
    const notice = recordChanges(current, home, seat.name, agentId, settings, written.written);
    logLine(
      join(current.root, '.agents'),
      'settings',
      'owner',
      `seat ${seat.name} (${agentId}) ${settings.map((setting) => `${setting.key}: ${sayConfigValue(setting.previous?.value ?? null)} -> ${sayConfigValue(setting.value)}`).join('; ')}`,
      now,
    );
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

  const written = writeConfigUnset(home, request);
  if (!written.ok) {
    if (written.kind === 'value') return notSetExit(io, json, written.why);
    return planExit(io, json, written.kind, written.why);
  }
  // A removal reports the record it removed from: the seat's agent id when it has one, and the
  // seat's name when the plan found nothing to remove under a declared name.
  const notice = recordRemovals(current, home, seat.name, targetId, removed, now);
  logLine(
    join(current.root, '.agents'),
    'settings',
    'owner',
    `seat ${seat.name} (${targetId}) ${removed.map((setting) => `${setting.key}: ${sayConfigValue(setting.previous?.value ?? setting.value)} -> unset`).join('; ')}`,
    now,
  );
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
    io.stderr(`team settings: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
