// The file-changing calls of `node:fs`, each passing the send host's effect guard first
// (rfc-bus-send-server §2.4, "Effects"; review round 1, finding 1 and decision B).
//
// Every module the hosted send, reply and ack lines can reach imports these names from here, not
// from `node:fs`; test/host/effect-inventory.test.ts walks the hosted import closure and fails on
// any raw import of a name listed here, so a new file-changing call cannot bypass the guard. Outside
// the host (every ordinary CLI run, the daemon, the watch) `hostedCommit` is a no-op and each
// export behaves exactly as the `node:fs` function it wraps.
//
// `openSync` and `open` pass the guard only when their flags can change a file (write, read-write,
// create, truncate or append); a read-only open is not an effect.

import * as fs from 'node:fs';
import { hostedCommit } from './request-scope.ts';

/** The `node:fs` names this module guards: the inventory test reads this list. */
export const GUARDED_FS_NAMES = [
  'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'copyFile', 'copyFileSync',
  'cp', 'cpSync', 'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'ftruncate', 'ftruncateSync',
  'futimes', 'futimesSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'lutimes', 'lutimesSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'open', 'openSync', 'rename', 'renameSync', 'rm',
  'rmSync', 'rmdir', 'rmdirSync', 'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink',
  'unlinkSync', 'utimes', 'utimesSync', 'write', 'writeSync', 'writeFile', 'writeFileSync', 'writev',
  'writevSync',
] as const;

type Fn = (...args: never[]) => unknown;

// Each wrapper looks its function up on the module when it is called, not when this module loads,
// so a test that replaces a `node:fs` function on the module (spyOn) still sees every call.
function guarded<F extends Fn>(name: string, _type: F): F {
  return ((...args: Parameters<F>) => {
    hostedCommit(`fs.${name}`);
    return ((fs as unknown as Record<string, (...a: Parameters<F>) => unknown>)[name]!)(...args);
  }) as F;
}

const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;

/** Whether an open with these flags can change a file. Unknown shapes count as writing. */
export function openWrites(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & WRITE_BITS) !== 0;
  if (typeof flags === 'string') return !(flags === 'r' || flags === 'rs' || flags === 'sr');
  return true;
}

function guardedOpen<F extends Fn>(name: string, _type: F): F {
  return ((...args: Parameters<F>) => {
    if (openWrites((args as unknown[])[1])) hostedCommit(`fs.${name}`);
    return ((fs as unknown as Record<string, (...a: Parameters<F>) => unknown>)[name]!)(...args);
  }) as F;
}

export const appendFile = guarded('appendFile', fs.appendFile);
export const appendFileSync = guarded('appendFileSync', fs.appendFileSync);
export const chmod = guarded('chmod', fs.chmod);
export const chmodSync = guarded('chmodSync', fs.chmodSync);
export const chown = guarded('chown', fs.chown);
export const chownSync = guarded('chownSync', fs.chownSync);
export const copyFile = guarded('copyFile', fs.copyFile);
export const copyFileSync = guarded('copyFileSync', fs.copyFileSync);
export const cp = guarded('cp', fs.cp);
export const cpSync = guarded('cpSync', fs.cpSync);
export const fchmod = guarded('fchmod', fs.fchmod);
export const fchmodSync = guarded('fchmodSync', fs.fchmodSync);
export const fchown = guarded('fchown', fs.fchown);
export const fchownSync = guarded('fchownSync', fs.fchownSync);
export const ftruncate = guarded('ftruncate', fs.ftruncate);
export const ftruncateSync = guarded('ftruncateSync', fs.ftruncateSync);
export const futimes = guarded('futimes', fs.futimes);
export const futimesSync = guarded('futimesSync', fs.futimesSync);
export const lchown = guarded('lchown', fs.lchown);
export const lchownSync = guarded('lchownSync', fs.lchownSync);
export const link = guarded('link', fs.link);
export const linkSync = guarded('linkSync', fs.linkSync);
export const lutimes = guarded('lutimes', fs.lutimes);
export const lutimesSync = guarded('lutimesSync', fs.lutimesSync);
export const mkdir = guarded('mkdir', fs.mkdir);
export const mkdirSync = guarded('mkdirSync', fs.mkdirSync);
export const mkdtemp = guarded('mkdtemp', fs.mkdtemp);
export const mkdtempSync = guarded('mkdtempSync', fs.mkdtempSync);
export const open = guardedOpen('open', fs.open);
export const openSync = guardedOpen('openSync', fs.openSync);
export const rename = guarded('rename', fs.rename);
export const renameSync = guarded('renameSync', fs.renameSync);
export const rm = guarded('rm', fs.rm);
export const rmSync = guarded('rmSync', fs.rmSync);
export const rmdir = guarded('rmdir', fs.rmdir);
export const rmdirSync = guarded('rmdirSync', fs.rmdirSync);
export const symlink = guarded('symlink', fs.symlink);
export const symlinkSync = guarded('symlinkSync', fs.symlinkSync);
export const truncate = guarded('truncate', fs.truncate);
export const truncateSync = guarded('truncateSync', fs.truncateSync);
export const unlink = guarded('unlink', fs.unlink);
export const unlinkSync = guarded('unlinkSync', fs.unlinkSync);
export const utimes = guarded('utimes', fs.utimes);
export const utimesSync = guarded('utimesSync', fs.utimesSync);
export const write = guarded('write', fs.write);
export const writeSync = guarded('writeSync', fs.writeSync);
export const writeFile = guarded('writeFile', fs.writeFile);
export const writeFileSync = guarded('writeFileSync', fs.writeFileSync);
export const writev = guarded('writev', fs.writev);
export const writevSync = guarded('writevSync', fs.writevSync);
