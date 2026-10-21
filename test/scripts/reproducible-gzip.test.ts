// The release tarball's gzip frame is fixed by scripts/reproducible-gzip.mjs:
// Node v22.23.3 with zlib 1.3.1-e00f703, level 9, and the stable header
// 1f8b08000000000002ff. These scenes pin the frame's shape, its determinism and
// the runtime refusal. The scenes that need the pinned compressor itself skip on
// a machine whose node/npm are not that pair; CI installs the pair, so it runs
// them.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { COMPRESSOR, crc32, gzipDeterministic, toolchainProblem } from '../../scripts/reproducible-gzip.mjs';

const helper = join(import.meta.dir, '..', '..', 'scripts', 'reproducible-gzip.mjs');
const areas: string[] = [];

function area(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-reproducible-gzip-'));
  areas.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of areas.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function commandOutput(command: string, args: string[]): string {
  return spawnSync(command, args, { encoding: 'utf8' }).stdout?.trim() ?? '';
}

const nodeVersion = commandOutput('node', ['--version']);
const nodeZlib = commandOutput('node', ['-p', 'process.versions.zlib']);
const NPM_VERSION = commandOutput('npm', ['--version']);
const PINNED = nodeVersion === COMPRESSOR.node && nodeZlib === COMPRESSOR.zlib && NPM_VERSION === '10.9.9';

test('the gzip frame has the fixed header, mtime zero and the CRC32/ISIZE trailer', () => {
  const tar = Buffer.from('a tar-shaped payload\n'.repeat(100));
  const gz = gzipDeterministic(tar);

  expect(gz.subarray(0, 10).toString('hex')).toBe(COMPRESSOR.gzipHeader);
  expect(gz[2]).toBe(8); // CM: DEFLATE
  expect(gz[3]).toBe(0); // FLG: no name, comment or extra field
  expect(gz.readUInt32LE(4)).toBe(0); // MTIME: no build time in the archive
  expect(gz[8]).toBe(2); // XFL: maximum compression
  expect(gz[9]).toBe(255); // OS: unknown, not the builder's platform

  const trailer = gz.subarray(gz.length - 8);
  expect(trailer.readUInt32LE(0)).toBe(crc32(tar));
  expect(trailer.readUInt32LE(4)).toBe(tar.length);

  expect(gunzipSync(gz).equals(tar)).toBe(true);
});

test('the same tar compresses to the same bytes', () => {
  const tar = Buffer.from('deterministic\n'.repeat(1000));
  expect(gzipDeterministic(tar).equals(gzipDeterministic(tar))).toBe(true);
});

test('the wrapper frames exactly the bytes the injected deflate returns', () => {
  const tar = Buffer.from('payload\n');
  let received: Buffer | undefined;
  let options: unknown;
  const gz = gzipDeterministic(tar, (input, passed) => {
    received = Buffer.from(input);
    options = passed;
    return Buffer.from([0x03, 0x00]);
  });

  expect(received?.equals(tar)).toBe(true);
  expect(options).toEqual({ level: 9, windowBits: 15, memLevel: 8, strategy: 0 });
  expect(gz.subarray(10, gz.length - 8)).toEqual(Buffer.from([0x03, 0x00]));
});

test('the runtime check names the pinned pair and the actual one', () => {
  expect(toolchainProblem({ node: COMPRESSOR.node, zlib: COMPRESSOR.zlib })).toBeUndefined();
  const problem = toolchainProblem({ node: 'v26.8.1', zlib: '1.2.12' });
  expect(problem).toContain(`pinned to Node ${COMPRESSOR.node}`);
  expect(problem).toContain(`zlib ${COMPRESSOR.zlib}`);
  expect(problem).toContain('v26.8.1');
  expect(problem).toContain('1.2.12');
});

test.skipIf(!PINNED)('a fixed vector compresses to its pinned sha256', () => {
  const gz = gzipDeterministic(Buffer.from('team reproducible gzip vector\n'));
  expect(gz.length).toBe(50);
  expect(sha256(gz)).toBe('f808b7c7baaceef4b8ae3b05bc4dbc0446fa3877203dde58647d84c0b873bbd7');
});

test.skipIf(!PINNED)('the CLI writes the pinned frame and reports input, tar and output identities', () => {
  const dir = area();
  const tar = Buffer.from('member content\n'.repeat(200));
  const input = join(dir, 'input.tgz');
  const output = join(dir, 'output.tgz');
  writeFileSync(input, gzipSync(tar));

  const result = spawnSync('node', [helper, input, output], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as {
    compressor: { node: string; zlib: string; level: number; gzipHeader: string };
    input: { sha256: string; bytes: number };
    tar: { sha256: string; bytes: number };
    output: { sha256: string; bytes: number };
  };

  const gz = readFileSync(output);
  expect(gz.subarray(0, 10).toString('hex')).toBe(COMPRESSOR.gzipHeader);
  expect(report.compressor).toEqual(COMPRESSOR);
  expect(report.input.sha256).toBe(sha256(readFileSync(input)));
  expect(report.input.bytes).toBe(readFileSync(input).length);
  expect(report.tar.sha256).toBe(sha256(tar));
  expect(report.tar.bytes).toBe(tar.length);
  expect(report.output.sha256).toBe(sha256(gz));
  expect(report.output.bytes).toBe(gz.length);
  expect(gunzipSync(gz).equals(tar)).toBe(true);
});

test.skipIf(!PINNED)('the CLI refuses an input that is not gzip', () => {
  const dir = area();
  const input = join(dir, 'not-gzip.bin');
  writeFileSync(input, 'not a gzip stream\n');
  const result = spawnSync('node', [helper, input, join(dir, 'out.tgz')], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('is not a gzip stream');
});

const bunRuntime = JSON.parse(commandOutput('bun', ['-p', 'JSON.stringify({node: process.version, zlib: process.versions.zlib})']) || '{}') as {
  node?: string;
  zlib?: string;
};
const BUN_PINNED = toolchainProblem({ node: bunRuntime.node ?? '', zlib: bunRuntime.zlib ?? '' }) === undefined;

test.skipIf(BUN_PINNED)('the CLI refuses a runtime that is not the pinned compressor', () => {
  const dir = area();
  const result = spawnSync('bun', [helper, join(dir, 'missing.tgz'), join(dir, 'out.tgz')], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`pinned to Node ${COMPRESSOR.node}`);
  expect(result.stderr).toContain(bunRuntime.node ?? '');
});
