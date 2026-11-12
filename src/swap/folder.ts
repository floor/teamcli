// The own folder a direct preset swap needs. Planning is read-only; creation records the
// worktree under the state lock. No fetch, setup command, branch deletion or shared checkout reset.
import { SEAT_FOLDER_DEFAULT, seatFolderOf } from '../file/sections/seat_folder.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { syncChildTimeout } from '../child.ts';
import { insideTrust } from '../file/paths.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { emptySession, readState, updateState, worktreeOf, type WorktreeState } from '../state.ts';
import { fillPattern, ownStartFolderProblem, placedStartFolders, protectedLanding, publicNameHit, realLanding, taskProblem } from '../worktree/place.ts';

export type SwapFolder = { cwd: string; mode: Seat['mode']; create?: { task: string; record: WorktreeState; base: string } };
export type FolderInput = { team: TeamFile; seat: Seat; cli: string; root: string; dir: string; home: string };
export type PresetAllocation = { task: string; record: WorktreeState; head: string; parents: string[] };

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
    // A recorded git worktree is worktree mode; a seat's own plain folder keeps the seat's mode.
    return { cwd, mode: tree !== undefined ? 'worktree' : seat.mode };
  }
  // Never remove or steal another seat's slot. A missing folder is not silently reused either.
  const task = `swap-${seat.name}`;
  if (taskProblem(task)) return { why: 'the seat name cannot form a worktree task' };
  // A team that names no worktree path gives the seat its seat folder instead, as a Grok or
  // Cursor seat that names no cwd gets (worktrees/{project}/{team}/{seat}, made at launch inside
  // the team's folder), in shared mode: no git worktree is created.
  if (!team.workspace.path) {
    const own = seatFolderOf(SEAT_FOLDER_DEFAULT, team.inProject ?? team.project, team.project, seat.name);
    const ownProblem = ownStartFolderProblem({ cli, seat: seat.name, cwd: own, root, home,
      lobby: lobbyOf(home, root, team), peers: placedStartFolders(team.seats, recorded) });
    if (ownProblem !== null && !/needs an existing start folder/.test(ownProblem)) return { why: ownProblem };
    return { cwd: own, mode: 'shared' };
  }
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

export function createPresetFolder(input: FolderInput, plan: SwapFolder): PresetAllocation | undefined {
  if (plan.create === undefined) return;
  const { create } = plan;
  return updateState(input.dir, state => {
    const session = state.sessions[input.team.session] ??= emptySession();
    const rows = Object.values(state.sessions).flatMap(s => Object.entries(s.worktrees));
    if (rows.some(([key]) => key === create.task) || rows.length >= input.team.workspace.limit) throw new Error('the worktree slots changed; run swap again');
    const fresh = presetFolder(input);
    if ('why' in fresh || fresh.cwd !== plan.cwd || fresh.create?.record.branch !== create.record.branch) throw new Error('the worktree plan changed; run swap again');
    const folder = resolve(input.root, create.record.path);
    const parents: string[] = [];
    for (let parent = dirname(folder); !existsSync(parent); parent = dirname(parent)) parents.push(parent);
    mkdirSync(dirname(folder), { recursive: true });
    const ran = spawnSync('git', ['worktree', 'add', '-q', '-b', create.record.branch, folder, create.base], {
      cwd: input.root, encoding: 'utf8', timeout: syncChildTimeout(8_000),
    });
    if (ran.status !== 0) throw new Error(`the worktree was not created: ${(ran.stderr || ran.error?.message || 'git refused').split('\n')[0]}`);
    const head = git(input.root, ['rev-parse', `refs/heads/${create.record.branch}`]);
    session.worktrees[create.task] = create.record;
    return { task: create.task, record: create.record, head, parents };
  }, { waitMs: 500 });
}

/** Undo only this invocation's clean allocation when restart refused before its declaration.
 * A changed record, dirty worktree or moved branch is kept, never forced away. A branch that
 * moves after the worktree folder is already gone still drops the slot record: the folder is
 * not there, and a later swap must not stay stuck on that task. */
export function rollbackPresetFolder(input: FolderInput, allocation: PresetAllocation | undefined): void {
  if (allocation === undefined) return;
  let branchMoved = false;
  updateState(input.dir, state => {
    const session = state.sessions[input.team.session];
    const held = session?.worktrees[allocation.task];
    if (!held || held.seat !== input.seat.name || held.path !== allocation.record.path ||
        held.branch !== allocation.record.branch || held.own_commits === true) throw new Error('the allocated worktree record changed; kept for inspection');
    const ref = `refs/heads/${held.branch}`;
    if (git(input.root, ['rev-parse', ref]) !== allocation.head) throw new Error('the allocated branch changed; kept for inspection');
    // No --force: even unexpected untracked work is a reason to preserve the allocation.
    git(input.root, ['worktree', 'remove', resolve(input.root, held.path)]);
    // Compare-and-delete preserves a branch moved concurrently after the check above.
    // The folder is already gone, so the slot is cleared either way. Leaving the record
    // would make the next swap refuse a task whose path is missing.
    const removed = spawnSync('git', ['update-ref', '-d', ref, allocation.head], {
      cwd: input.root, encoding: 'utf8', timeout: syncChildTimeout(2_000),
    });
    delete session!.worktrees[allocation.task];
    for (const parent of allocation.parents) {
      try { rmdirSync(parent); } catch { /* Only empty parents created by this invocation are removed. */ }
    }
    branchMoved = removed.status !== 0;
  }, { waitMs: 500 });
  if (branchMoved) throw new Error('the allocated branch moved during rollback; the worktree record was cleared');
}

function git(root: string, args: string[]): string {
  const ran = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: syncChildTimeout(2_000) });
  if (ran.status !== 0) throw new Error((ran.stderr || ran.error?.message || 'git refused').split('\n')[0]);
  return ran.stdout.trim();
}
