// The first-minute scene. A temporary home, no registry, no signer, no credential
// folder, and no real CLI. It runs `team start` once per trial, prints the six
// timestamps, and exits non-zero on the first miss. Three trials. The wall
// clock for one trial is 60 seconds.
//
//   bun scripts/first-minute.ts
//   bun scripts/first-minute.ts --runs 1 --bin /path/to/team
//
// The child receives only HOME, PATH, and TMPDIR. The scene does not read a
// screen, a credential path, or a seat's environment.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TRIALS = 3;
export const TOTAL_MS = 60_000;

export const STEP_BUDGET_MS = {
  bootstrap: 3_000,
  detect: 4_000,
  up: 15_000,
  exchange: 12_000,
  started: 10_000,
} as const;

export type StepName = 'install' | 'bootstrap' | 'detect' | 'up' | 'exchange' | 'started';

export type StepMark = {
  step: StepName;
  ms: number;
  ok: boolean;
  detail: string;
};

export type MinuteProof = {
  versionOk: boolean;
  daemonRunning: boolean;
  roots: number;
  teamFile: boolean;
  checkClean: boolean;
  readyLead: boolean;
  readyBuilder: boolean;
  exchangeId: string | null;
  exchangeArrived: boolean;
  exchangeRead: boolean;
  working: boolean;
  claimedTask: string | null;
};

export type MinuteClock = {
  elapsedMs: number;
  bootstrapMs: number;
  detectMs: number;
  upMs: number;
  exchangeMs: number;
  startedMs: number;
};

const EMPTY_PROOF: MinuteProof = {
  versionOk: false,
  daemonRunning: false,
  roots: 0,
  teamFile: false,
  checkClean: false,
  readyLead: false,
  readyBuilder: false,
  exchangeId: null,
  exchangeArrived: false,
  exchangeRead: false,
  working: false,
  claimedTask: null,
};

/** The six rows. A step past its budget is a miss. The trial is a miss past 60 seconds. */
export function assessMinute(proof: MinuteProof, clock: MinuteClock): StepMark[] {
  const exchangeOk = proof.exchangeId !== null
    && proof.exchangeArrived
    && proof.exchangeRead
    && proof.claimedTask === proof.exchangeId;
  const rows: Array<{ step: StepName; ok: boolean; ms: number; detail: string }> = [
    { step: 'install', ok: proof.versionOk, ms: 0, detail: proof.versionOk ? 'version' : 'team --version failed' },
    {
      step: 'bootstrap',
      ok: proof.daemonRunning && proof.roots === 1 && clock.bootstrapMs <= STEP_BUDGET_MS.bootstrap,
      ms: clock.bootstrapMs,
      detail: proof.daemonRunning && proof.roots === 1 ? 'daemon running, roots 1' : 'daemon not running with one root',
    },
    {
      step: 'detect',
      ok: proof.teamFile && proof.checkClean && clock.detectMs <= STEP_BUDGET_MS.detect,
      ms: clock.detectMs,
      detail: proof.teamFile && proof.checkClean ? 'team file, check clean' : 'team file or check missed',
    },
    {
      step: 'up',
      ok: proof.readyLead && proof.readyBuilder && clock.upMs <= STEP_BUDGET_MS.up,
      ms: clock.upMs,
      detail: proof.readyLead && proof.readyBuilder ? 'ready' : 'a seat is not ready',
    },
    {
      step: 'exchange',
      ok: exchangeOk && clock.exchangeMs <= STEP_BUDGET_MS.exchange,
      ms: clock.exchangeMs,
      detail: exchangeOk ? proof.exchangeId ?? '' : 'no arrived and read id',
    },
    {
      step: 'started',
      ok: proof.working && proof.claimedTask !== null && proof.claimedTask === proof.exchangeId && clock.startedMs <= STEP_BUDGET_MS.started,
      ms: clock.startedMs,
      detail: proof.working && proof.claimedTask === proof.exchangeId ? 'working' : 'working or the claimed id missed',
    },
  ];
  return rows.map((row) => ({ ...row, ok: row.ok && clock.elapsedMs <= TOTAL_MS }));
}

export function formatMarks(marks: readonly StepMark[], elapsedMs: number): string {
  const lines = marks.map((mark) => `${mark.step} ${mark.ms} ms ${mark.ok ? 'ok' : 'miss'} ${mark.detail}`);
  const ok = marks.every((mark) => mark.ok);
  lines.push(`total ${elapsedMs} ms ${ok ? 'ok' : 'miss'}`);
  return lines.join('\n');
}

/** `team start` is not a command when the CLI says so and exits 2. */
export function missingStart(code: number | null, stderr: string): boolean {
  return code === 2 && stderr.includes('unknown command "start"');
}

export type Trial = { ok: boolean; text: string; elapsedMs: number };

/** One trial in `home`. The project folder is empty apart from a short README. */
export function runTrial(opts: { bin: string; home: string; path: string }): Trial {
  const started = Date.now();
  const project = join(opts.home, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), 'project\n');
  const env = { HOME: opts.home, PATH: opts.path, TMPDIR: opts.home };
  const version = spawnSync(opts.bin, ['--version'], {
    env,
    cwd: project,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const command = spawnSync(opts.bin, ['start', '--json'], {
    env,
    cwd: project,
    encoding: 'utf8',
    timeout: TOTAL_MS,
  });
  const elapsedMs = Date.now() - started;
  if (missingStart(command.status, command.stderr ?? '')) {
    const clock: MinuteClock = { elapsedMs, bootstrapMs: 0, detectMs: 0, upMs: 0, exchangeMs: 0, startedMs: 0 };
    const marks = assessMinute(
      { ...EMPTY_PROOF, versionOk: version.status === 0 },
      clock,
    ).map((mark) => mark.step === 'install' ? mark : { ...mark, detail: 'team start is not a command' });
    return { ok: false, text: formatMarks(marks, elapsedMs), elapsedMs };
  }
  const proof = proofFromJson(command.stdout ?? '');
  const clock = clockFromJson(command.stdout ?? '', elapsedMs);
  const marks = assessMinute({ ...proof, versionOk: version.status === 0 && proof.versionOk }, clock);
  return { ok: marks.every((mark) => mark.ok) && command.status === 0, text: formatMarks(marks, elapsedMs), elapsedMs };
}

function proofFromJson(stdout: string): MinuteProof {
  const parsed = parseBlock(stdout);
  if (parsed === null) return { ...EMPTY_PROOF };
  return {
    versionOk: parsed.versionOk === true,
    daemonRunning: parsed.daemonRunning === true,
    roots: typeof parsed.roots === 'number' ? parsed.roots : 0,
    teamFile: parsed.teamFile === true,
    checkClean: parsed.checkClean === true,
    readyLead: parsed.readyLead === true,
    readyBuilder: parsed.readyBuilder === true,
    exchangeId: typeof parsed.exchangeId === 'string' ? parsed.exchangeId : null,
    exchangeArrived: parsed.exchangeArrived === true,
    exchangeRead: parsed.exchangeRead === true,
    working: parsed.working === true,
    claimedTask: typeof parsed.claimedTask === 'string' ? parsed.claimedTask : null,
  };
}

function clockFromJson(stdout: string, elapsedMs: number): MinuteClock {
  const parsed = parseBlock(stdout);
  const num = (key: string): number => {
    const value = parsed?.[key];
    return typeof value === 'number' ? value : elapsedMs;
  };
  return {
    elapsedMs,
    bootstrapMs: num('bootstrapMs'),
    detectMs: num('detectMs'),
    upMs: num('upMs'),
    exchangeMs: num('exchangeMs'),
    startedMs: num('startedMs'),
  };
}

function parseBlock(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && value !== '' ? value : fallback;
}

if (import.meta.main) {
  const runs = Number(flag('--runs', String(TRIALS)));
  const bin = flag('--bin', 'team');
  const path = flag('--path', '/usr/bin:/bin');
  let failed = 0;
  for (let trial = 1; trial <= runs; trial++) {
    const home = mkdtempSync(join(tmpdir(), 'first-minute-'));
    const result = runTrial({ bin, home, path });
    console.log(`trial ${trial}\n${result.text}`);
    if (!result.ok) failed++;
  }
  process.exit(failed === 0 ? 0 : 1);
}
