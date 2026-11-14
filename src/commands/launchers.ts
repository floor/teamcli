// `team launchers migrate` moves launch lines that run a script inside a repository or a temp
// folder onto a declaration in the launcher home. A dry run lists every change and every stale
// record and writes nothing. Apply writes the declaration, rewrites the line, and leaves the
// old script as a stub that says where the launch comes from. It never deletes a record and
// never reads a script's secrets or environment values.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { withoutFileOffer } from '../file/load.ts';
import { editedRecordText, getAt, withValue } from '../config/team-record.ts';
import { describeCaller, judgeCallerIn, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { readTeamText, writeTeamText } from '../file/team-text.ts';
import type { Seat } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import {
  compileLauncher,
  launcherHome,
  readLauncherHome,
  type LauncherDecl,
  launchLineProblem,
} from '../launch/launcher-home.ts';
import { launcherMigrationsPath, readLauncherMigrations } from '../launch/launcher-migrations.ts';
import { shellQuote } from '../profiles/profile.ts';
import { gateVerdict } from '../permissions/who.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { findAgent, readAgents, updateAgent, type Agent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { parseYaml, toValue } from '../yaml.ts';

export const USAGE = `Usage: team launchers migrate [--dry-run] [--json]

Finds every launch line of this team, in the team record and in its agent records, that runs a
script inside a git repository or a temp folder. Each known script becomes a declaration in the
launcher home, the line is rewritten to the compiled form, and the old script becomes a stub that
prints where the launch now comes from and then runs that line.

\`--dry-run\` lists every change and every stale record (the script is gone) and writes nothing.
Without it the same list is applied. A record is never deleted. The command never reads a
script's secrets or environment values. The owner, or a lead of this team, runs it from a
terminal. Run it inside the team's folder; another team's lines are that team's lead's, or the
owner's, from that folder.
General grants do not admit this command, including a wildcard grant.

Generic provider scripts have built-in declarations. For other scripts, write a local
~/.config/team/launcher-migrations.json with format 1 and a scripts object mapping exact
absolute script paths to existing launcher declaration names. The map is owned by you and not
group- or world-writable; migration never writes it. Unmapped scripts are reported unchanged.

Exits 0 when the dry run is listed or the apply is written, 1 when it is refused or a write
fails, 2 when the invocation or the team cannot be read.
`;

const WHY = 'only the owner, or a lead of this team, migrates its launchers';

type Shape = Pick<LauncherDecl, 'harness' | 'argv' | 'env' | 'endpoint' | 'identity'>;

// Generic provider scripts, by file name. Local script choices come from the owner's map.
// The environment map names references, never values.
const KNOWN: Readonly<Record<string, Shape>> = {
  'claude-deepseek': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'deepseek',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'deepseek-api-key' }, ANTHROPIC_BASE_URL: { ref: 'deepseek-base-url' } },
  },
  'claude-deepseek.sh': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'deepseek',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'deepseek-api-key' }, ANTHROPIC_BASE_URL: { ref: 'deepseek-base-url' } },
  },
  'claude-kimi': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'kimi',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'kimi-api-key' }, ANTHROPIC_BASE_URL: { ref: 'kimi-base-url' } },
  },
  'claude-kimi.sh': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'kimi',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'kimi-api-key' }, ANTHROPIC_BASE_URL: { ref: 'kimi-base-url' } },
  },
  'claude-glm': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'glm',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'glm-api-key' }, ANTHROPIC_BASE_URL: { ref: 'glm-base-url' } },
  },
  'claude-glm.sh': {
    harness: 'claude-code',
    argv: ['claude'],
    endpoint: 'glm',
    env: { ANTHROPIC_AUTH_TOKEN: { ref: 'glm-api-key' }, ANTHROPIC_BASE_URL: { ref: 'glm-base-url' } },
  },
};

export type MigrateChange = {
  kind: 'change';
  where: 'team' | 'agent';
  seat: string;
  id: string | null;
  script: string;
  launcher: string;
  from: string;
  to: string;
};

export type MigrateStale = {
  kind: 'stale';
  where: 'team' | 'agent';
  seat: string;
  id: string | null;
  script: string | null;
  from: string;
  why: string;
};

export type MigrateUnmapped = {
  kind: 'unmapped';
  where: 'team' | 'agent';
  seat: string;
  id: string | null;
  script: string | null;
  from: string;
  why: string;
};

export type MigrateRow = MigrateChange | MigrateStale | MigrateUnmapped;

export const launchers: Command = (argv, io) => runLaunchers(argv, io);
export default launchers;

export async function runLaunchers(argv: string[], io: Io, home = homedir()): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['dry-run', 'json']);
  if (args.error) return usage(out, args.error, json);
  const sub = args.rest[0];
  if (sub !== 'migrate') return usage(out, 'team launchers migrate [--dry-run] [--json]', json);
  if (args.rest.length > 1) return usage(out, `unexpected "${args.rest[1]}"`, json);
  const dry = args.flags.has('dry-run');
  const loaded = readTeamConfig(io.cwd, { home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => withoutFileOffer(problem.message)).join('; ') || 'the team cannot be read';
    return configuration(out, json, message);
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);
  const now = () => new Date();
  const verdictOf = (who: Caller, at: SeatStanding) => gateVerdict(who, team, root, home, 'launchers', at, now);
  const judged = judgeCallerIn(io, dir, team, verdictOf);
  const standing = standingOf(dir, judged.session, judged.caller);
  const verdict = gateVerdict(judged.caller, team, root, home, 'launchers', standing, now);
  if (verdict.kind !== 'ok') return refused(out, json, `${WHY} (${describeCaller(judged.caller)})`);

  const teamId = teamIdOf(root);
  let text: string;
  try {
    text = readTeamText(path, { home });
  } catch (error) {
    return configuration(out, json, `the team record cannot be read: ${(error as Error).message}`);
  }
  const recorded = readAgents(home).filter((agent) => agent.reach.team === teamId && agent.lifecycle !== 'retired');
  const existing = readLauncherHome(home);
  const mappings = readLauncherMigrations(home);
  if (!mappings.ok) return refused(out, json, mappings.why);
  const configured = new Map<string, LauncherDecl>();
  if (existing.ok) for (const decl of existing.launchers) {
    if (configured.has(decl.name)) return refused(out, json, 'the launcher home names a declaration more than once');
    configured.set(decl.name, decl);
  }
  const known = new Map(configured);

  const rows: MigrateRow[] = [];
  let next = text;
  for (const seat of team.seats) {
    const agent = findAgent(home, { team: teamId, seat: seat.name });
    const row = planLine('team', seat.name, agent?.id ?? null, seat.launch, seat, agent, root, home, known, mappings.scripts, configured);
    if (row === null) continue;
    if (row.kind !== 'change') {
      rows.push(row);
      continue;
    }
    const replaced = replaceLaunch(next, seat.name, seat.launch, row.to);
    if (replaced === null) {
      rows.push({
        kind: 'unmapped',
        where: 'team',
        seat: seat.name,
        id: agent?.id ?? null,
        script: row.script,
        from: seat.launch,
        why: unmappedWhy('the team record does not contain this launch line', home),
      });
      continue;
    }
    rows.push(row);
    next = replaced;
  }
  for (const agent of recorded) {
    if (team.seats.some((seat) => seat.name === agent.reach.seat && seat.launch === agent.launch)) continue;
    const seat = team.seats.find((item) => item.name === agent.reach.seat);
    const row = planLine('agent', agent.reach.seat, agent.id, agent.launch, seat, agent, root, home, known, mappings.scripts, configured);
    if (row !== null) rows.push(row);
  }

  if (!dry && !existing.ok) {
    return refused(out, json, `the launcher home cannot be read: ${existing.problems.join('; ')}`);
  }
  if (!dry) {
    const wrote = applyRows(home, path, next, text, rows, recorded, known, configured);
    if (!wrote.ok) return refused(out, json, wrote.why);
  }
  report(out, json, dry, rows);
  // exit: launchers.migrated
  return 0;
}

function planLine(
  where: 'team' | 'agent',
  seatName: string,
  id: string | null,
  line: string,
  seat: Seat | undefined,
  agent: Agent | null,
  root: string,
  home: string,
  known: Map<string, LauncherDecl>,
  mappings: ReadonlyMap<string, string>,
  configured: ReadonlyMap<string, LauncherDecl>,
): MigrateRow | null {
  const problem = launchLineProblem(line, root, home);
  if (problem === null) return null;
  const script = scriptWord(line, home, root, mappings);
  if (script !== null && !fileExists(script)) {
    return { kind: 'stale', where, seat: seatName, id, script, from: line, why: `${problem}; the launcher is gone and the record is left in place` };
  }
  const fileName = script === null ? '' : basename(script);
  const shape = Object.hasOwn(KNOWN, fileName) ? KNOWN[fileName] : undefined;
  const mapped = script === null ? undefined : mappings.get(resolve(script));
  const name = mapped ?? fileName.replace(/\.sh$/, '');
  const decl = mapped !== undefined
    ? configured.get(mapped)
    : shape === undefined ? undefined : known.get(name) ?? { name, ...shape };
  if (decl === undefined || seat === undefined) {
    const why = mapped !== undefined && decl === undefined
      ? 'the local migration mapping names no readable launcher declaration'
      : problem;
    return { kind: 'unmapped', where, seat: seatName, id, script, from: line, why: unmappedWhy(why, home) };
  }
  known.set(name, decl);
  const to = compileLauncher(decl, {
    ...seat,
    ...(agent?.reach.agent_session ? { agent_session: agent.reach.agent_session } : {}),
    channel: line.includes('--mcp') || line.includes('mcp-server'),
  });
  return { kind: 'change', where, seat: seatName, id, script: script ?? '', launcher: name, from: line, to };
}

function unmappedWhy(problem: string, home: string): string {
  return `${problem}; map this script in ${launcherMigrationsPath(home)} with format 1 and scripts mapping absolute script paths to existing declaration names`;
}

function applyRows(
  home: string,
  path: string,
  next: string,
  text: string,
  rows: readonly MigrateRow[],
  recorded: readonly Agent[],
  declarations: ReadonlyMap<string, LauncherDecl>,
  configured: ReadonlyMap<string, LauncherDecl>,
): { ok: true } | { ok: false; why: string } {
  if (next !== text) {
    const wrote = writeTeamText(path, next, { home, command: 'launchers migrate', keepWords: true });
    if (!wrote.ok) {
      return { ok: false, why: `the team record was not written: ${wrote.errors.map((problem) => problem.message).join('; ')}` };
    }
  }
  const dir = launcherHome(home);
  const changes = rows.filter((row): row is MigrateChange => row.kind === 'change');
  const names = new Set(changes.map((row) => row.launcher));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, why: `the launcher home could not be created: ${(error as Error).message}` };
  }
  for (const name of names) {
    const sample = changes.find((row) => row.launcher === name);
    if (sample === undefined) continue;
    if (configured.has(name)) continue;
    const declPath = join(dir, `${name}.json`);
    if (fileExists(declPath)) continue;
    const decl = declarations.get(name);
    if (decl === undefined) continue;
    writeFileSync(declPath, `${JSON.stringify(decl, null, 2)}\n`, { mode: 0o600 });
  }
  for (const row of changes) {
    if (row.where !== 'agent' && row.id === null) {
      const agent = recorded.find((item) => item.reach.seat === row.seat && item.launch === row.from);
      if (agent !== undefined) updateAgent(home, agent.id, { launch: row.to, launcher: row.launcher });
      continue;
    }
    if (row.id !== null && row.where === 'agent') updateAgent(home, row.id, { launch: row.to, launcher: row.launcher });
  }
  for (const row of changes) {
    if (row.where !== 'team') continue;
    const agent = recorded.find((item) => item.reach.seat === row.seat);
    if (agent !== undefined && agent.launch === row.from) updateAgent(home, agent.id, { launch: row.to, launcher: row.launcher });
    if (row.script !== '' && fileExists(row.script)) writeStub(row.script, row.launcher, row.to);
  }
  return { ok: true };
}

function writeStub(script: string, name: string, line: string): void {
  const info = lstatSync(script);
  if (!info.isFile() || info.isSymbolicLink()) return;
  const notice = shellQuote(`this launch now comes from the launcher declaration ${name}`);
  const text = `#!/bin/sh\nprintf '%s\\n' ${notice} >&2\nexec ${line} "$@"\n`;
  writeFileSync(script, text, { mode: 0o755 });
}

function fileExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function scriptWord(line: string, home: string, root: string, mappings: ReadonlyMap<string, string>): string | null {
  for (const raw of line.split(/\s+/)) {
    const word = raw.replace(/^['"]|['"]$/g, '');
    if (word === '' || word.startsWith('-') || word.includes('://')) continue;
    const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
    if (!value.includes('/') && !value.startsWith('~')) continue;
    const expanded = value.startsWith('~/') ? join(home, value.slice(2)) : value;
    const full = isAbsolute(expanded) ? expanded : resolve(root, expanded);
    const fileName = basename(full);
    if (!fileName.endsWith('.sh') && !Object.hasOwn(KNOWN, fileName) && !mappings.has(resolve(full))) continue;
    return full;
  }
  return null;
}

// Address the seat's value, so the record editor owns its YAML quoting and a matching
// comment or another seat's launch line cannot be rewritten instead.
function replaceLaunch(text: string, seat: string, from: string, to: string): string | null {
  try {
    const record = toValue(parseYaml(text));
    const path = ['seats', seat, 'launch'];
    const current = getAt(record, path);
    if (!current.found || current.value !== from) return null;
    const changed = withValue(record, path, to);
    if (!changed.ok) return null;
    return editedRecordText(text, path, to, changed.root).text;
  } catch {
    return null;
  }
}

function report(io: Io, json: boolean, dry: boolean, rows: readonly MigrateRow[]): void {
  if (json) {
    writeJson(io, 'launchers.migrate', { format: 1, dry_run: dry, rows });
    return;
  }
  if (rows.length === 0) {
    io.stdout('nothing to migrate\n');
    return;
  }
  for (const row of rows) {
    if (row.kind === 'change') io.stdout(`${dry ? 'would migrate' : 'migrated'} ${row.seat}: ${row.launcher}\n  ${row.from}\n  ${row.to}\n`);
    else if (row.kind === 'stale') io.stdout(`stale ${row.seat}: ${row.why}\n`);
    else io.stdout(`unmapped ${row.seat}: ${row.why}\n`);
  }
}

function usage(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'launchers.usage', message, 'team launchers migrate [--dry-run] [--json]');
  else io.stderr(`team launchers: ${message}\n${USAGE}`);
  // exit: launchers.usage
  return 2;
}

function failure(io: Io, json: boolean, message: string): void {
  if (json) writeJsonError(io, 'launchers.migrate', message, null);
  else io.stderr(`team launchers: ${message}\n`);
}

function configuration(io: Io, json: boolean, message: string): number {
  failure(io, json, message);
  // exit: launchers.configuration
  return 2;
}

function refused(io: Io, json: boolean, message: string): number {
  failure(io, json, message);
  // exit: launchers.refused
  return 1;
}
