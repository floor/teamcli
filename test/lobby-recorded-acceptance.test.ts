// The lobby rule across a team file's `entity:`. Once the registry holds a team's lobby, the
// recorded path is the team's law: a file that renames its entity never moves it, whatever the
// path was recorded from. A team the registry holds no lobby for yet derives one from its entity
// (`<home>/.config/team/lobbies/<slug>`); an explicit `lobby:` wins over that derivation; a file
// with neither key keeps the machine-global lobby, the shape every team had before per-entity
// lobbies existed. And `team check` names the drift between a file's entity-derived lobby and the
// recorded one as a notice — something to move the file back to, counted in neither the
// difference total nor the exit code, and never a refusal.
//
// The scenes drive the registry writer the launch commands call (`noteTeam`, through which `up`,
// `add`, `init` and `down` record a team) on a home and a registry of their own, and read the
// result back through the registry module and through the view the machine sees (`team list
// --json`). The check scene pins the caller and injects every read it makes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { realListSources, runList, type ListSources } from '../src/commands/list.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { getTeam, noteTeam, setRoster, teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const PANE = 'w1:p1';
const OWNER = { kind: 'owner' as const };

/** A team file that can set either lobby key, both or neither: the rest of it is the smallest
 *  file that validates — one lead seat, a shared workspace, the session the state records. */
function teamText(entity: string | null, lobby: string | null): string {
  const lines = [
    'format: 1',
    'project: acme',
    'coordinator: lead',
    'operator: lead',
    'session: acme',
  ];
  if (entity !== null) lines.push(`entity: ${entity}`);
  if (lobby !== null) lines.push(`lobby: ${lobby}`);
  lines.push(
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: coordinator',
    '    name: lead',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    leads: true',
    '',
  );
  return lines.join('\n');
}

function fileOf(text: string): TeamFile {
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

const made: string[] = [];
beforeEach(() => {
  // No pane of this machine's is behind any real read; scenes inject the ones they mean.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string };

/** One machine: the team's checkout holding `text`, a home with the machine lobby, no registry. */
function world(text: string): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lobby-recorded-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return { base, root, home, dir: join(root, '.agents') };
}

/** The file the team's next launch would read: `text` written where the checkout keeps it. */
function fileAt(w: World, text: string): TeamFile {
  writeFileSync(join(w.dir, 'team.yaml'), text);
  return fileOf(text);
}

/** One record of the team, written the way a launch writes it: the seed is the file's own keys. */
function note(w: World, team: TeamFile): string | null {
  return noteTeam(
    w.home,
    w.root,
    { project: team.project, entity: team.entity, session: team.session, lobby: team.lobby, inProject: team.inProject },
    'running',
    'up',
  );
}

/** The state a launch leaves: the seat ready on the pane it was given. */
function ready(w: World): void {
  updateState(w.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: PANE, workspace: 'w1' };
  });
}

/** The check scene's reading of herdr: the one seat running on its recorded pane, its screen the
 *  captured idle one, and the workspace label the file's seat composes. */
function liveOf(team: TeamFile): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: workspaceLabel(team.seats[0]!) }],
    screens: { [PANE]: CLAUDE_IDLE },
  };
}

function check(w: World, team: TeamFile): { code: number; out: string } {
  const io = testIo(w.root, OWNER);
  const live = liveOf(team);
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, w.home),
    now: () => NOW,
    home: w.home,
  });
  return { code, out: `${io.out}${io.err}` };
}

async function listed(argv: string[], sources: ListSources): Promise<{ code: number; out: string }> {
  const io = testIo('/anywhere');
  const code = await runList(argv, io, sources);
  return { code, out: io.out };
}

describe('the recorded lobby is the team\'s law', () => {
  test('a recorded entity-derived lobby stands when the file renames its entity', async () => {
    const w = world(teamText('acme', null));
    expect(note(w, fileOf(teamText('acme', null)))).toBeNull();
    const id = teamIdOf(w.root);
    const recorded = join(w.home, '.config', 'team', 'lobbies', 'acme');
    expect(getTeam(w.home, id)?.lobby).toBe(recorded);

    // The same checkout, the file's entity renamed: the lobby recorded under the old entity is
    // still the team's, and the record does not follow the file.
    const after = fileAt(w, teamText('renew', null));
    expect(note(w, after)).toBeNull();
    expect(getTeam(w.home, id)?.lobby).toBe(recorded);

    // The view the machine reads back says the same: the recorded path, not the derived one.
    const readback = await listed(['--json'], {
      ...realListSources(w.home),
      sessions: () => [{ name: 'acme', running: false }],
      team: () => null,
    });
    expect(readback.code).toBe(0);
    const rows = JSON.parse(readback.out) as Array<{ lobby: string | null }>;
    expect(rows[0]?.lobby).toBe(recorded);
  });

  test('a recorded explicit lobby stands when the file\'s entity changes and nothing else does', () => {
    const w = world(teamText(null, '~/shared-lobby'));
    expect(note(w, fileOf(teamText(null, '~/shared-lobby')))).toBeNull();
    const id = teamIdOf(w.root);
    const recorded = join(w.home, 'shared-lobby');
    expect(getTeam(w.home, id)?.lobby).toBe(recorded);

    // The file's `lobby:` key is gone and an entity is there now: the recorded path still governs.
    const after = fileAt(w, teamText('renew', null));
    expect(note(w, after)).toBeNull();
    expect(getTeam(w.home, id)?.lobby).toBe(recorded);
  });
});

describe('a team with no lobby on record derives one', () => {
  test('an entity alone derives <home>/.config/team/lobbies/<slug>', () => {
    const w = world(teamText('acme', null));
    expect(note(w, fileOf(teamText('acme', null)))).toBeNull();
    expect(getTeam(w.home, teamIdOf(w.root))?.lobby).toBe(join(w.home, '.config', 'team', 'lobbies', 'acme'));
  });

  test('an explicit lobby wins over the derivation', () => {
    const w = world(teamText('acme', '~/mine'));
    expect(note(w, fileOf(teamText('acme', '~/mine')))).toBeNull();
    expect(getTeam(w.home, teamIdOf(w.root))?.lobby).toBe(join(w.home, 'mine'));
  });

  test('neither key keeps the machine-global lobby', () => {
    const w = world(teamText(null, null));
    expect(note(w, fileOf(teamText(null, null)))).toBeNull();
    expect(getTeam(w.home, teamIdOf(w.root))?.lobby).toBe(lobbyDir(w.home));
  });
});

describe('team check names the drift as a notice', () => {
  test('a file whose entity-derived lobby differs from the recorded one gets a note, not a difference', () => {
    const w = world(teamText('acme', null));
    expect(note(w, fileOf(teamText('acme', null)))).toBeNull();
    const id = teamIdOf(w.root);
    // The seat completed its launch, so the roster names it and the scene has no other finding.
    setRoster(w.home, id, [{ agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true }]);
    ready(w);

    const recorded = join(w.home, '.config', 'team', 'lobbies', 'acme');
    const derived = join(w.home, '.config', 'team', 'lobbies', 'renew');
    // The file is edited where it stands: the record still holds the lobby from before, and the
    // file now derives another one. The check is what must say so.
    const after = fileAt(w, teamText('renew', null));
    const { code, out } = check(w, after);

    // Nothing else is wrong in this scene, so the drift is the only thing the check has to say —
    // and what it says is a notice: outside the finding total and off the exit code.
    expect(code).toBe(0);
    expect(out).toContain('team check: nothing wrong');
    expect(out).not.toContain('difference:');

    // One note, naming both lobbies: the one the registry holds and the one the file now derives.
    const notice = out.split('\n').find((line) => line.startsWith('note:') && line.includes(recorded));
    expect(notice).toBeDefined();
    expect(notice).toContain(derived);
  });
});
