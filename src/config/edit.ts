// `team config get|set|unset|edit`: the one editor of a team's record. The record is read and
// written through the writers' seam (src/file/team-text.ts): the registry's record under the
// registry source, the team file only on the legacy `file` source. Every write is validated by
// the team-file validator first and refused whole when it does not validate; the edit is the
// owner's, as editing the file by hand was.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { ownerSeatStep } from '../client/owner-action-step.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { readTeamConfig } from '../file/team-config.ts';
import {
  callerOf,
  describeCaller,
  detachedRefusal,
  isOwner,
  judgeCallerIn,
  standingOf,
  type Caller,
  type SeatStanding,
} from '../caller.ts';
import { charterGate } from '../charter/check.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import { gateVerdict } from '../permissions/who.ts';
import { findRoot, TEAM_FILE } from '../file/load.ts';
import { labelPersona, nicknameProblem, SEAT_NAME } from '../file/sections/seats.ts';
import { readTeamText, teamTextTarget, writeTeamText } from '../file/team-text.ts';
import { validateTeamFile } from '../file/validate.ts';
import { cleanedIo, type Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { nicknameChangeGate } from '../registry/names.ts';
import { readStoredTeamConfig } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';
import { refreshRoster } from '../registry/sync.ts';
import { findAgent, updateAgent } from '../registry/agents.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';
import { editedRecordText, getAt, parsePath, parseValue, reservedKeyIn, shownValue, withValue, type RecordPath } from './team-record.ts';
import type { ConfigSources } from '../commands/config.ts';

function realRoot(cwd: string): string {
  return findRoot(cwd) ?? resolve(cwd);
}

/** One line saying why a record's reader refused the text: the parser's own reason, with the
 *  line it names. */
function unreadableReason(error: unknown): string {
  if (error instanceof YamlError) return `line ${error.line}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** A record that cannot be read is refused through the documented end, with its reader's own
 *  one-line reason — never a stack trace. Nothing is written by the path that calls this. */
function unreadable(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'config', { id: 'config.no-record', message, repair: null });
  // exit: config.no-record
  return 2;
}

/** The invocation, or its path, is not one this command can carry out: one refusal, with the
 *  command's usage, before any write. Exit 2, always. */
function usageRefused(io: Io, json: boolean, message: string, usage: string): number {
  refuse(io, json, 'config', { id: 'config.usage', message, repair: null, usage });
  return 2; // exit: config.usage
}

function runEditor(path: string, env: Record<string, string | undefined>): number {
  const editor = env.VISUAL || env.EDITOR || 'vi';
  const ran = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', path], { stdio: 'inherit' });
  return ran.status ?? 1;
}

export async function runTeamRecordEdit(argv: string[], rawIo: Io, sources: ConfigSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['approval', 'general', 'key', 'reason'], ['json', 'request']);
  const [verb, rawPath, rawValue, extra] = args.rest;
  const usage = (await import('../commands/config.ts')).USAGE;
  const wants = verb === 'edit' ? 0 : verb === 'set' ? 2 : 1;
  const given = args.rest.length - 1;
  let why: string | null = args.error ?? null;
  if (why === null && given !== wants) {
    why = given > wants ? `unexpected "${args.rest[wants + 1] ?? extra}"` : verb === 'set' && given === 1 ? 'a value is required: team config set <path> <value>' : 'a path is required';
  }
  if (why === null && (args.flags.has('request') || args.values.approval !== undefined) && verb !== 'set' && verb !== 'unset') {
    why = '--request and --approval take set or unset';
  }
  if (why === null && (args.values.general !== undefined) !== (args.values.key !== undefined)) why = '--general and --key go together';
  if (why === null && args.values.general !== undefined && verb !== 'set' && verb !== 'unset') why = '--general takes set or unset';
  const path = why === null && rawPath !== undefined ? parsePath(rawPath) : [];
  if (why === null && typeof path === 'string') why = path;
  if (why !== null || typeof path === 'string') return usageRefused(io, json, why ?? 'invalid path', usage);
  const home = sources.home ?? homedir();
  const env = sources.env ?? process.env;
  const root = realRoot(io.cwd);
  const file = join(root, TEAM_FILE);
  let target: ReturnType<typeof teamTextTarget>;
  try {
    target = teamTextTarget(file, { home, env });
  } catch (error) {
    refuse(io, json, 'config', { id: 'config.unreadable', message: `the registry's record of this team cannot be read: ${error instanceof Error ? error.message : String(error)}`, repair: 'team import' });
    // exit: config.unreadable
    return 2;
  }
  if (target.kind === 'file' && !existsSync(file)) {
    const held = readStoredTeamConfig(home, teamIdOf(root)) !== null;
    refuse(io, json, 'config', {
      id: 'config.no-team',
      message: held
        ? `this team is in the registry, but team-config.source is file: set it back to registry to edit the record`
        : `no team is registered for ${root}: run \`team init\``,
      repair: null,
    });
    // exit: config.no-team
    return 2;
  }
  let text: string;
  try {
    text = readTeamText(file, { home, env });
  } catch (error) {
    return unreadable(io, json, error instanceof Error ? error.message : String(error));
  }
  const where = target.kind === 'registry' ? "the registry's record" : TEAM_FILE;
  // A reserved name is refused only where the path addresses it as a key the record does not
  // own: a list selects an item by name or index, and a dynamic map may own an account or rule
  // named `constructor`, so both are ordinary paths. The record is parsed here, before the owner
  // door, so a refused path spends no prompt. A record that does not parse is reported by the
  // verb's own reader, as before.
  let parsed: YamlValue | null = null;
  let parseError: unknown = null;
  try {
    parsed = toValue(parseYaml(text));
  } catch (error) {
    parseError = error;
  }
  const reserved = parsed === null ? null : reservedKeyIn(parsed, path);
  if (reserved !== null) {
    return usageRefused(io, json, `${rawPath}: "${reserved}" cannot be addressed: every object inherits that name, and the record does not hold it as its own key`, usage);
  }
  if (verb === 'get') {
    if (parsed === null) return unreadable(io, json, `${where} cannot be read: ${unreadableReason(parseError)}`);
    const got = getAt(parsed, path);
    if (!got.found) {
      refuse(io, json, 'config', { id: 'config.no-value', message: `${rawPath} is not set in ${where}`, repair: null });
      // exit: config.no-value
      return 1;
    }
    if (json) writeJson(io, 'team.config-value', { format: 1, path: rawPath, value: got.value as never, source: target.kind });
    else io.stdout(shownValue(got.value));
    // exit: config.value
    return 0;
  }
  // A write. A verified charter that covers this folder admits it with no prompt. Outside that
  // charter the run is refused, and the owner re-signs only with `team setup --edit`. With no
  // charter, the write stays the owner's, from a terminal, as the file was.
  // The owner-seat door for a set or unset: `--request` records exactly this change and sends it
  // to the owner seat (Touch ID); `--approval <id>` applies it once the owner's verified signature
  // binds these words. Nothing is written on a request, and an approval for other words refuses.
  let seatApproved = false;
  if (args.flags.has('request') || args.values.approval !== undefined) {
    const step = ownerSeatStep('config', 'team-config', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json, reason: args.values.reason }, io, { home, root, ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}), ...(sources.present !== undefined ? { present: sources.present } : {}) });
    if (step.kind === 'requested') {
      // exit: config.approval-requested
      return 0;
    }
    if (step.kind === 'refused') {
      // exit: config.approval-refused
      return 1;
    }
    seatApproved = step.kind === 'admitted';
  }
  // A general grant: the owner signed it once for this principal across these entities, so a set
  // or unset under it applies directly, with no per-action request.
  if (args.values.general !== undefined && !seatApproved) {
    let entity: string | null = null;
    try {
      const loaded = readTeamConfig(root, { home });
      if (loaded.ok) entity = loaded.team.entity;
    } catch {}
    const admitted = admitGeneral(home, resolve(io.cwd, args.values.general), resolve(io.cwd, args.values.key as string), 'config', entity, sources.now?.() ?? new Date());
    if (!admitted.ok) {
      refuse(io, json, 'config', { id: 'config.general-refused', message: admitted.why, repair: null });
      // exit: config.general-refused
      return 1;
    }
    if (!json) io.stderr(`team config: admitted by general grant ${admitted.grant.grant_id} (${admitted.grant.client_id})\n`);
    seatApproved = true;
  }
  const gate = charterGate(home, { operation: 'config', cwd: io.cwd }, sources.ownerSeatStore);
  if (gate.kind === 'block' && !seatApproved) {
    refuse(io, json, 'config', { id: 'config.charter', message: gate.message, repair: 'team setup --edit' });
    // exit: config.charter
    return 1;
  }
  let liftAudit: (() => void) | null = null;
  if (gate.kind !== 'admit' && !seatApproved) {
    const caller = callerOf(rawIo);
    const detached = detachedRefusal(caller);
    if (detached !== undefined) {
      refuse(io, json, 'config', { id: 'config.detached', message: detached, repair: null });
      // exit: config.detached
      return 1;
    }
    // A stopped seat's sign-off is its own team's to lift: the lead clears exactly
    // `seats.<seat>.stopped`, with no card, dev mode on or off — the same admission
    // `team restart` makes when it revives that seat. Every other key, verb and seat keeps the
    // owner door. This allowance is the team's own power, not dev mode's: it takes no warning
    // and leaves no audit line, and it reaches no further than the one key it names.
    if (!isOwner(caller) && !liftsStopped(caller, verb, path, rawIo, root, home, sources)) {
      const message = `only the owner edits the team's record, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
      // Dev mode's owner admission for exactly this gate, read through the one resolver the
      // sibling owner-only writers use: a placed orchestrator continues with the warning and
      // the audit line; the owner's own path above is untouched, and every other caller keeps
      // this refusal byte for byte. The audit waits for the write below: this gate answers
      // before the change is validated, and a refused or unchanged run writes no record line.
      const lift = devModeOwnerLiftAtCwd(rawIo, {
        command: 'config',
        refusal: message,
        home,
        audit: 'later',
        ...(sources.now !== undefined ? { now: sources.now() } : {}),
      });
      if (lift === null || !lift.lifted) {
        refuse(io, json, 'config', { id: 'config.not-owner', message, repair: null, rule: 'owner-only' });
        // exit: config.not-owner
        return 1;
      }
      liftAudit = lift.audit;
      io.stderr(`${lift.warning}\n`);
    }
  }
  let next: string;
  let kept: string | null = null;
  // Whether the change was made line by line, keeping the record's comments. An `edit` keeps
  // whatever the editor wrote, so it is not measured here.
  let commentsKept = true;
  // The other name a seat's label or nickname set wrote in the same edit, for the report line.
  let pairedNames: Array<{ seat: string; field: 'label' | 'nickname'; value: string }> = [];
  if (verb === 'edit') {
    const dir = mkdtempSync(join(tmpdir(), 'team-config-'));
    const draft = join(dir, 'team.yaml');
    writeFileSync(draft, text, { mode: 0o600 });
    const status = (sources.editor ?? ((p: string) => runEditor(p, env)))(draft);
    if (status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      refuse(io, json, 'config', { id: 'config.editor', message: `the editor exited ${status}; nothing was written`, repair: null });
      // exit: config.editor
      return 2;
    }
    next = readFileSync(draft, 'utf8');
    kept = draft;
    if (next === text) rmSync(dir, { recursive: true, force: true });
  } else {
    let record: YamlValue;
    try {
      record = toValue(parseYaml(text));
    } catch (error) {
      return unreadable(io, json, `${where} cannot be read: ${unreadableReason(error)}`);
    }
    const value: YamlValue | undefined = verb === 'set' ? parseValue(rawValue as string) : undefined;
    const changed = withValue(record, path, value);
    if (!changed.ok) {
      refuse(io, json, 'config', { id: 'config.path', message: `${rawPath}: ${changed.why}; nothing was written`, repair: null });
      // exit: config.path
      return 1;
    }
    if (!changed.changed) {
      next = text;
    } else {
      const edited = editedRecordText(text, path, value, changed.root);
      next = edited.text;
      commentsKept = edited.kept;
      // A set on one of a seat's two names writes the other in the same edit, so the label's
      // persona and the record's nickname cannot be left apart by a config write.
      const paired = syncSeatNames(next, path, changed.root);
      next = paired.text;
      commentsKept = commentsKept && paired.kept;
      pairedNames = paired.changed;
    }
  }
  if (next === text) {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: false, source: target.kind, comments_kept: true });
    else io.stdout(`nothing changed in ${where}\n`);
    // exit: config.unchanged
    return 0;
  }
  // A nickname this write newly sets is held to the entity's `names.unique` word, before the
  // record is touched: the same check for an owner's set, an edit and a general grant. A file
  // that does not validate is left to the writer below, whose refusal names its own problems.
  const namesAfter = validateTeamFile(next);
  if (namesAfter.ok) {
    const namesBefore = validateTeamFile(text);
    const names = nicknameChangeGate({
      home,
      teamId: teamIdOf(root),
      root,
      before: namesBefore.ok ? namesBefore.team : null,
      after: namesAfter.team,
    });
    if (!names.ok) {
      refuse(io, json, 'config', { id: 'config.name-taken', message: names.message, repair: null });
      // exit: config.name-taken
      return 1;
    }
  }
  const now = sources.now;
  const wrote = writeTeamText(file, next, { home, env, command: `config ${verb}`, ...(now !== undefined ? { now } : {}) });
  if (!wrote.ok) {
    const said = wrote.errors.map((p) => (p.line ? `line ${p.line}: ` : '') + p.message).join('; ');
    refuse(io, json, 'config', {
      id: 'config.invalid',
      message: `the change does not validate, and nothing was written: ${said}${kept !== null ? `; your edit is kept at ${kept}` : ''}`,
      repair: null,
    });
    // exit: config.invalid
    return 1;
  }
  // The record is on disk: only now does the lead's admission leave its audit line. Every
  // refusal above returned with the folder as it was.
  if (liftAudit !== null) liftAudit();
  if (kept !== null) rmSync(resolve(kept, '..'), { recursive: true, force: true });
  const checked = validateTeamFile(next);
  // A seat whose launch line this edit changed: its agent record's launch recipe follows, so the
  // next up or restart runs the line the team now declares, not the one the record kept.
  const synced = checked.ok ? syncAgentLaunches(home, teamIdOf(root), text, checked.team.seats) : [];
  if (!json) for (const name of synced) io.stdout(`agent record of ${name}: launch line updated to match\n`);
  if (!json) for (const change of pairedNames) io.stdout(`seats.${change.seat}.${change.field} updated with it: ${change.value}\n`);
  // The roster line the next message header reads is re-marked from the record just written, so a
  // renamed seat sends under its new name at once, with no relaunch (src/registry/sync.ts).
  const renamed = checked.ok ? refreshRoster(home, root, checked.team) : [];
  if (!json) {
    for (const seat of renamed) {
      const found = checked.ok ? checked.team.seats.find((item) => item.name === seat) : undefined;
      const name = found === undefined ? seat : labelPersona(found) ?? found.nickname ?? found.name;
      io.stdout(`roster line of ${seat}: nickname now ${name}\n`);
    }
  }
  if (!commentsKept) io.stderr(`team config: the record was rewritten whole to change ${rawPath}; its comments were not kept\n`);
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: true, source: wrote.target, comments_kept: commentsKept });
  } else {
    io.stdout(`${verb === 'edit' ? 'edited' : verb === 'set' ? `set ${rawPath}` : `unset ${rawPath}`} in ${where}; validated\n`);
  }
  // exit: config.written
  return 0;
}

/** The seats whose `launch` differs between the old record text and the new seats, with an agent
 *  record still holding the old line: that record is updated to the new line. Names updated. */
export function syncAgentLaunches(home: string, teamId: string, oldText: string, seats: ReadonlyArray<{ name: string; launch: string }>): string[] {
  const before = new Map<string, string>();
  try {
    const old = validateTeamFile(oldText);
    if (old.ok) for (const seat of old.team.seats) before.set(seat.name, seat.launch);
  } catch {}
  const updated: string[] = [];
  for (const seat of seats) {
    const was = before.get(seat.name);
    if (was === undefined || was === seat.launch) continue;
    try {
      const agent = findAgent(home, { team: teamId, seat: seat.name });
      if (agent === null || agent.launch === seat.launch) continue;
      updateAgent(home, agent.id, { launch: seat.launch });
      updated.push(seat.name);
    } catch {}
  }
  return updated;
}

/** A config path that writes one of a seat's two names: `seats.<name or index>.label`, or
 *  `seats.<name or index>.nickname`. */
function nameFieldOf(path: RecordPath): { seat: string; field: 'label' | 'nickname' } | null {
  if (path.length !== 3 || path[0] !== 'seats') return null;
  const field = path[2];
  if (field !== 'label' && field !== 'nickname') return null;
  return { seat: path[1] as string, field };
}

/**
 * The record's other name written in the same edit: a set on a seat's label writes the nickname
 * its persona names, and a set on its nickname rewrites the persona part of a written label. So
 * the two cannot be left apart by a config write (the driver's finding: a renamed seat kept
 * sending under its old name), and the roster line the next message header reads is re-marked
 * from the same record (src/registry/sync.ts). A name the field cannot hold — a space or an
 * accent (the nickname alphabet), the reserved `lead`, another seat's name or nickname — leaves
 * the nickname field as it is: the label is still the workspace title, the field is still the
 * address, and `team check` names the drift (src/check/team.ts:nicknameDriftNotes). Writing a
 * label never refuses on the word before its dot; nothing is slugged or rewritten.
 * Returns the text to write, whether its comments were kept, and what moved.
 */
function syncSeatNames(
  text: string,
  path: RecordPath,
  root: YamlValue,
): { text: string; kept: boolean; changed: Array<{ seat: string; field: 'label' | 'nickname'; value: string }> } {
  const none = { text, kept: true, changed: [] as Array<{ seat: string; field: 'label' | 'nickname'; value: string }> };
  const named = nameFieldOf(path);
  if (named === null) return none;
  const found = getAt(root, ['seats', named.seat]);
  if (!found.found || found.value === null || typeof found.value !== 'object' || Array.isArray(found.value)) return none;
  const seat = found.value as Record<string, YamlValue>;
  const seatName = typeof seat.name === 'string' ? seat.name : null;
  if (seatName === null) return none;
  const label = typeof seat.label === 'string' ? seat.label : null;
  const nickname = typeof seat.nickname === 'string' ? seat.nickname : undefined;
  let field: 'label' | 'nickname';
  let value: string;
  if (named.field === 'label') {
    const persona = labelPersona({ label: label ?? '', labelWritten: label !== null });
    if (persona === null || persona === nickname) return none;
    // A persona the nickname field could not hold is not projected: "Jane Doe" and "Inès" are
    // ordinary display labels, and refusing the label edit for a name it cannot carry would make
    // them unwritable. Nothing is slugged — the field keeps the name it had.
    if (!SEAT_NAME.test(persona)) return none;
    const parsed = validateTeamFile(text);
    if (!parsed.ok) return none;
    if (nicknameProblem(parsed.team.seats, persona, seatName) !== null) return none;
    field = 'nickname';
    value = persona;
  } else {
    // An unset leaves the label's persona: the label still names the seat, and its word stands.
    if (nickname === undefined || label === null) return none;
    // A written label with no middle dot is the persona whole (labelPersona), so the set replaces
    // it: leaving the old word in front of the new nickname would keep launch and header on the
    // old name until someone edited the label too.
    const at = label.indexOf('·');
    const rest = at < 0 ? '' : label.slice(at + 1).trim();
    const nextLabel = rest === '' ? nickname : `${nickname} · ${rest}`;
    if (nextLabel === label) return none;
    field = 'label';
    value = nextLabel;
  }
  const paired = withValue(root, ['seats', seatName, field], value);
  if (!paired.ok || !paired.changed) return none;
  const edited = editedRecordText(text, ['seats', seatName, field], value, paired.root);
  return { text: edited.text, kept: edited.kept, changed: [{ seat: seatName, field, value }] };
}

/**
 * Whether this write is the one a team's `leads` seat may make on its own record: `unset` of
 * exactly `seats.<declared seat>.stopped`, judged by the same gate `team restart` uses for the
 * revival — the caller placed as a seat of this team on its own recorded pane, in the session the
 * map admits it in. Every other key, verb, seat and caller is not this allowance and keeps the
 * owner door.
 */
function liftsStopped(
  caller: Caller,
  verb: string | undefined,
  path: RecordPath,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  root: string,
  home: string,
  sources: ConfigSources,
): boolean {
  if (verb !== 'unset' || caller.kind !== 'seat') return false;
  if (path.length !== 3 || path[0] !== 'seats' || typeof path[1] !== 'string' || path[2] !== 'stopped') return false;
  const loaded = readTeamConfig(root, { home, ...(sources.env === undefined ? {} : { env: sources.env }) });
  if (!loaded.ok) return false;
  const team = loaded.team;
  const seat = path[1];
  if (!team.seats.some((declared) => declared.name === seat)) return false;
  const dir = join(root, '.agents');
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'restart', at, sources.now);
  const judged = judgeCallerIn(io, dir, team, verdictOf);
  return verdictOf(judged.caller, standingOf(dir, judged.session, judged.caller)).kind === 'ok';
}
