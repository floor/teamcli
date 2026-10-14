import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { notInForce, worktreeTeamInForceOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller } from '../caller.ts';
import { insideTrust } from '../file/paths.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import type { TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
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

export const USAGE = `Usage: team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
       team worktree list [--session <name>] [--file <path>]
       team worktree remove <task> [--session <name>] [--file <path>]
Ignored files in the worktree are deleted with it.
`;

export const worktree: Command = (argv, io) => runWorktree(argv, io, realSources);
export default worktree;

export async function runWorktree(argv: string[], io: Io, sources: WorktreeSources = realSources): Promise<number> {
  const args = readArgs(argv, ['kind', 'seat', 'session', 'file'], []);
  const sub = args.rest[0];
  const task = args.rest[1];
  if (args.error) {
    io.stderr(`team worktree: ${args.error}\n${USAGE}`);
    // exit: worktree.invocation
    return 2;
  }
  if (sub !== 'new' && sub !== 'remove' && sub !== 'list') {
    io.stderr(`team worktree: ${sub ? `unknown subcommand "${sub}"` : 'a subcommand is required'}\n${USAGE}`);
    // exit: worktree.subcommand
    return 2;
  }
  if (sub !== 'list' && !task) {
    io.stderr(`team worktree: a task name is required\n${USAGE}`);
    // exit: worktree.task-required
    return 2;
  }
  if (sub === 'list' ? args.rest.length > 1 : args.rest.length > 2) {
    io.stderr(`team worktree: unexpected "${sub === 'list' ? args.rest[1] : args.rest[2]}"\n${USAGE}`);
    // exit: worktree.extra
    return 2;
  }
  if ((sub === 'remove' || sub === 'list') && (args.values.kind || args.values.seat)) {
    io.stderr(`team worktree: ${sub} takes no --kind or --seat\n${USAGE}`);
    // exit: worktree.remove-flags
    return 2;
  }

  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor ask
  // the host about that file's session — the one place every command whose `--file` is the owner's decides
  // it is `fileOwnerRefusal` (caller.ts). `list`, `new` and `remove` run this same gate before the
  // load below.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    io.stderr(`team worktree: ${fileRefusal}\n`);
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
      io.stderr(`team worktree: ${sessionOwnerRefusal(walked)}\n`);
      // exit: worktree.session-owner
      return 1;
    }
  }

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const loaded = loadTeamFile(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home: sources.home,
    checkOnly: true,
  });
  const standing = loaded.ok ? (sources.standing?.(loaded.root) ?? approvalStanding(loaded.root, sources.home)) : null;
  const inForce = loaded.ok && standing ? worktreeTeamInForceOf(standing, loaded.team) : null;
  // Placement is judged on the file the command will use. A verified run uses the approved
  // copy, so an unapproved protected list on the live file does not refuse the load.
  const placed = loaded.ok ? placedProblems(inForce?.team ?? loaded.team, loaded.root, sources.home) : [];
  if (!loaded.ok || placed.length) {
    const problems = loaded.ok ? placed : loaded.errors;
    for (const problem of problems) {
      io.stderr(`team worktree: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: worktree.not-a-repo
    // exit: worktree.file
    // exit: worktree.file-invalid
    return 2;
  }
  const { team, root } = loaded;
  // One verified snapshot for the whole command, read once: every value the subcommands read
  // from the file is the approved copy's, including when the fingerprints match. The caller's
  // gate below is judged on those values too — a seat the file added to `orchestrator` is not one
  // until the owner approves it. With nothing verified the file's own values are read, exactly
  // as before, so the refusals are still main's. `project` on the snapshot is the live file's.
  if (standing === null || inForce === null) {
    io.stderr('team worktree: the approved copy can\'t be read: run `team approve`\n');
    // exit: worktree.approved-copy
    return 1;
  }
  const reading = inForce.team;
  const dir = dirname(loaded.path);
  // The gate judges the caller placed in the session this command asks about — the proof its pane
  // is that session's. With no `--session` the session judged is the caller's own placement: the
  // approved file's session first, then a session the state records this caller's pane in (`team
  // up --session <other>`) — never one a non-owner chose. The refusal names the caller's own
  // placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, reading);
  const { caller, shown } = judged;
  const session = judged.session;
  const verdict = mayChangeTeamVerdict(caller, reading, standingOf(dir, session, caller));
  if (verdict.kind === 'no-pane') {
    io.stderr(`team worktree: ${noPaneRefusal(verdict.name)}\n`);
    // exit: worktree.no-pane
    return 1;
  }
  if (verdict.kind === 'another-pane') {
    io.stderr(`team worktree: ${anotherPaneRefusal(verdict.name, verdict.recordedPane)}\n`);
    // exit: worktree.another-pane
    return 1;
  }
  if (verdict.kind === 'refused') {
    io.stderr(`team worktree: only the owner, the orchestrator or the operator runs it; this call is ${describeCaller(shown)}\n`);
    // exit: worktree.caller
    return 1;
  }
  if (session === 'default') {
    io.stderr('team worktree: session can\'t be "default", herdr\'s own session\n');
    // exit: worktree.default-session
    return 1;
  }
  if (standing.kind !== 'verified') {
    io.stderr(`team worktree: ${notInForce(standing)}\n`);
    // exit: worktree.never-approved
    return 1;
  }
  // One note, before the folder or anything else the command prints: the run goes on with the
  // approved settings, and the owner is told the file asks for more than that.
  if (inForce.differs) {
    io.stderr('team worktree: using the approved workspace settings; the file has unapproved changes: run `team approve`\n');
  }

  const who = describeCaller(caller);
  if (sub === 'list') return listWorktrees(io, reading, root, dir);
  // `list` is the only subcommand that arrives without a task; the gate above already returned.
  const named = task ?? '';
  if (sub === 'new') return create(io, sources, reading, team, root, dir, session, named, args.values.kind, args.values.seat, who);
  return removeWorktree(io, sources, reading, root, dir, session, named, who);
}

// The counted entries, and nothing else: no lock, no state write, no log line. The same rows
// the limit refusal names. A missing folder stays a row until `team worktree remove` drops it.
function listWorktrees(io: Io, team: TeamFile, root: string, dir: string): number {
  const rows = worktreeRows(readState(dir), root);
  const lines = [`${rows.length} open, limit ${team.workspace.limit} (workspace.limit)`, ...rows.map(worktreeRow)];
  io.stdout(`${lines.join('\n')}\n`);
  // exit: worktree.listed
  return 0;
}

// `team` is the approved copy for a verified standing, or the live file when nothing is verified;
// every value below is read from it. `file` is the live file, read for one thing only: telling a
// seat the file added — which must not be used until `team approve` — from one no section declares.
function create(
  io: Io, sources: WorktreeSources, team: TeamFile, file: TeamFile, root: string, dir: string, session: string, task: string,
  kind: string | undefined, seatName: string | undefined, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    io.stderr(`team worktree: ${named}\n`);
    // exit: worktree.task
    return 1;
  }
  if (kind !== undefined && taskProblem(kind)) {
    io.stderr(`team worktree: --kind: ${taskProblem(kind)}\n`);
    // exit: worktree.kind
    return 1;
  }
  if (team.workspace.mode === 'shared') {
    io.stderr('team worktree: workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create\n');
    // exit: worktree.shared
    return 1;
  }
  const pathPattern = team.workspace.path;
  const base = team.workspace.base;
  if (!pathPattern || !base) {
    io.stderr('team worktree: workspace.path and workspace.base are required\n');
    // exit: worktree.config
    return 1;
  }
  if (pathPattern.includes('{kind}')) {
    io.stderr('team worktree: workspace.path fills {repo} and {task} only\n');
    // exit: worktree.path-kind
    return 1;
  }
  const branchPattern = team.workspace.branch;
  if (branchPattern.includes('{kind}') && kind === undefined) {
    io.stderr(`team worktree: --kind is required: the branch pattern is ${JSON.stringify(branchPattern)}\n`);
    // exit: worktree.kind-required
    return 1;
  }
  if (!branchPattern.includes('{kind}') && kind !== undefined) {
    io.stderr(`team worktree: --kind has nowhere to go: the branch pattern is ${JSON.stringify(branchPattern)}\n`);
    // exit: worktree.kind-nowhere
    return 1;
  }
  const branch = fillPattern(branchPattern, { kind, task });
  const folder = fillPattern(pathPattern, { repo: team.project, task });
  if (!branch || !folder) {
    io.stderr('team worktree: the branch or path pattern has a placeholder other than {kind}, {task} or {repo}\n');
    // exit: worktree.placeholder
    return 1;
  }
  const hit = publicNameHit(team, [task, kind, branch, basename(folder)].filter((name): name is string => Boolean(name)));
  if (hit) {
    io.stderr(`team worktree: ${hit}; a public project refuses that name\n`);
    // exit: worktree.forbidden
    return 1;
  }
  if (!insideTrust(folder, team.trust, root, sources.home)) {
    io.stderr(`team worktree: ${folder} is outside the approved trust paths\n`);
    // exit: worktree.trust
    return 1;
  }
  const landing = realLanding(root, folder);
  if (landing.real !== landing.logical) {
    const rel = relative(realpathSync(root), landing.real).split(sep).join('/');
    if (!insideTrust(rel, team.trust, root, sources.home)) {
      io.stderr(`team worktree: ${folder} follows a symlink to ${landing.real}, which is outside the approved trust paths\n`);
      // exit: worktree.symlink
      return 1;
    }
  }
  if (seatName !== undefined && !team.seats.some((seat) => seat.name === seatName)) {
    if (file.seats.some((seat) => seat.name === seatName)) {
      io.stderr(`team worktree: seat ${seatName} is not in the approved file: run \`team approve\`\n`);
      // exit: worktree.seat-unapproved
      return 1;
    }
    io.stderr(`team worktree: --seat ${JSON.stringify(seatName)} names no declared seat\n`);
    // exit: worktree.seat
    return 1;
  }

  const absolute = landing.logical;
  let refused: string | null = null;
  const outcome = withLock(dir, () => {
    const state = readState(dir);
    refused = openRefusal(state, team.workspace.limit, task, session, root);
    if (refused) return null;
    if (existsSync(absolute)) {
      refused = `${folder} already exists`;
      return null;
    }
    const branchTaken = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (branchTaken.code === 0) {
      refused = `branch ${branch} already exists`;
      return null;
    }
    const published = publishedBranch(root, branch);
    if (published) {
      refused = `${published} already exists`;
      return null;
    }
    const format = git(root, ['check-ref-format', '--branch', branch]);
    if (format.code !== 0) {
      refused = `${JSON.stringify(branch)} is not a branch name`;
      return null;
    }
    const start = startPoint(root, base);
    if ('error' in start) {
      refused = start.error;
      return null;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    const added = git(root, ['worktree', 'add', '-q', '-b', branch, absolute, start.ref]);
    if (added.code !== 0) {
      refused = `the worktree was not created: ${firstLine(added.stderr || added.stdout)}`;
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
    io.stderr(`team worktree: ${refused ?? 'nothing was created'}\n`);
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
  if (!outcome.setup.ok) {
    logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}; setup failed on command ${outcome.setup.at}`, sources.now());
    io.stderr(`team worktree: setup failed on command ${outcome.setup.at} of ${team.workspace.setup.length}; the worktree is kept and recorded as setup: failed\n`);
    io.stdout(`${folder}\n`);
    // exit: worktree.setup
    return 1;
  }
  const note = outcome.start.note ? `; ${outcome.start.note}` : '';
  logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}${note}`, sources.now());
  io.stdout(`${folder}\n`);
  // exit: worktree.created
  return 0;
}

export function removeWorktree(
  io: Io, sources: WorktreeSources, team: TeamFile, root: string, dir: string, session: string, task: string, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    io.stderr(`team worktree: ${named}\n`);
    // exit: worktree.remove-task
    return 1;
  }
  let refused: string | null = null;
  const removed = withLock(dir, () => {
    const state = readState(dir);
    const found = findWorktree(state, task, session);
    if (!found) {
      refused = `no worktree named ${JSON.stringify(task)} is recorded`;
      return false;
    }
    if (!found.record) {
      refused = `${JSON.stringify(task)} is recorded in session ${found.elsewhere.join(', ')}, not in ${session}; nothing was removed`;
      return false;
    }
    const occupant = seatInTask(state, task);
    if (occupant) {
      refused = `seat ${occupant} is recorded in this worktree; team remove ${occupant} first`;
      return false;
    }
    const record = found.record;
    const absolute = resolve(root, record.path);
    if (!existsSync(absolute)) {
      git(root, ['worktree', 'prune']);
      delete found.session.worktrees[task];
      writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
      return 'gone' as const;
    }
    const porcelain = git(absolute, ['status', '--porcelain']);
    if (porcelain.code !== 0) {
      refused = `couldn't read the worktree: ${firstLine(porcelain.stderr)}`;
      return false;
    }
    const dirty = porcelain.stdout.split('\n').filter((line) => line !== '');
    if (dirty.length) {
      refused = `uncommitted or untracked files:\n${list(dirty)}`;
      return false;
    }
    const unpublished = commitsOnNoRemote(root, absolute, record.branch, team.workspace.base);
    if (unpublished.length) {
      refused = `commits on no remote branch:\n${list(unpublished)}`;
      return false;
    }
    const gone = git(root, ['worktree', 'remove', absolute]);
    if (gone.code !== 0) {
      refused = `the worktree was not removed: ${firstLine(gone.stderr || gone.stdout)}`;
      return false;
    }
    delete found.session.worktrees[task];
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return record.branch;
  });
  if (refused || removed === false) {
    io.stderr(`team worktree: ${refused ?? 'nothing was removed'}\n`);
    // exit: worktree.missing
    // exit: worktree.elsewhere
    // exit: worktree.occupied
    // exit: worktree.unreadable
    // exit: worktree.dirty
    // exit: worktree.unpublished
    // exit: worktree.remove-failed
    return 1;
  }
  if (removed === 'gone') {
    logLine(dir, 'worktree remove', who, `removed the record of ${task}; its folder was already gone`, sources.now());
    io.stdout(`removed the record of ${task}; its folder was already gone. No branch was deleted.\n`);
    // exit: worktree.record-gone
    return 0;
  }
  logLine(dir, 'worktree remove', who, `removed ${task}; kept branch ${removed}`, sources.now());
  io.stdout(`removed ${task}; the branch ${removed} is kept\n`);
  // exit: worktree.removed
  return 0;
}

function openRefusal(state: State, limit: number, task: string, session: string, root: string): string | null {
  for (const [name, recorded] of Object.entries(state.sessions)) {
    if (recorded.worktrees[task]) {
      return name === session
        ? `${JSON.stringify(task)} is already recorded`
        : `${JSON.stringify(task)} is already recorded in session ${name}`;
    }
  }
  const rows = worktreeRows(state, root);
  if (rows.length >= limit) {
    return `the worktree limit is ${limit}, and ${rows.length} are open (workspace.limit in the team file)\n${rows.map(worktreeRow).join('\n')}`;
  }
  return null;
}

// One row per counted key, every session of this state file. Sorted so the list and the
// refusal name the same entries in the same order.
function worktreeRows(state: State, root: string): { task: string; session: string; seat?: string; path: string; exists: boolean }[] {
  const rows: { task: string; session: string; seat?: string; path: string; exists: boolean }[] = [];
  for (const [session, recorded] of Object.entries(state.sessions)) {
    for (const [task, work] of Object.entries(recorded.worktrees)) {
      rows.push({
        task,
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
function startPoint(root: string, base: string): { ref: string; note?: string } | { error: string } {
  const local = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  if (local.code !== 0) return { error: `workspace.base ${JSON.stringify(base)} is not a branch here; nothing was created` };
  const upstream = git(root, ['rev-parse', '--abbrev-ref', `${base}@{upstream}`]);
  if (upstream.code !== 0) {
    return { ref: base, note: `base ${base} has no upstream, so the worktree starts from the local branch` };
  }
  const remote = upstream.stdout.trim();
  const slash = remote.indexOf('/');
  if (slash <= 0) return { error: `base ${base} tracks ${JSON.stringify(remote)}, which isn't a remote branch; nothing was created` };
  const fetched = git(root, ['fetch', '--quiet', remote.slice(0, slash), remote.slice(slash + 1)]);
  if (fetched.code !== 0) {
    return { error: `couldn't fetch ${remote}: ${firstLine(fetched.stderr || fetched.stdout) || 'fetch failed'}. Nothing was created.` };
  }
  return { ref: remote };
}

// The recorded branch and whatever HEAD the worktree has checked out. A detached HEAD, or
// another branch, is not the recorded branch; removing the folder drops that reflog, so a commit
// that lives only there is named and the folder stays. With no remote-tracking refs, unpublished
// means not in the base.
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
