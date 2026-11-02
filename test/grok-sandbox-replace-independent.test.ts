// Urania's independent scenes (writer-04) for the FLO-1208 lane: the replaced record's mode,
// and the short-write loop under byte-at-a-time writes. The write interception follows the only
// shape bun allows (mock.module before the writer's import, as the lane's own test does); the
// checks are different: a 0644 record replaced to 0600 with its neighbor table kept, a
// byte-at-a-time write whose result is byte-identical to an uncapped write, and a stall that
// begins AFTER real progress — a partially-written temporary that must be discarded, leaving the
// record exactly as it was.
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrokSandbox } from '../src/launch/grok-sandbox.ts';

const realWriteSync = realFs.writeSync;
/** The most bytes one write accepts; the call (0-based) that stalls at zero instead. */
let cap = Number.POSITIVE_INFINITY;
let stopAt = -1;
let calls = 0;
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  Object.assign(wrapped, {
    writeSync: (fd: number, text: string | Uint8Array, ...rest: unknown[]): number => {
      const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
      const offset = typeof rest[0] === 'number' ? rest[0] : 0;
      const length = typeof rest[1] === 'number' ? rest[1] : bytes.byteLength - offset;
      calls += 1;
      if (calls - 1 === stopAt) return 0;
      const take = Math.min(length, cap);
      return (realWriteSync as unknown as (fd: number, buffer: Uint8Array, offset: number, length: number) => number)(fd, bytes, offset, take);
    },
  });
  return wrapped as typeof realFs;
});
afterAll(() => { mock.module('node:fs', () => ({ ...realFs, writeSync: realWriteSync })); });

let writeGrokSandbox: (typeof import('../src/launch/grok-sandbox.ts'))['writeGrokSandbox'];
beforeAll(async () => {
  ({ writeGrokSandbox } = await import('../src/launch/grok-sandbox.ts'));
});

const made: string[] = [];
function dir(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'grok-replace-')));
  made.push(path);
  return path;
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  cap = Number.POSITIVE_INFINITY;
  stopAt = -1;
  calls = 0;
});

// A record with a neighbor table and a multiline array: the replace must keep both and still
// end byte-exact, whatever the update does to the seat's own table.
const OLD = `# the owner's own profile, with "quotes" and a \\ backslash
[profiles.other]
extends = "base"
read_write = [
  "/keep/one",
  "/keep/two with space",
]

[profiles.team-seat-acme]
extends = "old"
read_write = ["/old"]
`;

function sandboxAt(at: string): GrokSandbox {
  return {
    profile: 'team-seat-acme',
    file: join(at, 'sandbox.toml'),
    guard: at,
    readWrite: ['/synthetic/state', '/synthetic/project'],
  };
}

function temps(at: string): string[] {
  return readdirSync(at).filter((name) => name.includes('.tmp'));
}

test('a 0644 record is replaced whole at 0600, keeping its neighbor table and no temporary', () => {
  const at = dir();
  const sandbox = sandboxAt(at);
  writeFileSync(sandbox.file, OLD);
  chmodSync(sandbox.file, 0o644);
  expect((statSync(sandbox.file).mode & 0o777)).toBe(0o644);

  expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });

  expect((statSync(sandbox.file).mode & 0o777)).toBe(0o600);
  const after = readFileSync(sandbox.file, 'utf8');
  expect(after).toContain('[profiles.other]');
  expect(after).toContain('"/keep/two with space"');
  expect(after).toContain('[profiles.team-seat-acme]');
  expect(temps(at)).toEqual([]);
});

test('a byte-at-a-time write produces the same bytes as an uncapped write', () => {
  const steady = dir();
  const capped = dir();
  writeFileSync(join(steady, 'sandbox.toml'), OLD, { mode: 0o600 });
  writeFileSync(join(capped, 'sandbox.toml'), OLD, { mode: 0o600 });

  expect(writeGrokSandbox(sandboxAt(steady))).toEqual({ ok: true });
  const callsBefore = calls;
  cap = 1;
  expect(writeGrokSandbox(sandboxAt(capped))).toEqual({ ok: true });
  expect(calls - callsBefore).toBeGreaterThan(1);

  const steadyBytes = readFileSync(join(steady, 'sandbox.toml'));
  const cappedBytes = readFileSync(join(capped, 'sandbox.toml'));
  expect(Buffer.compare(steadyBytes, cappedBytes)).toBe(0);
  expect((statSync(join(capped, 'sandbox.toml')).mode & 0o777)).toBe(0o600);
  expect(temps(capped)).toEqual([]);
  expect(Bun.TOML.parse(cappedBytes.toString('utf8'))).toEqual(Bun.TOML.parse(steadyBytes.toString('utf8')));
});

test('a stall that begins after real progress discards the partial temporary and keeps the record', () => {
  const at = dir();
  const sandbox = sandboxAt(at);
  writeFileSync(sandbox.file, OLD, { mode: 0o600 });

  cap = 1;
  stopAt = 3; // three single bytes are already in the temporary when the host stalls
  const written = writeGrokSandbox(sandbox);
  expect(written.ok).toBe(false);
  if (!written.ok) expect(written.why).toContain('made no progress');
  expect(readFileSync(sandbox.file, 'utf8')).toBe(OLD);
  expect(temps(at)).toEqual([]);
  expect((statSync(sandbox.file).mode & 0o777)).toBe(0o600);
});
