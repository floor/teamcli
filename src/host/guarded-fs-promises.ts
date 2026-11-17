// The file-changing calls of `node:fs/promises`, each passing the send host's effect guard first
// (see guarded-fs.ts; test/host/effect-inventory.test.ts holds every hosted module to these).
// The guard runs when the call is made, before the promise starts any work.

import * as fsp from 'node:fs/promises';
import { hostedCommit } from './request-scope.ts';
import { openWrites } from './guarded-fs.ts';

/** The `node:fs/promises` names this module guards: the inventory test reads this list. */
export const GUARDED_FS_PROMISES_NAMES = [
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp',
  'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
] as const;

type Fn = (...args: never[]) => unknown;

// Each wrapper looks its function up on the module when it is called, not when this module loads,
// so a test that replaces a `node:fs` function on the module (spyOn) still sees every call.
function guarded<F extends Fn>(name: string, _type: F): F {
  return ((...args: Parameters<F>) => {
    hostedCommit(`fs/promises.${name}`);
    return ((fsp as unknown as Record<string, (...a: Parameters<F>) => unknown>)[name]!)(...args);
  }) as F;
}

export const appendFile = guarded('appendFile', fsp.appendFile);
export const chmod = guarded('chmod', fsp.chmod);
export const chown = guarded('chown', fsp.chown);
export const copyFile = guarded('copyFile', fsp.copyFile);
export const cp = guarded('cp', fsp.cp);
export const lchown = guarded('lchown', fsp.lchown);
export const link = guarded('link', fsp.link);
export const lutimes = guarded('lutimes', fsp.lutimes);
export const mkdir = guarded('mkdir', fsp.mkdir);
export const mkdtemp = guarded('mkdtemp', fsp.mkdtemp);
export const open = ((...args: Parameters<typeof fsp.open>) => {
  if (openWrites(args[1])) hostedCommit('fs/promises.open');
  return (fsp as unknown as { open: typeof fsp.open }).open(...args);
}) as typeof fsp.open;
export const rename = guarded('rename', fsp.rename);
export const rm = guarded('rm', fsp.rm);
export const rmdir = guarded('rmdir', fsp.rmdir);
export const symlink = guarded('symlink', fsp.symlink);
export const truncate = guarded('truncate', fsp.truncate);
export const unlink = guarded('unlink', fsp.unlink);
export const utimes = guarded('utimes', fsp.utimes);
export const writeFile = guarded('writeFile', fsp.writeFile);
