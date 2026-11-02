// A Grok seat's sandbox profile: `[profiles.team-seat-<project>]` in `$GROK_HOME/sandbox.toml`,
// written before the pane's command runs. The reading comes from the runs quoted in
// src/launch/grok-sandbox.ts: the profile is found by name under `$GROK_HOME`, its `read_write`
// entries are taken literally, and a profile Grok cannot find refuses the run (exit 1). Every
// scene here uses a synthetic `GROK_HOME`; nothing reads the machine's own Grok home.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import {
  grokHomeFor, grokSandboxOf, grokSandboxProfileName, withoutGrokSandbox, writeGrokSandbox, type GrokSandbox,
} from '../../src/launch/grok-sandbox.ts';
import { upPlan, type Step } from '../../src/launch/plan.ts';

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
  return { base, home, root, grokHome, sandbox: grokSandboxOf({ home, root, project }) };
}

describe('the profile name and the file it lives in', () => {
  test('the name is team-seat-<project>, in TOML bare-key characters, and never empty', () => {
    expect(grokSandboxProfileName('acme')).toBe('team-seat-acme');
    expect(grokSandboxProfileName('Acme Web')).toBe('team-seat-Acme-Web');
    expect(grokSandboxProfileName('acme/web.git')).toBe('team-seat-acme-web-git');
    expect(grokSandboxProfileName('  ')).toBe('team-seat');
    expect(grokSandboxProfileName('--')).toBe('team-seat');
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

  test('a launch names its file and the two folders the seat writes', () => {
    const { base, home, root, grokHome, sandbox } = world();
    expect(sandbox).toEqual({
      profile: 'team-seat-acme',
      file: join(grokHome, 'sandbox.toml'),
      readWrite: [join(home, '.config', 'team'), join(root, '.agents')],
      // The Grok home here sits outside the user home: the guard is its parent, so a linked
      // Grok home is refused before anything is written through it.
      guard: base,
    });
  });

  test('a folder reached through a link is granted by its target', () => {
    const base = dir();
    const home = join(base, 'home');
    const root = join(base, 'project');
    const state = join(base, 'state');
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(root);
    mkdirSync(state);
    // `~/.config/team` is the link; the sandbox takes paths literally, so the grant names the
    // folder the seat's writes land in, not the link's own name.
    symlinkSync(state, join(home, '.config', 'team'));
    const sandbox = grokSandboxOf({ home, root, project: 'acme', grokHome: join(home, '.grok') });
    expect(sandbox.readWrite[0]).toBe(realpathSync(state));
    expect(sandbox.readWrite[1]).toBe(join(root, '.agents'));
  });
});

describe('writing the file', () => {
  test('a first launch creates the profile: it extends workspace and grants the two folders', () => {
    const { home, root, sandbox } = world();
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    expect(readFileSync(sandbox.file, 'utf8')).toBe(
      `[profiles.team-seat-acme]\nextends = "workspace"\nread_write = ["${home}/.config/team", "${root}/.agents"]\n`,
    );
  });

  test('an existing file keeps its other profiles, comments and keys', () => {
    const { sandbox } = world();
    const before = '# mine\n[profiles.other]\nextends = "workspace"\ndeny = ["/etc"]\n';
    writeFileSync(sandbox.file, before);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect(text).toContain('[profiles.team-seat-acme]\nextends = "workspace"\n');
    expect(text.split('[profiles.other]')).toHaveLength(2);
  });

  test('an existing profile is updated in place, a multi-line array replaced whole', () => {
    const { home, root, sandbox } = world();
    writeFileSync(sandbox.file, [
      '[profiles.team-seat-acme]',
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
    expect(text).toContain(`read_write = ["${home}/.config/team", "${root}/.agents"]`);
    expect(text).not.toContain('/old/one');
    expect(text).toContain('# a comment stays\ndeny = ["/etc"]');
    expect(text.split('[profiles.team-seat-acme]')).toHaveLength(2);
    expect(text.split('[profiles.other]')).toHaveLength(2);
  });

  test('a quoted table header is the same profile, not a second one', () => {
    const { sandbox } = world();
    writeFileSync(sandbox.file, '[profiles."team-seat-acme"]\nextends = "workspace"\n');
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
    const text = readFileSync(sandbox.file, 'utf8');
    expect(text.split('profiles.')).toHaveLength(2);
    expect(text).toContain('read_write = [');
  });

  for (const header of ['[profiles.team-seat-acme] # keep this table comment', '[ profiles . "team-seat-acme" ]']) {
    test(`a valid table header in another spelling is updated, never duplicated: ${header}`, () => {
      const { sandbox } = world();
      writeFileSync(sandbox.file, `${header}\nextends = "old"\nread_write = ["/old"]\ncustom = "kept"\n`);
      expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
      const text = readFileSync(sandbox.file, 'utf8');
      const parsed = Bun.TOML.parse(text) as { profiles: Record<string, any> };
      // A second table header would make the whole file unparseable ("Cannot redefine table");
      // the parsed file is the proof only one profile table stands.
      expect(Object.keys(parsed.profiles)).toEqual(['team-seat-acme']);
      expect(parsed.profiles['team-seat-acme']?.read_write).toEqual([...sandbox.readWrite]);
      expect(parsed.profiles['team-seat-acme']?.custom).toBe('kept');
      expect(parsed.profiles['team-seat-acme']?.extends).toBe('workspace');
    });
  }

  test('a file that does not parse is left byte for byte and the launch hears why', () => {
    const { sandbox } = world();
    const broken = '[profiles.team-seat-acme\nextends = "workspace"\n';
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
    // Appending `[profiles.team-seat-acme]` would be "Cannot extend inline table 'profiles'".
    expect(written.ok).toBe(false);
    expect(readFileSync(sandbox.file, 'utf8')).toBe(before);
  });

  test('a profile defined as an inline value under [profiles] is reported, not overwritten', () => {
    const { sandbox } = world();
    const before = '[profiles]\nteam-seat-acme = { extends = "workspace" }\n';
    writeFileSync(sandbox.file, before);
    const written = writeGrokSandbox(sandbox);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.why).toContain('profiles.team-seat-acme');
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
    const sandbox = grokSandboxOf({ home, root, project: 'acme', grokHome: join(base, 'grok-home') });
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
    const sandbox = grokSandboxOf({ home, root, project: 'acme', grokHome: join(home, '.grok') });
    expect(sandbox.guard).toBe(home);
    expect(writeGrokSandbox(sandbox)).toEqual({ ok: false, why: 'a symbolic link' });
    expect(existsSync(join(real, 'sandbox.toml'))).toBe(false);
  });
});

describe('taking the flag off a line whose profile was not written', () => {
  test('only this run\'s own --sandbox pair is removed, in either spelling', () => {
    expect(withoutGrokSandbox(`AGENT_UNATTENDED=1 grok ${FLAGS} --sandbox team-seat-acme --rules Rules.`, 'team-seat-acme'))
      .toBe(`AGENT_UNATTENDED=1 grok ${FLAGS} --rules Rules.`);
    expect(withoutGrokSandbox('grok --sandbox=team-seat-acme --rules R', 'team-seat-acme'))
      .toBe('grok --rules R');
  });

  test('a line naming another profile is left as it is', () => {
    expect(withoutGrokSandbox('grok --sandbox team-seat-other --rules R', 'team-seat-acme'))
      .toBe('grok --sandbox team-seat-other --rules R');
    expect(withoutGrokSandbox('grok --sandbox team-seat-acme-2 --rules R', 'team-seat-acme'))
      .toBe('grok --sandbox team-seat-acme-2 --rules R');
  });

  test('a prompt quoting the same words keeps them, and only the real pair is removed', () => {
    // The option this run appended is an argv pair. The same text inside a quoted prompt is one
    // argument, and removing characters from it would rewrite what the CLI is asked to do.
    const single = `grok -p 'preserve --sandbox team-seat-acme in this quoted prompt' --sandbox team-seat-acme`;
    expect(withoutGrokSandbox(single, 'team-seat-acme'))
      .toBe(`grok -p 'preserve --sandbox team-seat-acme in this quoted prompt'`);
    const double = 'grok -p "preserve --sandbox team-seat-acme here" --sandbox=team-seat-acme';
    expect(withoutGrokSandbox(double, 'team-seat-acme'))
      .toBe('grok -p "preserve --sandbox team-seat-acme here"');
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
    expect(launch.command).toBe(`AGENT_UNATTENDED=1 grok ${FLAGS} --sandbox team-seat-acme --rules Rules.`);
    expect(launch.grokSandbox).toEqual(sandbox);
    expect(existsSync(join(grokHome, 'sandbox.toml'))).toBe(false);
  });

  test('a launch line naming its own --sandbox keeps it, and the plan carries no write', () => {
    const { home, root, grokHome } = world();
    const plan = grokPlan(home, root, 'grok --sandbox mine');
    const launch = plan.find((step) => step.do?.do === 'launch')?.do;
    if (launch?.do !== 'launch') throw new Error('the plan has no launch step');
    expect(launch.command).toContain('--sandbox mine');
    expect(launch.command).not.toContain('team-seat-acme');
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
    expect(scene.runs[0]).toContain('--sandbox team-seat-acme');
    expect(scene.existsAtRun).toEqual([true]);
    expect(readFileSync(sandbox.file, 'utf8')).toContain('[profiles.team-seat-acme]');
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
