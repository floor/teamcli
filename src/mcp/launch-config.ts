// A Claude channel's project config belongs to one seat and one claimed launch. No CLI home,
// shared lobby config or trust store is read or written here.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { verifyLobby } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { getTeam, registeredRootOf, teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import { CHANNEL_SERVER, channelLaunchEnabled } from './channel.ts';
import { inboxServeArgs, selfRunner } from './register.ts';

export function claudeChannelSeat(seat: { cli: string; launch: string }): boolean {
  return seat.cli === 'claude-code' && channelLaunchEnabled(seat.launch);
}

/** Used at placement and again after the existing lobby gate canonicalizes its root. */
export function channelLobbyFolder(lobby: string, seat: { name: string; cli: string; launch: string }): string {
  return claudeChannelSeat(seat) ? join(lobby, seat.name) : lobby;
}

export type ChannelLaunchScope = { root: string; home?: string; epoch?: string };
export type ChannelConfigLease = { check(): void; release(): void };
type ObjectMap = Record<string, unknown>;
type Seen = Stats;
class ConfigRefusal extends Error {}

function object(value: unknown): value is ObjectMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same(a: Seen, b: Seen): boolean { return a.dev === b.dev && a.ino === b.ino; }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function present(path: string): Seen | null {
  try { return lstatSync(path); } catch (error) { if (absent(error)) return null; throw error; }
}
function directory(path: string, privateMode = true): Seen {
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
function configDocument(path: string) {
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
  const parsed: unknown = before === undefined ? {} : JSON.parse(before);
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
function ownedEntry(value: unknown, owner: string, seat: string, session: string): boolean {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'args,command,env'
    || typeof value.command !== 'string' || !isAbsolute(value.command) || !object(value.env)
    || Object.keys(value.env).join(',') !== OWNER_ENV || value.env[OWNER_ENV] !== owner
    || !Array.isArray(value.args) || value.args.some((word) => typeof word !== 'string')) return false;
  const args = value.args as string[];
  return args.length === 9 && isAbsolute(args[0]!) && args[1] === 'mcp' && args[2] === 'serve'
    && args[3] === '--seat' && args[4] === seat && args[5] === '--session' && args[6] === session
    && args[7] === '--epoch' && isBriefEpoch(args[8]);
}

/** Called after the launch claim exists and before create/spawn, under the existing launch
 *  ownership. A second, non-reclaiming per-seat claim serializes config writers. The lease is
 *  held until the pane-run attempt returns. Failed launches keep their bounded config: later
 *  launches replace only this owned entry, and mcp serve rejects its stale epoch. */
export function prepareChannelConfig(input: ChannelLaunchScope & { seat: string; session: string; cwd: string }):
  { ok: true; lease: ChannelConfigLease } | { ok: false; reason: string } {
  let release: (() => void) | undefined;
  let cleanTemp: (() => void) | undefined;
  try {
    if (input.home === undefined || !isBriefEpoch(input.epoch) || !SEAT_NAME.test(input.seat)) {
      throw new ConfigRefusal('channel launch requires its home and explicit claimed epoch');
    }
    const home = input.home;
    const epoch = input.epoch;
    const found = registeredRootOf(home, input.seat, input.session);
    if (!found.ok || realpathSync(found.root) !== realpathSync(input.root)) throw new ConfigRefusal('the channel seat has no unique registered team root');
    const record = getTeam(home, teamIdOf(found.root));
    const loaded = readTeamConfig(found.root, { home });
    if (!loaded.ok || loaded.team.session !== input.session || record === null) throw new ConfigRefusal('the registered channel team cannot be read for this session');
    const declared = loaded.team.seats.find((seat) => seat.name === input.seat);
    if (declared === undefined || declared.stopped || declared.human || !claudeChannelSeat(declared)) {
      throw new ConfigRefusal('the registered seat does not declare a Claude channel launch');
    }
    const lobby = lobbyOf(home, loaded.root, loaded.team);
    if (record.lobbies[input.session] !== lobby || !loaded.team.trust?.some((path) => resolve(path.replace(/^~(?=$|\/)/, home)) === resolve(lobby))) {
      throw new ConfigRefusal('the channel lobby must already be registered and trusted by the team');
    }
    if (resolve(input.cwd) !== join(lobby, input.seat)) throw new ConfigRefusal('the channel must start in its own folder inside the team lobby');
    const gate = verifyLobby(home, { lobby, create: false });
    if (!gate.ok || !('path' in gate)) throw new ConfigRefusal('the registered channel lobby is unsafe or missing');
    const lobbySeen = directory(lobby);
    const folder = join(lobby, input.seat);
    const stateDir = dirname(loaded.path);
    const claimMatches = (): void => {
      const current = currentBriefClaim(readState(stateDir).sessions[input.session]?.briefs?.[input.seat]);
      if (current === null || current.epoch !== epoch) throw new ConfigRefusal('the channel launch epoch is no longer its current claim');
    };
    claimMatches();
    try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const folderSeen = directory(folder);
    const lock = join(folder, '.team-channel.lock');
    // A lock left by a launch that did not release is not taken and not removed. The hand
    // cleanup is to remove that .team-channel.lock directory from the seat folder, then launch again.
    if (present(lock) !== null) {
      throw new ConfigRefusal('a leftover channel lock is in the seat folder; remove .team-channel.lock by hand and launch again');
    }
    mkdirSync(lock, { mode: 0o700 });
    const lockSeen = directory(lock);
    let held = true;
    const configMatches: Array<() => boolean> = [];
    let settingsFolder: { path: string; seen: Seen } | undefined;
    const check = (): void => {
      if (!held || !same(directory(lobby), lobbySeen) || !same(directory(folder), folderSeen)
        || !same(directory(lock), lockSeen)) throw new ConfigRefusal('the channel config claim or folder changed');
      claimMatches();
      if (settingsFolder !== undefined && !same(directory(settingsFolder.path, false), settingsFolder.seen)) {
        throw new ConfigRefusal('the channel approval folder changed before launch');
      }
      if (configMatches.some((matches) => !matches())) throw new ConfigRefusal('the prepared channel config changed before launch');
    };
    release = (): void => {
      if (!held) return;
      held = false;
      // Do not follow a replaced folder or remove another writer's claim. A release failure
      // stays fail-closed for the next launch instead of reclaiming something unproven.
      try {
        if (same(directory(lobby), lobbySeen) && same(directory(folder), folderSeen)
          && same(directory(lock), lockSeen)) rmdirSync(lock);
      } catch { /* retain an unproven lock */ }
    };
    check();
    const mcp = configDocument(join(folder, '.mcp.json'));
    const existing = mcp.value;
    const servers = existing.mcpServers === undefined ? {} : existing.mcpServers;
    if (!object(servers)) throw new ConfigRefusal('the channel project config has invalid mcpServers');
    const owner = JSON.stringify({ v: 1, team: teamIdOf(loaded.root), seat: input.seat, session: input.session });
    if (Object.hasOwn(servers, CHANNEL_SERVER) && !ownedEntry(servers[CHANNEL_SERVER], owner, input.seat, input.session)) {
      throw new ConfigRefusal('the channel server name is already owned by another configuration');
    }
    const runner = selfRunner();
    const entry = { command: runner.command,
      args: [runner.entry, ...inboxServeArgs(input.seat, input.session, undefined, epoch)],
      env: { [OWNER_ENV]: owner } };
    const text = `${JSON.stringify({ ...existing, mcpServers: { ...servers, [CHANNEL_SERVER]: entry } }, null, 2)}\n`;
    const approvalDir = join(folder, '.claude');
    check();
    try { mkdirSync(approvalDir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    settingsFolder = { path: approvalDir, seen: directory(approvalDir, false) };
    const approval = configDocument(join(approvalDir, 'settings.local.json'));
    const approved = approveChannel(approval.value);
    const approvalText = approved === approval.value ? approval.before! : `${JSON.stringify(approved, null, 2)}\n`;
    const documents = [{ doc: mcp, text }, { doc: approval, text: approvalText }];
    for (let index = 0; index < documents.length; index += 1) {
      const next = documents[index]!;
      const pendingUnchanged = (): boolean => documents.slice(index).every(({ doc }) => doc.unchanged());
      check();
      if (!pendingUnchanged()) throw new ConfigRefusal('the channel configuration pair changed during preparation');
      if (next.doc.before === next.text) {
        configMatches.push(next.doc.bind(next.text));
        continue;
      }
      const parent = dirname(next.doc.path);
      const parentSeen = parent === folder ? folderSeen : settingsFolder.seen;
      const temp = join(parent, `.team-channel.${randomBytes(12).toString('hex')}.tmp`);
      const fd = openSync(temp, 'wx', 0o600);
      const tempSeen = fstatSync(fd);
      cleanTemp = () => {
        const now = present(temp);
        if (held && now !== null && same(now, tempSeen) && same(directory(lobby), lobbySeen)
          && same(directory(folder), folderSeen) && same(directory(lock), lockSeen)
          && same(directory(parent, parent === folder), parentSeen)) unlinkSync(temp);
      };
      try { writeFileSync(fd, next.text); fsyncSync(fd); } finally { closeSync(fd); }
      check();
      if (!pendingUnchanged()) throw new ConfigRefusal('the channel configuration pair changed during preparation');
      renameSync(temp, next.doc.path);
      cleanTemp = undefined;
      configMatches.push(next.doc.bind(next.text));
    }
    check();
    return { ok: true, lease: { check, release } };
  } catch (error) {
    // Only our exclusive random temporary is cleanup data. Existing config/seat folders stay.
    try { cleanTemp?.(); } catch { /* leave anything whose ownership cannot be proven */ }
    release?.();
    return { ok: false, reason: error instanceof ConfigRefusal ? error.message : 'the channel config could not be safely read or written' };
  }
}
