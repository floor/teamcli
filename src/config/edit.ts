// `team config get|set|unset|edit`: the one editor of a team's record. The record is read and
// written through the writers' seam (src/file/team-text.ts): the registry's record under the
// registry source, the team file only on the legacy `file` source. Every write is validated by
// the team-file validator first and refused whole when it does not validate; the edit is the
// owner's, as editing the file by hand was; and the run names what the approval no longer
// covers, the way a hand edit of an owner section left the approval stale.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { ownerSeatStep } from '../client/owner-action-step.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { charterGate } from '../charter/check.ts';
import { approvalDifferences } from '../approve/approval.ts';
import { findRoot, TEAM_FILE } from '../file/load.ts';
import { readTeamText, teamTextTarget, writeTeamText } from '../file/team-text.ts';
import { validateTeamFile } from '../file/validate.ts';
import { cleanedIo, type Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { readStoredTeamConfig } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';
import { findAgent, updateAgent } from '../registry/agents.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';
import { editedRecordText, getAt, parsePath, parseValue, reservedKeyIn, shownValue, withValue } from './team-record.ts';
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
  const args = readArgs(argv, ['approval', 'general', 'key'], ['json', 'request']);
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
    const step = ownerSeatStep('config', 'team-config', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, { home, root, ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}), ...(sources.present !== undefined ? { present: sources.present } : {}) });
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
  if (gate.kind !== 'admit' && !seatApproved) {
    const caller = callerOf(rawIo);
    const detached = detachedRefusal(caller);
    if (detached !== undefined) {
      refuse(io, json, 'config', { id: 'config.detached', message: detached, repair: null });
      // exit: config.detached
      return 1;
    }
    if (!isOwner(caller)) {
      refuse(io, json, 'config', {
        id: 'config.not-owner',
        message: `only the owner edits the team's record, from a terminal outside herdr; this call is ${describeCaller(caller)}`,
        repair: null,
        rule: 'owner-only',
      });
      // exit: config.not-owner
      return 1;
    }
  }
  let next: string;
  let kept: string | null = null;
  // Whether the change was made line by line, keeping the record's comments. An `edit` keeps
  // whatever the editor wrote, so it is not measured here.
  let commentsKept = true;
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
    }
  }
  if (next === text) {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: false, source: target.kind, comments_kept: true, approval_differences: [] });
    else io.stdout(`nothing changed in ${where}\n`);
    // exit: config.unchanged
    return 0;
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
  if (kept !== null) rmSync(resolve(kept, '..'), { recursive: true, force: true });
  const checked = validateTeamFile(next);
  // A seat whose launch line this edit changed: its agent record's launch recipe follows, so the
  // next up or restart runs the line the team now declares, not the one the record kept.
  const synced = checked.ok ? syncAgentLaunches(home, teamIdOf(root), text, checked.team.seats) : [];
  if (!json) for (const name of synced) io.stdout(`agent record of ${name}: launch line updated to match\n`);
  const stale = checked.ok ? (approvalDifferences(checked.team, root, home, { text: next }) ?? []) : [];
  if (!commentsKept) io.stderr(`team config: the record was rewritten whole to change ${rawPath}; its comments were not kept\n`);
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: true, source: wrote.target, comments_kept: commentsKept, approval_differences: stale });
  } else {
    io.stdout(`${verb === 'edit' ? 'edited' : verb === 'set' ? `set ${rawPath}` : `unset ${rawPath}`} in ${where}; validated\n`);
    if (stale.length > 0) {
      io.stdout(`the approval no longer covers: ${stale.join('; ')}; the change was applied, and the stored team approval still describes an earlier record; this version has no command to refresh that snapshot\n`);
    }
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
