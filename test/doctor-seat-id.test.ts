// A seat record whose launch wrote the pane's process but not the seat's id: `team seats` shows
// `-` in its ID column, and nothing said why. doctor says it once, with the registration `check`
// already names as the repair — `team register <seat>`, the seat's own name — and a registered
// seat draws no such line. A lead's own seat draws none, the rule the process note already keeps.
// Fixtures only: the sample team file, a scratch home, and a doctor whose sources answer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { emptySession, updateState, type SeatState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-04T09:00:00Z');
const SESSION = 'acme-web';
const SEAT = 'codex-acme';
const LEAD = 'claude-coordinator-acme';
const ID = 'seat_aaaaaaaaaaaa';
const LAUNCHED = { shell: 400, cli: [401] };

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-id-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function sources(): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

/** One seat of the session's state, as a launch left it. */
function seed(name: string, seat: SeatState): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions[SESSION] = { ...emptySession(), seats: { [name]: seat } };
  });
}

async function doctor(): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, OWNER);
  const code = await runDoctor(FILE, io, sources());
  return { code, out: io.out, err: io.err };
}

const LINE = `note  ${SEAT}: launched before team recorded its id; run \`team register ${SEAT}\` to record it`;

describe('a seat record with a process but no id', () => {
  test('doctor names the seat and the registration that writes the id', async () => {
    seed(SEAT, { stage: 'ready', launched: LAUNCHED });
    const run = await doctor();
    expect(run.out).toContain(LINE);
    // A note is not the file's refusal: the run prints findings and its summary.
    expect(run.code).not.toBe(2);
  });

  test('a registered seat draws no such line', async () => {
    seed(SEAT, { id: ID, stage: 'ready', launched: LAUNCHED });
    const run = await doctor();
    expect(run.out).not.toContain('launched before team recorded its id');
    expect(run.code).not.toBe(2);
  });

  test("a lead's own seat draws no line, as the process note's rule holds", async () => {
    seed(LEAD, { stage: 'ready', launched: LAUNCHED });
    const run = await doctor();
    expect(run.out).not.toContain('launched before team recorded its id');
  });
});
