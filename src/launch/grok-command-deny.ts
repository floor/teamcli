import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { cliWordList } from '../profiles/profile.ts';
import { cursorCommandDenyConfig, cursorCommandDenyRules, grokCommandDenyArgs, type GrokCommandDeny } from '../settings/grok-command-deny.ts';

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
    if (!before.isFile() || before.size > CONFIG_LIMIT) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const held = fstatSync(fd);
    const after = lstatSync(dirname(path));
    if (!held.isFile() || held.size > CONFIG_LIMIT || held.dev !== before.dev || held.ino !== before.ino
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

function nativeDenies(line: string): Set<string> {
  const words = cliWordList('grok', line) ?? [];
  const denies = new Set<string>();
  const takesValue = new Set(['--rules', '--model', '-m', '--sandbox', '--cwd', '--session-id', '--resume', '-r', '--allow', '--permission-mode', '--output-format', '--tools', '--disallowed-tools']);
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    if (word === '--') break;
    if (word === '--deny') {
      const value = words[++at];
      if (value !== undefined) denies.add(value);
    } else if (word.startsWith('--deny=')) denies.add(word.slice('--deny='.length));
    else if (takesValue.has(word)) at++;
  }
  return denies;
}

/** Read-only drift check. Folder placement belongs to the launch adapter: until it records a
 *  seat's folder, report that gap instead of reading or writing a shared folder's CLI config. */
export function grokCommandDenyNotes(
  mode: GrokCommandDeny,
  seats: readonly CommandDenySeat[],
  records: Readonly<Record<string, CommandDenyRecord | undefined>>,
  read: (path: string) => unknown = readCursorConfig,
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
      const missing = grokCommandDenyArgs(mode).filter((word) => word !== '--deny' && !actual.has(word));
      if (missing.length) out.push(`${prefix}: its recorded launch lacks --deny ${missing.join(', ')}`);
      continue;
    }
    if (recorded?.start_cwd === undefined || !isAbsolute(recorded.start_cwd)) {
      out.push(`${prefix}: no recorded launch folder with an absolute path to check .cursor/cli.json`);
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
