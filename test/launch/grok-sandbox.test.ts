// A Grok seat's sandbox profile: `[profiles.team-seat-<project>-<seat>]` in `$GROK_HOME/sandbox.toml`,
// written before the pane's command runs. The reading comes from the runs quoted in
// src/launch/grok-sandbox.ts: the profile is found by name under `$GROK_HOME`, its `read_write`
// entries are taken literally, and a profile Grok cannot find refuses the run (exit 1). Every
// scene here uses a synthetic `GROK_HOME`; nothing reads the machine's own Grok home.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerInbox } from '../../src/mcp/register.ts';
import { ownStartFolderProblem, seatStart } from '../../src/worktree/place.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import {
  grokHomeFor, grokSandboxOf, grokSandboxProfileName, settleGrokSandbox, withoutGrokSandbox, writeGrokSandbox, type GrokSandbox,
} from '../../src/launch/grok-sandbox.ts';
import { emptySession } from '../../src/state.ts';
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

/** The seat's own paths when it starts in `start`, a folder that is not the shared project root
 *  and not a git checkout. The launcher's hook file is not among them. */
function seatGrants(root: string, start: string): string[] {
  return [
    realpathSync(start),
    join(root, '.agents', 'send-drops', 'acme', 'grok-seat'),
    join(root, '.agents', 'messages', 'grok-seat'),
    join(root, '.agents', 'seat-state', 'acme', 'grok-seat'),
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
function world(project = 'acme'): { base: string; home: string; root: string; start: string; grokHome: string; sandbox: GrokSandbox } {
  const base = dir();
  const home = join(base, 'home');
  const root = join(base, 'project');
  const start = join(root, 'seat');
  const grokHome = join(base, 'grok-home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(start, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  process.env.GROK_HOME = grokHome;
  return { base, home, root, start, grokHome, sandbox: grokSandboxOf({ home, root, project, seat: 'grok-seat', session: 'acme', cwd: start }) };
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
    const { base, home, root, start, grokHome, sandbox } = world();
    expect(sandbox).toEqual({
      profile: 'team-seat-acme-grok-seat',
      file: join(grokHome, 'sandbox.toml'),
      readWrite: seatGrants(root, start),
      prepare: seatGrants(root, start).slice(1),
      retire: 'team-seat-acme',
      // The Grok home here sits outside the user home: the guard is its parent, so a linked
      // Grok home is refused before anything is written through it.
      guard: base,
    });
    expect(sandbox.readWrite).not.toContain(join(home, '.config', 'team'));
    expect(sandbox.readWrite).not.toContain(join(root, '.agents'));
    expect(sandbox.readWrite).not.toContain(join(root, '.agents', 'hooks', 'acme', 'grok-seat.json'));
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
    git(['pack-refs', '--all'], root);
    const tree = join(dirname(root), 'tree');
    git(['worktree', 'add', '-b', 'scene', tree], root);
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: tree, worktree: tree });
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], tree).trim();
    const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], tree).trim();
    expect(sandbox.readWrite).toContain(realpathSync(tree));
    for (const name of ['objects', 'refs', 'logs']) expect(sandbox.readWrite).toContain(join(realpathSync(common), name));
    expect(lstatSync(join(common, 'packed-refs')).isFile()).toBe(true);
    expect(sandbox.readWrite).not.toContain(join(realpathSync(common), 'packed-refs'));
    expect(sandbox.readWrite).toContain(realpathSync(gitDir));
    for (const wider of [common, realpathSync(common), join(common, 'hooks'), join(common, 'config'), join(common, 'info'), join(common, 'worktrees'), join(home, '.config', 'team'), join(root, '.agents')]) {
      expect(sandbox.readWrite).not.toContain(wider);
    }
  });
});

describe('writing the file', () => {
  test('a first launch creates the profile: it extends workspace and grants only the seat\'s own paths', () => {
    const { root, start, sandbox } = world();
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(readFileSync(sandbox.file, 'utf8')).toBe(
      `[profiles.team-seat-acme-grok-seat]\nextends = "workspace"\nread_write = ${JSON.stringify(seatGrants(root, start)).replaceAll(',', ', ')}\n`,
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
    const { root, start, sandbox } = world();
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
    expect(text).toContain(`read_write = ${JSON.stringify(seatGrants(root, start)).replaceAll(',', ', ')}`);
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
  function grokPlan(home: string, root: string, launch = 'grok', cwd = 'seat') {
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
        name: 'grok-seat', cli: 'grok', launch, cwd, label: 'grok-seat', stopped: false, rules: 'Rules.',
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

  test('a start at the shared project root is refused before a workspace is created', () => {
    const { home, root, grokHome } = world();
    const granted = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: root });
    expect(granted.readWrite).toContain(realpathSync(root));
    const plan = grokPlan(home, root, 'grok', '.');
    const refusal = plan.find((step) => step.do?.do === 'refuse')?.do;
    expect(refusal).toMatchObject({
      do: 'refuse',
      seat: 'grok-seat',
      why: 'its start folder is the shared project root, which would grant the whole checkout; give the seat its own worktree or clone',
    });
    expect(plan.some((step) => step.do?.do === 'launch' || step.do?.do === 'create')).toBe(false);
    expect(existsSync(join(grokHome, 'sandbox.toml'))).toBe(false);
  });

  test('writing the per-seat profile removes the project-wide table and keeps a quoted copy', () => {
    const { sandbox } = world();
    writeFileSync(sandbox.file, [
      'notes = """',
      '[profiles.team-seat-acme]',
      'read_write = ["/quoted"]',
      '"""',
      '[profiles.team-seat-acme]',
      'extends = "workspace"',
      'read_write = ["/wide"]',
      '[profiles.other]',
      'extends = "workspace"',
      '',
    ].join('\n'));
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text).toContain('[profiles.team-seat-acme]\nread_write = ["/quoted"]');
    expect(text).not.toContain('read_write = ["/wide"]');
    expect(text).toContain('[profiles.team-seat-acme-grok-seat]');
    expect(text).toContain('[profiles.other]');
    const parsed = Bun.TOML.parse(text) as { profiles: Record<string, unknown>; notes: string };
    expect(parsed.profiles['team-seat-acme']).toBeUndefined();
    expect(parsed.notes).toContain('[profiles.team-seat-acme]');
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

  function execute(sandbox: GrokSandbox, root = sandbox.readWrite[0]!): { runs: string[]; said: string[]; done: Promise<unknown>; existsAtRun: boolean[] } {
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

  for (const name of ['injected.json', 'packed-refs']) test(`directory-only settlement refuses a surviving file grant named ${name} before launch`, async () => {
    const { base, sandbox } = world();
    const file = join(base, name);
    writeFileSync(file, 'unchanged synthetic bytes\n');
    const scene = execute({ ...sandbox, readWrite: [...sandbox.readWrite, file] });
    await scene.done;
    expect(scene.runs).toEqual([]);
    expect(scene.said.join('')).toContain(`${file} is a file, and the launch needs a directory; nothing was launched`);
    expect(existsSync(sandbox.file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('unchanged synthetic bytes\n');
  });

  test('directory-only settlement accepts and prepares folders whose names end in .json', () => {
    const { base, sandbox } = world();
    const existing = join(base, 'worktree.json');
    const missing = join(base, 'seat.json');
    mkdirSync(existing);
    const settled = settleGrokSandbox({ ...sandbox, readWrite: [existing, missing], prepare: [missing] });
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error(settled.why);
    expect(settled.sandbox.readWrite).toEqual([existing, missing]);
    expect(lstatSync(missing).isDirectory()).toBe(true);
    expect(lstatSync(missing).mode & 0o777).toBe(0o700);
  });


  test('an uncovered start folder refuses execution without changing the profile', async () => {
    const { home, sandbox } = world();
    const lobby = join(home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
    const before = '# synthetic profile must remain unchanged\n'; writeFileSync(sandbox.file, before);
    const scene = execute(sandbox, lobby); await scene.done;
    expect(scene.runs).toEqual([]);
    expect(scene.said.join('')).toContain('own worktree');
    expect(readFileSync(sandbox.file, 'utf8')).toBe(before);
  });

  test('the profile is on disk before the pane\'s command runs', async () => {
    const { root, sandbox } = world();
    const scene = execute(sandbox);
    await scene.done;
    expect(scene.runs).toHaveLength(1);
    expect(scene.runs[0]).toContain('--sandbox team-seat-acme-grok-seat');
    expect(scene.existsAtRun).toEqual([true]);
    expect(readFileSync(sandbox.file, 'utf8')).toContain('[profiles.team-seat-acme-grok-seat]');
    expect(scene.said.join('')).not.toContain('sandbox profile was not written');
    const written = Bun.TOML.parse(readFileSync(sandbox.file, 'utf8')) as { profiles: Record<string, { read_write: string[] }> };
    for (const grant of written.profiles['team-seat-acme-grok-seat']!.read_write) {
      const held = lstatSync(grant);
      expect(held.isSymbolicLink()).toBe(false);
      expect(held.isDirectory()).toBe(true);
    }
    const state = join(root, '.agents', 'seat-state', 'acme', 'grok-seat');
    expect(lstatSync(state).isDirectory()).toBe(true);
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(written.profiles['team-seat-acme-grok-seat']!.read_write).not.toContain(join(root, '.agents', 'seat-state', 'acme'));
    expect(existsSync(join(state, 'state.json'))).toBe(false);
  });

  test('a profile that cannot be written refuses the seat and launches nothing', async () => {
    const { sandbox } = world();
    const target = join(dir(), 'elsewhere.toml');
    writeFileSync(target, '# untouched\n');
    symlinkSync(target, sandbox.file);
    const scene = execute(sandbox);
    await scene.done;
    expect(scene.runs).toEqual([]);
    const said = scene.said.join('');
    expect(said).toContain('left out: its sandbox profile was not written: a symbolic link; nothing was launched. Repair the sandbox file, then launch the seat again');
    expect(said).not.toContain('launched without it');
    expect(readFileSync(target, 'utf8')).toBe('# untouched\n');
  });

  test('a read-only sandbox file is left as it is and the seat is not launched', async () => {
    const { sandbox, grokHome } = world();
    writeFileSync(sandbox.file, 'keep exact bytes\n', { mode: 0o444 });
    chmodSync(grokHome, 0o555);
    try {
      const scene = execute(sandbox);
      await scene.done;
      expect(scene.runs).toEqual([]);
      const said = scene.said.join('');
      expect(said).toContain('its sandbox profile was not written:');
      expect(said).toContain('nothing was launched');
      expect(said).toContain('Repair the sandbox file, then launch the seat again');
      expect(said).not.toContain('launched without it');
      expect(readFileSync(sandbox.file, 'utf8')).toBe('keep exact bytes\n');
    } finally {
      chmodSync(grokHome, 0o700);
    }
  });

  test('packed-refs is omitted, and every written grant exists as a directory', () => {
    const { home, root, start } = world();
    const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init'], { cwd: root, env });
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: start });
    const packed = join(root, '.git', 'packed-refs');
    expect(sandbox.readWrite).not.toContain(packed);
    expect(existsSync(packed)).toBe(false);
    const logs = sandbox.readWrite.find((grant) => grant.endsWith('/logs'));
    if (logs !== undefined && existsSync(logs)) rmSync(logs, { recursive: true });
    const settled = settleGrokSandbox(sandbox);
    if (!settled.ok) throw new Error(settled.why);
    expect(settled.sandbox.readWrite).not.toContain(packed!);
    if (logs !== undefined) {
      expect(settled.sandbox.readWrite).toContain(logs);
      expect(lstatSync(logs).isDirectory()).toBe(true);
    }
    expect(writeGrokSandbox(settled.sandbox)).toEqual({ ok: true });
    const written = Bun.TOML.parse(readFileSync(sandbox.file, 'utf8')) as { profiles: Record<string, { read_write: string[] }> };
    for (const grant of written.profiles['team-seat-acme-grok-seat']!.read_write) {
      const held = lstatSync(grant);
      expect(held.isSymbolicLink()).toBe(false);
      expect(held.isDirectory()).toBe(true);
    }
  });

  test('a directory at packed-refs is never a grant and is left untouched', () => {
    const { home, root, start } = world();
    const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init'], { cwd: root, env });
    const packed = join(root, '.git', 'packed-refs');
    mkdirSync(packed);
    const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: start });
    expect(sandbox.readWrite).not.toContain(packed);
    const settled = settleGrokSandbox(sandbox);
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error(settled.why);
    expect(settled.sandbox.readWrite).not.toContain(packed);
    expect(lstatSync(packed).isDirectory()).toBe(true);
  });

  test('a file at the seat-state folder refuses the launch', async () => {
    const { root, sandbox } = world();
    const state = join(root, '.agents', 'seat-state', 'acme', 'grok-seat');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, 'not a folder\n');
    const scene = execute(sandbox);
    await scene.done;
    expect(scene.runs).toEqual([]);
    const said = scene.said.join('');
    expect(said).toContain(`${state} is a file, and the launch needs a directory`);
    expect(said).toContain('Repair that path and launch the seat again');
    expect(lstatSync(state).isFile()).toBe(true);
  });
});


describe('Grok start folders stay within the seat grants', () => {
  function scene(cwd: (w: ReturnType<typeof world>) => string, launch = 'grok') {
    const w = world();
    const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
    if (!checked.ok) throw new Error('invalid synthetic team');
    const start = cwd(w);
    const plan = upPlan({ root: w.root, home: w.home, team: checked.team, session: 'acme',
      sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [{
        name: 'grok-seat', cli: 'grok', launch, cwd: start, worktree: w.start,
        label: 'grok-seat', stopped: false, rules: 'Rules.', repairLine: 'repair synthetic seat',
      }] });
    return { ...w, plan };
  }
  for (const customProfile of [false, true]) test(`a lobby start refuses before workspace/profile writes, custom profile=${customProfile}`, () => {
    const w = scene(({ home }) => {
      const lobby = join(home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true }); return lobby;
    }, customProfile ? 'grok --sandbox own-profile' : 'grok');
    const refused = w.plan.find(step => step.do?.do === 'refuse')?.do;
    expect(refused?.do).toBe('refuse');
    if (refused?.do === 'refuse') expect(refused.why).toContain('own worktree');
    expect(w.plan.some(step => (step.do?.do === 'create' || step.do?.do === 'launch') && step.do.seat === 'grok-seat')).toBe(false);
    expect(existsSync(w.sandbox.file)).toBe(false);
  });
  test('an existing worktree does not lend a grant to an unrelated start folder', () => {
    const w = scene(({ base }) => { const other = join(base, 'elsewhere'); mkdirSync(other); return other; });
    expect(w.plan.some(step => step.do?.do === 'refuse')).toBe(true);
    expect(w.plan.some(step => step.do?.do === 'launch')).toBe(false);
  });
  test('a symlink inside the worktree that escapes it refuses by its real target', () => {
    const w = scene(({ base, start }) => {
      const outside = join(base, 'outside'); mkdirSync(outside);
      const link = join(start, 'escape'); symlinkSync(outside, link); return link;
    });
    expect(w.plan.some(step => step.do?.do === 'refuse')).toBe(true);
    expect(w.plan.some(step => step.do?.do === 'launch')).toBe(false);
  });
  test('a linked parent and a real child inside the worktree remain valid starts', () => {
    const w = scene(({ base, start }) => {
      mkdirSync(join(start, 'child'));
      const link = join(base, 'own-link'); symlinkSync(start, link); return join(link, 'child');
    });
    expect(w.plan.some(step => step.do?.do === 'refuse')).toBe(false);
    expect(w.plan.some(step => step.do?.do === 'launch')).toBe(true);
  });
  test('a sibling sharing the worktree name prefix is outside the grant', () => {
    const w = scene(({ start }) => { const sibling = start + '-other'; mkdirSync(sibling); return sibling; });
    expect(w.plan.some(step => step.do?.do === 'refuse')).toBe(true);
  });
  function placement() {
    const w = world();
    const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
    if (!checked.ok) throw new Error('invalid synthetic team');
    const lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
    const team = { ...checked.team, trust: [w.root, lobby], lobby };
    const start = join(w.base, 'own-worktree'); mkdirSync(start);
    const seat = { ...team.seats.find(s => s.name === 'grok-seat')!, cwd: start };
    return { ...w, start, lobby, team, seat };
  }
  test('placement keeps a Grok worker in its explicit own worktree instead of the lobby', () => {
    const w = placement();
    expect(seatStart(w.team, w.seat, w.root, w.home)).toEqual({ cwd: w.start });
  });

  for (const requested of ['lobby', 'root', 'unspecified', 'custom-lobby']) test(`Cursor placement refuses ${requested} instead of sharing the MCP file`, () => {
    const w = placement();
    let cwd = requested === 'root' ? w.root : requested === 'unspecified' ? '.' : w.lobby;
    let team = w.team;
    if (requested === 'custom-lobby') { cwd = join(w.base, 'custom-lobby'); mkdirSync(cwd); team = { ...team, lobby: cwd, trust: [...team.trust, cwd] }; }
    const placed = seatStart(team, { ...w.seat, cli: 'cursor', launch: 'cursor-agent', cwd }, w.root, w.home);
    expect('problem' in placed).toBe(true);
    if ('problem' in placed) expect(placed.problem).toContain('own worktree');
  });
  test('two Cursor placements keep distinct MCP registrations without writing the lobby', () => {
    const w = placement(), other = join(w.base, 'peer-worktree'); mkdirSync(other);
    const first = { ...w.seat, cli: 'cursor', launch: 'cursor-agent' };
    const second = { ...first, name: 'peer', cwd: other };
    const yaml = TEAM.replace('cli: grok', 'cli: cursor').replace('launch: grok', 'launch: cursor-agent') + '\n  - role: implementer\n    name: peer\n    cli: cursor\n    vendor: xai\n    model: Grok\n    version: "4.7"\n    launch: cursor-agent\n';
    const file = join(w.root, '.agents/team.yaml'); writeFileSync(file, yaml);
    const placeA = seatStart(w.team, first, w.root, w.home), placeB = seatStart(w.team, second, w.root, w.home);
    if ('problem' in placeA || 'problem' in placeB) throw new Error('own worktree placement refused');
    const register = (name: string, cwd: string) => registerInbox({ cli: 'cursor', seat: name, cwd, file, home: w.home, session: 'acme' });
    expect(register(first.name, placeA.cwd)).toEqual({ ok: true });
    const configA = join(placeA.cwd, '.cursor/mcp.json'), bytesA = readFileSync(configA);
    expect(register(second.name, placeB.cwd)).toEqual({ ok: true });
    expect(readFileSync(configA)).toEqual(bytesA);
    expect(placeA.cwd).toBe(w.start); expect(placeB.cwd).toBe(other);
    for (const [name, cwd] of [[first.name, placeA.cwd], [second.name, placeB.cwd]]) {
      const args = JSON.parse(readFileSync(join(cwd!, '.cursor/mcp.json'), 'utf8')).mcpServers['team-inbox'].args as string[];
      expect(args[args.indexOf('--seat') + 1]).toBe(name);
    }
    expect(existsSync(join(w.lobby, '.cursor/mcp.json'))).toBe(false);
  });

  test('two Cursor seats cannot claim the same own folder through different path spellings', () => {
    const w = placement(), link = join(w.base, 'peer-link'); symlinkSync(w.start, link);
    const first = { ...w.seat, cli: 'cursor', launch: 'cursor-agent' };
    const second = { ...first, name: 'peer', cwd: link };
    const team = { ...w.team, seats: [first, second] };
    for (const seat of team.seats) {
      const placed = seatStart(team, seat, w.root, w.home);
      expect('problem' in placed).toBe(true);
      if ('problem' in placed) expect(placed.problem).toContain('own worktree');
    }
  });

  test('the planner refuses a Cursor launch in the lobby before creating a workspace', () => {
    const w = placement();
    const plan = upPlan({ root: w.root, home: w.home, team: w.team, session: 'acme', sessionRunning: true,
      watchAlive: true, watchLabel: 'Watch', seats: [{ name: 'grok-seat', cli: 'cursor', launch: 'cursor-agent',
        cwd: w.lobby, label: 'worker', stopped: false, rules: 'Rules.', repairLine: 'repair' }] });
    expect(plan.some(step => step.do?.do === 'refuse')).toBe(true);
    expect(plan.some(step => (step.do?.do === 'create' || step.do?.do === 'launch') && step.do.seat === 'grok-seat')).toBe(false);
  });


  for (const cli of ['grok', 'cursor']) test(`${cli} fresh placement uses its recorded own worktree and never overrides an explicit lobby`, () => {
    const w = placement(), seat = { ...w.seat, cli, cwd: '.' };
    expect(seatStart(w.team, seat, w.root, w.home, undefined, w.start)).toEqual({ cwd: w.start });
    const explicit = seatStart(w.team, { ...seat, cwd: w.lobby }, w.root, w.home, undefined, w.start);
    expect('problem' in explicit).toBe(true);
  });

  for (const requested of ['lobby', 'root', 'unspecified', 'custom-lobby', 'linked-lobby']) test(`placement refuses ${requested} and names the own-worktree repair`, () => {
    const w = placement();
    let cwd = requested === 'root' ? w.root : requested === 'unspecified' ? '.' : w.lobby;
    let team = w.team;
    if (requested === 'custom-lobby') { cwd = join(w.base, 'custom-lobby'); mkdirSync(cwd); team = { ...team, lobby: cwd, trust: [...team.trust, cwd] }; }
    if (requested === 'linked-lobby') { cwd = join(w.base, 'linked-lobby'); symlinkSync(w.lobby, cwd); }
    const placed = seatStart(team, { ...w.seat, cwd }, w.root, w.home);
    expect('problem' in placed).toBe(true);
    if ('problem' in placed) expect(placed.problem).toContain('own worktree');
  });
});


describe('start folders cannot contain shared instruction folders', () => {
  for (const cli of ['grok', 'cursor']) for (const name of ['home', 'filesystem-root', 'project-parent', 'config-parent', 'custom-lobby-parent', 'linked-home']) {
    test(`${cli} refuses ${name} as an ancestor grant`, () => {
      const w = world();
      let lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
      let cwd = name === 'home' ? w.home : name === 'filesystem-root' ? '/' : name === 'config-parent' ? join(w.home, '.config') : w.base;
      if (name === 'custom-lobby-parent') { cwd = join(w.base, 'shared-start'); lobby = join(cwd, 'lobby'); mkdirSync(lobby, { recursive: true }); }
      if (name === 'linked-home') { cwd = join(w.base, 'home-alias'); symlinkSync(w.home, cwd); }
      const problem = ownStartFolderProblem({ cli, seat: 'worker', cwd, root: w.root, home: w.home, lobby, peers: [] });
      expect(problem).not.toBeNull();
      expect(problem).toContain('own worktree');
      expect(existsSync(w.sandbox.file)).toBe(false);
    });
  }
});


describe('a non-writing peer at the shared root does not own the worktree', () => {
  for (const cli of ['grok', 'cursor']) for (const linked of [false, true]) test(`${cli} can start below the project root beside a shared-root peer, alias=${linked}`, () => {
    const w = world(), lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
    let peerCwd = '.';
    if (linked) { peerCwd = join(w.base, 'root-alias'); symlinkSync(w.root, peerCwd); }
    expect(ownStartFolderProblem({ cli, seat: 'worker', cwd: w.start, root: w.root, home: w.home, lobby,
      peers: [{ name: 'lead', cli: 'claude-code', cwd: peerCwd }] })).toBeNull();
  });
  for (const peerCli of ['grok', 'cursor', 'claude-code']) test(`overlap with ${peerCli} outside the shared root is still refused`, () => {
    const w = world(), lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
    expect(ownStartFolderProblem({ cli: 'cursor', seat: 'worker', cwd: w.start, root: w.root, home: w.home, lobby,
      peers: [{ name: 'peer', cli: peerCli, cwd: w.start }] })).not.toBeNull();
  });
  test('fresh Grok placement below an unprotected project root keeps its explicit folder', () => {
    const w = world(), lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
    const checked = validateTeamFile(TEAM, { home: w.home, root: w.root }); if (!checked.ok) throw new Error('invalid synthetic team');
    const team = { ...checked.team, trust: [w.root, lobby], lobby, workspace: { ...checked.team.workspace, protected: [] } };
    const seat = { ...team.seats.find(s => s.name === 'grok-seat')!, cwd: w.start };
    expect(seatStart(team, seat, w.root, w.home)).toEqual({ cwd: w.start });
  });
});


describe('recorded peer placement is part of own-folder checks', () => {
  for (const cli of ['grok', 'cursor']) for (const source of ['worktree', 'start_cwd']) {
    test(`${cli} refuses a peer's recorded ${source}, including through an alias`, () => {
      const w = world();
      const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
      if (!checked.ok) throw new Error('invalid synthetic team');
      const target = join(w.base, 'occupied'); mkdirSync(target);
      const alias = join(w.base, 'occupied-link'); symlinkSync(target, alias);
      const peer = { ...checked.team.seats[0]!, cwd: '.' };
      const own = { ...checked.team.seats.find(s => s.name === 'grok-seat')!, cli, cwd: alias };
      const lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
      const team = { ...checked.team, trust: [w.root, w.base], lobby, seats: [peer, own] };
      const state = emptySession();
      if (source === 'worktree') state.worktrees['assigned-task'] = { seat: peer.name, path: target, branch: 'fix/task', setup: 'ok' };
      else state.seats[peer.name] = { stage: 'ready', start_cwd: target };
      const start = seatStart(team, own, w.root, w.home, undefined, undefined, state);
      expect('problem' in start).toBe(true);
      if ('problem' in start) expect(start.problem).toContain(`overlaps seat ${peer.name}`);
    });
  }
  for (const cli of ['grok', 'cursor']) test(`a single-seat ${cli} plan checks the other seats' recorded starts`, () => {
    const w = world();
    const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
    if (!checked.ok) throw new Error('invalid synthetic team');
    const target = join(w.base, 'occupied'); mkdirSync(target);
    const own = { name: 'grok-seat', cli, launch: cli === 'grok' ? 'grok' : 'cursor-agent', cwd: target,
      label: 'grok-seat', stopped: false, rules: 'Rules.', repairLine: 'repair' };
    const plan = upPlan({ root: w.root, home: w.home, team: checked.team, session: 'acme',
      sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [own],
      startFolders: [{ name: 'lead', cli: 'claude-code', cwd: target }] });
    expect(plan.some(step => step.do?.do === 'refuse')).toBe(true);
    expect(plan.some(step => step.do?.do === 'launch')).toBe(false);
  });
});


describe('placement is rechecked before launch writes', () => {
  for (const cli of ['grok', 'cursor']) for (const change of ['start-before-create', 'lobby-before-create', 'start-after-create', 'lobby-after-inbox']) {
    test(`${cli} refuses ${change} before inbox, rules, profile or command writes`, async () => {
      const w = world();
      const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
      if (!checked.ok) throw new Error('invalid synthetic team');
      const lobby = join(w.base, 'shared-lobby'); mkdirSync(lobby);
      const team = { ...checked.team, lobby };
      const plan = upPlan({ root: w.root, home: w.home, team, session: 'acme', sessionRunning: true,
        watchAlive: true, watchLabel: 'Watch', seats: [{ name: 'grok-seat', cli,
          launch: cli === 'grok' ? 'grok' : 'cursor-agent', cwd: w.start,
          label: 'grok-seat', stopped: false, rules: 'Rules.', repairLine: 'repair' }] });
      expect(plan.some(step => step.do?.do === 'launch')).toBe(true);
      const substituteStart = () => { renameSync(w.start, w.start + '-before'); symlinkSync(lobby, w.start); };
      if (change === 'start-before-create') substituteStart();
      if (change === 'lobby-before-create') { renameSync(lobby, lobby + '-before'); symlinkSync(w.start, lobby); }
      const writes: string[] = [];
      const host: Host = {
        startServer: () => true, sessionUp: () => true,
        createWorkspace: () => { writes.push('workspace'); if (change === 'start-after-create') substituteStart(); return { pane: 'pane-grok', workspace: 'ws-grok' }; },
        registerInbox: () => { writes.push('inbox'); if (change === 'lobby-after-inbox') { renameSync(lobby, lobby + '-before'); symlinkSync(w.start, lobby); } return { ok: true }; },
        deliverRules: async () => { writes.push('rules'); return true; },
        paneRun: () => { writes.push('command'); return true; },
        typeLine: () => false, renameAgent: () => true, closeWorkspace: () => { writes.push('close'); return true; },
        stopSession: () => true, kill: () => true, agentPanes: () => [], classify: () => 'idle',
        sleep: async () => {}, now: () => 0, allow: () => null, record: () => {}, running: () => {},
        drop: () => {}, say: () => {}, log: () => {},
      };
      const result = await executePlan(plan, 'acme', host);
      expect(result.dropped).toContain('grok-seat');
      expect(writes).toEqual(change === 'start-after-create' ? ['workspace'] : change === 'lobby-after-inbox' ? ['workspace', 'inbox'] : []);
      expect(existsSync(w.sandbox.file)).toBe(false);
      // Even prepared grants must not be created before the start check.
      for (const folder of w.sandbox.prepare) expect(existsSync(folder)).toBe(false);
    });
  }
});


test('a planned peer worktree replaces its shared-root declaration for overlap checks', () => {
  const w = world();
  const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
  if (!checked.ok) throw new Error('invalid synthetic team');
  const other = join(w.base, 'peer-tree'); mkdirSync(other);
  const team = { ...checked.team, seats: checked.team.seats.map(seat => seat.name === 'lead' ? { ...seat, cli: 'cursor', cwd: '.' } : seat) };
  const plan = upPlan({ root: w.root, home: w.home, team, session: 'acme', sessionRunning: true,
    watchAlive: true, watchLabel: 'Watch', seats: [
      { name: 'lead', cli: 'cursor', launch: 'cursor-agent', cwd: '.', worktree: other, stage: 'ready',
        label: 'lead', stopped: false, rules: 'Rules.', repairLine: 'repair', pane: 'peer-pane' },
      { name: 'grok-seat', cli: 'grok', launch: 'grok', cwd: w.start, worktree: w.start,
        label: 'grok-seat', stopped: false, rules: 'Rules.', repairLine: 'repair' },
    ] });
  expect(plan.some(step => step.do?.do === 'refuse' && step.do.seat === 'grok-seat')).toBe(false);
  expect(plan.some(step => step.do?.do === 'launch' && step.do.seat === 'grok-seat')).toBe(true);
});


describe('in-place restore proves the folder the pane will reuse', () => {
  for (const cli of ['grok', 'cursor']) for (const kind of ['own', 'unknown', 'lobby', 'different-own']) {
    test(`${cli} in-place start ${kind}`, () => {
      const w = world(), own = join(w.base, 'own-tree'); mkdirSync(own);
      const lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
      const other = join(w.base, 'other-tree'); mkdirSync(other);
      const checked = validateTeamFile(TEAM, { home: w.home, root: w.root });
      if (!checked.ok) throw new Error('invalid synthetic team');
      const plan = upPlan({ root: w.root, home: w.home, team: { ...checked.team, lobby }, session: 'acme',
        sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [{
          name: 'grok-seat', cli, launch: cli === 'grok' ? 'grok' : 'cursor-agent', cwd: own, worktree: own,
          ...(kind === 'unknown' ? {} : { startCwd: kind === 'own' ? own : kind === 'lobby' ? lobby : other }),
          label: 'grok-seat', stopped: false, rules: 'Rules.', repairLine: 'repair', pane: 'own-pane',
          repair: { pane: 'own-pane', workspace: 'own-workspace', launched: { shell: 1, cli: [2] }, cli, ownLine: {} },
        }] });
      expect(plan.some(s => s.do?.do === 'launch')).toBe(kind === 'own');
      expect(plan.some(s => s.do?.do === 'relaunch')).toBe(kind === 'own');
      expect(plan.find(s => s.do?.do === 'refuse' || s.do?.do === 'relaunch')?.do?.do).toBe(kind === 'own' ? 'relaunch' : 'refuse');
    });
  }
});


for (const cli of ['grok', 'cursor']) test(`${cli} rechecks a reused pane's recorded folder alias`, () => {
  const w = world(), own = join(w.base, 'own'); mkdirSync(own);
  const lobby = join(w.home, '.config/team/lobby'); mkdirSync(lobby, { recursive: true });
  const alias = join(w.base, 'recorded-start'); symlinkSync(own, alias);
  const input = { cli, seat: 'worker', cwd: own, inPlaceCwd: alias, root: w.root, home: w.home, lobby, peers: [] };
  expect(ownStartFolderProblem(input)).toBeNull();
  renameSync(alias, alias + '-before'); symlinkSync(lobby, alias);
  expect(ownStartFolderProblem(input)).toContain('own worktree');
});
