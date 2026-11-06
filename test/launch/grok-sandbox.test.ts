// A Grok seat's sandbox profile: `[profiles.team-seat-<project>-<seat>]` in `$GROK_HOME/sandbox.toml`,
// written before the pane's command runs. The reading comes from the runs quoted in
// src/launch/grok-sandbox.ts: the profile is found by name under `$GROK_HOME`, its `read_write`
// entries are taken literally, and a profile Grok cannot find refuses the run (exit 1). Every
// scene here uses a synthetic `GROK_HOME`; nothing reads the machine's own Grok home.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import {
  grokHomeFor, grokSandboxOf, grokSandboxProfileName, withoutGrokSandbox, writeGrokSandbox, type GrokSandbox,
} from '../../src/launch/grok-sandbox.ts';
import { upPlan, type Step } from '../../src/launch/plan.ts';
import { writePrivateAtomic } from '../../src/launch/private-file.ts';
import { gitEnv } from '../helpers.ts';

const FLAGS = "--trust --permission-mode auto --allow 'Bash(bun *)' --allow 'Bash(team *)' --allow 'Bash(git *)'";

const TEAM = `format: 1
project: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: grok-seat
    label: grok-seat
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok
`;

const made: string[] = [];
const ambientGrokHome = process.env.GROK_HOME;

/** The seat's own paths when the seat starts at a checkout that is not a git repository. */
function seatGrants(root: string): string[] {
  return [
    realpathSync(root),
    join(root, '.agents', 'send-drops', 'acme', 'grok-seat'),
    join(root, '.agents', 'messages', 'grok-seat'),
    join(root, '.agents', 'seat-state', 'acme', 'grok-seat.json'),
    join(root, '.agents', 'hooks', 'acme', 'grok-seat.json'),
  ];
}

function dir(prefix = 'grok-sandbox-'): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => {
  if (ambientGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = ambientGrokHome;
});

/** A home, a project root and a Grok home of their own; the environment Grok reads names the
 *  last, so `grokSandboxOf` resolves exactly the file this scene reads back. */
function world(project = 'acme'): { base: string; home: string; root: string; grokHome: string; sandbox: GrokSandbox } {
  const base = dir();
  const home = join(base, 'home');
  const root = join(base, 'project');
  const grokHome = join(base, 'grok-home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  process.env.GROK_HOME = grokHome;
  return { base, home, root, grokHome, sandbox: grokSandboxOf({ home, root, project, seat: 'grok-seat', session: 'acme', cwd: root }) };
}

describe('the profile name and the file it lives in', () => {
  test('the name is team-seat-<project>-<seat>, in TOML bare-key characters, and never empty', () => {
    expect(grokSandboxProfileName('acme', 'grok-seat')).toBe('team-seat-acme-grok-seat');
    expect(grokSandboxProfileName('Acme Web', 'builder.1')).toBe('team-seat-Acme-Web-builder-1');
    expect(grokSandboxProfileName('acme/web.git', 'seat')).toBe('team-seat-acme-web-git-seat');
    expect(grokSandboxProfileName('  ', 'grok-seat')).toBe('team-seat-grok-seat');
    expect(grokSandboxProfileName('acme', '--')).toBe('team-seat-acme');
    expect(grokSandboxProfileName('  ', '')).toBe('team-seat');
    expect(grokSandboxProfileName('--', '--')).toBe('team-seat');
  });

  test('the Grok home is an absolute GROK_HOME, else ~/.grok', () => {
    const home = '/home/owner';
    expect(grokHomeFor(home, {})).toBe('/home/owner/.grok');
    expect(grokHomeFor(home, { GROK_HOME: '/srv/grok' })).toBe('/srv/grok');
    expect(grokHomeFor(home, { GROK_HOME: '  /srv/grok  ' })).toBe('/srv/grok');
    // A relative GROK_HOME is resolved by Grok against the pane's folder, which is not known
    // here: the default is written instead of guessing the pane.
    expect(grokHomeFor(home, { GROK_HOME: 'relative/grok' })).toBe('/home/owner/.grok');
    expect(grokHomeFor(home, { GROK_HOME: '  ' })).toBe('/home/owner/.grok');
  });

  test('a launch names its file and only the seat\'s own paths', () => {
    const { base, home, root, grokHome, sandbox } = world();
    expect(sandbox).toEqual({
      profile: 'team-seat-acme-grok-seat',
      file: join(grokHome, 'sandbox.toml'),
      readWrite: seatGrants(root),
      // The Grok home here sits outside the user home: the guard is its parent, so a linked
      // Grok home is refused before anything is written through it.
      guard: base,
    });
    expect(sandbox.readWrite).not.toContain(join(home, '.config', 'team'));
    expect(sandbox.readWrite).not.toContain(join(root, '.agents'));
  });

  test('a folder reached through a link is granted by its target, and the team config directory is not', () => {
    const base = dir();
    const home = join(base, 'home');
    const root = join(base, 'project');
    const state = join(base, 'state');
    const messages = join(base, 'messages');
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(state);
    mkdirSync(messages);
    symlinkSync(state, join(home, '.config', 'team'));
    symlinkSync(messages, join(root, '.agents', 'messages'));
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: root, grokHome: join(home, '.grok') });
    expect(sandbox.readWrite).toContain(join(realpathSync(messages), 'grok-seat'));
    expect(sandbox.readWrite).not.toContain(realpathSync(state));
    expect(sandbox.readWrite).not.toContain(join(home, '.config', 'team'));
  });

  test('the lobby is not a sandbox grant, and the seat is not moved', () => {
    const { home, root } = world();
    // The lobby is where a Grok seat starts, under the shared team config directory.
    const lobby = join(home, '.config', 'team', 'lobbies', 'acme');
    mkdirSync(lobby, { recursive: true });
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: lobby });
    expect(sandbox.readWrite).not.toContain(realpathSync(lobby));
    expect(sandbox.readWrite.some((grant) => grant === realpathSync(join(home, '.config', 'team')) || grant.startsWith(`${realpathSync(join(home, '.config', 'team'))}/`))).toBe(false);
  });

  test('a linked worktree grants its own git paths and refuses the wider ones', () => {
    const { home, root } = world();
    const env = {
      ...gitEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Synthetic',
      GIT_AUTHOR_EMAIL: 'synthetic@example.com',
      GIT_COMMITTER_NAME: 'Synthetic',
      GIT_COMMITTER_EMAIL: 'synthetic@example.com',
    };
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    git(['init'], root);
    writeFileSync(join(root, 'readme'), 'scene\n');
    git(['add', 'readme'], root);
    git(['commit', '-m', 'scene'], root);
    const tree = join(dirname(root), 'tree');
    git(['worktree', 'add', '-b', 'scene', tree], root);
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: tree, worktree: tree });
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], tree).trim();
    const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], tree).trim();
    expect(sandbox.readWrite).toContain(realpathSync(tree));
    for (const name of ['objects', 'refs', 'logs', 'packed-refs']) expect(sandbox.readWrite).toContain(join(realpathSync(common), name));
    expect(sandbox.readWrite).toContain(realpathSync(gitDir));
    for (const wider of [common, realpathSync(common), join(common, 'hooks'), join(common, 'config'), join(common, 'info'), join(common, 'worktrees'), join(home, '.config', 'team'), join(root, '.agents')]) {
      expect(sandbox.readWrite).not.toContain(wider);
    }
  });
});

describe('writing the file', () => {
  test('a first launch creates the profile: it extends workspace and grants only the seat\'s own paths', () => {
    const { root, sandbox } = world();
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(readFileSync(sandbox.file, 'utf8')).toBe(
      `[profiles.team-seat-acme-grok-seat]\nextends = "workspace"\nread_write = ${JSON.stringify(seatGrants(root)).replaceAll(',', ', ')}\n`,
    );
  });

  test('an existing file keeps its other profiles, comments and keys', () => {
    const { sandbox } = world();
    const before = '# mine\n[profiles.other]\nextends = "workspace"\ndeny = ["/etc"]\n';
    writeFileSync(sandbox.file, before);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect(text).toContain('[profiles.team-seat-acme-grok-seat]\nextends = "workspace"\n');
    expect(text.split('[profiles.other]')).toHaveLength(2);
  });

  test('an existing profile is updated in place, a multi-line array replaced whole', () => {
    const { home, root, sandbox } = world();
    writeFileSync(sandbox.file, [
      '[profiles.team-seat-acme-grok-seat]',
      'extends = "workspace"',
      'read_write = [',
      '  "/old/one",',
      '  "/old/two",',
      ']',
      '# a comment stays',
      'deny = ["/etc"]',
      '',
      '[profiles.other]',
      'extends = "workspace"',
      '',
    ].join('\n'));
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text).toContain(`read_write = ${JSON.stringify(seatGrants(root)).replaceAll(',', ', ')}`);
    expect(text).not.toContain('/old/one');
    expect(text).toContain('# a comment stays\ndeny = ["/etc"]');
    expect(text.split('[profiles.team-seat-acme-grok-seat]')).toHaveLength(2);
    expect(text.split('[profiles.other]')).toHaveLength(2);
  });

  test('a quoted table header is the same profile, not a second one', () => {
    const { sandbox } = world();
    writeFileSync(sandbox.file, '[profiles."team-seat-acme-grok-seat"]\nextends = "workspace"\n');
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text.split('profiles.')).toHaveLength(2);
    expect(text).toContain('read_write = [');
  });

  for (const header of ['[profiles.team-seat-acme-grok-seat] # keep this table comment', '[ profiles . "team-seat-acme-grok-seat" ]']) {
    test(`a valid table header in another spelling is updated, never duplicated: ${header}`, () => {
      const { sandbox } = world();
      writeFileSync(sandbox.file, `${header}\nextends = "old"\nread_write = ["/old"]\ncustom = "kept"\n`);
      expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
      const text = readFileSync(sandbox.file, 'utf8');
      const parsed = Bun.TOML.parse(text) as { profiles: Record<string, any> };
      // A second table header would make the whole file unparseable ("Cannot redefine table");
      // the parsed file is the proof only one profile table stands.
      expect(Object.keys(parsed.profiles)).toEqual(['team-seat-acme-grok-seat']);
      expect(parsed.profiles['team-seat-acme-grok-seat']?.read_write).toEqual([...sandbox.readWrite]);
      expect(parsed.profiles['team-seat-acme-grok-seat']?.custom).toBe('kept');
      expect(parsed.profiles['team-seat-acme-grok-seat']?.extends).toBe('workspace');
    });
  }

  test('a header-looking line inside a multi-line string is text: only the real table is updated', () => {
    const { sandbox } = world();
    const before = 'notes = """\n[profiles.team-seat-acme-grok-seat]\nextends = "quoted prose"\nread_write = ["not a grant"]\n"""\n[profiles.team-seat-acme-grok-seat]\nextends = "old"\nread_write = ["/old"]\ncustom = "real table field"\n';
    writeFileSync(sandbox.file, before);
    const original = Bun.TOML.parse(before) as { notes: string };
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    const parsed = Bun.TOML.parse(text) as { notes: string; profiles: Record<string, any> };
    expect(parsed.notes).toBe(original.notes);
    expect(parsed.profiles['team-seat-acme-grok-seat']).toMatchObject({
      extends: 'workspace',
      read_write: [...sandbox.readWrite],
      custom: 'real table field',
    });
    // The rewrite is done: a second launch writes nothing.
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(readFileSync(sandbox.file, 'utf8')).toBe(text);
  });

  test('a header-looking line inside a multi-line literal string is text too', () => {
    const { sandbox } = world();
    const before = "notes = '''\n[profiles.team-seat-acme-grok-seat]\nextends = \"kept prose\"\nread_write = [\"not a grant\"]\n'''\n[profiles.team-seat-acme-grok-seat]\nextends = \"old\"\nread_write = [\"/old\"]\n";
    writeFileSync(sandbox.file, before);
    const original = Bun.TOML.parse(before) as { notes: string };
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const parsed = Bun.TOML.parse(readFileSync(sandbox.file, 'utf8')) as { notes: string; profiles: Record<string, any> };
    expect(parsed.notes).toBe(original.notes);
    expect(parsed.profiles['team-seat-acme-grok-seat']).toMatchObject({ extends: 'workspace', read_write: [...sandbox.readWrite] });
  });

  test('a field-looking line inside a string in the real table is text: the real field is updated', () => {
    const { sandbox } = world();
    const before = '[profiles.team-seat-acme-grok-seat]\nnote = """\nextends = "quoted"\nread_write = ["not a grant"]\ncustom = "inside"\n"""\nextends = "old"\nread_write = ["/old"]\ncustom = "real"\n';
    writeFileSync(sandbox.file, before);
    const original = Bun.TOML.parse(before) as { profiles: Record<string, any> };
    expect(original.profiles['team-seat-acme-grok-seat']?.note).toContain('extends = "quoted"');
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const parsed = Bun.TOML.parse(readFileSync(sandbox.file, 'utf8')) as { profiles: Record<string, any> };
    expect(parsed.profiles['team-seat-acme-grok-seat']?.note).toBe(original.profiles['team-seat-acme-grok-seat']?.note);
    expect(parsed.profiles['team-seat-acme-grok-seat']).toMatchObject({
      extends: 'workspace',
      read_write: [...sandbox.readWrite],
      custom: 'real',
    });
  });

  test('the replacement is private whatever the old mode was, and leaves no temporary file', () => {
    const { sandbox } = world();
    writeFileSync(sandbox.file, '[profiles.team-seat-acme-grok-seat]\nextends = "old"\nread_write = ["/old"]\n');
    chmodSync(sandbox.file, 0o644);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(statSync(sandbox.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(sandbox.file)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  test('a replacement that cannot be renamed leaves the original and no temporary file', () => {
    const { sandbox } = world();
    // A directory where the file belongs: the temporary is written and the rename cannot replace
    // the directory, so the failure must clean up after itself.
    mkdirSync(sandbox.file);
    writeFileSync(join(sandbox.file, 'kept'), 'kept');
    expect(() => writePrivateAtomic(sandbox.file, 'replacement', sandbox.guard)).toThrow();
    expect(readFileSync(join(sandbox.file, 'kept'), 'utf8')).toBe('kept');
    expect(readdirSync(dirname(sandbox.file)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  test('a file that does not parse is left byte for byte and the launch hears why', () => {
    const { sandbox } = world();
    const broken = '[profiles.team-seat-acme-grok-seat\nextends = "workspace"\n';
    writeFileSync(sandbox.file, broken);
    const written = writeGrokSandbox(sandbox);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.why).toContain('not valid TOML');
    expect(readFileSync(sandbox.file, 'utf8')).toBe(broken);
  });

  test('a file whose profiles table is inline is not extended into an unparseable file', () => {
    const { sandbox } = world();
    const before = 'profiles = { other = { extends = "workspace" } }\n';
    writeFileSync(sandbox.file, before);
    const written = writeGrokSandbox(sandbox);
    // Appending `[profiles.team-seat-acme-grok-seat]` would be "Cannot extend inline table 'profiles'".
    expect(written.ok).toBe(false);
    expect(readFileSync(sandbox.file, 'utf8')).toBe(before);
  });

  test('a profile defined as an inline value under [profiles] is reported, not overwritten', () => {
    const { sandbox } = world();
    const before = '[profiles]\nteam-seat-acme-grok-seat = { extends = "workspace" }\n';
    writeFileSync(sandbox.file, before);
    const written = writeGrokSandbox(sandbox);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.why).toContain('profiles.team-seat-acme-grok-seat');
    expect(readFileSync(sandbox.file, 'utf8')).toBe(before);
  });

  test('a file that already holds the profile is not written again', () => {
    const { sandbox } = world();
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const once = readFileSync(sandbox.file, 'utf8');
    // A write through the symlink guard would fail on a read-only file; `ok: true` with the
    // same bytes is the proof the second launch wrote nothing.
    chmodSync(sandbox.file, 0o400);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(readFileSync(sandbox.file, 'utf8')).toBe(once);
  });

  test('a symbolic link is refused, and the file it points at is untouched', () => {
    const { sandbox } = world();
    const target = join(dir(), 'elsewhere.toml');
    writeFileSync(target, '# untouched\n');
    symlinkSync(target, sandbox.file);
    const written = writeGrokSandbox(sandbox);
    expect(written).toEqual({ ok: false, why: 'a symbolic link' });
    expect(readFileSync(target, 'utf8')).toBe('# untouched\n');
  });

  test('a linked Grok home is refused before anything is written through it', () => {
    const base = dir();
    const home = join(base, 'home');
    const root = join(base, 'project');
    const real = join(base, 'real-grok');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(real);
    symlinkSync(real, join(base, 'grok-home'));
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', grokHome: join(base, 'grok-home') });
    expect(sandbox.guard).toBe(base);
    const written = writeGrokSandbox(sandbox);
    expect(written).toEqual({ ok: false, why: 'a symbolic link' });
    expect(existsSync(join(real, 'sandbox.toml'))).toBe(false);
  });

  test('a linked .grok under the user home is refused', () => {
    const base = dir();
    const home = join(base, 'home');
    const root = join(base, 'project');
    const real = join(base, 'real-grok');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(real);
    symlinkSync(real, join(home, '.grok'));
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', grokHome: join(home, '.grok') });
    expect(sandbox.guard).toBe(home);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: false, why: 'a symbolic link' });
    expect(existsSync(join(real, 'sandbox.toml'))).toBe(false);
  });
});

describe('taking the flag off a line whose profile was not written', () => {
  test('only this run\'s own --sandbox pair is removed, in either spelling', () => {
    expect(withoutGrokSandbox(`AGENT_UNATTENDED=1 grok ${FLAGS} --sandbox team-seat-acme-grok-seat --rules Rules.`, 'team-seat-acme-grok-seat'))
      .toBe(`AGENT_UNATTENDED=1 grok ${FLAGS} --rules Rules.`);
    expect(withoutGrokSandbox('grok --sandbox=team-seat-acme-grok-seat --rules R', 'team-seat-acme-grok-seat'))
      .toBe('grok --rules R');
  });

  test('a line naming another profile is left as it is', () => {
    expect(withoutGrokSandbox('grok --sandbox team-seat-other --rules R', 'team-seat-acme-grok-seat'))
      .toBe('grok --sandbox team-seat-other --rules R');
    expect(withoutGrokSandbox('grok --sandbox team-seat-acme-2 --rules R', 'team-seat-acme-grok-seat'))
      .toBe('grok --sandbox team-seat-acme-2 --rules R');
  });

  test('a prompt quoting the same words keeps them, and only the real pair is removed', () => {
    // The option this run appended is an argv pair. The same text inside a quoted prompt is one
    // argument, and removing characters from it would rewrite what the CLI is asked to do.
    const single = `grok -p 'preserve --sandbox team-seat-acme-grok-seat in this quoted prompt' --sandbox team-seat-acme-grok-seat`;
    expect(withoutGrokSandbox(single, 'team-seat-acme-grok-seat'))
      .toBe(`grok -p 'preserve --sandbox team-seat-acme-grok-seat in this quoted prompt'`);
    const double = 'grok -p "preserve --sandbox team-seat-acme-grok-seat here" --sandbox=team-seat-acme-grok-seat';
    expect(withoutGrokSandbox(double, 'team-seat-acme-grok-seat'))
      .toBe('grok -p "preserve --sandbox team-seat-acme-grok-seat here"');
  });
});

describe('the plan and the launch', () => {
  function grokPlan(home: string, root: string, launch = 'grok') {
    const checked = validateTeamFile(TEAM, { home, root });
    if (!checked.ok) throw new Error(checked.errors.map((error) => error.message).join('; '));
    return upPlan({
      root,
      session: 'acme',
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'Watch · acme',
      home,
      team: checked.team,
      seats: [{
        name: 'grok-seat', cli: 'grok', launch, cwd: '.', label: 'grok-seat', stopped: false, rules: 'Rules.',
        repairLine: '`team remove grok-seat --keep` then `team add grok-seat`',
      }],
    });
  }

  test('a Grok seat\'s plan names the profile, carries the write, and writes nothing yet', () => {
    const { home, root, grokHome, sandbox } = world();
    const plan = grokPlan(home, root);
    const launch = plan.find((step) => step.do?.do === 'launch')?.do;
    if (launch?.do !== 'launch') throw new Error('the plan has no launch step');
    expect(launch.command).toBe(`AGENT_UNATTENDED=1 grok ${FLAGS} --sandbox team-seat-acme-grok-seat --rules Rules.`);
    expect(launch.grokSandbox).toEqual(sandbox);
    expect(existsSync(join(grokHome, 'sandbox.toml'))).toBe(false);
  });

  test('a launch line naming its own --sandbox keeps it, and the plan carries no write', () => {
    const { home, root, grokHome } = world();
    const plan = grokPlan(home, root, 'grok --sandbox mine');
    const launch = plan.find((step) => step.do?.do === 'launch')?.do;
    if (launch?.do !== 'launch') throw new Error('the plan has no launch step');
    expect(launch.command).toContain('--sandbox mine');
    expect(launch.command).not.toContain('team-seat-acme-grok-seat');
    expect(launch.grokSandbox).toBeUndefined();
    expect(existsSync(join(grokHome, 'sandbox.toml'))).toBe(false);
  });

  function execute(sandbox: GrokSandbox, root = '.'): { runs: string[]; said: string[]; done: Promise<unknown>; existsAtRun: boolean[] } {
    const runs: string[] = [];
    const said: string[] = [];
    const existsAtRun: boolean[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'pane-grok', workspace: 'ws-grok' }),
      paneRun: (_session, _pane, command) => {
        runs.push(command);
        existsAtRun.push(existsSync(sandbox.file));
        return true;
      },
      typeLine: () => false,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { said.push(line); },
      log: () => {},
    };
    const steps: Step[] = [
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'launch', seat: 'grok-seat', label: 'grok-seat', cli: 'grok', cwd: root,
          command: `AGENT_UNATTENDED=1 grok ${FLAGS} --sandbox ${sandbox.profile} --rules Rules.`,
          pane: 'pane-grok', grokSandbox: sandbox,
        },
      },
      { kind: 'skip', text: 'grok-seat: ready', do: { do: 'ready', seat: 'grok-seat', rules: 'option' } },
    ];
    return { runs, said, done: executePlan(steps, 'acme', host), existsAtRun };
  }

  test('the profile is on disk before the pane\'s command runs', async () => {
    const { sandbox } = world();
    const scene = execute(sandbox);
    await scene.done;
    expect(scene.runs).toHaveLength(1);
    expect(scene.runs[0]).toContain('--sandbox team-seat-acme-grok-seat');
    expect(scene.existsAtRun).toEqual([true]);
    expect(readFileSync(sandbox.file, 'utf8')).toContain('[profiles.team-seat-acme-grok-seat]');
    expect(scene.said.join('')).not.toContain('sandbox profile was not written');
  });

  test('a profile that cannot be written takes the flag off the line and the seat still launches', async () => {
    const { sandbox } = world();
    const target = join(dir(), 'elsewhere.toml');
    writeFileSync(target, '# untouched\n');
    symlinkSync(target, sandbox.file);
    const scene = execute(sandbox);
    await scene.done;
    expect(scene.runs).toHaveLength(1);
    expect(scene.runs[0]).toContain('AGENT_UNATTENDED=1 grok');
    expect(scene.runs[0]).not.toContain('--sandbox');
    expect(scene.said.join('')).toContain('its sandbox profile was not written: a symbolic link; launched without it');
    expect(readFileSync(target, 'utf8')).toBe('# untouched\n');
  });
});
