// Registering a seat's team inbox with its CLI, at launch.
//
// A CLI that reads a project-scope MCP config file is registered in the seat's own folder:
// by the CLI's own `mcp add` where a run measured one, or by writing the file where team
// measured the shape (cursor). Only the route a profile carries is used, and the file is
// written only when the seat's folder is not a git work tree, or git confirms the file is
// ignored there: nothing team writes may land in a file the project tracks. A refused
// registration leaves the seat on its drop and typed legs, and the line says why.
//
// A route that lives on the launch line needs no file: the profile names the values, and the
// launch carries them. The client is told this install's own runner — the executable and its
// entry script — so the inbox server starts whether or not `team` is on the PATH. The seat is
// the only binding the launch states; the session is the team file's the launch read, so the
// drop folder the server serves is the sender's. A seat whose pane folder is a lobby has no
// team file of its own: the launch passes the file it resolved, and the registration names it
// to the server too, so neither reads the seat's folder for the team.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTeamConfig } from '../file/team-config.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { fillInboxPlace, profileFor, type InboxPlace } from '../profiles/profile.ts';
import { readState } from '../state.ts';

/** A registration's outcome: made, or refused with the reason the seat's line carries. */
export type InboxRegistration = { ok: true } | { ok: false; reason: string };

/** One command run in the seat's folder. `code` is null when it did not run at all. */
export type InboxRun = { code: number | null };

const SERVER_NAME = 'team-inbox';

/** The arguments the inbox server is started with, after the entry script. `file` is the team
 *  file the launch read; the server resolves the team from it, whatever folder the client
 *  starts it in. `epoch` is the runtime the seat's brief was delivered under, when the launch
 *  has a claim: a server started with it serves only that delivery. */
export function inboxServeArgs(seat: string, session: string, file?: string, epoch?: string): string[] {
  return [
    'mcp', 'serve',
    '--seat', seat,
    '--session', session,
    ...(file === undefined ? [] : ['--file', file]),
    ...(epoch === undefined ? [] : ['--epoch', epoch]),
  ];
}

/** The runtime epoch the seat's current claim names, when the launch's state holds one. A state
 *  file that cannot be read, or a claim an older build wrote, has none: the server then serves
 *  the claim it reads. */
function claimEpochOf(dir: string, session: string, seat: string): string | undefined {
  try {
    return currentBriefClaim(readState(dir).sessions[session]?.briefs?.[seat])?.epoch;
  } catch {
    return undefined;
  }
}

/** This install's runner: the executable and the entry script it runs. Resolved from this
 *  module, so a checkout runs its `cli.ts` and an installed build its `cli.js`. */
export function selfRunner(): { command: string; entry: string } {
  const here = fileURLToPath(import.meta.url);
  return { command: process.execPath, entry: join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js') };
}

function runIn(cwd: string): (command: string, args: readonly string[]) => InboxRun {
  return (command, args) => {
    const result = spawnSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: result.status ?? null };
  };
}

/**
 * Registers the seat's inbox when its CLI's profile carries a file route: the CLI's own
 * `mcp add`, or a config file team writes itself. Null when it carries none: a launch-line
 * route wrote everything it needs into the launch, and a CLI with no route stays on the drop
 * and typed legs.
 */
export function registerInbox(input: {
  cli: string;
  seat: string;
  cwd: string;
  /** The team file the seat's launch read: the registration and the server it names resolve
   *  the team from it, so a seat whose folder is a lobby registers like any other. Absent: the
   *  folder's own team file, read as the server reads it. */
  file?: string;
  /** The runtime epoch the launch delivered the seat's brief under, when the caller has it.
   *  Absent: read from the claim the launch's state holds for this seat. */
  epoch?: string;
  /** Runs a command in the seat's folder; tests pass their own. Absent: the real one. */
  run?: (command: string, args: readonly string[], cwd: string) => InboxRun;
}): InboxRegistration | null {
  const profile = profileFor(input.cli);
  const block = profile?.mcpInbox;
  if (!profile || !block || (block.add === null && block.file === null)) return null;
  let folder: string;
  try {
    folder = lstatSync(input.cwd).isDirectory() ? input.cwd : '';
  } catch {
    folder = '';
  }
  if (!folder) return { ok: false, reason: 'its folder could not be read' };
  // The launch's own team file when it names one; otherwise the folder's, read the way the
  // server itself reads it. A folder with no team file makes the server refuse, so nothing is
  // registered there: the seat stays on its drop and typed legs.
  const loaded = input.file === undefined ? readTeamConfig(folder) : readTeamConfig(folder, { file: input.file });
  if (!loaded.ok) {
    return { ok: false, reason: input.file === undefined ? 'no team file could be read from its folder' : 'the team file its launch read could not be read' };
  }
  const epoch = input.epoch ?? claimEpochOf(dirname(loaded.path), loaded.team.session, input.seat);
  const place: InboxPlace = {
    seat: input.seat,
    session: loaded.team.session,
    // The launch's file, named to the server: it starts in the seat's folder (a lobby has no
    // team file), and reads the team from this path instead.
    ...(input.file === undefined ? {} : { file: loaded.path }),
    // The runtime the seat's brief was delivered under: a server registered with it serves only
    // that delivery. Absent when the state holds no claim this run wrote.
    ...(epoch === undefined ? {} : { epoch }),
    ...selfRunner(),
  };
  const target = block.file ?? block.target;
  if (target === null) return null;
  const refused = ignoreProblem(folder, target);
  if (refused !== null) return { ok: false, reason: refused };
  if (block.file !== null) return writeConfigFile(folder, block.file, place);
  // `{file}` is a whole word: it is the launch's `--file <path>` pair, and nothing at all when
  // the launch named no file. `{epoch}` is the same for the runtime epoch, when this launch has
  // a claim: the server is then bound to the delivery it was registered under.
  const args: string[] = [];
  for (const word of block.add!) {
    if (word === '{file}') {
      if (place.file !== undefined) args.push('--file', place.file);
      continue;
    }
    if (word === '{epoch}') {
      if (place.epoch !== undefined) args.push('--epoch', place.epoch);
      continue;
    }
    args.push(fillInboxPlace(word, place));
  }
  const run = input.run ?? ((command, argv) => runIn(folder)(command, argv));
  const result = run(profile.binary, args, folder);
  if (result.code !== 0) {
    return { ok: false, reason: `\`${profile.binary} mcp add\` exited ${result.code === null ? 'without running' : result.code}` };
  }
  const path = join(folder, block.target!);
  try {
    if (lstatSync(path).isFile()) return { ok: true };
  } catch {
    // The command said it wrote the file and did not: the client would start with no server.
  }
  return { ok: false, reason: `${block.target} was not written` };
}

/**
 * Why the seat's folder may not take a config file, or null when it may. A folder outside a
 * repository is the seat's own; one inside a work tree must have the file ignored, which is
 * also how a tracked file reads — git never ignores one.
 */
function ignoreProblem(folder: string, target: string): string | null {
  const inside = runGit(folder, ['rev-parse', '--is-inside-work-tree']);
  // No repository here — or no git to ask: the folder is the seat's own and holds no
  // tracked file to protect. A repository with no work tree is neither.
  if (inside === null || inside.code !== 0) return null;
  if (inside.stdout.trim() !== 'true') return 'its folder is inside a git repository with no work tree';
  const ignored = runGit(folder, ['check-ignore', '-q', '--', target]);
  if (ignored === null) return `git could not say whether ${target} is ignored`;
  if (ignored.code === 0) return null;
  if (ignored.code === 1) return `its project does not ignore ${target}`;
  return `git could not say whether ${target} is ignored`;
}

function runGit(folder: string, args: readonly string[]): { code: number; stdout: string } | null {
  const result = spawnSync('git', [...args], {
    cwd: folder,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status === null) return null;
  return { code: result.status, stdout: result.stdout ?? '' };
}

/**
 * A config file team writes itself: the seat's entry merged into the file's other keys. A file
 * that is a link, not one object, or not JSON is left exactly as it is — the seat keeps its
 * drop and typed legs rather than the project losing a file team cannot read. The new text is
 * written beside it and renamed over it, so a failed write leaves the old file whole.
 */
function writeConfigFile(folder: string, file: string, place: InboxPlace): InboxRegistration {
  const path = join(folder, file);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return { ok: false, reason: `${file} could not be read` };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, reason: `${file} is not a regular file` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { ok: false, reason: `${file} is not JSON, so it was left as it is` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `${file} does not hold a JSON object, so it was left as it is` };
    }
    existing = parsed as Record<string, unknown>;
  }
  const servers = existing.mcpServers ?? {};
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: false, reason: `${file} holds mcpServers that is not an object, so it was left as it is` };
  }
  const next = {
    ...existing,
    mcpServers: {
      ...(servers as Record<string, unknown>),
      [SERVER_NAME]: {
        command: place.command,
        args: [place.entry, ...inboxServeArgs(place.seat, place.session, place.file, place.epoch)],
      },
    },
  };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const temp = `${path}.team-tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // The temp never existed, or is already gone: the refusal is the same either way.
    }
    return { ok: false, reason: `${file} could not be written` };
  }
  return { ok: true };
}
