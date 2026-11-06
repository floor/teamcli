// A Grok or Cursor seat starts in a folder of its own. Shared places and a symlink to one are
// refused, and the refusal names the own-worktree repair. Synthetic folders only.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { grokSandboxOf } from '../src/launch/grok-sandbox.ts';
import { upPlan } from '../src/launch/plan.ts';
import { registerInbox } from '../src/mcp/register.ts';
import { fillPattern, seatStart } from '../src/worktree/place.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const REPAIR = 'own worktree';
const SESSION = 'morning';

type World = {
  base: string;
  root: string;
  home: string;
  lobby: string;
  config: string;
  grants: string;
  grokOwn: string;
  cursorOwn: string;
  peerOwn: string;
  team: TeamFile;
  file: string;
};

function retarget(team: TeamFile, cwdOf: Readonly<Record<string, string>>): TeamFile {
  return {
    ...team,
    seats: team.seats.map((seat) => {
      const cwd = cwdOf[seat.name];
      return cwd === undefined ? seat : { ...seat, cwd };
    }),
  };
}

function seatOf(team: TeamFile, name: string): Seat {
  const seat = team.seats.find((one) => one.name === name);
  if (seat === undefined) throw new Error(`a scene names no ${name}`);
  return seat;
}

function world(): World {
  const base = fixtureBase('start-folder-own-');
  // The checkout's parent contains the project root and nothing else this scene starts in.
  const root = join(base, 'checkout', 'repo');
  const home = join(base, 'home');
  const config = join(home, '.config', 'team');
  const lobby = join(config, 'lobby');
  const grants = join(config, 'grants');
  const grokOwn = join(base, 'worktrees', 'grok-hand');
  const cursorOwn = join(base, 'worktrees', 'cursor-hand');
  const peerOwn = join(base, 'worktrees', 'cursor-peer');
  for (const folder of [root, home, config, lobby, grants, grokOwn, cursorOwn, peerOwn]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { mode: 0o700 });
  writeFileSync(file, `format: 1
project: fixture
session: ${SESSION}
coordinator: lead
operator: lead
lobby: ${lobby}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: example
    model: Example
    version: "1"
    launch: claude
  - role: implementer
    name: grok-hand
    cli: grok
    vendor: example
    model: Example
    version: "1"
    launch: grok
  - role: implementer
    name: cursor-hand
    cli: cursor
    vendor: example
    model: Example
    version: "1"
    launch: cursor-agent
  - role: implementer
    name: cursor-peer
    cli: cursor
    vendor: example
    model: Example
    version: "1"
    launch: cursor-agent
`, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { base, root, home, lobby, config, grants, grokOwn, cursorOwn, peerOwn, team: loaded.team, file };
}

function discard(held: World): void {
  discardFixtures([held.base], { roots: [dirname(held.base)] });
}

test('a Grok or Cursor seat refuses the shared root, the lobby, the team config, and a symlink to each', () => {
  const held = world();
  try {
    const shared = [
      ['project root', held.root],
      ['lobby', held.lobby],
      ['team config', held.grants],
    ] as const;
    for (const name of ['grok-hand', 'cursor-hand'] as const) {
      for (const [label, folder] of shared) {
        const link = join(held.base, `${name}-${label.replace(/ /g, '-')}`);
        symlinkSync(folder, link);
        for (const cwd of [folder, link]) {
          const team = retarget(held.team, { [name]: cwd });
          const placed = seatStart(team, seatOf(team, name), held.root, held.home);
          expect('problem' in placed, `${name} ${label}`).toBe(true);
          if ('problem' in placed) expect(placed.problem, `${name} ${label}`).toContain(REPAIR);
        }
      }
    }
  } finally {
    discard(held);
  }
});

test('a seat that starts where another seat starts, or through a symlink to that folder, is refused', () => {
  const held = world();
  try {
    const link = join(held.base, 'peer-alias');
    symlinkSync(held.grokOwn, link);
    const shared = retarget(held.team, { 'grok-hand': held.grokOwn, 'cursor-hand': held.grokOwn });
    for (const name of ['grok-hand', 'cursor-hand'] as const) {
      const placed = seatStart(shared, seatOf(shared, name), held.root, held.home);
      expect('problem' in placed, name).toBe(true);
      if ('problem' in placed) expect(placed.problem).toContain(REPAIR);
    }
    const aliased = retarget(held.team, { 'grok-hand': held.grokOwn, 'cursor-hand': link });
    const through = seatStart(aliased, seatOf(aliased, 'cursor-hand'), held.root, held.home);
    expect('problem' in through).toBe(true);
    if ('problem' in through) expect(through.problem).toContain(REPAIR);
  } finally {
    discard(held);
  }
});

test('a Grok or Cursor seat starts in its own worktree, and an explicit lobby is not replaced by a recorded one', () => {
  const held = world();
  try {
    const grok = retarget(held.team, { 'grok-hand': held.grokOwn });
    const cursor = retarget(held.team, { 'cursor-hand': held.cursorOwn });
    expect(seatStart(grok, seatOf(grok, 'grok-hand'), held.root, held.home)).toEqual({ cwd: held.grokOwn });
    expect(seatStart(cursor, seatOf(cursor, 'cursor-hand'), held.root, held.home)).toEqual({ cwd: held.cursorOwn });
    const recorded = seatStart(held.team, seatOf(held.team, 'grok-hand'), held.root, held.home, undefined, held.grokOwn);
    expect(recorded).toEqual({ cwd: held.grokOwn });
    const lobby = retarget(held.team, { 'grok-hand': held.lobby });
    const explicit = seatStart(lobby, seatOf(lobby, 'grok-hand'), held.root, held.home, undefined, held.grokOwn);
    expect('problem' in explicit).toBe(true);
    if ('problem' in explicit) expect(explicit.problem).toContain(REPAIR);
  } finally {
    discard(held);
  }
});

test('two Cursor seats get separate inbox files, each naming its own seat', () => {
  const held = world();
  try {
    const first = registerInbox({ cli: 'cursor', seat: 'cursor-hand', cwd: held.cursorOwn, file: held.file, home: held.home, session: SESSION });
    const firstFile = join(held.cursorOwn, '.cursor', 'mcp.json');
    const firstBytes = readFileSync(firstFile);
    const second = registerInbox({ cli: 'cursor', seat: 'cursor-peer', cwd: held.peerOwn, file: held.file, home: held.home, session: SESSION });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(readFileSync(firstFile)).toEqual(firstBytes);
    for (const [name, cwd] of [['cursor-hand', held.cursorOwn], ['cursor-peer', held.peerOwn]] as const) {
      const args = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')).mcpServers['team-inbox'].args as string[];
      expect(args[args.indexOf('--seat') + 1]).toBe(name);
    }
    expect(existsSync(join(held.lobby, '.cursor', 'mcp.json'))).toBe(false);
  } finally {
    discard(held);
  }
});

test('an unrelated folder is not added to a Grok seat\'s grant, and the launch is refused', () => {
  const held = world();
  try {
    const other = join(held.base, 'elsewhere');
    mkdirSync(other, { mode: 0o700 });
    const sandbox = grokSandboxOf({
      home: held.home,
      root: held.root,
      project: 'fixture',
      seat: 'grok-hand',
      session: SESSION,
      cwd: other,
      worktree: held.grokOwn,
    });
    expect(sandbox.readWrite).toContain(realpathSync(held.grokOwn));
    expect(sandbox.readWrite).not.toContain(realpathSync(other));
    const plan = upPlan({
      root: held.root,
      home: held.home,
      team: held.team,
      session: SESSION,
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'watch',
      seats: [{
        name: 'grok-hand',
        cli: 'grok',
        launch: 'grok',
        cwd: other,
        worktree: held.grokOwn,
        label: 'grok-hand',
        stopped: false,
        rules: 'Rules.',
        repairLine: 'repair',
      }],
    });
    const refusal = plan.find((step) => step.do?.do === 'refuse');
    const why = refusal?.do?.do === 'refuse' ? refusal.do.why : '';
    expect(why).toContain(REPAIR);
    expect(plan.some((step) => step.do?.do === 'launch')).toBe(false);
  } finally {
    discard(held);
  }
});

test('a start that contains the project root, the lobby, or the team config is refused', () => {
  const held = world();
  try {
    const aside = { 'cursor-hand': held.cursorOwn, 'cursor-peer': held.peerOwn };
    const ancestor = dirname(held.root);
    for (const [label, cwd] of [['ancestor of the root', ancestor], ['home of the lobby', held.home]] as const) {
      const team = retarget(held.team, { 'grok-hand': cwd, ...aside });
      const placed = seatStart(team, seatOf(team, 'grok-hand'), held.root, held.home);
      expect('problem' in placed, label).toBe(true);
      if ('problem' in placed) expect(placed.problem, label).toContain(REPAIR);
    }
  } finally {
    discard(held);
  }
});

test('a linked worktree under workspace.path is accepted when the only peer at the root is the lead', () => {
  const held = world();
  try {
    // The path team itself fills: relative, ending in {task}, outside the protected checkout.
    const pattern = '../../worktrees/{repo}/{task}';
    const task = 'grok-hand';
    const relativeFolder = fillPattern(pattern, { repo: held.team.project, task });
    if (relativeFolder === null) throw new Error('workspace.path did not fill');
    const under = resolve(held.root, relativeFolder);
    mkdirSync(dirname(under), { recursive: true, mode: 0o700 });
    const git = (cwd: string, args: readonly string[]): void => {
      const result = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr || result.stdout}`);
    };
    git(held.root, ['init', '-q']);
    git(held.root, ['config', 'user.email', 'fixture@example.com']);
    git(held.root, ['config', 'user.name', 'Fixture']);
    git(held.root, ['commit', '--allow-empty', '-m', 'fixture', '-q']);
    git(held.root, ['worktree', 'add', '-q', '-b', task, under, 'HEAD']);
    const team = retarget({
      ...held.team,
      workspace: { ...held.team.workspace, mode: 'worktree', path: pattern, base: 'main' },
    }, {
      'grok-hand': under,
      'cursor-hand': held.cursorOwn,
      'cursor-peer': held.peerOwn,
    });
    expect(seatStart(team, seatOf(team, 'grok-hand'), held.root, held.home)).toEqual({ cwd: under });
  } finally {
    discard(held);
  }
});

test('a recorded worktree outside the root still counts as an overlapping start', () => {
  const held = world();
  try {
    const plan = upPlan({
      root: held.root,
      home: held.home,
      team: held.team,
      session: SESSION,
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'watch',
      seats: [
        {
          name: 'grok-hand',
          cli: 'grok',
          launch: 'grok',
          cwd: held.grokOwn,
          label: 'grok-hand',
          stopped: false,
          rules: 'Rules.',
          repairLine: 'repair',
        },
        {
          name: 'cursor-hand',
          cli: 'cursor',
          launch: 'cursor-agent',
          cwd: '.',
          worktree: held.grokOwn,
          label: 'cursor-hand',
          stopped: false,
          rules: 'Rules.',
          repairLine: 'repair',
        },
      ],
    });
    const refusal = plan.find((step) => step.do?.do === 'refuse' && step.do.seat === 'grok-hand');
    const why = refusal?.do?.do === 'refuse' ? refusal.do.why : '';
    expect(why).toContain(REPAIR);
    expect(plan.some((step) => step.do?.do === 'launch' && step.do.seat === 'grok-hand')).toBe(false);
  } finally {
    discard(held);
  }
});

test('the write-time check refuses a lobby start before the profile is written', async () => {
  const held = world();
  try {
    const plan = upPlan({
      root: held.root,
      home: held.home,
      team: held.team,
      session: SESSION,
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'watch',
      teamFile: held.file,
      seats: [{
        name: 'grok-hand',
        cli: 'grok',
        launch: 'grok',
        cwd: held.grokOwn,
        worktree: held.grokOwn,
        label: 'grok-hand',
        stopped: false,
        rules: 'Rules.',
        repairLine: 'repair',
      }],
    });
    const launch = plan.find((step) => step.do?.do === 'launch' && step.do.seat === 'grok-hand');
    if (launch?.do?.do !== 'launch' || launch.do.grokSandbox === undefined) {
      throw new Error('the plan did not launch grok-hand from its own folder');
    }
    // The home contains the lobby. A grant of the home would cover that start unless the
    // plan's own start context still names the lobby and the write refuses it.
    const planned = launch.do.grokSandbox;
    const wide = { ...planned, readWrite: [...planned.readWrite, held.home] };
    // The plan's own start context stays. The folder is swapped to the lobby afterwards,
    // which is the write the launch rechecks before it writes the profile.
    const swapped = {
      ...launch,
      do: {
        ...launch.do,
        cwd: held.lobby,
        grokSandbox: wide,
      },
    };
    const marker = 'unchanged\n';
    mkdirSync(dirname(wide.file), { recursive: true, mode: 0o700 });
    writeFileSync(wide.file, marker, { mode: 0o600 });
    const said: string[] = [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => null,
      paneRun: () => false,
      typeLine: () => false,
      renameAgent: () => false,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => false,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line: string) => { said.push(line); },
      log: () => {},
      final: (_seat, record) => { if (record.kind === 'left out') said.push(record.reason); },
    };
    await executePlan([swapped], SESSION, host);
    expect(said.join('\n')).toContain('shared lobby');
    expect(readFileSync(wide.file, 'utf8')).toBe(marker);
  } finally {
    discard(held);
  }
});
