// A Claude channel's project config belongs to one seat and one claimed launch. No CLI home,
// shared lobby config or trust store is read or written here.
import { socketSuppressed } from '../queue/floor.ts';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from '../host/guarded-fs.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import { isLegacyTrust } from '../file/paths.ts';
import { isLeadSeat } from '../file/sections/lead.ts';
import type { TeamFile } from '../file/types.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { verifyLobby } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { getTeam, registeredRootOf, teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import { CHANNEL_SERVER } from './channel.ts';
import { inboxServeArgs, selfRunner } from './register.ts';
import { addJsonName, setJsonValue } from './json-text.ts';

type ChannelSeat = { name?: string; cli: string; cwd?: string; launch?: string; channelOff?: boolean; human?: boolean; stopped?: boolean };

/** Every claude-code seat, unless its record says `channel: off` or the pane is a person's. */
export function claudeChannelSeat(seat: ChannelSeat): boolean {
  return seat.cli === 'claude-code' && seat.channelOff !== true && seat.human !== true && seat.stopped !== true;
}

/** Used at placement and again after the existing lobby gate canonicalizes its root. */
export function channelLobbyFolder(lobby: string, seat: ChannelSeat & { name: string }): string {
  return claudeChannelSeat(seat) ? join(lobby, seat.name) : lobby;
}

function samePlace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** The owner's checkout already holds this seat's team-inbox pair: both project files name it,
 *  and the server entry is this seat's. Another seat's pair in that folder is not this one's. */
export function channelPairPresent(dir: string, seat: string): boolean {
  try {
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const server = mcp.mcpServers?.[CHANNEL_SERVER];
    if (server === null || typeof server !== 'object' || Array.isArray(server)) return false;
    const args = (server as { args?: unknown }).args;
    const named = Array.isArray(args) && args[args.indexOf('--seat') + 1] === seat;
    if (!named) return false;
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')) as {
      enabledMcpjsonServers?: unknown;
      enableAllProjectMcpServers?: unknown;
    };
    if (settings.enableAllProjectMcpServers === true) return true;
    return Array.isArray(settings.enabledMcpjsonServers) && settings.enabledMcpjsonServers.includes(CHANNEL_SERVER);
  } catch {
    return false;
  }
}

/** Whether the folder's team-inbox entry names an `--epoch`: a pair an earlier build wrote. */
export function channelPairPinsEpoch(dir: string): boolean {
  try {
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const args = (mcp.mcpServers?.[CHANNEL_SERVER] as { args?: unknown } | undefined)?.args;
    return Array.isArray(args) && args.includes('--epoch');
  } catch {
    return false;
  }
}

export type ChannelStart = { cwd: string; lobby: boolean };

/**
 * Where a Claude seat reads its channel pair. A lead keeps its project cwd, with or without a
 * pair; other seats keep that checkout only when their own pair is already there. A seat with
 * its own worktree uses that worktree. Every other seat uses its folder inside the lobby.
 * Null when the seat is not a channel seat.
 */
export function channelStart(seat: ChannelSeat & { name: string; cwd: string }, root: string, lobby: string, keepProjectCwd = false): ChannelStart | null {
  if (!claudeChannelSeat(seat)) return null;
  const declared = isAbsolute(seat.cwd) ? resolve(seat.cwd) : resolve(root, seat.cwd);
  const checkout = resolve(root);
  if (samePlace(declared, checkout) && (keepProjectCwd || channelPairPresent(checkout, seat.name))) return { cwd: checkout, lobby: false };
  const lobbyRoot = resolve(lobby);
  if (seat.cwd === '.' || samePlace(declared, checkout) || samePlace(declared, lobbyRoot)) {
    return { cwd: join(lobbyRoot, seat.name), lobby: true };
  }
  return { cwd: declared, lobby: false };
}

/** A default channel never changes an admitted legacy start or moves a lead out of its project.
 *  The launch says and logs this repair once, while retaining the stored launch recipe. */
export function channelLaunchFallback(
  team: Pick<TeamFile, 'trust' | 'orchestrator' | 'operator'>,
  seat: ChannelSeat & { name: string; cwd: string },
  root: string,
  /** The home the root's floor state is read under: on an E7b-active root no socket is dialed
   *  (the Claude adapter §1), so the warning names the pointer instead. Absent, the dark words. */
  home?: string,
): string | undefined {
  if (!claudeChannelSeat(seat)) return undefined;
  const fallback = home !== undefined && socketSuppressed(root, home)
    ? 'no proven channel: pointer wakes until the next `team restart`'
    : 'socket delivery remains available';
  if (isLegacyTrust(team.trust)) {
    return `its channel needs the current trust form. Launching without the channel; ${fallback}. Move trust to the current absolute-path form, or set channel: off to silence this warning.`;
  }
  if (isLeadSeat(team, seat.name) && samePlace(resolve(root, seat.cwd), root) && !channelPairPresent(root, seat.name)) {
    return `its project folder has no channel pair for this seat. Launching without the channel; ${fallback}. Add the seat's channel pair in this folder, or move the lead's cwd to opt in.`;
  }
  return undefined;
}

export type ChannelLaunchScope = { root: string; home?: string; epoch?: string };
export type ChannelConfigLease = { check(): void; release(): void };
export type ObjectMap = Record<string, unknown>;
type Seen = Stats;
export class ConfigRefusal extends Error {}

function object(value: unknown): value is ObjectMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same(a: Seen, b: Seen): boolean { return a.dev === b.dev && a.ino === b.ino; }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function present(path: string): Seen | null {
  try { return lstatSync(path); } catch (error) { if (absent(error)) return null; throw error; }
}
export function channelDirectory(path: string, privateMode = true): Seen {
  const stat = lstatSync(path);
  const mode = stat.mode & 0o7777;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (privateMode ? mode !== 0o700 : (mode & 0o700) !== 0o700 || (mode & 0o7022) !== 0)) {
    throw new ConfigRefusal('the channel folder must be an owned real directory with safe permissions');
  }
  if (realpathSync(path) !== resolve(path)) throw new ConfigRefusal('the channel folder resolves through a symbolic link');
  return stat;
}

/** A snapshot of one owned project JSON file. Both snapshots are validated before publishing
 *  either member of the pair; their exact bytes and identities are then bound to the lease. */
export function channelDocument(path: string) {
  const previous = present(path);
  const bytes = (expected: Seen): string => {
    const now = lstatSync(path);
    if (!now.isFile() || now.isSymbolicLink() || now.uid !== process.getuid?.() || now.nlink !== 1 || !same(now, expected)) {
      throw new ConfigRefusal('the channel configuration is not the same owned regular file');
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(fstatSync(fd), expected)) throw new ConfigRefusal('the channel configuration changed before it could be read');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  };
  const before = previous === null ? undefined : bytes(previous);
  let parsed: unknown;
  try { parsed = before === undefined ? {} : JSON.parse(before); }
  catch { throw new ConfigRefusal('the channel configuration must hold valid JSON'); }
  if (!object(parsed)) throw new ConfigRefusal('the channel configuration must hold a JSON object');
  return { path, before, value: parsed,
    unchanged: (): boolean => previous === null ? present(path) === null : bytes(previous) === before,
    bind: (text: string): (() => boolean) => {
      const published = lstatSync(path);
      return () => bytes(published) === text;
    },
  };
}

/** Only the documented named approval is added. Existing data, other names and rejection
 *  lists stay intact; an explicit local rejection is a refusal, never something to erase. */
function approveChannel(settings: ObjectMap): ObjectMap {
  const names = (key: string): string[] => {
    const value = settings[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
      throw new ConfigRefusal('the local channel approval lists must be arrays of server names');
    }
    return value as string[];
  };
  const enabled = names('enabledMcpjsonServers');
  if (names('disabledMcpjsonServers').includes(CHANNEL_SERVER) || names('disabledMcpServers').includes(CHANNEL_SERVER)) {
    throw new ConfigRefusal('the local settings explicitly reject the channel server');
  }
  if (settings.enableAllProjectMcpServers !== undefined && typeof settings.enableAllProjectMcpServers !== 'boolean') {
    throw new ConfigRefusal('the existing project-server approval switch is malformed');
  }
  return enabled.includes(CHANNEL_SERVER) ? settings : { ...settings, enabledMcpjsonServers: [...enabled, CHANNEL_SERVER] };
}

const OWNER_ENV = 'TEAMCLI_CHANNEL_SCOPE';

/** Ownership lives inside the generated server entry, in its standard MCP env map. Other
 *  entries and top-level keys are never claimed. An edited or unmarked entry is a conflict. */
export function ownedEntry(value: unknown, owner: string, seat: string, session: string): boolean {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'args,command,env'
    || typeof value.command !== 'string' || !isAbsolute(value.command) || !object(value.env)
    || Object.keys(value.env).join(',') !== OWNER_ENV || value.env[OWNER_ENV] !== owner
    || !Array.isArray(value.args) || value.args.some((word) => typeof word !== 'string')) return false;
  const args = value.args as string[];
  return (args.length === 7 || args.length === 9) && isAbsolute(args[0]!) && args[1] === 'mcp' && args[2] === 'serve'
    && args[3] === '--seat' && args[4] === seat && args[5] === '--session' && args[6] === session
    && (args.length === 7 || (args[7] === '--epoch' && isBriefEpoch(args[8])));
}

export type ChannelDocument = ReturnType<typeof channelDocument>;
export type ChannelWrite = { doc: ChannelDocument; text: string | undefined };
export type ChannelPairPlan = {
  cwd: string;
  privateFolder: boolean;
  folder: Seen;
  approvalFolder: Seen | null;
  documents: ChannelWrite[];
};
export type ChannelPairScope = { root: string; seat: string; session: string; cwd: string; epoch?: string };

/** Shared, read-only preflight for launch and setup. Admission and placement belong to callers. */
export function planChannelPair(input: ChannelPairScope, privateFolder = true): ChannelPairPlan {
  const folder = channelDirectory(input.cwd, privateFolder);
  const approvalDir = join(input.cwd, '.claude');
  const approvalFolder = present(approvalDir);
  if (approvalFolder !== null) channelDirectory(approvalDir, false);
  if (present(join(input.cwd, '.team-channel.lock')) !== null) {
    throw new ConfigRefusal('a leftover channel lock is in the seat folder; remove .team-channel.lock by hand and launch again');
  }
  const mcp = channelDocument(join(input.cwd, '.mcp.json'));
  const servers = mcp.value.mcpServers === undefined ? {} : mcp.value.mcpServers;
  if (!object(servers)) throw new ConfigRefusal('the channel project config has invalid mcpServers');
  const owner = JSON.stringify({ v: 1, team: teamIdOf(input.root), seat: input.seat, session: input.session });
  if (Object.hasOwn(servers, CHANNEL_SERVER) && !ownedEntry(servers[CHANNEL_SERVER], owner, input.seat, input.session)) {
    throw new ConfigRefusal('the channel server name is already owned by another configuration');
  }
  const runner = selfRunner();
  // A pair in a checkout folder (a project root or a worktree) outlives the launch that wrote
  // it, so it names no epoch: a pinned epoch there goes stale at the next relaunch and the
  // server it names refuses. The server binds the seat's current claim at its own start, and a
  // claim written after that start is never adopted. A lobby pair is written by each launch.
  const epoch = privateFolder ? input.epoch : undefined;
  const entry = { command: runner.command,
    args: [runner.entry, ...inboxServeArgs(input.seat, input.session, undefined, epoch)],
    env: { [OWNER_ENV]: owner } };
  const approval = channelDocument(join(approvalDir, 'settings.local.json'));
  approveChannel(approval.value); // Validate rejection switches and both approval lists first.
  return { cwd: input.cwd, privateFolder, folder, approvalFolder, documents: [
    { doc: mcp, text: setJsonValue(mcp.before ?? '{}\n', ['mcpServers', CHANNEL_SERVER], JSON.stringify(entry)) },
    { doc: approval, text: addJsonName(approval.before ?? '{}\n', 'enabledMcpjsonServers', CHANNEL_SERVER) },
  ] };
}

/** The same inode-bound, exclusive pair publication for both entry points. */
export function publishChannelPair(plan: ChannelPairPlan, validate: () => void, extra: ChannelWrite[] = [], releaseGuard: () => void = () => {}, extraLast = false):
  { ok: true; lease: ChannelConfigLease } | { ok: false; reason: string } {
  let release: (() => void) | undefined;
  let cleanTemp: (() => void) | undefined;
  try {
    const { cwd: folder, privateFolder } = plan;
    const folderSeen = plan.folder;
    const approvalDir = join(folder, '.claude');
    let approvalSeen = plan.approvalFolder;
    const documents = extraLast ? [...plan.documents, ...extra] : [...extra, ...plan.documents];
    const matches: Array<() => boolean> = [];
    const folderMatches = () => {
      if (!same(channelDirectory(folder, privateFolder), folderSeen)) throw new ConfigRefusal('the channel folder changed');
      validate();
    };
    folderMatches();
    if (documents.some(({ doc }) => !doc.unchanged())) throw new ConfigRefusal('the channel configuration pair changed during preparation');
    const lock = join(folder, '.team-channel.lock');
    if (present(lock) !== null) throw new ConfigRefusal('a leftover channel lock is in the seat folder; remove .team-channel.lock by hand and launch again');
    mkdirSync(lock, { mode: 0o700 }); const lockSeen = channelDirectory(lock); let held = true;
    const check = () => {
      folderMatches();
      if (!held || !same(channelDirectory(lock), lockSeen)) throw new ConfigRefusal('the channel config claim changed');
      if (approvalSeen !== null && !same(channelDirectory(approvalDir, false), approvalSeen)) throw new ConfigRefusal('the channel approval folder changed before launch');
      if (matches.some((match) => !match())) throw new ConfigRefusal('the prepared channel config changed before launch');
    };
    release = () => {
      if (!held) return; held = false;
      try { releaseGuard(); if (same(channelDirectory(folder, privateFolder), folderSeen) && same(channelDirectory(lock), lockSeen)) rmdirSync(lock); } catch { /* retain an unproven lock */ }
    };
    if (approvalSeen === null && plan.documents.some(({ doc, text }) => dirname(doc.path) === approvalDir && text !== undefined)) {
      check();
      mkdirSync(approvalDir, { mode: 0o700 }); approvalSeen = channelDirectory(approvalDir, false);
    }
    for (let index = 0; index < documents.length; index++) {
      const { doc, text } = documents[index]!;
      const unchanged = () => documents.slice(index).every(({ doc: pending }) => pending.unchanged());
      check(); if (!unchanged()) throw new ConfigRefusal('the channel configuration pair changed during preparation');
      if (doc.before === text) {
        matches.push(text === undefined ? () => present(doc.path) === null : doc.bind(text)); continue;
      }
      if (text === undefined) {
        unlinkSync(doc.path); matches.push(() => present(doc.path) === null); continue;
      }
      const parent = dirname(doc.path); const parentSeen = parent === folder ? folderSeen : approvalSeen!;
      const temp = join(parent, `.team-channel.${randomBytes(12).toString('hex')}.tmp`);
      const fd = openSync(temp, 'wx', 0o600); const tempSeen = fstatSync(fd);
      cleanTemp = () => {
        const current = present(temp);
        if (held && current !== null && same(current, tempSeen)
          && same(channelDirectory(folder, privateFolder), folderSeen) && same(channelDirectory(lock), lockSeen)
          && same(channelDirectory(parent, parent === folder ? privateFolder : false), parentSeen)) unlinkSync(temp);
      };
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      check(); if (!unchanged()) throw new ConfigRefusal('the channel configuration pair changed during preparation');
      renameSync(temp, doc.path); cleanTemp = undefined; matches.push(doc.bind(text));
    }
    check(); return { ok: true, lease: { check, release } };
  } catch (error) {
    try { cleanTemp?.(); } catch { /* leave anything whose ownership cannot be proven */ }
    release?.();
    return { ok: false, reason: error instanceof ConfigRefusal ? error.message : 'the channel config could not be safely read or written' };
  }
}

/** Launch admission stays stricter than setup: a trusted registered lobby and current claim. */
export function prepareChannelConfig(input: ChannelLaunchScope & { seat: string; session: string; cwd: string }):
  { ok: true; lease: ChannelConfigLease } | { ok: false; reason: string } {
  try {
    if (input.home === undefined || !isBriefEpoch(input.epoch) || !SEAT_NAME.test(input.seat)) throw new ConfigRefusal('channel launch requires its home and explicit claimed epoch');
    const home = input.home; const epoch = input.epoch;
    const found = registeredRootOf(home, input.seat, input.session);
    if (!found.ok || realpathSync(found.root) !== realpathSync(input.root)) throw new ConfigRefusal('the channel seat has no unique registered team root');
    const record = getTeam(home, teamIdOf(found.root));
    const loaded = readTeamConfig(found.root, { home });
    if (!loaded.ok || loaded.team.session !== input.session || record === null) throw new ConfigRefusal('the registered channel team cannot be read for this session');
    const declared = loaded.team.seats.find((seat) => seat.name === input.seat);
    if (declared === undefined || declared.stopped || declared.human || !claudeChannelSeat(declared)) throw new ConfigRefusal('the registered seat does not declare a Claude channel launch');
    const lobby = lobbyOf(home, loaded.root, loaded.team);
    if (record.lobbies[input.session] !== lobby || !loaded.team.trust?.some((path) => resolve(path.replace(/^~(?=$|\/)/, home)) === resolve(lobby))) throw new ConfigRefusal('the channel lobby must already be registered and trusted by the team');
    const start = channelStart(declared, loaded.root, lobby, isLeadSeat(loaded.team, declared.name));
    if (start === null) throw new ConfigRefusal('the registered seat does not declare a Claude channel launch');
    const at = resolve(input.cwd);
    if (!samePlace(at, start.cwd)) throw new ConfigRefusal('the channel must start in its own folder');
    if (!start.lobby && samePlace(at, resolve(loaded.root))) {
      if (!channelPairPresent(at, declared.name)) throw new ConfigRefusal('the project folder has no channel pair for this seat');
      // A pair an earlier build wrote pins the epoch of the launch it was written for. It is
      // rewritten, owned entry only, to name none, so this and every later launch serves.
      // The launch's own claim must still be current through the rewrite and up to the spawn: a
      // pair rewritten for a launch a relaunch has replaced would be read by the wrong server.
      const stillCurrent = () => {
        const current = currentBriefClaim(readState(dirname(loaded.path)).sessions[input.session]?.briefs?.[input.seat]);
        if (current === null || current.epoch !== epoch) throw new ConfigRefusal('the channel launch epoch is no longer its current claim');
      };
      stillCurrent();
      if (!channelPairPinsEpoch(at)) return { ok: true, lease: { check: stillCurrent, release() {} } };
      return publishChannelPair(planChannelPair({ ...input, epoch }, false), stillCurrent);
    }
    const gate = verifyLobby(home, { lobby, create: false });
    if (!gate.ok || !('path' in gate)) throw new ConfigRefusal('the registered channel lobby is unsafe or missing');
    const lobbySeen = channelDirectory(lobby);
    const claimMatches = () => {
      if (!same(channelDirectory(lobby), lobbySeen)) throw new ConfigRefusal('the channel lobby changed');
      const current = currentBriefClaim(readState(dirname(loaded.path)).sessions[input.session]?.briefs?.[input.seat]);
      if (current === null || current.epoch !== epoch) throw new ConfigRefusal('the channel launch epoch is no longer its current claim');
    };
    claimMatches();
    // A lobby folder is one this run creates, so it stays private. A worktree already exists
    // at the mode git gave it: owner-owned, with no group or other write, is enough.
    const privateFolder = start.lobby;
    if (privateFolder) {
      try { mkdirSync(input.cwd, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return publishChannelPair(planChannelPair({ ...input, epoch }, privateFolder), claimMatches, [], () => {
      if (!same(channelDirectory(lobby), lobbySeen)) throw new ConfigRefusal('the channel lobby changed');
    });
  } catch (error) {
    return { ok: false, reason: error instanceof ConfigRefusal ? error.message : 'the channel config could not be safely read or written' };
  }
}
