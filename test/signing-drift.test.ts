// The signing drift: what a seat's registry record says it signs as against what its pane runs.
// The record's `signing` triple is the launch's own declaration (`src/registry/sync.ts`), and the
// commits a seat writes are checked against it — so a pane running another model than the record
// signs is a finding `team check` prints as `signs as X, runs Y`, with the re-record or the
// relaunch beside it. The record's own words spell X, unless the file still declares exactly what
// the record signs: then the seat's `display` spelling stands, the spelling every other line
// gives it. Nothing here writes: the check is a read, and the record is only re-made by
// `team register` once the drift is accepted. A team the registry holds no record for reads as
// before, and a screen the reader cannot name a model from — unread, or another maker's through
// Claude Code — is never wrong.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import type { AgentSigning } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-04T09:00:00Z');

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const codexScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it; the codex seat's pane is added by the scenes that
// need its captured footer.
function built(): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'w1', 'working'),
      agent('codex-acme', 'w2', 'idle', 'codex'),
      agent('deepseek-acme', 'w3', 'done'),
      agent('deepseek-acme-2', 'w4'),
    ],
    workspaces: [
      { id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' },
      { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' }, { id: 'w9', label: 'watchdog' },
    ],
    screens: { 'w1:p1': claudeScreen('Opus 5.5') },
  };
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-signing-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), example);
  // The state a launch leaves: every live seat recorded on its own pane. The signing drift is
  // read on the pane the state recorded, as the attention and label differences read theirs.
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    for (const [name, workspace] of [
      ['claude-coordinator-acme', 'w1'],
      ['codex-acme', 'w2'],
      ['deepseek-acme', 'w3'],
      ['deepseek-acme-2', 'w4'],
    ] as const) {
      session.seats[name] = { stage: 'ready', pane: `${workspace}:p1`, workspace };
    }
  });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// One agent record, the way a launch would have written it: the seat's own pane and session, and
// the signing triple under test.
function record(seat: string, signing: AgentSigning, pane: string, over: { team?: string; cli?: string; lab?: string } = {}) {
  return registerAgent(home, {
    name: seat,
    signing,
    lab: over.lab ?? 'openai',
    cli: over.cli ?? 'codex',
    launcher: null,
    launch: 'codex',
    reach: { team: over.team ?? teamIdOf(root), seat, session: 'acme-web', pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'the test',
  });
}

function check(live: Live = built()) {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  });
  return { code, out: io.out, err: io.err };
}

// The registry as it stands on disk: every agent file's bytes, for the scenes that prove the
// check read it and wrote nothing.
function registryOnDisk(): Record<string, string> {
  const dir = join(home, '.config', 'team', 'agents');
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), 'utf8');
  return out;
}

describe('the signing drift', () => {
  test('a record that signs what the pane runs is no finding', () => {
    record('codex-acme', { model: 'GPT Terra', version: '5.6', role: 'implementer' }, 'w2:p1');
    const live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { out } = check(live);
    expect(out).not.toContain('signs as');
    // The pane still runs another model than the file declares — that finding is the file's, and
    // it stands beside this one, unchanged.
    expect(out).toContain('codex-acme: running GPT Terra 5.6 medium, file says GPT-6 Sol');
  });

  test('a record that signs another model than the pane runs is a finding, and nothing is written', () => {
    record('codex-acme', { model: 'GPT Sol', version: '6', role: 'implementer' }, 'w2:p1');
    const before = registryOnDisk();
    const { code, out } = check({ ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } });
    expect(out).toContain('difference: codex-acme: signs as GPT-6 Sol, runs GPT Terra 5.6');
    expect(out).toContain(
      "  repair: update the team file's model, then team register codex-acme, " +
        'or relaunch on the recorded model (team remove codex-acme --keep, then team add codex-acme)',
    );
    expect(code).toBe(1);
    expect(registryOnDisk()).toEqual(before);
  });

  test('a name herdr lists on another pane than the state recorded is not the seat', () => {
    record('codex-acme', { model: 'GPT Sol', version: '6', role: 'implementer' }, 'w2:p1');
    // herdr now lists the name on the watchdog's pane; the state still records the seat on
    // w2:p1, so the screen there is not this seat's and no drift is read from it.
    const live = built();
    live.agents = live.agents.map((item) =>
      item.name === 'codex-acme' ? { ...item, pane: 'w9:p1', workspace: 'w9' } : item,
    );
    live.screens = { ...live.screens, 'w9:p1': codexScreen('idle') };
    const { out } = check(live);
    expect(out).not.toContain('signs as');
  });

  test('a lead\'s relaunch names the whole team, and the file\'s display spells the record', () => {
    record('claude-coordinator-acme', { model: 'Claude Opus', version: '5.5', role: 'project coordinator' }, 'w1:p1', {
      cli: 'claude-code',
      lab: 'anthropic',
    });
    const live = { ...built(), screens: { 'w1:p1': claudeScreen('Fable 5.1') } };
    const { out } = check(live);
    expect(out).toContain('difference: claude-coordinator-acme: signs as Claude Opus 5.5, runs Claude Fable 5.1');
    expect(out).toContain(
      "  repair: update the team file's model, then team register claude-coordinator-acme, " +
        'or relaunch on the recorded model (team down, then team up (to restart the whole team))',
    );
  });

  test('a file edited past the record spells the record\'s own words', () => {
    record('codex-acme', { model: 'GPT Sol', version: '6', role: 'implementer' }, 'w2:p1');
    // The file now declares what the pane runs: the model drift is gone, and the stale record is
    // all that is left — spelled as it stands, never through the file's display.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      example.replace('    model: GPT Sol\n    version: "6"', '    model: GPT Terra\n    version: "5.6"').replace('    display: GPT-6 Sol', '    display: GPT-5.6 Terra'),
    );
    const { out } = check({ ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } });
    expect(out).toContain('difference: codex-acme: signs as GPT Sol 6, runs GPT Terra 5.6');
    expect(out).not.toContain('signs as GPT-5.6 Terra');
  });

  test('a seat the registry holds no record for is not a finding', () => {
    record('codex-acme', { model: 'GPT Sol', version: '6', role: 'implementer' }, 'w2:p1', { team: 'deadbeef0000' });
    const live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { out } = check(live);
    // Another team's record is not this seat's; nor is a seat with no record at all.
    expect(out).not.toContain('signs as');
  });

  test('a screen the reader cannot name a model from is never a signing drift', () => {
    record('deepseek-acme', { model: 'DeepSeek Flash', version: 'V4.1', role: 'implementer' }, 'w3:p1', {
      cli: 'claude-code',
      lab: 'deepseek',
    });
    // Claude Code's line names Claude's families only: the DeepSeek seat's own screen says nothing
    // to compare, so the record stands rather than being called wrong.
    const live = { ...built(), screens: { ...built().screens, 'w3:p1': claudeScreen('Opus 5.5') } };
    const { out } = check(live);
    expect(out).not.toContain('deepseek-acme: signs as');
  });
});
