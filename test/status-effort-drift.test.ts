// Effort drift: the effort word the pane prints about itself against the word the file carries.
// The label's own line follows the observed word (src/labels/observe.ts); the comparison lives in
// src/status/compare.ts's modelOf, so `team status`, `team check` and `team seats` report it the
// way the model drift is reported: one difference naming both sides, the restart-or-correct
// repair, and the file never rewritten. A screen that prints no word is not a value — the file's
// word stands there, the rule the label follows — so only a word actually seen can differ.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runStatus } from '../src/commands/status.ts';
import type { StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

const LEAD_REPAIR = "restart the seat on the file's model (team down, then team up (to restart the whole team)), or correct the file";

// The word sits in the model cell, where Claude Code's own line keeps it (`Opus 4.8 with high
// effort · Claude Max` is the captured banner's spelling): both reads take their own part.
const claudeScreen = (model: string, effort?: string) =>
  `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model}${effort ? ` with ${effort} effort` : ''} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const codexScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it, fully built; nothing drifts until a scene says so.
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

// The file with one seat's effort written in: the field lands beside the seat's own lines, and
// the rewritten file is approved on disk — the drift under test is the running seat's, not the
// approval's.
function withEffort(anchor: string, word: string) {
  const text = example.replace(anchor, `${anchor}\n    effort: ${word}`);
  if (text === example) throw new Error('the anchor did not match the fixture');
  writeFileSync(file, text);
  approveOnDisk();
}

let dir: string;
let file: string;
let live: Live | null;
let branch: string | null;
let standing: Standing;

const sources: StatusSources = {
  live: () => live,
  branch: () => branch,
  standing: () => standing,
  now: () => NOW,
};

function approveOnDisk() {
  const text = readFileSync(file, 'utf8');
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(parsed.errors)}`);
  standing = verifiedOf(parsed.team, text, dir, NOW);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-effort-drift-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  live = built();
  branch = 'main';
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function status(...argv: string[]) {
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

describe('effort drift', () => {
  test('the word the screen prints where the file says nothing is a difference, and the file is left alone', async () => {
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Opus 5.5', 'high') } };
    const before = readFileSync(file, 'utf8');
    const { code, out } = await status();
    expect(out).toContain('difference: claude-coordinator-acme: running Claude Opus 5.5 high, file says Claude Opus 5.5');
    expect(out).toContain(`  repair: ${LEAD_REPAIR}\n`);
    // An effort alone does not move the model column: the model on the pane is still the file's.
    expect(out).toMatch(/claude-coordinator-acme\s+working\s+Claude Opus 5\.5\s+w1:p1/);
    expect(out).not.toContain('(file:');
    expect(out).toContain('1 difference(s)');
    expect(code).toBe(1);
    // Observed ≠ file is a report, never a write.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('the file\'s word, the screen\'s word: agreement is no difference', async () => {
    withEffort('    launch: claude --model claude-opus-5-5', 'high');
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Opus 5.5', 'high') } };
    const { code, out } = await status();
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a screen word the file contradicts names both words', async () => {
    withEffort('    launch: claude --model claude-opus-5-5', 'high');
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Opus 5.5', 'low') } };
    const { code, out } = await status();
    expect(out).toContain('difference: claude-coordinator-acme: running Claude Opus 5.5 low, file says Claude Opus 5.5 high');
    expect(out).toContain(`  repair: ${LEAD_REPAIR}\n`);
    expect(code).toBe(1);
  });

  test('a screen that prints no word leaves the file\'s word standing', async () => {
    withEffort('    launch: claude --model claude-opus-5-5', 'high');
    const { code, out } = await status();
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
    // The word is still the seat's, and the column still reads the model: only a word the pane
    // actually printed could have differed.
    expect(out).not.toContain('effort');
  });

  test('a codex footer\'s word joins the file\'s, both sides said', async () => {
    withEffort('    display: GPT-6 Sol', 'xhigh');
    live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { code, out } = await status();
    expect(out).toContain('difference: codex-acme: running GPT Terra 5.6 medium, file says GPT-6 Sol xhigh');
    expect(out).toContain('(file: GPT-6 Sol)');
    expect(code).toBe(1);
  });

  test('team check reports the same drift', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-effort-check-')));
    const root = join(base, 'acme-web');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), example);
    const check = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, check, {
      live: () => ({ ...built(), screens: { 'w1:p1': claudeScreen('Opus 5.5', 'high') } }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(check.out).toContain('difference: claude-coordinator-acme: running Claude Opus 5.5 high, file says Claude Opus 5.5');
    expect(check.out).toContain(`  repair: ${LEAD_REPAIR}\n`);
    expect(code).toBe(1);
    expect(readFileSync(join(root, '.agents/team.yaml'), 'utf8')).toBe(example);
    rmSync(base, { recursive: true, force: true });
  });
});
