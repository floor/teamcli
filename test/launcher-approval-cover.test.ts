// A launcher file is outside the team file. Under --resolve-launch it runs only when the
// approval digest covers the bytes on disk. A file the approval never covered, or one that
// changed after approval, refuses the launch and starts nothing. Synthetic home and team only.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import {
  LAUNCHER_CHANGED,
  LAUNCHER_UNAPPROVED,
  readLauncherCover,
  withLauncherCover,
} from '../src/launch/launcher-cover.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, recordRenames, testIo } from './helpers.ts';

const IDLE = readFileSync(new URL('./fixtures/claude-code/2.1.302/idle.txt', import.meta.url), 'utf8');
const NOW = new Date('2026-11-06T17:10:00Z');
const SESSION = 'scratch';
const BINARY = '/opt/fixture/claude-resolved';

let scratch = '';

afterEach(() => {
  if (scratch !== '') discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
});

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const runs: { pane: string; command: string }[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      const pane = 'fixture-pane-1';
      panes.set(pane, { text: '', agent: false });
      return { pane, workspace: 'fixture-ws-1' };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) {
        known.agent = true;
        known.text = IDLE;
      }
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: () => ['fixture-pane-1'],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  recordRenames(launch);
  return { launch, runs };
}

function sources(home: string, made: ReturnType<typeof world>): UpSources {
  const doctor: DoctorSources = {
    version: () => '1.0.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor,
    launch: made.launch,
  };
}

function opened(): { root: string; home: string; made: ReturnType<typeof world>; text: string; team: Extract<ReturnType<typeof loadTeamFile>, { ok: true }>['team'] } {
  const scratchNow = fixtureBase('launcher-approval-cover-');
  scratch = scratchNow;
  const homeDir = join(scratchNow, 'home');
  const root = join(scratchNow, 'repo');
  mkdirSync(lobbyDir(homeDir), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  const dir = join(root, '.agents', 'launchers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude-lead-resolved.yaml'), `format: 1\nname: claude-lead-resolved\nkind: custom\nargv:\n  - ${BINARY}\n  - --from-resolver\n`, { mode: 0o600 });
  const text = `format: 1
project: acme
session: ${SESSION}
coordinator: claude-lead
operator: claude-lead
workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(homeDir)}
  - ${root}
seats:
  - role: coordinator
    name: claude-lead
    label: claude-lead
    cli: claude-code
    vendor: test
    model: "Test"
    version: "1"
    launch: claude
    launcher: claude-lead-resolved
`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home: homeDir });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { root, home: homeDir, made: world(), text, team: loaded.team };
}

function approve(openedTeam: ReturnType<typeof opened>, covered: boolean): void {
  const approval = approvalOf(openedTeam.team, openedTeam.root, NOW);
  const signed = covered ? withLauncherCover(approval, openedTeam.root) : approval;
  writeApproval(
    storePath(openedTeam.team.project, openedTeam.root, openedTeam.home),
    { approval: signed, file: openedTeam.text },
    openedTeam.team.seats,
    openedTeam.home,
    NOW,
  );
}

test('a launcher file outside the approval refuses the flag and starts nothing', async () => {
  const scene = opened();
  approve(scene, false);
  const io = testIo(scene.root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(scene.home, scene.made));
  expect(code, io.out + io.err).not.toBe(0);
  expect(io.out + io.err).toContain(LAUNCHER_UNAPPROVED);
  expect(scene.made.runs.some((run) => run.command.includes(BINARY))).toBe(false);
});

test('a launcher file changed since approval refuses the flag and starts nothing', async () => {
  const scene = opened();
  const approved = readLauncherCover(scene.root);
  approve(scene, true);
  writeFileSync(join(scene.root, '.agents', 'launchers', 'claude-lead-resolved.yaml'), `format: 1\nname: claude-lead-resolved\nkind: custom\nargv:\n  - ${BINARY}\n  - --swapped\n`, { mode: 0o600 });
  const live = readLauncherCover(scene.root);
  expect(live.ok && approved.ok && live.digest).not.toBe(approved.ok ? approved.digest : '');
  const io = testIo(scene.root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(scene.home, scene.made));
  expect(code, io.out + io.err).not.toBe(0);
  expect(io.out + io.err).toContain(LAUNCHER_CHANGED);
  expect(scene.made.runs.some((run) => run.command.includes(BINARY))).toBe(false);
});

test('approved launcher bytes pass the cover', async () => {
  const scene = opened();
  approve(scene, true);
  const io = testIo(scene.root, { kind: 'owner' });
  const code = await runUp(['--resolve-launch'], io, sources(scene.home, scene.made));
  const said = io.out + io.err;
  expect(said).not.toContain(LAUNCHER_UNAPPROVED);
  expect(said).not.toContain(LAUNCHER_CHANGED);
  const command = scene.made.runs.map((run) => run.command).find((line) => line.includes(BINARY));
  expect(command, said).toBeDefined();
  expect(command).toContain('--from-resolver');
  expect(code, said).toBe(0);
});
