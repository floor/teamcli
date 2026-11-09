// `team launchers migrate` maps an owner-written local mapping file: ~/.config/team/
// launcher-migrations.json under the seat's home, `{"format":1,"scripts":{}}` with exact
// absolute script paths naming existing launcher declarations. Independent scenes for that
// interface: a missing map means no mappings, a valid map maps an extensionless script
// inside a repository to an existing declaration which apply consumes without rewriting
// it (the old script becomes a stub), a mapping to a missing declaration is an unmapped
// row and never guessed, a key for a different script maps nothing while two spellings of
// one path refuse the map, an unreadable, malformed or unsafe map and a launcher home
// naming one declaration twice each refuse the whole command before any write, and an
// agent record's own launch line migrates through the same map. The command is
// runLaunchers in src/commands/launchers.ts; the third argument is the synthetic home.
// Homes, scripts, declarations and seat names are synthetic; no real launcher, credential
// or CLI is read.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { runLaunchers } from '../src/commands/launchers.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readLauncherHome } from '../src/launch/launcher-home.ts';
import { launcherMigrationsPath } from '../src/launch/launcher-migrations.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { getAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-09T10:00:00Z');
const MARKER = '# synthetic\n';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(): string {
  const base = fixtureBase('launchers-map-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

/** One seat entry whose launch line is written exactly as given. */
function seat(name: string, launchLine: string): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${launchLine}
    mode: shared
`;
}

const LEAD = `  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`;

type Row = { kind?: string; where?: string; seat?: string; launcher?: string; script?: string; from?: string; to?: string; why?: string };

type World = {
  home: string;
  root: string;
  teamFile: string;
  mapPath: string;
  declHome: string;
  tool: (relative: string) => string;
  writeMap: (scripts: Record<string, string>) => void;
  writeDecl: (name: string, as?: 'json' | 'yaml') => string;
  migrate: (argv: string[]) => Promise<{ code: number; out: string; err: string; doc: unknown }>;
};

/** A fixture team with one wrapper script per seat launch line, built after the checkout
 *  exists so scenes can quote the script's absolute path. The wrappers sit inside the repo
 *  and carry no extension, so no shipped table entry can name them: only the owner map
 *  can map them. */
function world(makeSeats: (tool: (relative: string) => string) => string): World {
  const base = scratch();
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const declHome = join(home, '.config', 'team', 'launchers');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { mode: 0o700 });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'ignore', env: gitEnv() });
  const tool = (relative: string): string => {
    const full = join(root, relative);
    writeFileSync(full, MARKER);
    return full;
  };
  const yaml = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${root}
  - ${lobbyDir(home)}
seats:
${LEAD}${makeSeats(tool)}`;
  const teamFile = join(root, '.agents', 'team.yaml');
  writeFileSync(teamFile, yaml);
  const parsed = validateTeamFile(yaml, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((problem) => problem.message).join('; '));
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, at: NOW.toISOString() });
  const writeMap = (scripts: Record<string, string>): void => {
    writeFileSync(launcherMigrationsPath(home), `${JSON.stringify({ format: 1, scripts }, null, 2)}\n`);
  };
  const writeDecl = (name: string, as: 'json' | 'yaml' = 'json'): string => {
    mkdirSync(declHome, { recursive: true });
    const path = join(declHome, as === 'json' ? `${name}.json` : `${name}.yaml`);
    writeFileSync(path, as === 'json'
      ? `${JSON.stringify({ name, harness: 'claude-code', argv: ['claude', '--model', 'claude-opus-5-5'] }, null, 2)}\n`
      : `name: ${name}\nharness: claude-code\nargv:\n  - claude\n  - --model\n  - claude-opus-5-5\n`);
    return path;
  };
  const migrate = async (argv: string[]) => {
    const io = testIo(root, { kind: 'owner' });
    const code = await runLaunchers(argv, io, home);
    let doc: unknown = null;
    try {
      doc = JSON.parse(io.out);
    } catch {
      // A refused command prints no document; the scenes that expect one assert on it.
    }
    return { code, out: io.out, err: io.err, doc };
  };
  return { home, root, teamFile, mapPath: launcherMigrationsPath(home), declHome, tool, writeMap, writeDecl, migrate };
}

/** The command's rows, or null when the run printed no document. */
function rows(doc: unknown): Row[] | null {
  if (doc === null || typeof doc !== 'object') return null;
  const list = (doc as { rows?: unknown }).rows;
  return Array.isArray(list) ? (list as Row[]) : null;
}

function rowFor(doc: unknown, seatName: string): Row | undefined {
  return rows(doc)?.find((row) => row.seat === seatName);
}

/** The seat's launch value, read back from the written file. */
function launchOf(w: World, seatName: string): string {
  const loaded = readTeamConfig(w.root, { home: w.home });
  if (!loaded.ok) throw new Error(`the migrated file no longer reads: ${loaded.errors.map((p) => p.message).join('; ')}`);
  const found = loaded.team.seats.find((one) => one.name === seatName);
  if (found === undefined) throw new Error(`no seat ${seatName} after migrate`);
  return found.launch;
}

test('a missing map gives no mappings: an unknown script stays an unmapped row that names the map, and nothing is written', async () => {
  const w = world((tool) => seat('stray-seat', `${tool('tools/unlisted-tool')} --go`));
  const before = readFileSync(w.teamFile, 'utf8');
  const dry = await w.migrate(['migrate', '--dry-run', '--json']);
  expect(dry.code, `dry err: ${dry.err}`).toBe(0);
  const dryRow = rowFor(dry.doc, 'stray-seat');
  expect(dryRow?.kind).toBe('unmapped');
  expect(JSON.stringify(dryRow)).toContain('inside a repository');
  // The row tells the owner where the mapping belongs and in what shape.
  expect(JSON.stringify(dryRow)).toContain('launcher-migrations.json');
  expect(JSON.stringify(dryRow)).toContain('format 1');

  const applied = await w.migrate(['migrate', '--json']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(rowFor(applied.doc, 'stray-seat')?.kind).toBe('unmapped');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  // No map file is ever created by the command, and no declaration is written for a row
  // that did not migrate.
  expect(existsSync(w.mapPath)).toBe(false);
  expect(readLauncherHome(w.home)).toEqual({ ok: true, launchers: [] });
  expect(readFileSync(join(w.root, 'tools', 'unlisted-tool'), 'utf8')).toBe(MARKER);
});

test('a valid map maps an extensionless script to an existing declaration, consumes it without rewriting it, and stubs the old script', async () => {
  const w = world((tool) => {
    const wrapper = tool('tools/wrapper-tool');
    return seat('map-seat', `${wrapper} --flag`) + seat('copy-seat', `${wrapper} --flag`);
  });
  const decl = w.writeDecl('wrapper-decl');
  const declBefore = readFileSync(decl, 'utf8');
  const wrapper = join(w.root, 'tools', 'wrapper-tool');
  w.writeMap({ [wrapper]: 'wrapper-decl' });
  const mapBefore = readFileSync(w.mapPath, 'utf8');
  const before = readFileSync(w.teamFile, 'utf8');

  const dry = await w.migrate(['migrate', '--dry-run', '--json']);
  expect(dry.code, `dry err: ${dry.err}`).toBe(0);
  expect(rowFor(dry.doc, 'map-seat')).toMatchObject({ kind: 'change', where: 'team', seat: 'map-seat', launcher: 'wrapper-decl', script: wrapper, from: `${wrapper} --flag` });
  expect(rowFor(dry.doc, 'copy-seat')).toMatchObject({ kind: 'change', seat: 'copy-seat', launcher: 'wrapper-decl' });
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(readFileSync(w.mapPath, 'utf8')).toBe(mapBefore);
  expect(readFileSync(wrapper, 'utf8')).toBe(MARKER);

  const applied = await w.migrate(['migrate', '--json']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  const mapRow = rowFor(applied.doc, 'map-seat');
  if (mapRow?.kind !== 'change' || mapRow.to === undefined) throw new Error(`no change row for map-seat in:\n${applied.out}`);
  const line = mapRow.to;
  expect(rowFor(applied.doc, 'copy-seat')?.to).toBe(line);
  expect(line.startsWith('claude ')).toBe(true);
  expect(line).toContain('crossSessionInbound');
  expect(launchOf(w, 'map-seat')).toBe(line);
  expect(launchOf(w, 'copy-seat')).toBe(line);
  expect(validateTeamFile(readFileSync(w.teamFile, 'utf8'), { root: w.root, home: w.home }).ok).toBe(true);
  // The one existing declaration is consumed exactly: its bytes are untouched, it is not
  // duplicated, and the map is not rewritten by the command.
  expect(readFileSync(decl, 'utf8')).toBe(declBefore);
  const read = readLauncherHome(w.home);
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.launchers.map((one) => one.name)).toEqual(['wrapper-decl']);
  expect(readFileSync(w.mapPath, 'utf8')).toBe(mapBefore);
  // The old script becomes a stub that names the declaration and runs the new line.
  const notice = shellQuote('this launch now comes from the launcher declaration wrapper-decl');
  expect(readFileSync(wrapper, 'utf8')).toBe(`#!/bin/sh\nprintf '%s\\n' ${notice} >&2\nexec ${line} "$@"\n`);
});

test('a mapping to a missing declaration is an unmapped row, never guessed', async () => {
  const w = world((tool) => seat('absent-seat', `${tool('tools/absent-tool')} --go`));
  w.writeMap({ [join(w.root, 'tools', 'absent-tool')]: 'absent-decl' });
  const mapBefore = readFileSync(w.mapPath, 'utf8');
  const before = readFileSync(w.teamFile, 'utf8');

  const applied = await w.migrate(['migrate', '--json']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  const row = rowFor(applied.doc, 'absent-seat');
  expect(row?.kind).toBe('unmapped');
  expect(row?.why).toContain('names no readable launcher declaration');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(readFileSync(w.mapPath, 'utf8')).toBe(mapBefore);
  expect(existsSync(join(w.declHome, 'absent-decl.json'))).toBe(false);
  expect(readLauncherHome(w.home)).toEqual({ ok: true, launchers: [] });
  expect(readFileSync(join(w.root, 'tools', 'absent-tool'), 'utf8')).toBe(MARKER);
});

test('a key for a different script maps nothing, and two spellings of one path refuse the map', async () => {
  const w = world((tool) => seat('odd-seat', `${tool('tools/odd-tool')} --go`));
  w.writeDecl('wrapper-decl');
  // The map names a sibling script, not the seat's: an exact path never matches by folder.
  w.writeMap({ [join(w.root, 'tools', 'other-tool')]: 'wrapper-decl' });
  const before = readFileSync(w.teamFile, 'utf8');
  const neighbour = join(w.root, 'tools', 'other-tool');
  writeFileSync(neighbour, MARKER);

  const applied = await w.migrate(['migrate', '--json']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(rowFor(applied.doc, 'odd-seat')?.kind).toBe('unmapped');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(launchOf(w, 'odd-seat')).toBe(`${join(w.root, 'tools', 'odd-tool')} --go`);

  // Two spellings of one path are one script named twice: the whole map refuses.
  const twin = world((tool) => seat('twin-seat', `${tool('tools/odd-tool')} --go`));
  twin.writeDecl('wrapper-decl');
  twin.writeMap({ [join(twin.root, 'tools', 'odd-tool')]: 'wrapper-decl', [`${twin.root}/tools/../tools/odd-tool`]: 'wrapper-decl' });
  const twinBefore = readFileSync(twin.teamFile, 'utf8');
  const refused = await twin.migrate(['migrate', '--dry-run', '--json']);
  expect(refused.code).toBe(1);
  expect(`${refused.out}${refused.err}`).toContain('names one script more than once');
  expect(readFileSync(twin.teamFile, 'utf8')).toBe(twinBefore);
});

test('an invalid, unreadable or unsafe map refuses the whole command before any write', async () => {
  const legs: { name: string; says: string; make: (w: World) => void }[] = [
    { name: 'invalid json', says: 'must hold valid JSON', make: (w) => { writeFileSync(w.mapPath, '{ this is not json\n'); } },
    { name: 'a format the command does not know', says: 'needs format 1 and scripts only', make: (w) => { writeFileSync(w.mapPath, `${JSON.stringify({ format: 2, scripts: {} }, null, 2)}\n`); } },
    { name: 'a relative script key', says: 'needs an absolute script path', make: (w) => { writeFileSync(w.mapPath, `${JSON.stringify({ format: 1, scripts: { 'tools/wrapper-tool': 'wrapper-decl' } }, null, 2)}\n`); } },
    { name: 'an unreadable map', says: 'launcher migration map was refused', make: (w) => { writeFileSync(w.mapPath, '{"format":1,"scripts":{}}\n'); chmodSync(w.mapPath, 0o000); } },
    { name: 'a symlinked map', says: 'launcher migration map was refused', make: (w) => { const real = join(dirname(w.home), 'migrations-real.json'); writeFileSync(real, '{"format":1,"scripts":{}}\n'); symlinkSync(real, w.mapPath); } },
    { name: 'a group-writable map', says: 'group- or world-writable', make: (w) => { writeFileSync(w.mapPath, '{"format":1,"scripts":{}}\n'); chmodSync(w.mapPath, 0o664); } },
    { name: 'a world-writable map', says: 'group- or world-writable', make: (w) => { writeFileSync(w.mapPath, '{"format":1,"scripts":{}}\n'); chmodSync(w.mapPath, 0o666); } },
  ];
  for (const leg of legs) {
    const w = world((tool) => seat('map-seat', `${tool('tools/wrapper-tool')} --flag`));
    const decl = w.writeDecl('wrapper-decl');
    const declBefore = readFileSync(decl, 'utf8');
    leg.make(w);
    const before = readFileSync(w.teamFile, 'utf8');

    const dry = await w.migrate(['migrate', '--dry-run', '--json']);
    expect(dry.code, `${leg.name}: dry out:\n${dry.out}\n${dry.err}`).toBe(1);
    expect(`${dry.out}${dry.err}`).toContain(leg.says);
    // The refusal happens before any write: the team file and the declaration the seat
    // would have consumed both keep their bytes.
    expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
    expect(readFileSync(decl, 'utf8')).toBe(declBefore);

    const applied = await w.migrate(['migrate', '--json']);
    expect(applied.code).toBe(1);
    expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
    expect(readFileSync(decl, 'utf8')).toBe(declBefore);
  }
});

test('a launcher home that names one declaration twice refuses rather than choosing', async () => {
  const w = world((tool) => seat('map-seat', `${tool('tools/wrapper-tool')} --flag`));
  const jsonDecl = w.writeDecl('wrapper-decl', 'json');
  const yamlDecl = w.writeDecl('wrapper-decl', 'yaml');
  w.writeMap({ [join(w.root, 'tools', 'wrapper-tool')]: 'wrapper-decl' });
  const before = readFileSync(w.teamFile, 'utf8');
  const jsonBefore = readFileSync(jsonDecl, 'utf8');
  const yamlBefore = readFileSync(yamlDecl, 'utf8');

  const dry = await w.migrate(['migrate', '--dry-run', '--json']);
  expect(dry.code, `dry out:\n${dry.out}\n${dry.err}`).toBe(1);
  expect(`${dry.out}${dry.err}`).toContain('names a declaration more than once');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(readFileSync(jsonDecl, 'utf8')).toBe(jsonBefore);
  expect(readFileSync(yamlDecl, 'utf8')).toBe(yamlBefore);
});

test("an agent record's own launch line migrates through the same map", async () => {
  const w = world(() => seat('record-seat', 'claude --model claude-opus-5-5'));
  const decl = w.writeDecl('wrapper-decl');
  const declBefore = readFileSync(decl, 'utf8');
  const wrapper = w.tool('tools/agent-tool');
  w.writeMap({ [wrapper]: 'wrapper-decl' });
  const agent = registerAgent(w.home, {
    name: 'record-seat',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'synthetic-lab',
    cli: 'claude-code',
    launcher: null,
    launch: `${wrapper} --go`,
    reach: { team: teamIdOf(w.root), seat: 'record-seat', session: 'fixture-session', pane: null, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'registered',
    by: 'tester',
  });
  const before = readFileSync(w.teamFile, 'utf8');

  const applied = await w.migrate(['migrate', '--json']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  const list = rows(applied.doc) ?? [];
  expect(list).toHaveLength(1);
  const row = list[0];
  expect(row).toMatchObject({ kind: 'change', where: 'agent', seat: 'record-seat', launcher: 'wrapper-decl', from: `${wrapper} --go` });
  if (row?.to === undefined) throw new Error(`the agent row carries no new launch line:\n${applied.out}`);
  // The agent record is rewritten, the team file and the script are not, and the one
  // declaration is consumed without being rewritten.
  expect(getAgent(w.home, agent.id)?.launch).toBe(row.to);
  expect(getAgent(w.home, agent.id)?.launcher).toBe('wrapper-decl');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(readFileSync(wrapper, 'utf8')).toBe(MARKER);
  expect(readFileSync(decl, 'utf8')).toBe(declBefore);
  expect(launchOf(w, 'record-seat')).toBe('claude --model claude-opus-5-5');
});
