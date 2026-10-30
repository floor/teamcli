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
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';
import { getAt, parsePath, parseValue, recordText, shownValue, withValue } from './team-record.ts';
import type { ConfigSources } from '../commands/config.ts';

function realRoot(cwd: string): string {
  return findRoot(cwd) ?? resolve(cwd);
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
  if (why !== null || typeof path === 'string') {
    refuse(io, json, 'config', { id: 'config.usage', message: why ?? 'invalid path', repair: null, usage });
    // exit: config.usage
    return 2;
  }
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
    refuse(io, json, 'config', { id: 'config.no-record', message: error instanceof Error ? error.message : String(error), repair: null });
    // exit: config.no-record
    return 2;
  }
  const where = target.kind === 'registry' ? "the registry's record" : TEAM_FILE;
  if (verb === 'get') {
    const record = toValue(parseYaml(text));
    const got = getAt(record, path);
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
    const step = ownerSeatStep('config', 'team-config', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, { home, ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}), ...(sources.present !== undefined ? { present: sources.present } : {}) });
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
    const record = toValue(parseYaml(text));
    const value: YamlValue | undefined = verb === 'set' ? parseValue(rawValue as string) : undefined;
    const changed = withValue(record, path, value);
    if (!changed.ok) {
      refuse(io, json, 'config', { id: 'config.path', message: `${rawPath}: ${changed.why}; nothing was written`, repair: null });
      // exit: config.path
      return 1;
    }
    next = changed.changed ? recordText(changed.root) : text;
  }
  if (next === text) {
    if (json) writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: false, source: target.kind, approval_differences: [] });
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
  const stale = checked.ok ? (approvalDifferences(checked.team, root, home) ?? []) : [];
  if (json) {
    writeJson(io, 'team.config-edit', { format: 1, verb, path: rawPath ?? null, changed: true, source: wrote.target, approval_differences: stale });
  } else {
    io.stdout(`${verb === 'edit' ? 'edited' : verb === 'set' ? `set ${rawPath}` : `unset ${rawPath}`} in ${where}; validated\n`);
    if (stale.length > 0) {
      io.stdout(`the approval no longer covers: ${stale.join('; ')}; approve the team again with the owner seat\n`);
    }
  }
  // exit: config.written
  return 0;
}
