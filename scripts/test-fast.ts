#!/usr/bin/env bun
// The whole suite on this machine, every shard at once. The shards are CI's own
// (scripts/ci-shard-assignment.json, balanced by recorded time); each runs as its own
// `bun scripts/ci-shard-tests.ts --run i/N` process, so the cores share the suite instead of one
// process walking 1,400 files in turn. Each shard's output goes to its own log; the summary at
// the end gives the totals and every failing test, with the log that holds it.
//
//   bun scripts/test-fast.ts [--out <folder>]
//
// Exits 1 when any shard failed or ran no tests, or the machine's registry changed; 0 otherwise.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const assignment = JSON.parse(readFileSync(join(ROOT, 'scripts', 'ci-shard-assignment.json'), 'utf8')) as { shards: number };
const at = process.argv.indexOf('--out');
const out = at === -1 ? mkdtempSync(join(tmpdir(), 'teamcli-fast-')) : resolve(process.argv[at + 1]!);
mkdirSync(out, { recursive: true });
const started = Date.now();
// The machine's own registry must come out of a run as it went in: a scene that writes it reaches
// the owner's real teams (2026-11-13: a census registered ten scratch folders as running teams).
const REGISTRY = ['teams.yaml', 'projects.yaml', 'entities.yaml'].map((name) => join(homedir(), '.config', 'team', name));
const fingerprint = (): string => REGISTRY.map((path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '-')).join(' ');
const registryBefore = fingerprint();

const runs = Array.from({ length: assignment.shards }, (_, index) => new Promise<{ index: number; code: number; log: string }>((done) => {
  const log = join(out, `shard-${index}.log`);
  const stream = createWriteStream(log);
  const child = spawn('bun', ['scripts/ci-shard-tests.ts', '--run', `${index}/${assignment.shards}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  child.on('close', (code) => { stream.end(); done({ index, code: code ?? 1, log }); });
}));

const results = await Promise.all(runs);
let pass = 0; let fail = 0; let skip = 0;
const failures: string[] = [];
const silent: string[] = [];
for (const result of results) {
  const text = readFileSync(result.log, 'utf8');
  // A shard that printed no totals ran nothing (an unassigned file, a crash): say why, and fail.
  if (!/^\s*\d+ pass$/m.test(text)) silent.push(`shard ${result.index} ran no tests (exit ${result.code}):\n${text.trim().split('\n').slice(-5).map((line) => `  ${line}`).join('\n')}`);
  for (const match of text.matchAll(/^\s*(\d+) (pass|fail|skip)$/gm)) {
    const count = Number(match[1]);
    if (match[2] === 'pass') pass += count; else if (match[2] === 'fail') fail += count; else skip += count;
  }
  for (const line of text.split('\n')) if (line.startsWith('(fail)')) failures.push(`shard ${result.index}: ${line.replace(/ \[[0-9.]+m?s\]$/, '')}`);
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`test:fast: ${pass} pass, ${fail} fail, ${skip} skip across ${assignment.shards} shards in ${seconds}s; logs in ${out}`);
for (const line of failures) console.log(line);
for (const line of silent) console.log(line);
const registryChanged = fingerprint() !== registryBefore;
if (registryChanged) console.log(`test:fast: the machine's registry changed during the run (${REGISTRY.join(', ')}): a test, or a live command run meanwhile, wrote the owner's real teams`);
process.exit(silent.length > 0 || registryChanged || results.some((result) => result.code !== 0) ? 1 : 0);
