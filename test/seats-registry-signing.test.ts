// `team seats` reads a seat's declared model from its registry record where the launch wrote
// one, the same like-for-like `status` reads: the record's signing triple is what the seat
// signed, and a team file edited after the launch cannot prove what the pane started from. The
// model column is the one surface this changes — a seat with no record keeps the file's display.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSeats, type SeatsSources } from '../src/commands/seats.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-04T09:00:00Z');
const codexScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

function agent(name: string, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}-pane`, workspace, status, cwd: null };
}

// The example's codex seat as herdr shows it: its pane runs the model the record signs, while
// the file's own declaration was edited past that launch.
function built(): Live {
  return {
    running: true,
    agents: [agent('codex-acme', 'fixture-ws-2', 'idle', 'codex')],
    workspaces: [{ id: 'fixture-ws-2', label: 'gpt terra 5.6' }],
    screens: { 'fixture-ws-2-pane': codexScreen('idle') },
  };
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seats-signing-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), example);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['codex-acme'] = { stage: 'ready', pane: 'fixture-ws-2-pane', workspace: 'fixture-ws-2' };
  });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

// The record a launch writes: the signing triple the pane was started on, with the record's own
// cli and launch as the provenance the reader takes.
function record(): void {
  registerAgent(home, {
    name: 'codex-acme',
    signing: { model: 'GPT Terra', version: '5.6', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex',
    reach: { team: teamIdOf(root), seat: 'codex-acme', session: 'acme-web', pane: 'fixture-ws-2-pane', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function sources(): SeatsSources {
  return {
    live: () => built(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  };
}

describe('the seats model column reads the registry record', () => {
  test('a file edited past the record shows the record\'s model, not a phantom drift', async () => {
    record();
    const io = testIo(root, { kind: 'owner' });
    expect(await runSeats(['--json'], io, sources())).toBe(0);
    const doc = JSON.parse(io.out) as { seats: Array<{ name: string; model: string }> };
    const codex = doc.seats.find((row) => row.name === 'codex-acme');
    // The record signs GPT Terra 5.6, and the pane runs it: no drift. Read against the file's
    // GPT-6 Sol alone, the same pane would have shown `GPT Terra 5.6 (file: GPT-6 Sol)`.
    expect(codex?.model).toBe('gpt terra 5.6');
  });
});
