// The command side of the standing grants: `team grant <seat|@team> --capabilities …` writes a
// seat- or team-grant record through the permissions module, `team revoke <name>` appends its
// revocation — owner-only, with the team-file editors' own refusal, and no dev-mode waiver. The
// file forms (`team grant <seat> --scope …`, `team revoke grant|delegate`) keep their behaviour.
// Every file, caller and registry record below is synthetic; the caller is injected, never a real
// terminal, and no environment variable is used to make anything pass.
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGrant } from '../../src/commands/grant.ts';
import { runRevoke } from '../../src/commands/revoke.ts';
import { grantsDir } from '../../src/grant.ts';
import { activeGrants, covers, readGrants, writeGrant } from '../../src/permissions/grants.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { testIo, type TestIo } from '../helpers.ts';

const TEAM_FILE = `# Preserve the file's spelling and comments.
format: 1
project: beacon
session: arena
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Place = { root: string; home: string; file: string };
const made: string[] = [];
afterEach(() => {
  for (const root of made.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function folder(text = TEAM_FILE): Place {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-grant-levels-')));
  made.push(root);
  const home = join(root, 'home');
  const file = join(root, '.agents', 'team.yaml');
  fs.mkdirSync(dirname(file));
  fs.mkdirSync(home);
  fs.writeFileSync(file, text);
  return { root, home, file };
}

function textAt(place: Place): string {
  return fs.readFileSync(place.file, 'utf8');
}

function ownerAt(root: string): TestIo {
  const io = testIo(root);
  io.stdinIsTTY = true;
  io.callerSources = () => ({
    ancestors: () => [{ pid: 20, name: 'zsh' }, { pid: 1, name: 'launchd' }],
    agents: () => { throw new Error('the owner gate must not list panes'); },
    paneRootPid: () => { throw new Error('the owner gate must not read panes'); },
    env: {},
    stdinIsTTY: true,
  });
  return io;
}

function owner(place: Place): TestIo {
  return ownerAt(place.root);
}

function agentOf(place: Place, seat: string): string {
  return registerAgent(place.home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(place.root), seat, session: 'arena', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }).id;
}

function teamOf(place: Place): string {
  const id = teamIdOf(place.root);
  upsertTeam(place.home, id, { project: 'beacon', session: 'arena', root: place.root });
  return id;
}

describe('team grant --capabilities writes the standing record', () => {
  test('a seat grant carries the registered agent id, and the team file does not move', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const io = owner(place);
    expect(await runGrant(['helper', '--capabilities', 'gate,merge'], io, { home: place.home })).toBe(0);
    expect(io.out).toBe('grant: updated\n');
    expect(io.err).toBe('');
    expect(textAt(place)).toBe(TEAM_FILE);

    const { grants, revocations } = readGrants(place.home);
    expect(grants).toHaveLength(1);
    expect(revocations).toEqual([]);
    expect(grants[0]).toMatchObject({
      name: `seat-${id}`,
      grantor: 'owner',
      grantee: id,
      kind: 'seat',
      capabilities: ['gate', 'merge'],
      scope: [place.root],
      expires: null,
      generation: 1,
    });
    expect(covers(grants[0]!, { agentId: id })).toBe(true);
    expect(activeGrants(place.home, new Date())).toEqual(grants);
  });

  test('--scope, --expires and --name are carried into the record', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const io = owner(place);
    const argv = ['helper', '--capabilities', 'read,gate', '--scope', join(place.root, 'src'),
      '--expires', '2027-01-01T00:00:00.000Z', '--name', 'helper-read'];
    expect(await runGrant(argv, io, { home: place.home })).toBe(0);
    expect(readGrants(place.home).grants).toMatchObject([{
      name: 'helper-read',
      grantee: id,
      capabilities: ['gate', 'read'],
      scope: [join(place.root, 'src')],
      expires: '2027-01-01T00:00:00.000Z',
    }]);
  });

  test('a team grant names the project team id and covers seats added after it', async () => {
    const place = folder();
    const teamId = teamOf(place);
    const io = owner(place);
    expect(await runGrant(['@team', '--capabilities', 'gate'], io, { home: place.home })).toBe(0);
    const record = readGrants(place.home).grants[0]!;
    expect(record).toMatchObject({ name: `team-${teamId}`, kind: 'team', grantee: teamId });
    expect(covers(record, { teamId })).toBe(true);
    // The seat exists only after the grant, and the same record covers it.
    const late = agentOf(place, 'late-arrival');
    expect(covers(record, { agentId: late, teamId })).toBe(true);
  });

  test('a team grant never carries the four administrative names; the rule is named and nothing is written', async () => {
    const place = folder();
    teamOf(place);
    for (const name of ['grant', 'create', 'agree', 'leads']) {
      const io = owner(place);
      expect(await runGrant(['@team', '--capabilities', `gate,${name}`], io, { home: place.home })).toBe(2);
      expect(io.err).toContain(`\`${name}\``);
      expect(io.err).toContain('team grant never carries');
      expect(io.err).toStartWith('team grant: ');
    }
    expect(readGrants(place.home)).toEqual({ grants: [], revocations: [] });
  });

  test('an unregistered seat, an unregistered team and an @-word that is neither name nothing', async () => {
    const place = folder();
    const teamId = teamIdOf(place.root);
    const ghost = owner(place);
    expect(await runGrant(['ghost', '--capabilities', 'gate'], ghost, { home: place.home })).toBe(2);
    expect(ghost.err).toContain('"ghost"');
    expect(ghost.err).toContain(teamId);

    const unteamed = owner(place);
    expect(await runGrant(['@team', '--capabilities', 'gate'], unteamed, { home: place.home })).toBe(2);
    expect(unteamed.err).toContain(teamId);
    expect(unteamed.err).toContain('register the team');

    const stray = owner(place);
    expect(await runGrant(['@other', '--capabilities', 'gate'], stray, { home: place.home })).toBe(2);
    expect(stray.err).toContain('"@other"');
    expect(readGrants(place.home).grants).toEqual([]);
  });

  test('the capability list and the scope are checked as records, with the field named', async () => {
    const place = folder();
    agentOf(place, 'helper');
    const unknown = owner(place);
    expect(await runGrant(['helper', '--capabilities', 'deploy-all'], unknown, { home: place.home })).toBe(2);
    expect(unknown.err).toContain('deploy-all');
    expect(unknown.err).toContain('not a grantable capability');

    const outside = owner(place);
    const argv = ['helper', '--capabilities', 'read', '--scope', join(tmpdir(), 'elsewhere')];
    expect(await runGrant(argv, outside, { home: place.home })).toBe(2);
    expect(outside.err).toContain('outside the declared roots');
    expect(outside.err).toContain(place.root);
    expect(readGrants(place.home).grants).toEqual([]);
  });

  test('names that collide with the file forms or a revocation are refused naming the rule', async () => {
    const place = folder();
    agentOf(place, 'helper');
    for (const [name, needle] of [
      ['grant', 'team-file form'],
      ['delegate', 'team-file form'],
      ['revoke-x', 'reserved'],
      ['x'.repeat(58), 'too long for a revocation'],
      ['a/b', 'not one safe file name'],
    ] as const) {
      const io = owner(place);
      expect(await runGrant(['helper', '--capabilities', 'gate', '--name', name], io, { home: place.home })).toBe(2);
      expect(io.err).toContain(needle);
    }
    expect(readGrants(place.home).grants).toEqual([]);
  });

  test('a dry run explains the record and writes nothing at all', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const io = owner(place);
    expect(await runGrant(['helper', '--capabilities', 'gate', '--dry-run'], io, { home: place.home })).toBe(0);
    expect(io.out).toBe(`grant: would write the seat grant seat-${id} for helper (${id}): capabilities gate; scope ${place.root}; no expiry\n`);
    expect(fs.existsSync(grantsDir(place.home))).toBe(false);
    expect(readGrants(place.home)).toEqual({ grants: [], revocations: [] });

    const teamId = teamOf(place);
    const team = owner(place);
    expect(await runGrant(['@team', '--capabilities', 'gate', '--expires', '2027-01-01T00:00:00.000Z', '--dry-run'], team, { home: place.home })).toBe(0);
    expect(team.out).toBe(`grant: would write the team grant team-${teamId} for team ${teamId}: capabilities gate; scope ${place.root}; expires 2027-01-01T00:00:00.000Z\n`);
    expect(fs.existsSync(grantsDir(place.home))).toBe(false);
  });

  test('a re-grant under the same name is one record at a new generation', async () => {
    const place = folder();
    agentOf(place, 'helper');
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    expect(await runGrant(['helper', '--capabilities', 'gate,merge'], owner(place), { home: place.home })).toBe(0);
    const { grants } = readGrants(place.home);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ capabilities: ['gate', 'merge'], generation: 2 });
  });

  test('a non-owner is refused before anything is read, dev mode or not', async () => {
    const place = folder();
    const refused = testIo(place.root, { kind: 'owner-no-tty' });
    expect(await runGrant(['helper', '--capabilities', 'gate'], refused, { home: place.home })).toBe(1);
    expect(refused.err).toContain('only the owner runs this');
    expect(refused.err).toContain("unplaced (it doesn't run on a terminal)");
    expect(refused.out).toBe('');

    const withMode = testIo(place.root, { kind: 'owner-no-tty' });
    withMode.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runGrant(['helper', '--capabilities', 'gate'], withMode, { home: place.home })).toBe(1);
    expect(withMode.err).toBe(refused.err);
    expect(readGrants(place.home)).toEqual({ grants: [], revocations: [] });
  });

  test('the record path still needs a loadable team file', async () => {
    const place = folder();
    const bare = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-grant-levels-bare-')));
    made.push(bare);
    const io = ownerAt(bare);
    expect(await runGrant(['helper', '--capabilities', 'gate'], io, { home: place.home })).toBe(2);
    expect(io.err).toStartWith('team grant: ');
    expect(readGrants(place.home).grants).toEqual([]);
  });

  test('the file form is untouched: --scope alone still edits the team file', async () => {
    const place = folder();
    const io = owner(place);
    expect(await runGrant(['lead', '--scope', 'up,down'], io, { home: place.home })).toBe(0);
    expect(io.out).toBe('grant: updated\n');
    expect(textAt(place)).toContain('grant:\n  session: "arena"\n  seat: "lead"\n  scope: ["up","down"]\n');
    expect(readGrants(place.home)).toEqual({ grants: [], revocations: [] });
  });

  test('the invocation errors keep the file form\'s sentences and name the one-form flags', async () => {
    const place = folder();
    for (const [argv, needle] of [
      [[], 'a seat and --scope are required'],
      [['lead'], 'a seat and --scope are required'],
      [['helper', '--capabilities'], '--capabilities needs a value'],
      [['a', 'b', '--capabilities', 'gate'], 'one seat or @team is required'],
      [['lead', '--expires', '2027-01-01'], '--expires belongs to the --capabilities form'],
      [['lead', '--name', 'x'], '--name belongs to the --capabilities form'],
    ] as const) {
      const io = owner(place);
      expect(await runGrant([...argv], io, { home: place.home })).toBe(2);
      expect(io.err).toContain(needle);
      expect(io.err).toContain('Usage: team grant');
    }
    expect(textAt(place)).toBe(TEAM_FILE);
    expect(readGrants(place.home)).toEqual({ grants: [], revocations: [] });
  });
});

describe('team revoke <name> appends the revocation record', () => {
  test('the grant file is never edited and the pair stops admitting', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    const grantFile = join(grantsDir(place.home), `${name}.json`);
    const before = fs.readFileSync(grantFile);
    expect(activeGrants(place.home, new Date())).toHaveLength(1);

    const io = owner(place);
    expect(await runRevoke([name], io, { home: place.home })).toBe(0);
    expect(io.out).toBe('revoke: updated\n');
    expect(io.err).toBe('');
    expect(fs.readFileSync(grantFile).equals(before)).toBe(true);

    const { grants, revocations } = readGrants(place.home);
    expect(grants).toHaveLength(1);
    expect(revocations).toMatchObject([{ name: `revoke-${name}`, grant: name, grantGeneration: 1, by: 'owner' }]);
    expect(activeGrants(place.home, new Date())).toEqual([]);
  });

  test('revoking the same record again is an unchanged no-op, and a fresh grant under the name is a new record', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    expect(await runRevoke([name], owner(place), { home: place.home })).toBe(0);
    const again = owner(place);
    expect(await runRevoke([name], again, { home: place.home })).toBe(0);
    expect(again.out).toBe('revoke: unchanged\n');
    expect(readGrants(place.home).revocations).toHaveLength(1);

    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    const active = activeGrants(place.home, new Date());
    expect(active).toHaveLength(1);
    // The revocation is a generation of its own in the same sequence, so the revival is newer
    // than both; what the revocation named stays revoked.
    const secondGen = active[0]!.generation;
    expect(secondGen).toBeGreaterThan(1);

    const preview = owner(place);
    expect(await runRevoke([name, '--dry-run'], preview, { home: place.home })).toBe(0);
    expect(preview.out).toBe(
      `revoke: would revoke the grant ${name} at generation ${secondGen}, writing the record revoke-${name}-${secondGen}; nothing written\n`,
    );

    expect(await runRevoke([name], owner(place), { home: place.home })).toBe(0);
    expect(readGrants(place.home).revocations).toMatchObject([
      { name: `revoke-${name}-${secondGen}`, grant: name, grantGeneration: secondGen, by: 'owner' },
      { name: `revoke-${name}`, grant: name, grantGeneration: 1, by: 'owner' },
    ]);
    expect(activeGrants(place.home, new Date())).toEqual([]);
  });

  test('a revocation dry run explains and writes nothing', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    const io = owner(place);
    expect(await runRevoke([name, '--dry-run'], io, { home: place.home })).toBe(0);
    expect(io.out).toBe(`revoke: would revoke the grant ${name} at generation 1, writing the record revoke-${name}; nothing written\n`);
    expect(readGrants(place.home).revocations).toEqual([]);
    expect(activeGrants(place.home, new Date())).toHaveLength(1);
  });

  test('a bare word no grant holds stays the invocation error, and `grant` and `delegate` stay file forms', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);

    const ghost = owner(place);
    expect(await runRevoke(['ghost'], ghost, { home: place.home })).toBe(2);
    expect(ghost.err).toContain('Usage: team revoke');
    expect(ghost.err).toContain('no grant or delegate is named "ghost"');
    expect(ghost.err).toContain(`\`ls ${grantsDir(place.home)}\` shows the standing grants`);

    // A malformed file form keeps the general sentence: it names a form, not a word the
    // records could hold.
    const malformed = owner(place);
    expect(await runRevoke(['grant', 'extra'], malformed, { home: place.home })).toBe(2);
    expect(malformed.err).toContain('name grant, or delegate and its session/pane');

    // `team revoke grant` on a file with no grant section is the file form's no-op, not the
    // standing grant's revocation: the record still admits.
    const fileForm = owner(place);
    expect(await runRevoke(['grant'], fileForm, { home: place.home })).toBe(0);
    expect(fileForm.out).toBe('revoke: unchanged\n');
    expect(activeGrants(place.home, new Date())).toHaveLength(1);
  });

  test('the record form is owner-only too, and still needs the team file', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);

    const refused = testIo(place.root, { kind: 'owner-no-tty' });
    expect(await runRevoke([name], refused, { home: place.home })).toBe(1);
    expect(refused.err).toContain('only the owner runs this');
    expect(readGrants(place.home).revocations).toEqual([]);

    const bare = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-grant-levels-bare-')));
    made.push(bare);
    const io = ownerAt(bare);
    expect(await runRevoke([name], io, { home: place.home })).toBe(2);
    expect(io.err).toStartWith('team revoke: ');
    expect(readGrants(place.home).revocations).toEqual([]);
  });

  test('a revocation whose record name another grant holds is refused, naming the rule, and neither grant is touched', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    // Another grant's file already holds the name this revocation would take.
    const clash = writeGrant(place.home, {
      name: `revoke-${name}`,
      kind: 'seat',
      grantee: id,
      capabilities: ['read'],
      scope: ['~/Code/acme'],
      roots: ['~/Code/acme'],
    });
    expect(clash.ok).toBe(true);
    const grantFile = join(grantsDir(place.home), `${name}.json`);
    const clashFile = join(grantsDir(place.home), `revoke-${name}.json`);
    const grantBefore = fs.readFileSync(grantFile);
    const clashBefore = fs.readFileSync(clashFile);

    const io = owner(place);
    expect(await runRevoke([name], io, { home: place.home })).toBe(2);
    expect(io.err).toStartWith('team revoke: ');
    expect(io.err).toContain('a separate record');
    expect(io.err).toContain('never writes over');
    expect(io.out).toBe('');
    expect(fs.readFileSync(grantFile).equals(grantBefore)).toBe(true);
    expect(fs.readFileSync(clashFile).equals(clashBefore)).toBe(true);
    expect(readGrants(place.home).revocations).toEqual([]);
    expect(activeGrants(place.home, new Date())).toHaveLength(2);
  });

  test('a revocation the folder refuses to take is refused loudly and leaves the grant byte-identical', async () => {
    const place = folder();
    const id = agentOf(place, 'helper');
    const name = `seat-${id}`;
    expect(await runGrant(['helper', '--capabilities', 'gate'], owner(place), { home: place.home })).toBe(0);
    const grantFile = join(grantsDir(place.home), `${name}.json`);
    const before = fs.readFileSync(grantFile);

    // The folder takes no new file: the write fails, and the command reports it, never a success.
    fs.chmodSync(grantsDir(place.home), 0o500);
    try {
      const io = owner(place);
      expect(await runRevoke([name], io, { home: place.home })).toBe(1);
      expect(io.out).toBe('');
      expect(io.err).toStartWith('team revoke: ');
      expect(io.err).toMatch(/EACCES|permission denied/);
      expect(fs.readFileSync(grantFile).equals(before)).toBe(true);
      expect(readGrants(place.home).revocations).toEqual([]);
      expect(activeGrants(place.home, new Date())).toHaveLength(1);
    } finally {
      fs.chmodSync(grantsDir(place.home), 0o700);
    }
  });
});
