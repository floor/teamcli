import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller } from '../caller.ts';
import { insideTrust } from '../file/paths.ts';
import { LINK_NOT_FOLLOWED, NOT_A_REPO, placedProblems } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { contextLine, displayPath, formatTable, hasJsonFlag, pluralCount, refuse, renderNotes, writeJson } from '../output/index.ts';
import { emptySession, readState, withLock, writeAtomic, STATE_FILE, type State } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { fillPattern, publicNameHit, realLanding, taskProblem } from '../worktree/place.ts';

// What the command reads from outside the process, so a test can point the approval store elsewhere.
export type WorktreeSources = {
  home: string;
  now(): Date;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  // One `workspace.setup` command, in the new worktree. Absent: `sh -c` there. The status is
  // the command's own: zero ran, anything else stops the list.
  setup?(cwd: string, command: string): number;
};

export const realSources: WorktreeSources = {
  home: homedir(),
  now: () => new Date(),
};

type Run = { code: number; stdout: string; stderr: string };

export const USAGE = `Usage: team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]
       team worktree list [--session <name>] [--file <path>] [--json]
       team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]
Ignored files in the worktree are deleted with it.

Exits 0 when the worktree is created, listed, or removed, 1 when the operation is refused or fails, 2 when the invocation or team file can't be read.
`;

export const worktree: Command = (argv, io) => runWorktree(argv, io, realSources);
export default worktree;

export async function runWorktree(argv: string[], io: Io, sources: WorktreeSources = realSources): Promise<number> {
  const args = readArgs(argv, ['kind', 'seat', 'session', 'file', 'branch'], ['json']);
  // Read from the raw argv before the parser runs: a bad option before `--json`, or a
  // malformed `--json=<value>`, still asks for the structured refusal.
  const json = hasJsonFlag(argv);
  const sub = args.rest[0];
  const task = args.rest[1];
  if (args.error) {
    refuse(io, json, 'worktree', { id: 'worktree.invocation', message: args.error, repair: null, usage: USAGE });
    // exit: worktree.invocation
    return 2;
  }
  if (sub !== 'new' && sub !== 'remove' && sub !== 'list') {
    refuse(io, json, 'worktree', {
      id: 'worktree.subcommand',
      message: sub ? `unknown subcommand "${sub}"` : 'a subcommand is required',
      repair: null,
      usage: USAGE,
    });
    // exit: worktree.subcommand
    return 2;
  }
  const detached = detachedRefusal(walkCaller(io), { who: 'the owner, the orchestrator or the operator', where: 'a terminal outside herdr or its own seat' });
  if (detached !== undefined) {
    refuse(io, json, 'worktree', { id: 'worktree.detached', message: detached, repair: null });
    // exit: worktree.detached
    return 1;
  }
  if (sub !== 'list' && !task) {
    refuse(io, json, 'worktree', { id: 'worktree.task-required', message: 'a task name is required', repair: null, usage: USAGE });
    // exit: worktree.task-required
    return 2;
  }
  if (sub === 'list' ? args.rest.length > 1 : args.rest.length > 2) {
    refuse(io, json, 'worktree', {
      id: 'worktree.extra',
      message: `unexpected "${sub === 'list' ? args.rest[1] : args.rest[2]}"`,
      repair: null,
      usage: USAGE,
    });
    // exit: worktree.extra
    return 2;
  }
  if ((sub === 'remove' || sub === 'list') && (args.values.kind || args.values.seat)) {
    refuse(io, json, 'worktree', { id: 'worktree.remove-flags', message: `${sub} takes no --kind or --seat`, repair: null, usage: USAGE });
    // exit: worktree.remove-flags
    return 2;
  }
  if (sub !== 'remove' && args.values.branch !== undefined) {
    refuse(io, json, 'worktree', { id: 'worktree.branch-flags', message: `${sub} takes no --branch`, repair: null, usage: USAGE });
    // exit: worktree.branch-flags
    return 2;
  }

  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor ask
  // the host about that file's session — the one place every command whose `--file` is the owner's decides
  // it is `fileOwnerRefusal` (caller.ts). `list`, `new` and `remove` run this same gate before the
  // load below.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    refuse(io, json, 'worktree', { id: 'worktree.file-owner', message: fileRefusal, repair: null });
    // exit: worktree.file-owner
    return 1;
  }

  // The owner is a terminal outside herdr, and the walk alone decides that: a non-owner aiming
  // `--session` is refused here, before the flag's session is read — no agent list, no pane root,
  // no state write, no log line. (A seat cannot be named in this refusal: placing it would read a
  // session, and that is what must not happen yet.)
  if (args.values.session !== undefined) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      refuse(io, json, 'worktree', { id: 'worktree.session-owner', message: sessionOwnerRefusal(walked), repair: null });
      // exit: worktree.session-owner
      return 1;
    }
  }

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const loaded = readTeamConfig(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home: sources.home,
    checkOnly: true,
  });
  const placed = loaded.ok ? placedProblems(loaded.team, loaded.root, sources.home) : [];
  if (!loaded.ok || placed.length) {
    const problems = loaded.ok ? placed : loaded.errors;
    if (json) {
      refuse(io, true, 'worktree', {
        id: fileProblemId(problems),
        message: problems.map(problemLine).join('; '),
        repair: null,
      });
    } else {
      for (const problem of problems) io.stderr(`team worktree: ${problemLine(problem)}\n`);
    }
    // exit: worktree.not-a-repo
    // exit: worktree.file
    // exit: worktree.file-invalid
    return 2;
  }
  const { team, root } = loaded;
  const standing = sources.standing?.(loaded.root) ?? approvalStanding(loaded.root, sources.home);
  // The live file is the record the subcommands act on: an edit to it is not a difference to say.
  const reading = team;
  const dir = dirname(loaded.path);
  // The gate judges the caller placed in the session this command asks about — the proof its pane
  // is that session's. With no `--session` the session judged is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team
  // up --session <other>`) — never one a non-owner chose. The refusal names the caller's own
  // placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, reading);
  const { caller, shown } = judged;
  const session = judged.session;
  const verdict = mayChangeTeamVerdict(caller, reading, standingOf(dir, session, caller));
  if (verdict.kind === 'no-pane') {
    refuse(io, json, 'worktree', { id: 'worktree.no-pane', message: noPaneRefusal(verdict.name), repair: null });
    // exit: worktree.no-pane
    return 1;
  }
  if (verdict.kind === 'another-pane') {
    refuse(io, json, 'worktree', {
      id: 'worktree.another-pane',
      message: anotherPaneRefusal(verdict.name, verdict.recordedPane),
      repair: null,
    });
    // exit: worktree.another-pane
    return 1;
  }
  if (verdict.kind === 'refused') {
    refuse(io, json, 'worktree', {
      id: 'worktree.caller',
      message: `only the owner, the orchestrator or the operator runs it; this call is ${describeCaller(shown)}`,
      repair: null,
      rule: 'owner-or-leads',
    });
    // exit: worktree.caller
    return 1;
  }
  if (session === 'default') {
    refuse(io, json, 'worktree', { id: 'worktree.default-session', message: 'session can\'t be "default", herdr\'s own session', repair: null });
    // exit: worktree.default-session
    return 1;
  }
  // The live file is the record: no stored approval is what every team made after `approve` was
  // removed has, and it runs (as up, remove and down do). A stored record that is legacy or
  // cannot be verified still refuses.
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    refuse(io, json, 'worktree', { id: 'worktree.never-approved', message: notInForce(standing), repair: null });
    // exit: worktree.never-approved
    return 1;
  }
  const who = describeCaller(caller);
  if (sub === 'list') return listWorktrees(io, json, reading, root, dir, session, sources.home);
  // `list` is the only subcommand that arrives without a task; the gate above already returned.
  const named = task ?? '';
  if (sub === 'new') return create(io, json, sources, reading, root, dir, session, named, args.values.kind, args.values.seat, who);
  return removeWorktree(io, json, sources, reading, root, dir, session, named, args.values.branch, who);
}

/** The row of a team-file problem: the two load failures `load.ts` writes are named, the rest
 *  come from the parser or the validator. */
function fileProblemId(problems: Problem[]): 'worktree.not-a-repo' | 'worktree.file' | 'worktree.file-invalid' {
  const first = problems[0]?.message ?? '';
  if (first === NOT_A_REPO || first === LINK_NOT_FOLLOWED) return 'worktree.not-a-repo';
  if (first.startsWith('no team file')) return 'worktree.file';
  return 'worktree.file-invalid';
}

function problemLine(problem: Problem): string {
  return `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`;
}

// The counted entries, and nothing else: no lock, no state write, no log line. The same rows
// the limit refusal names. A missing folder stays a row until `team worktree remove` drops it.
function listWorktrees(io: Io, json: boolean, team: TeamFile, root: string, dir: string, session: string, home?: string): number {
  const rows = worktreeRows(readState(dir), root);
  const limit = `limit ${team.workspace.limit} (workspace.limit)`;
  if (json) {
    writeJson(io, 'team.worktree', {
      format: 1 as const,
      project: team.project,
      session,
      notice: null,
      worktrees: rows.map((row) => ({
        task: row.task,
        branch: row.branch,
        path: row.path,
        session: row.session,
        seat: row.seat ?? null,
        exists: row.exists,
      })),
      notes: [limit],
      summary: { worktrees: rows.length },
    });
  } else {
    const table = formatTable({
      headers: ['TASK', 'BRANCH', 'PATH'],
      rows: rows.map((row) => [row.task, row.branch, displayPath(row.exists ? row.path : `${row.path} (gone)`, home)]),
    });
    io.stdout(`${contextLine(team.project, session)}\n${table}${renderNotes([limit], { home }).join('\n')}\n${pluralCount(rows.length, 'worktree')}\n`);
  }
  // exit: worktree.listed
  return 0;
}

// `team` is the live file; every value below is read from it.
function create(
  io: Io, json: boolean, sources: WorktreeSources, team: TeamFile, root: string, dir: string, session: string, task: string,
  kind: string | undefined, seatName: string | undefined, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    refuse(io, json, 'worktree', { id: 'worktree.task', message: named, repair: null });
    // exit: worktree.task
    return 1;
  }
  if (kind !== undefined && taskProblem(kind)) {
    refuse(io, json, 'worktree', { id: 'worktree.kind', message: `--kind: ${taskProblem(kind)}`, repair: null });
    // exit: worktree.kind
    return 1;
  }
  if (team.workspace.mode === 'shared') {
    refuse(io, json, 'worktree', {
      id: 'worktree.shared',
      message: 'workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create',
      repair: null,
    });
    // exit: worktree.shared
    return 1;
  }
  const pathPattern = team.workspace.path;
  const base = team.workspace.base;
  if (!pathPattern || !base) {
    refuse(io, json, 'worktree', { id: 'worktree.config', message: 'workspace.path and workspace.base are required', repair: null });
    // exit: worktree.config
    return 1;
  }
  if (pathPattern.includes('{kind}')) {
    refuse(io, json, 'worktree', { id: 'worktree.path-kind', message: 'workspace.path fills {repo} and {task} only', repair: null });
    // exit: worktree.path-kind
    return 1;
  }
  const branchPattern = team.workspace.branch;
  if (branchPattern.includes('{kind}') && kind === undefined) {
    refuse(io, json, 'worktree', {
      id: 'worktree.kind-required',
      message: `--kind is required: the branch pattern is ${JSON.stringify(branchPattern)}`,
      repair: null,
    });
    // exit: worktree.kind-required
    return 1;
  }
  if (!branchPattern.includes('{kind}') && kind !== undefined) {
    refuse(io, json, 'worktree', {
      id: 'worktree.kind-nowhere',
      message: `--kind has nowhere to go: the branch pattern is ${JSON.stringify(branchPattern)}`,
      repair: null,
    });
    // exit: worktree.kind-nowhere
    return 1;
  }
  const branch = fillPattern(branchPattern, { kind, task });
  const folder = fillPattern(pathPattern, { repo: team.project, task });
  if (!branch || !folder) {
    refuse(io, json, 'worktree', {
      id: 'worktree.placeholder',
      message: 'the branch or path pattern has a placeholder other than {kind}, {task} or {repo}',
      repair: null,
    });
    // exit: worktree.placeholder
    return 1;
  }
  const hit = publicNameHit(team, [task, kind, branch, basename(folder)].filter((name): name is string => Boolean(name)));
  if (hit) {
    refuse(io, json, 'worktree', { id: 'worktree.forbidden', message: `${hit}; a public project refuses that name`, repair: null });
    // exit: worktree.forbidden
    return 1;
  }
  if (!insideTrust(folder, team.trust, root, sources.home)) {
    refuse(io, json, 'worktree', { id: 'worktree.trust', message: `${folder} is outside the file's trust paths`, repair: null });
    // exit: worktree.trust
    return 1;
  }
  const landing = realLanding(root, folder);
  if (landing.real !== landing.logical) {
    const rel = relative(realpathSync(root), landing.real).split(sep).join('/');
    if (!insideTrust(rel, team.trust, root, sources.home)) {
      refuse(io, json, 'worktree', {
        id: 'worktree.symlink',
        message: `${folder} follows a symlink to ${landing.real}, which is outside the file's trust paths`,
        repair: null,
      });
      // exit: worktree.symlink
      return 1;
    }
  }
  if (seatName !== undefined && !team.seats.some((seat) => seat.name === seatName)) {
    refuse(io, json, 'worktree', { id: 'worktree.seat', message: `--seat ${JSON.stringify(seatName)} names no declared seat`, repair: null });
    // exit: worktree.seat
    return 1;
  }

  const absolute = landing.logical;
  let refused: { id: string; message: string } | null = null;
  const outcome = withLock(dir, () => {
    const state = readState(dir);
    refused = openRefusal(state, team.workspace.limit, task, session, root);
    if (refused) return null;
    if (existsSync(absolute)) {
      refused = { id: 'worktree.exists', message: `${folder} already exists` };
      return null;
    }
    const branchTaken = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (branchTaken.code === 0) {
      refused = { id: 'worktree.branch', message: `branch ${branch} already exists` };
      return null;
    }
    const published = publishedBranch(root, branch);
    if (published) {
      refused = { id: 'worktree.published', message: `${published} already exists` };
      return null;
    }
    const format = git(root, ['check-ref-format', '--branch', branch]);
    if (format.code !== 0) {
      refused = { id: 'worktree.branch-name', message: `${JSON.stringify(branch)} is not a branch name` };
      return null;
    }
    const start = startPoint(root, base);
    if ('error' in start) {
      refused = { id: start.id, message: start.error };
      return null;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    const added = git(root, ['worktree', 'add', '-q', '-b', branch, absolute, start.ref]);
    if (added.code !== 0) {
      refused = {
        id: 'worktree.create-failed',
        message: `the worktree was not created: ${firstLine(added.stderr || added.stdout)}`,
      };
      return null;
    }
    const setup = runSetup(absolute, team.workspace.setup, sources.setup ?? realSetup);
    const record = {
      path: folder,
      branch,
      own_commits: false,
      ...(seatName ? { seat: seatName } : {}),
      setup: setup.ok ? 'ok' as const : 'failed' as const,
    };
    const sessionState = state.sessions[session] ?? emptySession();
    state.sessions[session] = sessionState;
    sessionState.worktrees[task] = record;
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return { start, setup };
  });
  if (refused || !outcome) {
    const failure = refused ?? { id: 'worktree.create-failed', message: 'nothing was created' };
    refuse(io, json, 'worktree', { id: failure.id, message: failure.message, repair: null });
    // exit: worktree.limit
    // exit: worktree.recorded
    // exit: worktree.recorded-elsewhere
    // exit: worktree.exists
    // exit: worktree.branch
    // exit: worktree.published
    // exit: worktree.branch-name
    // exit: worktree.base
    // exit: worktree.tracking
    // exit: worktree.fetch
    // exit: worktree.create-failed
    return 1;
  }
  const line = `worktree ${task}: created at ${folder}`;
  if (!outcome.setup.ok) {
    logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}; setup failed on command ${outcome.setup.at}`, sources.now());
    refuse(io, json, 'worktree', {
      id: 'worktree.setup',
      message: `setup failed on command ${outcome.setup.at} of ${team.workspace.setup.length}; the worktree is kept and recorded as setup: failed`,
      repair: null,
    });
    if (!json) io.stdout(`${contextLine(team.project, session)}\n${line}\n`);
    // exit: worktree.setup
    return 1;
  }
  const note = outcome.start.note ? `; ${outcome.start.note}` : '';
  logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}${note}`, sources.now());
  action(io, json, team, session, 'created', line, 'new', task, branch, folder);
  // exit: worktree.created
  return 0;
}

/** The `team.worktree` action envelope, or the same line under the context line. */
function action(
  io: Io, json: boolean, team: Pick<TeamFile, 'project'>, session: string, status: 'created' | 'removed' | 'record-gone',
  actionSummary: string, name: 'new' | 'remove', task: string, branch: string, path: string,
): void {
  if (json) {
    writeJson(io, 'team.worktree', {
      format: 1 as const,
      dry_run: false,
      status,
      action_summary: actionSummary,
      project: team.project,
      session,
      action: name,
      task,
      branch,
      path,
    });
    return;
  }
  io.stdout(`${contextLine(team.project, session)}\n${actionSummary}\n`);
}

export function removeWorktree(
  io: Io, json: boolean, sources: WorktreeSources, team: TeamFile, root: string, dir: string, session: string, task: string,
  branch: string | undefined, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    refuse(io, json, 'worktree', { id: 'worktree.remove-task', message: named, repair: null });
    // exit: worktree.remove-task
    return 1;
  }
  let refused: { id: string; message: string } | null = null;
  const removed = withLock(dir, () => {
    const state = readState(dir);
    const found = findWorktree(state, task, session);
    if (!found) {
      refused = { id: 'worktree.missing', message: `no worktree named ${JSON.stringify(task)} is recorded` };
      return false;
    }
    if (!found.record) {
      refused = {
        id: 'worktree.elsewhere',
        message: `${JSON.stringify(task)} is recorded in session ${found.elsewhere.join(', ')}, not in ${session}; nothing was removed`,
      };
      return false;
    }
    const occupant = seatInTask(state, task);
    if (occupant) {
      refused = { id: 'worktree.occupied', message: `seat ${occupant} is recorded in this worktree; team remove ${occupant} first` };
      return false;
    }
    const record = found.record;
    const absolute = resolve(root, record.path);
    if (!existsSync(absolute)) {
      git(root, ['worktree', 'prune']);
      delete found.session.worktrees[task];
      writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
      return { gone: true, branch: record.branch, path: record.path };
    }
    const porcelain = git(absolute, ['status', '--porcelain']);
    if (porcelain.code !== 0) {
      refused = { id: 'worktree.unreadable', message: `couldn't read the worktree: ${firstLine(porcelain.stderr)}` };
      return false;
    }
    const dirty = porcelain.stdout.split('\n').filter((line) => line !== '');
    if (dirty.length) {
      refused = { id: 'worktree.dirty', message: `uncommitted or untracked files:\n${list(dirty)}` };
      return false;
    }
    const expectedFolder = team.workspace.path ? fillPattern(team.workspace.path, { repo: team.project, task }) : null;
    if (expectedFolder && absolute !== resolve(root, expectedFolder)) {
      refused = {
        id: 'worktree.remove-failed',
        message: `the recorded path ${JSON.stringify(record.path)} is not ${JSON.stringify(expectedFolder)}; nothing was removed`,
      };
      return false;
    }
    // The branch the worktree itself is on, read from git's own list — not derived from
    // `workspace.branch`: a branch renamed in place is still the one that must hold nothing
    // unpublished, and the one the message names as kept. The list has no branch for a detached
    // HEAD, and none at all for a folder it does not name; the record's branch stands for it
    // then, as it always did. `--branch` asserts the name and refuses on any other.
    const real = listedBranch(root, absolute) ?? record.branch;
    if (branch !== undefined && branch !== real) {
      refused = {
        id: 'worktree.remove-branch',
        message: `--branch ${JSON.stringify(branch)} does not name the branch this worktree is on (${JSON.stringify(real)}); nothing was removed`,
      };
      return false;
    }
    const unpublished = commitsOnNoRemote(root, absolute, real, team.workspace.base);
    if (unpublished.length) {
      refused = { id: 'worktree.unpublished', message: `commits on no remote branch:\n${list(unpublished)}` };
      return false;
    }
    const gone = git(root, ['worktree', 'remove', absolute]);
    if (gone.code !== 0) {
      refused = { id: 'worktree.remove-failed', message: `the worktree was not removed: ${firstLine(gone.stderr || gone.stdout)}` };
      return false;
    }
    delete found.session.worktrees[task];
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return { gone: false, branch: real, path: record.path };
  });
  if (refused || removed === false) {
    const failure = refused ?? { id: 'worktree.remove-failed', message: 'nothing was removed' };
    refuse(io, json, 'worktree', { id: failure.id, message: failure.message, repair: null });
    // exit: worktree.missing
    // exit: worktree.elsewhere
    // exit: worktree.occupied
    // exit: worktree.unreadable
    // exit: worktree.dirty
    // exit: worktree.remove-branch
    // exit: worktree.unpublished
    // exit: worktree.remove-failed
    return 1;
  }
  if (removed.gone) {
    logLine(dir, 'worktree remove', who, `removed the record of ${task}; its folder was already gone`, sources.now());
    action(io, json, team, session, 'record-gone',
      `removed the record of ${task}; its folder was already gone. No branch was deleted.`,
      'remove', task, removed.branch, removed.path);
    // exit: worktree.record-gone
    return 0;
  }
  logLine(dir, 'worktree remove', who, `removed ${task}; kept branch ${removed.branch}`, sources.now());
  action(io, json, team, session, 'removed', `removed ${task}; the branch ${removed.branch} is kept`,
    'remove', task, removed.branch, removed.path);
  // exit: worktree.removed
  return 0;
}

function openRefusal(
  state: State, limit: number, task: string, session: string, root: string,
): { id: string; message: string } | null {
  for (const [name, recorded] of Object.entries(state.sessions)) {
    if (recorded.worktrees[task]) {
      return name === session
        ? { id: 'worktree.recorded', message: `${JSON.stringify(task)} is already recorded` }
        : { id: 'worktree.recorded-elsewhere', message: `${JSON.stringify(task)} is already recorded in session ${name}` };
    }
  }
  const rows = worktreeRows(state, root);
  if (rows.length >= limit) {
    return {
      id: 'worktree.limit',
      message: `the worktree limit is ${limit}, and ${rows.length} are open (workspace.limit in the team file)\n${rows.map(worktreeRow).join('\n')}`,
    };
  }
  return null;
}

// One row per counted key, every session of this state file. Sorted so the list and the
// refusal name the same entries in the same order.
function worktreeRows(
  state: State, root: string,
): { task: string; branch: string; session: string; seat?: string; path: string; exists: boolean }[] {
  const rows: { task: string; branch: string; session: string; seat?: string; path: string; exists: boolean }[] = [];
  for (const [session, recorded] of Object.entries(state.sessions)) {
    for (const [task, work] of Object.entries(recorded.worktrees)) {
      rows.push({
        task,
        branch: work.branch,
        session,
        seat: work.seat,
        path: work.path,
        exists: existsSync(resolve(root, work.path)),
      });
    }
  }
  rows.sort((a, b) => a.session.localeCompare(b.session) || a.task.localeCompare(b.task));
  return rows;
}

function worktreeRow(row: { task: string; session: string; seat?: string; path: string; exists: boolean }): string {
  const seat = row.seat ? ` seat ${row.seat}` : '';
  const folder = row.exists ? 'folder exists' : `folder gone; team worktree remove ${row.task}`;
  return `${row.task} session ${row.session}${seat} ${row.path} ${folder}`;
}

// The record in the session this call is for. A record that lives only in another session is
// reported, not removed: `--session` chooses, and one call never clears two.
function findWorktree(state: State, task: string, sessionName: string) {
  const recorded = state.sessions[sessionName];
  const record = recorded?.worktrees[task];
  if (record && recorded) return { elsewhere: [] as string[], session: recorded, record };
  const elsewhere = Object.entries(state.sessions)
    .filter(([name, session]) => name !== sessionName && session.worktrees[task])
    .map(([name]) => name);
  if (elsewhere.length) return { elsewhere, session: recorded ?? emptySession(), record: undefined };
  return null;
}

function seatInTask(state: State, task: string): string | null {
  for (const recorded of Object.values(state.sessions)) {
    for (const [name, seat] of Object.entries(recorded.seats)) {
      if (seat.temporary?.task === task) return name;
    }
  }
  return null;
}

// The commit the new branch starts from: the base's upstream after a fetch, or the local base
// when the base has no upstream. A failed fetch creates nothing.
type StartPoint =
  | { ref: string; note?: string }
  | { error: string; id: 'worktree.base' | 'worktree.tracking' | 'worktree.fetch' };

function startPoint(root: string, base: string): StartPoint {
  const local = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  if (local.code !== 0) {
    return { error: `workspace.base ${JSON.stringify(base)} is not a branch here; nothing was created`, id: 'worktree.base' };
  }
  const upstream = git(root, ['rev-parse', '--abbrev-ref', `${base}@{upstream}`]);
  if (upstream.code !== 0) {
    return { ref: base, note: `base ${base} has no upstream, so the worktree starts from the local branch` };
  }
  const remote = upstream.stdout.trim();
  const slash = remote.indexOf('/');
  if (slash <= 0) {
    return {
      error: `base ${base} tracks ${JSON.stringify(remote)}, which isn't a remote branch; nothing was created`,
      id: 'worktree.tracking',
    };
  }
  const fetched = git(root, ['fetch', '--quiet', remote.slice(0, slash), remote.slice(slash + 1)]);
  if (fetched.code !== 0) {
    return {
      error: `couldn't fetch ${remote}: ${firstLine(fetched.stderr || fetched.stdout) || 'fetch failed'}. Nothing was created.`,
      id: 'worktree.fetch',
    };
  }
  return { ref: remote };
}

// The branch a worktree is on, as git's own list answers it: the entry whose folder is this one,
// and its ref. `null` is the list's answer that the folder's HEAD is detached, `undefined` that
// the list does not name the folder; the caller falls back to the record's branch for both.
function listedBranch(root: string, absolute: string): string | null | undefined {
  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return undefined;
  const want = realPath(absolute);
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line !== '');
    const head = lines[0] ?? '';
    if (!head.startsWith('worktree ') || realPath(head.slice('worktree '.length)) !== want) continue;
    const ref = lines.find((line) => line.startsWith('branch '));
    if (!ref) return null;
    const name = ref.slice('branch '.length);
    return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null;
  }
  return undefined;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The worktree's branch and whatever HEAD it has checked out. A detached HEAD, or another
// branch, is not that branch; removing the folder drops that reflog, so a commit that lives
// only there is named and the folder stays. With no remote-tracking refs, unpublished means
// not in the base.
function commitsOnNoRemote(root: string, worktree: string, branch: string, base: string | null): string[] {
  const remotes = git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
  const args = remotes.stdout.trim()
    ? ['rev-list', '--oneline', 'HEAD', branch, '--not', '--remotes']
    : ['rev-list', '--oneline', 'HEAD', branch, '--not', base ?? 'HEAD'];
  const listed = git(worktree, args);
  if (listed.code !== 0) return [`couldn't list commits: ${firstLine(listed.stderr)}`];
  return listed.stdout.split('\n').filter((line) => line !== '');
}

function realSetup(cwd: string, command: string): number {
  const result = spawnSync('sh', ['-c', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status ?? 1;
}

function runSetup(
  cwd: string, commands: string[], setup: (cwd: string, command: string) => number,
): { ok: true } | { ok: false; at: number } {
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i] as string;
    if (setup(cwd, command) !== 0) return { ok: false, at: i + 1 };
  }
  return { ok: true };
}

function publishedBranch(root: string, branch: string): string | null {
  const listed = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  for (const ref of listed.stdout.split('\n')) {
    const slash = ref.indexOf('/');
    if (slash > 0 && ref.slice(slash + 1) === branch) return ref;
  }
  return null;
}

function git(cwd: string, args: string[]): Run {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function list(lines: string[]): string {
  const shown = lines.slice(0, 20).map((line) => `  ${line}`);
  if (lines.length > 20) shown.push(`  and ${lines.length - 20} more`);
  return shown.join('\n');
}
