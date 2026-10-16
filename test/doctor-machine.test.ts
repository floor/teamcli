// The one machine check a reading cannot pass: the check in force asks for more free swap than the
// machine has in total. `doctor` reports it as one warning, `status` as one note, and neither
// changes an exit: `up`'s own refusal is where it bites, and it is unaffected.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runApprove } from '../src/approve/command.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, standingSource, type StatusSources } from '../src/commands/status.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-04T09:00:00Z');

// The file declares no `swap_free_min`, so the check in force is the 2GB default.
const SENTENCE =
  'the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so `team up` would refuse now; set `machine.swap_free_min` to a figure this machine can keep';

// A machine reading whose 1GB of swap in total cannot hold the 2GB the check wants.
const SMALL: Machine = { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 1e9, swapFree: 0.5e9, swapUsed: 0.5e9 };
// The same machine with room in total and none of it free right now: the check can pass in
// principle, `up` refuses today, and nothing new is said — that is `up`'s line and the watch's.
const ROOMY: Machine = { ...SMALL, swapTotal: 16e9 };

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-machine-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

async function approve() {
  const io = testIo(root, OWNER);
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  return { code, out: io.out, err: io.err };
}

function doctorSources(machine?: () => Machine): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...(machine ? { machine } : {}),
  };
}

function statusSources(machine?: () => Machine): StatusSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
    ...(machine ? { machine } : {}),
  };
}

async function doctor(sources: DoctorSources) {
  const io = testIo(root, OWNER);
  const code = await runDoctor(FILE, io, sources);
  return { code, out: io.out, err: io.err };
}

async function status(sources: StatusSources, ...argv: string[]) {
  const io = testIo(root, OWNER);
  const code = await runStatus([...FILE, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

// The findings as one body, with the summary line — whose count the added warning changes —
// taken off, so the only difference the run may show is the finding itself.
function withoutSummary(out: string): string {
  return out.slice(0, out.lastIndexOf('team doctor: '));
}

describe('the swap the check can never meet', () => {
  test('doctor: one warning, and no other finding or exit changes', async () => {
    expect((await approve()).code).toBe(0);
    const plain = await doctor(doctorSources());
    const withMachine = await doctor(doctorSources(() => SMALL));
    expect(withMachine.code).toBe(plain.code);
    expect(withoutSummary(withMachine.out)).toBe(`${withoutSummary(plain.out)}warn  ${SENTENCE}\n`);
    // It is a warning, not a MISS: the summary counts it and says nothing blocks `up`.
    expect(withMachine.out).toMatch(/^team doctor: nothing missing, \d+ warning/m);
    expect(withMachine.out).not.toContain('block `up`');
    // A check that can pass in principle, failing right now, is not this case: nothing is said.
    const roomy = await doctor(doctorSources(() => ROOMY));
    expect(roomy.out).toBe(plain.out);
    // No machine reader at all is nothing said, never a guess.
    expect(plain.out).not.toContain('the machine check asks');
  });

  test('status: the same fact as one note, and the exit is untouched', async () => {
    expect((await approve()).code).toBe(0);
    const plain = await status(statusSources());
    const withMachine = await status(statusSources(() => SMALL));
    expect(withMachine.code).toBe(plain.code);
    expect(withMachine.out).toContain(`note: ${SENTENCE}\n`);
    expect(withMachine.out.replace(`note: ${SENTENCE}\n`, '')).toBe(plain.out);
    // It sits with the approval note, above it, and below the session's own note.
    const lines = withMachine.out.split('\n');
    expect(lines.filter((line) => line.includes(SENTENCE))).toHaveLength(1);
    expect(lines.indexOf(`note: ${SENTENCE}`) + 1).toBe(lines.findIndex((line) => line.startsWith('note: approval #')));
    // `--json` carries the same sentence, in the same place among the notes.
    const doc = JSON.parse((await status(statusSources(() => SMALL), '--json')).out) as { notes: string[] };
    expect(doc.notes[doc.notes.findIndex((note) => note.startsWith('approval #')) - 1]).toBe(SENTENCE);
    // The check that can pass in principle says nothing here either.
    const roomy = await status(statusSources(() => ROOMY));
    expect(roomy.out).toBe(plain.out);
  });

  test('a total that moves: the line is the reading it came from, and promises nothing', async () => {
    // The after-review's case: on macOS `vm.swapusage`'s total moves with pressure, so one reading
    // cannot promise what a later `team up` will meet. The same commands over the machine twice,
    // with the total moved between the runs: the line is there for the reading the check cannot
    // meet and gone for the next one, and its words are the reading's own (`would refuse now`) —
    // never what a later run will do.
    expect((await approve()).code).toBe(0);
    let machine: Machine = SMALL;
    const firstDoctor = await doctor(doctorSources(() => machine));
    const firstStatus = await status(statusSources(() => machine));
    machine = ROOMY;
    const secondDoctor = await doctor(doctorSources(() => machine));
    const secondStatus = await status(statusSources(() => machine));
    const lineOf = (out: string) => out.split('\n').find((line) => line.includes('the machine check asks'));
    expect(lineOf(firstDoctor.out)).toBe(`warn  ${SENTENCE}`);
    expect(lineOf(secondDoctor.out)).toBeUndefined();
    expect(firstStatus.out).toContain(`note: ${SENTENCE}\n`);
    expect(secondStatus.out).not.toContain('the machine check asks');
    expect(SENTENCE).toContain('would refuse now');
    expect(SENTENCE).not.toContain('will');
  });
});
