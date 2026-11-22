// `team launchers migrate` rewrites a seat's launch value through the parsed record editor,
// addressed as the seat's own path and guarded by the value the file parses to, so YAML
// quoting is owned by the editor and a matching comment cannot be rewritten instead of the
// seat. Independent scenes for that fix: both YAML quote forms migrate by parsed value, an
// argument value with escaped quotes migrates through its parsed form, a comment line before
// the seat survives — including one carrying the old launch line —, two seats sharing one
// prior launch line both migrate with nothing else in the file changing, and a line whose
// script cannot be read or matched refuses with nothing written. The seat's tool is the
// owner's own wrapper: each migrating scene maps it through an owner-written
// launcher-migrations.json to one existing declaration. The command is runLaunchers
// in src/commands/launchers.ts; the third argument is the synthetic home. Homes, scripts and
// seat names are synthetic; no real launcher, credential or CLI is read.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { runLaunchers } from '../src/commands/launchers.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readLauncherHome } from '../src/launch/launcher-home.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
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
  const base = fixtureBase('launchers-quote-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

/** One seat entry whose launch line is written exactly as given, quote form included. */
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

type Scene = { root: string; home: string; script: (relative: string, present?: boolean) => string };

type World = {
  home: string;
  root: string;
  teamFile: string;
  tool: string;
  writeMap: (scripts: Record<string, string>) => void;
  writeDecl: (name: string) => string;
  migrate: (argv: string[]) => Promise<{ code: number; out: string; err: string }>;
};

/** A fixture team whose seat entries are built after the checkout exists, so a scene can put
 *  its scripts on disk first and quote their absolute paths in the launch lines it writes. */
function world(makeSeats: (scene: Scene) => string): World {
  const base = scratch();
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { mode: 0o700 });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'ignore', env: gitEnv() });
  const script = (relative: string, present = true): string => {
    const full = join(root, relative);
    if (present) writeFileSync(full, MARKER);
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
${LEAD}${makeSeats({ root, home, script })}`;
  const teamFile = join(root, '.agents', 'team.yaml');
  writeFileSync(teamFile, yaml);
  const parsed = validateTeamFile(yaml, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((problem) => problem.message).join('; '));
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, at: NOW.toISOString() });
  const migrate = async (argv: string[]) => {
    const io = testIo(root, { kind: 'owner' });
    const code = await runLaunchers(argv, io, home);
    return { code, out: io.out, err: io.err };
  };
  const declHome = join(home, '.config', 'team', 'launchers');
  const writeDecl = (name: string): string => {
    mkdirSync(declHome, { recursive: true });
    const path = join(declHome, `${name}.json`);
    writeFileSync(path, `${JSON.stringify({ name, harness: 'claude-code', argv: ['claude', '--model', 'claude-opus-5-5'] }, null, 2)}\n`);
    return path;
  };
  const writeMap = (scripts: Record<string, string>): void => {
    writeFileSync(join(home, '.config', 'team', 'launcher-migrations.json'), `${JSON.stringify({ format: 1, scripts }, null, 2)}\n`);
  };
  return { home, root, teamFile, tool: join(root, 'tools', 'wrapper-tool'), writeMap, writeDecl, migrate };
}

/** The row `report` prints for one migrated seat: its old line and its new one. */
function saidRow(out: string, seatName: string, verb: 'migrated' | 'would migrate'): { from: string; to: string } {
  const lines = out.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`${verb} ${seatName}: `));
  if (at < 0) throw new Error(`no ${verb} row for ${seatName} in:\n${out}`);
  return { from: lines[at + 1]!.trim(), to: lines[at + 2]!.trim() };
}

/** The seat's launch value, read back from the written file. */
function launchOf(w: World, seatName: string): string {
  const loaded = readTeamConfig(w.root, { home: w.home });
  if (!loaded.ok) throw new Error(`the migrated file no longer reads: ${loaded.errors.map((p) => p.message).join('; ')}`);
  const found = loaded.team.seats.find((one) => one.name === seatName);
  if (found === undefined) throw new Error(`no seat ${seatName} after migrate`);
  return found.launch;
}

test('a launch value written in either YAML quote form migrates by its parsed value', async () => {
  const w = world(({ script }) =>
    seat('single-seat', `'${script('tools/wrapper-tool')} --single'`) +
    seat('double-seat', `"${script('tools/wrapper-tool')} --double"`),
  );
  w.writeDecl('wrapper-decl');
  w.writeMap({ [w.tool]: 'wrapper-decl' });
  const before = readFileSync(w.teamFile, 'utf8');
  const dry = await w.migrate(['migrate', '--dry-run']);
  expect(dry.code, `dry err: ${dry.err}`).toBe(0);
  expect(dry.out).toContain('would migrate single-seat: wrapper-decl');
  expect(dry.out).toContain('would migrate double-seat: wrapper-decl');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);

  const applied = await w.migrate(['migrate']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(applied.out).toContain('migrated single-seat: wrapper-decl');
  expect(applied.out).toContain('migrated double-seat: wrapper-decl');
  expect(applied.out).not.toContain('unmapped');
  const after = readFileSync(w.teamFile, 'utf8');
  expect(after.includes('--single')).toBe(false);
  expect(after.includes('--double')).toBe(false);
  const single = saidRow(applied.out, 'single-seat', 'migrated');
  const double = saidRow(applied.out, 'double-seat', 'migrated');
  expect(single.from).toBe(`${w.tool} --single`);
  expect(double.from).toBe(`${w.tool} --double`);
  expect(launchOf(w, 'single-seat')).toBe(single.to);
  expect(launchOf(w, 'double-seat')).toBe(double.to);
  expect(single.to.includes(w.root)).toBe(false);
  expect(validateTeamFile(after, { root: w.root, home: w.home }).ok).toBe(true);
});

test('an argument value with escaped quotes migrates through its parsed form', async () => {
  const w = world(({ script }) =>
    // The raw text escapes the inner quotes; the value the file parses to does not carry them.
    seat('quoted-seat', `"${script('tools/wrapper-tool')} --prompt \\"hi team\\""`),
  );
  w.writeDecl('wrapper-decl');
  w.writeMap({ [w.tool]: 'wrapper-decl' });
  const applied = await w.migrate(['migrate']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(applied.out).toContain('migrated quoted-seat: wrapper-decl');
  expect(applied.out).not.toContain('unmapped quoted-seat');
  const row = saidRow(applied.out, 'quoted-seat', 'migrated');
  expect(row.from).toBe(`${w.tool} --prompt "hi team"`);
  expect(launchOf(w, 'quoted-seat')).toBe(row.to);
  const after = readFileSync(w.teamFile, 'utf8');
  expect(after.includes(w.tool)).toBe(false);
  expect(validateTeamFile(after, { root: w.root, home: w.home }).ok).toBe(true);
});

test('a comment line before the seat survives, including one carrying the old launch line', async () => {
  const w = world(({ script }) => {
    const tool = script('tools/wrapper-tool');
    return `  # kept: the tool this seat ran before the launcher declaration
  # was: launch: ${tool} --old
${seat('comment-seat', `${tool} --old`)}`;
  });
  w.writeDecl('wrapper-decl');
  w.writeMap({ [w.tool]: 'wrapper-decl' });
  const applied = await w.migrate(['migrate']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(applied.out).toContain('migrated comment-seat: wrapper-decl');
  const after = readFileSync(w.teamFile, 'utf8');
  expect(after).toContain('  # kept: the tool this seat ran before the launcher declaration');
  // The only place the script path survives is the comment, byte for byte; the seat's own
  // launch value is the line that was rewritten.
  expect(after.split('\n').filter((line) => line.includes(w.tool))).toEqual([`  # was: launch: ${w.tool} --old`]);
  expect(launchOf(w, 'comment-seat')).toBe(saidRow(applied.out, 'comment-seat', 'migrated').to);
  expect(validateTeamFile(after, { root: w.root, home: w.home }).ok).toBe(true);
});

test('two seats sharing one prior launch line both migrate and nothing else changes', async () => {
  const w = world(({ script }) =>
    seat('pair-one', `"${script('tools/wrapper-tool')} --shared"`) +
    seat('pair-two', `"${script('tools/wrapper-tool')} --shared"`),
  );
  w.writeDecl('wrapper-decl');
  w.writeMap({ [w.tool]: 'wrapper-decl' });
  const before = readFileSync(w.teamFile, 'utf8');
  const applied = await w.migrate(['migrate']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(applied.out).toContain('migrated pair-one: wrapper-decl');
  expect(applied.out).toContain('migrated pair-two: wrapper-decl');
  const after = readFileSync(w.teamFile, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  const changed = beforeLines.flatMap((line, at) => (line === afterLines[at] ? [] : [at]));
  expect(changed.length).toBe(2);
  for (const at of changed) {
    expect(beforeLines[at]).toContain('--shared');
    expect(afterLines[at]).toContain('launch:');
    expect(afterLines[at]).not.toContain(w.tool);
  }
  const one = launchOf(w, 'pair-one');
  const two = launchOf(w, 'pair-two');
  expect(one).toBe(two);
  expect(one).toBe(saidRow(applied.out, 'pair-one', 'migrated').to);
  expect(two).toBe(saidRow(applied.out, 'pair-two', 'migrated').to);
  expect(validateTeamFile(after, { root: w.root, home: w.home }).ok).toBe(true);
});

test('a line whose script cannot be read or matched refuses with nothing written', async () => {
  const w = world(({ root, script }) =>
    seat('odd-seat', `"${script('tools/unlisted-helper.sh')} --odd"`) +
    // vanished-tool.sh is deliberately not created: its script cannot be read.
    seat('gone-seat', `"${join(root, 'tools/vanished-tool.sh')} --gone"`),
  );
  const before = readFileSync(w.teamFile, 'utf8');
  const dry = await w.migrate(['migrate', '--dry-run']);
  expect(dry.code, `dry err: ${dry.err}`).toBe(0);
  expect(dry.out).toContain('unmapped odd-seat: its launch line runs a script inside a repository');
  expect(dry.out).toContain('stale gone-seat:');
  expect(dry.out).toContain('the launcher is gone and the record is left in place');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);

  const applied = await w.migrate(['migrate']);
  expect(applied.code, `apply err: ${applied.err}`).toBe(0);
  expect(applied.out).toContain('unmapped odd-seat: its launch line runs a script inside a repository');
  expect(applied.out).toContain('stale gone-seat:');
  expect(applied.out).not.toContain('migrated ');
  expect(readFileSync(w.teamFile, 'utf8')).toBe(before);
  expect(readLauncherHome(w.home)).toEqual({ ok: true, launchers: [] });
  expect(readFileSync(join(w.root, 'tools', 'unlisted-helper.sh'), 'utf8')).toBe(MARKER);
});
