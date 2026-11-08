// The own folder a direct preset swap needs. Planning is read-only; creation records the
// worktree under the state lock. No fetch, setup command, branch deletion or shared checkout reset.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { syncChildTimeout } from '../child.ts';
import { insideTrust } from '../file/paths.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { emptySession, readState, updateState, worktreeOf, type WorktreeState } from '../state.ts';
import { fillPattern, ownStartFolderProblem, placedStartFolders, protectedLanding, publicNameHit, realLanding, taskProblem } from '../worktree/place.ts';

export type SwapFolder = { cwd: string; mode: Seat['mode']; create?: { task: string; record: WorktreeState; base: string } };
export type FolderInput = { team: TeamFile; seat: Seat; cli: string; root: string; dir: string; home: string };

export function presetFolder(input: FolderInput): SwapFolder | { why: string } {
  const { team, seat, cli, root, dir, home } = input;
  if (cli !== 'grok' && cli !== 'cursor') return { cwd: seat.cwd, mode: seat.mode };
  const state = readState(dir);
  const recorded = state.sessions[team.session];
  const held = worktreeOf(recorded, seat.name);
  const tree = held?.seat === seat.name && held.branch !== '' ? held : undefined;
  const cwd = tree?.path ?? seat.cwd;
  const problem = ownStartFolderProblem({ cli, seat: seat.name, cwd, root, home,
    lobby: lobbyOf(home, root, team), peers: placedStartFolders(team.seats, recorded) });
  if (problem === null && (tree !== undefined || insideTrust(cwd, team.trust, root, home)) &&
      (tree !== undefined || protectedLanding(root, cwd, team.workspace.protected) === null)) {
    return { cwd, mode: 'worktree' };
  }
  // Never remove or steal another seat's slot. A missing folder is not silently reused either.
  const task = `swap-${seat.name}`;
  if (taskProblem(task)) return { why: 'the seat name cannot form a worktree task' };
  if (!team.workspace.path) return { why: 'this preset needs an own worktree: set workspace.path inside an accepted trust path' };
  const path = fillPattern(team.workspace.path, { repo: team.project, task });
  const branch = fillPattern(team.workspace.branch, { kind: 'swap', task });
  if (!path || !branch) return { why: 'the workspace path or branch has an unknown placeholder' };
  const hit = publicNameHit(team, [task, branch]);
  if (hit !== null) return { why: hit };
  if (!insideTrust(path, team.trust, root, home)) return { why: 'the swap worktree is outside the accepted trust paths' };
  const landing = realLanding(root, path);
  if (!insideTrust(landing.real, team.trust, root, home)) return { why: 'the swap worktree follows a path outside trust' };
  if (protectedLanding(root, path, team.workspace.protected) !== null) return { why: 'the swap worktree would land in a protected checkout' };
  if (existsSync(landing.logical)) return { why: 'the swap worktree folder already exists but is not this seat’s recorded worktree' };
  if (Object.values(state.sessions).some(s => s.worktrees[task] !== undefined)) return { why: 'the swap worktree task is already recorded' };
  const count = Object.values(state.sessions).reduce((n, s) => n + Object.keys(s.worktrees).length, 0);
  if (count >= team.workspace.limit) return { why: `the worktree limit is ${team.workspace.limit}; no free slot` };
  return { cwd: path, mode: 'worktree', create: { task, base: team.workspace.base ?? 'HEAD',
    record: { path, branch, seat: seat.name, own_commits: false, setup: 'ok' } } };
}

export function createPresetFolder(input: FolderInput, plan: SwapFolder): void {
  if (plan.create === undefined) return;
  const { create } = plan;
  updateState(input.dir, state => {
    const session = state.sessions[input.team.session] ??= emptySession();
    const rows = Object.values(state.sessions).flatMap(s => Object.entries(s.worktrees));
    if (rows.some(([key]) => key === create.task) || rows.length >= input.team.workspace.limit) throw new Error('the worktree slots changed; run swap again');
    const fresh = presetFolder(input);
    if ('why' in fresh || fresh.cwd !== plan.cwd || fresh.create?.record.branch !== create.record.branch) throw new Error('the worktree plan changed; run swap again');
    const folder = resolve(input.root, create.record.path);
    mkdirSync(dirname(folder), { recursive: true });
    const ran = spawnSync('git', ['worktree', 'add', '-q', '-b', create.record.branch, folder, create.base], {
      cwd: input.root, encoding: 'utf8', timeout: syncChildTimeout(8_000),
    });
    if (ran.status !== 0) throw new Error(`the worktree was not created: ${(ran.stderr || ran.error?.message || 'git refused').split('\n')[0]}`);
    session.worktrees[create.task] = create.record;
  }, { waitMs: 500 });
}
