// A host's write may accept only part of the text and return the count without throwing. The
// replacement must finish the text before it syncs and renames — a half-written record is never
// substituted for a valid one — and a write that reports no progress at all leaves the record as
// it was. The host's write is injected before the writer is imported, so the module binds the
// injected one; every other file operation is the real module's. Bun's mocks are process-wide,
// so the captured real function goes back when this file ends.
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrokSandbox } from '../../src/launch/grok-sandbox.ts';

const realFsCalls = { writeSync: realFs.writeSync };
// The most bytes one write accepts, and the call (0-based) that reports no progress instead.
let cap = 8;
let stopAt = -1;
let calls = 0;
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  Object.assign(wrapped, {
    writeSync: (fd: number, text: string | Uint8Array, ...rest: unknown[]): number => {
      const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
      const offset = typeof rest[0] === 'number' ? rest[0] : 0;
      const length = typeof rest[1] === 'number' ? rest[1] : bytes.byteLength - offset;
      if (calls++ === stopAt) return 0;
      const take = Math.min(length, cap);
      const write = realFsCalls.writeSync as unknown as (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
      return write(fd, bytes, offset, take);
    },
  });
  return wrapped as typeof realFs;
});
afterAll(() => { mock.module('node:fs', () => ({ ...realFs, ...realFsCalls })); });

let writeGrokSandbox: (typeof import('../../src/launch/grok-sandbox.ts'))['writeGrokSandbox'];
beforeAll(async () => {
  ({ writeGrokSandbox } = await import('../../src/launch/grok-sandbox.ts'));
});

const made: string[] = [];
function dir(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'grok-short-')));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const OLD = '[profiles.team-seat-acme]\nextends = "old"\nread_write = ["/old"]\n';

function sandboxAt(at: string): GrokSandbox {
  return {
    profile: 'team-seat-acme',
    file: join(at, 'sandbox.toml'),
    prepare: [],
    guard: at,
    readWrite: ['/synthetic/state', '/synthetic/project'],
  };
}

test('a write the host accepts in parts is finished before the record is replaced', () => {
  const at = dir();
  const sandbox = sandboxAt(at);
  writeFileSync(sandbox.file, OLD, { mode: 0o600 });
  cap = 8;
  stopAt = -1;
  calls = 0;

  expect(writeGrokSandbox(sandbox)).toEqual({ ok: true });
  const parsed = Bun.TOML.parse(readFileSync(sandbox.file, 'utf8')) as {
    profiles: Record<string, { extends?: string; read_write?: string[] }>;
  };
  expect(parsed.profiles['team-seat-acme']).toMatchObject({
    extends: 'workspace',
    read_write: [...sandbox.readWrite],
  });
  expect(readdirSync(at).filter((name) => name.includes('.tmp'))).toEqual([]);
});

test('a write that reports no progress leaves the record as it was, with no temporary', () => {
  const at = dir();
  const sandbox = sandboxAt(at);
  writeFileSync(sandbox.file, OLD, { mode: 0o600 });
  cap = 8;
  stopAt = 0;
  calls = 0;

  const written = writeGrokSandbox(sandbox);
  expect(written.ok).toBe(false);
  if (!written.ok) expect(written.why).toContain('made no progress');
  expect(readFileSync(sandbox.file, 'utf8')).toBe(OLD);
  expect(readdirSync(at).filter((name) => name.includes('.tmp'))).toEqual([]);
});
