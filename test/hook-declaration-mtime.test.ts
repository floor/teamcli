// Independent coverage for the hook settings file as a live declaration: a run that installs
// hooks for a seat it is not launching must not rewrite a file that already holds exactly the
// text it would write. The file's modification time is the seat's `declaredAt`; a running
// session's socket predates an unrelated install, so a byte-identical rewrite would make
// `inboundIsLive` read the receiver as stale and the walk would skip a live socket.
//
// The scenes build the declaration the real launch builds: a wrapper script whose settings word
// is `accept`, the generated per-seat file the launcher appends last, and a synthetic socket
// file whose mtime sits between the declaration and now. Every path is a temporary folder; no
// CLI home is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCliHooks } from '../src/launch/cli-hook.ts';
import { declaredInboundOf, inboundIsLive } from '../src/send/inbound.ts';

const SESSION = 'acme';
/** The declaration the running seat was launched with, and the socket it exposes afterwards. */
const DECLARED = new Date('2026-10-21T05:00:00Z');
const SOCKET = new Date('2026-10-21T05:01:00Z');

let base: string;
let dir: string;
let wrapper: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-hook-decl-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
  wrapper = join(base, 'launch.sh');
  writeWrapper('accept');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The seat's launch line: a script that hands the CLI a settings word of its own. */
function writeWrapper(word: 'accept' | 'hold'): void {
  writeFileSync(wrapper, `#!/bin/sh\nexec claude --settings '{"crossSessionInbound":"${word}"}' "$@"\n`, { mode: 0o700 });
}

const seat = () => ({ name: 'worker', cli: 'claude-code', launch: wrapper });

/** The declaration the walk reads from the generated file, with the launch as declared. */
function declaration() {
  return declaredInboundOf({ dir, root: base, session: SESSION, seat: 'worker', launch: wrapper });
}

/** A live socket file whose mtime is when the running session exposed it. */
function socket(): string {
  const path = join(base, 'receiver.sock');
  writeFileSync(path, '');
  utimesSync(path, SOCKET, SOCKET);
  return path;
}

describe('an install for a seat the run is not launching leaves a live declaration alone', () => {
  test('an unchanged file is not rewritten, so the running socket still counts as live', () => {
    const landed = installCliHooks(dir, SESSION, [seat()], undefined, base);
    const settings = landed.worker!;
    expect((JSON.parse(readFileSync(settings, 'utf8')) as { crossSessionInbound?: string }).crossSessionInbound).toBe('accept');

    // The session was launched when this declaration landed; everything since is an unrelated
    // run installing hooks for the same seat.
    utimesSync(settings, DECLARED, DECLARED);
    const wire = socket();
    const before = declaration();
    expect(before.policy).toBe('accept');
    expect(before.declaredAt).toBe(DECLARED.getTime());
    expect(inboundIsLive(before, wire)).toBe(true);

    expect(installCliHooks(dir, SESSION, [seat()], undefined, base)).toEqual({ worker: settings });
    expect(statSync(settings).mtimeMs).toBe(DECLARED.getTime());
    // The declaration the sender's walk reads is exactly the one the session was launched with.
    expect(declaration()).toEqual(before);
    expect(inboundIsLive(declaration(), wire)).toBe(true);
  });

  test('a launch word that really changed is installed, and the declaration reads it', () => {
    const landed = installCliHooks(dir, SESSION, [seat()], undefined, base);
    const settings = landed.worker!;
    utimesSync(settings, DECLARED, DECLARED);

    writeWrapper('hold');
    expect(installCliHooks(dir, SESSION, [seat()], undefined, base)).toEqual({ worker: settings });
    expect(statSync(settings).mtimeMs).toBeGreaterThan(DECLARED.getTime());
    expect((JSON.parse(readFileSync(settings, 'utf8')) as { crossSessionInbound?: string }).crossSessionInbound).toBe('hold');
    expect(declaration().policy).toBe('hold');
    // A held word never dials, whatever the socket's age: the write did what the launch asks.
    expect(inboundIsLive(declaration(), socket())).toBe(true);
  });

  test('an unchanged file in a wider mode is still tightened and declared again', () => {
    const landed = installCliHooks(dir, SESSION, [seat()], undefined, base);
    const settings = landed.worker!;
    chmodSync(settings, 0o644);
    utimesSync(settings, DECLARED, DECLARED);

    expect(installCliHooks(dir, SESSION, [seat()], undefined, base)).toEqual({ worker: settings });
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    // The rewrite is owed: the file was not yet the private declaration the launcher names.
    expect(statSync(settings).mtimeMs).toBeGreaterThan(DECLARED.getTime());
    expect((JSON.parse(readFileSync(settings, 'utf8')) as { crossSessionInbound?: string }).crossSessionInbound).toBe('accept');
  });
});
