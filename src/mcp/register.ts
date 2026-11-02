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
// team file of its own. A file the launch read is passed on and named to the server too, so
// neither reads the seat's folder for the team; a registry team's launch names no file — the
// record is the definition, and the file beside it need not exist — and both resolve the team
// from the registry's roster instead. A launch that can name no team is refused loudly rather
// than registered against whatever folder it started in.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTeamConfig } from '../file/team-config.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { fillInboxPlace, profileFor, type InboxPlace } from '../profiles/profile.ts';
import { registeredRootOf, type RegisteredRoot } from '../registry/teams.ts';
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
   *  team is the registry's record for this seat, resolved here and in the server's own way; a
   *  seat no registered roster holds is refused, never registered against the folder's team. */
  file?: string;
  /** The session the launch serves: narrows between registered teams that hold the seat name.
   *  Read only when no `file` is named; a named file's own session is the team's. */
  session?: string;
  /** The registry's home. Absent: the machine's own. */
  home?: string;
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
  // The launch's own team file when it names one. Otherwise the team is the registry's record
  // for this seat: a registry-sourced launch names no file (the path a registry read carries is
  // for a file that need not exist), so reading a team file here would be reading a folder that
  // holds none — exactly the launch that left a seat with no inbox, silently.
  let loaded: ReturnType<typeof readTeamConfig>;
  if (input.file !== undefined) {
    loaded = readTeamConfig(folder, { file: input.file });
    if (!loaded.ok) return { ok: false, reason: 'the team file its launch read could not be read' };
  } else {
    const found = registeredRootOf(input.home ?? homedir(), input.seat, input.session);
    if (!found.ok) return { ok: false, reason: registryReason(found, input.seat) };
    loaded = readTeamConfig(found.root, { ...(input.home === undefined ? {} : { home: input.home }) });
    if (!loaded.ok) return { ok: false, reason: 'the registered team could not be read' };
    // The roster lookup returns a lone holder even when it is another session's team, so this
    // run's own session is checked here, before any config is written: a launch that asked for
    // one team must never be registered against another team's inbox. The server makes the same
    // two checks after the same lookup; a seat the found record does not declare is refused too.
    if (input.session !== undefined && input.session !== loaded.team.session) {
      return { ok: false, reason: `the registered team's session is ${JSON.stringify(loaded.team.session)}, not ${JSON.stringify(input.session)}` };
    }
    if (!loaded.team.seats.some((one) => one.name === input.seat)) {
      return { ok: false, reason: `the registered team declares no seat ${JSON.stringify(input.seat)}` };
    }
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
  const run = input.run ?? ((command, argv) => runIn(folder)(command, argv));
  if (target === null) {
    // The CLI's own user-level store: the entry belongs to no checkout, so there is no file in
    // the seat's folder to protect or to read back. The command's own exit is the answer
    // (measured on agy 1.4.12: `agy mcp add <name> ...` exits 0 and writes exactly that entry).
    const result = run(profile.binary, addWords(block.add!, place), folder);
    return result.code === 0 ? { ok: true } : { ok: false, reason: addRefusal(profile.binary, result.code) };
  }
  const refused = ignoreProblem(folder, target);
  if (refused !== null) return { ok: false, reason: refused };
  if (block.file !== null) return writeConfigFile(folder, block.file, place);
  const result = run(profile.binary, addWords(block.add!, place), folder);
  if (result.code !== 0) {
    // A JSON project file is the shape `writeConfigFile` already writes. When the CLI's own
    // `mcp add` fails, write that file instead of leaving the seat without an inbox. A non-JSON
    // target (a toml, for one) is still the CLI's to write, and the exit is reported.
    if (target.endsWith('.json')) return writeConfigFile(folder, target, place);
    return { ok: false, reason: addRefusal(profile.binary, result.code) };
  }
  const path = join(folder, block.target!);
  try {
    if (lstatSync(path).isFile()) return { ok: true };
  } catch {
    // The command said it wrote the file and did not: the client would start with no server.
  }
  return { ok: false, reason: `${block.target} was not written` };
}

/** The `mcp add` words with the launch's values filled in. `{file}` is a whole word: it is the
 *  launch's `--file <path>` pair, and nothing at all when the launch named no file. `{epoch}`
 *  is the same for the runtime epoch, when this launch has a claim: the server is then bound to
 *  the delivery it was registered under. */
function addWords(words: readonly string[], place: InboxPlace): string[] {
  const args: string[] = [];
  for (const word of words) {
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
  return args;
}

function addRefusal(binary: string, code: number | null): string {
  return `\`${binary} mcp add\` exited ${code === null ? 'without running' : code}`;
}

/** A teardown's outcome: an entry removed, nothing to remove because the store did not hold the
 *  name (the one failure a run measured), or the reason the command could not be run. */
export type InboxRemoval = { ok: true; removed: boolean } | { ok: false; reason: string };

/**
 * Removes this seat's entry from its CLI's user-level store, for a seat `team down` closes.
 * Null when the CLI's profile carries no user-level route with a measured remove: a project
 * file or a launch-line argument leaves nothing behind. Only the seat's own entry — `{inbox}`,
 * the name the launch registered — is named, and the CLI's command takes exactly that one name.
 * The store is shared by every team on the machine, so no other entry is touched.
 */
export function removeInbox(input: {
  cli: string;
  seat: string;
  session: string;
  /** Runs a command; tests pass their own. Absent: the real one, in this process's folder. */
  run?: (command: string, args: readonly string[]) => InboxRun;
}): InboxRemoval | null {
  const profile = profileFor(input.cli);
  const block = profile?.mcpInbox;
  if (!profile || !block || block.remove === null || block.add === null
    || block.target !== null || block.file !== null) return null;
  const place: InboxPlace = { seat: input.seat, session: input.session, ...selfRunner() };
  const args = block.remove.map((word) => fillInboxPlace(word, place));
  const run = input.run ?? ((command, argv) => runIn(process.cwd())(command, argv));
  const result = run(profile.binary, args);
  if (result.code === 0) return { ok: true, removed: true };
  // agy 1.4.12's one measured remove failure is a name the store does not hold: exit 1 with
  // `Error: MCP server "<name>" not found`. That entry is already gone, so the teardown is
  // done; any other exit — or a command that never ran — is reported and the entry is kept.
  if (result.code === 1) return { ok: true, removed: false };
  return {
    ok: false,
    reason: result.code === null
      ? `\`${profile.binary} mcp remove\` did not run`
      : `\`${profile.binary} mcp remove\` exited ${result.code}`,
  };
}

/** Why the registry named no team for the seat, in the seat's line's words. */
function registryReason(found: Exclude<RegisteredRoot, { ok: true }>, seat: string): string {
  switch (found.kind) {
    case 'unreadable':
      return `the team registry cannot be read: ${found.message}`;
    case 'none':
      return `no registered team holds seat ${JSON.stringify(seat)}`;
    case 'ambiguous':
      return `seat ${JSON.stringify(seat)} is on ${String(found.ids.length)} registered teams (${found.ids.join(', ')})`;
  }
}

/**
 * What the seat's folder says about its profile's file route: the file the route writes, and
 * whether that file holds the registration. Read from the file itself — a JSON file's
 * `mcpServers` entry, or the server's name in a file whose format this module does not parse
 * (a toml). Null when nothing on disk can say: a profile with no route, or a launch-line route
 * whose registration lives on the command and not in a file.
 */
export function inboxRegistration(cli: string, cwd: string): { target: string; registered: boolean } | null {
  const block = profileFor(cli)?.mcpInbox;
  if (!block) return null;
  const target = block.file ?? block.target;
  if (target === null) return null;
  let text: string;
  try {
    text = readFileSync(join(cwd, target), 'utf8');
  } catch {
    return { target, registered: false };
  }
  if (!target.endsWith('.json')) return { target, registered: text.includes(SERVER_NAME) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { target, registered: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { target, registered: false };
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return { target, registered: false };
  return { target, registered: (servers as Record<string, unknown>)[SERVER_NAME] !== undefined };
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
  if (isIgnored(folder, target)) return null;
  // A tracked file is never ignored. Do not pretend, and do not append it to exclude.
  const tracked = runGit(folder, ['ls-files', '--error-unmatch', '--', target]);
  if (tracked !== null && tracked.code === 0) return `its project tracks ${target}`;
  if (!excludeTarget(folder, target)) return `its project does not ignore ${target}`;
  if (isIgnored(folder, target)) return null;
  return `its project does not ignore ${target}`;
}

function isIgnored(folder: string, target: string): boolean {
  const ignored = runGit(folder, ['check-ignore', '-q', '--', target]);
  return ignored !== null && ignored.code === 0;
}

/** Appends `target` to the common git dir's info/exclude, the same place `team init` writes. */
function excludeTarget(folder: string, target: string): boolean {
  const common = runGit(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null || common.code !== 0) return false;
  const path = join(common.stdout.trim(), 'info', 'exclude');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current.split('\n').some((line) => line.trim() === target)) return true;
    writeFileSync(path, `${current}${current !== '' && !current.endsWith('\n') ? '\n' : ''}${target}\n`);
    return true;
  } catch {
    return false;
  }
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
