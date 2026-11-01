// The secret's checks and the bytes handed back must come from one opened file. If the mode and
// ownership are checked on one observation and the contents read through the path again, a
// public 0644 file renamed over the path between them is accepted — operator-3's mode race.
//
// Run as its own process: node:fs is mocked so the swap lands exactly at the read, and the real
// module's functions are captured by value before the mock is registered (bun 1.4.2 binds a
// named import to the function it saw at import time, so the mock must be in place before the
// reader is imported). The child prints the facts and the scene in test/bus-webhook-adapter.test.ts
// asserts on them.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';

const PRIVATE = 'synthetic-private-value';
const PUBLIC = 'synthetic-public-value';

const realReadFileSync = fs.readFileSync;
const realFstatSync = fs.fstatSync;
const realRenameSync = fs.renameSync;

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-webhook-race-')));
try {
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const parked = join(base, 'hook-secret-parked');
  const replacement = join(base, 'public-replacement');
  fs.writeFileSync(urlFile, 'http://127.0.0.1:1/routine\n');
  fs.writeFileSync(secretFile, `${PRIVATE}\n`, { mode: 0o600 });
  fs.chmodSync(secretFile, 0o600);
  fs.writeFileSync(replacement, `${PUBLIC}\n`, { mode: 0o644 });
  fs.chmodSync(replacement, 0o644);
  const secretIno = fs.statSync(secretFile).ino;

  let swapped = false;
  const mocked = Object.assign({}, fs, {
    readFileSync(target: string | number, ...rest: unknown[]): unknown {
      const readingSecret =
        (typeof target === 'string' && target === secretFile) ||
        (typeof target === 'number' && realFstatSync(target).ino === secretIno);
      if (readingSecret && !swapped) {
        swapped = true;
        realRenameSync(secretFile, parked);
        realRenameSync(replacement, secretFile);
      }
      return (realReadFileSync as unknown as (target: string | number, ...rest: unknown[]) => unknown)(target, ...rest);
    },
  });
  mock.module('node:fs', () => mocked);

  const { webhookRouteOf } = (await import('../src/send/webhook.ts')) as typeof import('../src/send/webhook.ts');

  const route = webhookRouteOf({ urlFile, secretFile });
  const second = webhookRouteOf({ urlFile, secretFile });
  const reason = second !== null && !second.ok ? second.reason : '';
  const parkedBytes = fs.readFileSync(parked, 'utf8').trim();
  const modeAtPath = (fs.statSync(secretFile).mode & 0o777).toString(8).padStart(4, '0');

  console.log(
    JSON.stringify({
      swapped,
      accepted: route !== null && route.ok,
      valueIsPrivate: route !== null && route.ok && route.secret === PRIVATE,
      valueIsPublic: route !== null && route.ok && route.secret === PUBLIC,
      secondRefused: second !== null && !second.ok,
      refusalNamesMode: reason.includes('mode 0644'),
      reasonEchoesValue: reason.includes(PRIVATE) || reason.includes(PUBLIC),
      parkedKept: parkedBytes === PRIVATE,
      modeAtPath,
    }),
  );
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
