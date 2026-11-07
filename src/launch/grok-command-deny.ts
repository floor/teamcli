import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync, type Stats } from 'node:fs';
import { constants as systemConstants } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { cliWordList, shellQuote } from '../profiles/profile.ts';
import { cursorCommandDenyConfig, cursorCommandDenyRules, grokCommandDenyArgs, type GrokCommandDeny } from '../settings/grok-command-deny.ts';
import { ownStartFolderProblem, type OwnStartFolderInput } from '../worktree/place.ts';
import { getRelativeDirOps, type RelativeDirOps } from '../send/drop-retention.ts';
import type { TeamFile } from '../file/types.ts';
import { readTeamPolicySource } from '../policy/sources.ts';
import { resolvePolicyChain } from '../policy/resolve.ts';
import { parseGrokCommandDeny } from '../settings/grok-command-deny.ts';
import { appendOnLaunchLine } from './cli-scope.ts';

/** Merge in the seat's held directory, never through a mutable path to another folder. */
export function writeCursorCommandDeny(mode: GrokCommandDeny, place: OwnStartFolderInput, supplied?: RelativeDirOps | null): { ok: true } | { ok: false; why: string } {
  if (mode === 'off') return { ok: true };
  const problem = ownStartFolderProblem(place);
  if (problem !== null) return { ok: false, why: problem };
  const ops = supplied === undefined ? getRelativeDirOps() : supplied;
  if (ops === null) return { ok: false, why: 'relative file operations are unavailable; run team on Bun or Node with --experimental-ffi' };
  let rootFd: number | undefined, folderFd: number | undefined, tempFd: number | undefined;
  let temp: string | undefined;
  try {
    const start = realpathSync(resolve(place.root, place.cwd));
    rootFd = openSync(start, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const root = fstatSync(rootFd);
    const guard = () => {
      const why = ownStartFolderProblem(place);
      if (why !== null || realpathSync(resolve(place.root, place.cwd)) !== start || !sameInode(root, lstatSync(start))) {
        throw new Error(why ?? 'the seat start folder changed during command-deny placement');
      }
    };
    guard();
    let folder = ops.openat(rootFd, '.cursor', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (folder.fd < 0 && folder.errno === systemConstants.errno.ENOENT) {
      const made = ops.mkdirat(rootFd, '.cursor', 0o700);
      if (!made.ok && made.errno !== systemConstants.errno.EEXIST) throw new Error('the seat config directory could not be created');
      folder = ops.openat(rootFd, '.cursor', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    if (folder.fd < 0) throw new Error('the seat config directory is not a real readable directory');
    folderFd = folder.fd;
    const heldFolder = fstatSync(folderFd);
    const guardFolder = () => {
      guard();
      const now = ops.openat(rootFd!, '.cursor', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (now.fd < 0) throw new Error('the seat config directory changed during command-deny placement');
      try { if (!sameInode(heldFolder, fstatSync(now.fd))) throw new Error('the seat config directory changed during command-deny placement'); }
      finally { closeSync(now.fd); }
    };
    guardFolder();
    const before = cursorAt(ops, folderFd);
    let original: unknown = {};
    if (before !== null) {
      try { original = JSON.parse(before.text); }
      catch { throw new Error('the seat config is not valid JSON; it was left unchanged'); }
    }
    const config = cursorCommandDenyConfig(mode, original);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(text) > CONFIG_LIMIT) throw new Error('the generated seat config exceeds its bounded size');
    temp = `.cli.json.${randomBytes(12).toString('hex')}.tmp`;
    const opened = ops.openat(folderFd, temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (opened.fd < 0) throw new Error('the private seat config temporary could not be opened');
    tempFd = opened.fd; fchmodSync(tempFd, 0o600);
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(tempFd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error('writing the seat config made no progress');
      offset += count;
    }
    fsyncSync(tempFd); closeSync(tempFd); tempFd = undefined;
    guardFolder();
    const current = cursorAt(ops, folderFd);
    if ((before === null) !== (current === null) || (before !== null && current !== null && !sameFile(before.stat, current.stat))) {
      throw new Error('the seat config changed while the deny rules were generated');
    }
    const moved = ops.renameatReplace(folderFd, temp, folderFd, 'cli.json');
    if (!moved.ok) throw new Error('the generated seat config could not be published');
    temp = undefined;
    guardFolder();
    if (cursorAt(ops, folderFd)?.text !== text) throw new Error('the published seat config could not be verified');
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'the seat command-deny file could not be written' };
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
    if (temp !== undefined && folderFd !== undefined) ops.unlinkat(folderFd, temp);
    if (folderFd !== undefined) closeSync(folderFd);
    if (rootFd !== undefined) closeSync(rootFd);
  }
}

export function grokCommandDenyLine(mode: GrokCommandDeny, line: string): { ok: true; line: string } | { ok: false; why: string } {
  if (mode === 'off') return { ok: true, line };
  const actual = nativeDenies(line);
  if (actual === null) return { ok: false, why: 'the native Grok command cannot be read to place command-deny options' };
  const addition = grokCommandDenyArgs(mode).filter((word) => word !== '--deny' && !actual.has(word)).flatMap(rule => ['--deny', rule]);
  if (addition.length === 0) return { ok: true, line };
  const placed = appendOnLaunchLine(line, addition.map(shellQuote).join(' '), 'grok');
  const verified = nativeDenies(placed.line);
  if (placed.uncertain || verified === null || grokCommandDenyArgs(mode).some(word => word !== '--deny' && !verified.has(word))) {
    return { ok: false, why: 'native Grok command-deny options could not be placed and verified before its prompt' };
  }
  return { ok: true, line: placed.line };
}

export function grokCommandDenyPolicy(home: string, root: string, team: TeamFile): { ok: true; value: GrokCommandDeny } | { ok: false; why: string } {
  const source = readTeamPolicySource(home, root, team);
  const chain = resolvePolicyChain({ team: source }, { upToLevel: 'team' });
  if (!chain.ok) return { ok: false, why: `grok-command-deny: ${chain.refusals.map(one => one.message).join('; ')}` };
  const value = parseGrokCommandDeny(chain.policies['grok-command-deny']?.value);
  return value === null ? { ok: false, why: 'grok-command-deny has no valid verified value' } : { ok: true, value };
}

function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && b.isDirectory(); }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }

function cursorAt(ops: RelativeDirOps, folder: number): { text: string; stat: Stats } | null {
  const read = ops.openat(folder, 'cli.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (read.fd < 0) {
    if (read.errno === systemConstants.errno.ENOENT) return null;
    throw new Error('the seat config is not a readable regular file');
  }
  try {
    const stat = fstatSync(read.fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CONFIG_LIMIT) throw new Error('the seat config must be a bounded regular file with one link');
    const bytes = Buffer.alloc(CONFIG_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(read.fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > CONFIG_LIMIT || !sameFile(stat, fstatSync(read.fd))) throw new Error('the seat config changed or exceeded its bounded size while reading');
    return { text: bytes.subarray(0, length).toString('utf8'), stat };
  } finally { closeSync(read.fd); }
}

export type CommandDenySeat = { name: string; cli: string; model: string; human?: boolean; stopped?: boolean };
export type CommandDenyRecord = { start_cwd?: string; launch_line?: string };

const CONFIG_LIMIT = 64 * 1024;

/** Read only a bounded regular file in the explicitly supplied launch folder. Both the
 *  `.cursor` directory and the leaf must be real; a descriptor is checked before any bytes. */
function readCursorConfig(path: string): unknown {
  let fd: number | undefined;
  try {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > CONFIG_LIMIT) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const held = fstatSync(fd);
    const after = lstatSync(dirname(path));
    if (!held.isFile() || held.nlink !== 1 || held.size > CONFIG_LIMIT || held.dev !== before.dev || held.ino !== before.ino
      || !after.isDirectory() || after.dev !== parent.dev || after.ino !== parent.ino) return null;
    const bytes = Buffer.alloc(CONFIG_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const got = readSync(fd, bytes, length, bytes.length - length, length);
      if (got === 0) break;
      length += got;
    }
    if (length > CONFIG_LIMIT) return null;
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The adapter's supported options, from the CLI reference and headless reference:
 *  https://docs.x.ai/build/cli/reference and https://docs.x.ai/build/cli/headless-scripting.
 *  Unknown options cannot prove where a value ends, so an enabled policy refuses them. */
function nativeDenies(line: string): Set<string> | null {
  const words = cliWordList('grok', line);
  if (words === null) return null;
  let program = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program] ?? '')) program++;
  if (basename(words[program] ?? '') === 'env') {
    program++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program] ?? '') || words[program] === '--') program++;
  }
  if (words[program] === 'exec' || words[program] === 'command') program++;
  if (basename(words[program] ?? '') !== 'grok') return null;
  const denies = new Set<string>();
  const takesValue = new Set(['--rules', '--model', '-m', '--sandbox', '--cwd', '--session-id', '-s', '--allow', '--permission-mode', '--output-format', '--tools', '--disallowed-tools', '--allowedTools', '--disallowedTools', '-p', '--single', '--prompt-file', '--prompt-json', '--system-prompt-override', '--system-prompt', '--append-system-prompt', '--effort', '--reasoning-effort', '--max-turns', '--ref']);
  const optionalValue = new Set(['--resume', '-r', '--worktree', '-w']);
  const flags = new Set(['--trust', '--always-approve', '--yolo', '--dangerously-skip-permissions', '--continue', '-c', '--fork-session', '--no-alt-screen', '--verbatim', '--no-auto-update', '--no-plan', '--no-subagents', '--no-memory', '--disable-web-search', '--experimental-memory', '--oauth', '--version', '--help', '-h']);
  for (let at = program + 1; at < words.length; at++) {
    const word = words[at]!;
    if (word === '--') break;
    if (word === '--deny') {
      const value = words[++at];
      if (value === undefined) return null;
      denies.add(value);
    } else if (word.startsWith('--deny=')) denies.add(word.slice('--deny='.length));
    else if (takesValue.has(word)) { if (words[++at] === undefined) return null; }
    else if (optionalValue.has(word)) { if (words[at + 1] !== undefined && !words[at + 1]!.startsWith('-')) at++; }
    else if (word.includes('=') && (takesValue.has(word.slice(0, word.indexOf('='))) || optionalValue.has(word.slice(0, word.indexOf('='))))) continue;
    else if (!flags.has(word)) return null;
  }
  return denies;
}

/** Read-only drift check against the caller's effective launch models and recorded folders.
 *  The checker supplies the same own-folder proof as placement before any config is read. */
export function grokCommandDenyNotes(
  mode: GrokCommandDeny,
  seats: readonly CommandDenySeat[],
  records: Readonly<Record<string, CommandDenyRecord | undefined>>,
  read: (path: string) => unknown = readCursorConfig,
  folderProblem?: (seat: CommandDenySeat, folder: string) => string | null,
): string[] {
  if (mode === 'off') return [];
  const out: string[] = [];
  for (const seat of seats) {
    if (seat.human === true || seat.stopped === true) continue;
    const native = seat.cli === 'grok';
    if (!native && !(seat.cli === 'cursor' && /^grok(?:\b|[-_])/i.test(seat.model))) continue;
    const prefix = `${seat.name}: grok-command-deny ${mode}`;
    const recorded = records[seat.name];
    if (native) {
      const actual = nativeDenies(recorded?.launch_line ?? '');
      const missing = grokCommandDenyArgs(mode).filter((word) => word !== '--deny' && !actual?.has(word));
      if (missing.length) out.push(`${prefix}: its recorded launch lacks --deny ${missing.join(', ')}`);
      continue;
    }
    if (recorded?.start_cwd === undefined || !isAbsolute(recorded.start_cwd)) {
      out.push(`${prefix}: no recorded launch folder with an absolute path to check .cursor/cli.json`);
      continue;
    }
    const unsafe = folderProblem?.(seat, recorded.start_cwd);
    if (unsafe !== undefined && unsafe !== null) {
      out.push(`${prefix}: its recorded launch folder cannot be checked: ${unsafe}`);
      continue;
    }
    const path = join(recorded.start_cwd, '.cursor', 'cli.json');
    let config: unknown;
    try { config = cursorCommandDenyConfig('off', read(path)); } catch { config = null; }
    const permissions = config !== null && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).permissions : undefined;
    const deny = permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>).deny : undefined;
    const missing = cursorCommandDenyRules(mode).filter((rule) => !Array.isArray(deny) || !deny.includes(rule));
    if (missing.length) out.push(`${prefix}: ${path} is unreadable or lacks permissions.deny ${missing.join(', ')}`);
  }
  return out;
}
