// The workspace-title drift at its boundaries. The difference has a guard with three arms: a
// written label always reports, a default label stays silent while the workspace carries the
// default spelling or the seat's own name, and an empty title never reports. These pins hold the
// arms the change's own tests leave open — the silence is as much the feature as the report —
// and the one cleaning the difference line does itself.
import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Standing } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');
const PAGE = '../docs/internal/status.md';

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it: codex-acme's workspace w2 carries the default label.
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
      { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' },
    ],
    screens: { 'w1:p1': claudeScreen('Opus 5.5') },
  };
}

let dir: string;
let file: string;
let live: Live;
let standing: Standing;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-label-bnd-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
  live = built();
});

const sources = (): StatusSources => ({ live: () => live, branch: () => 'main', standing: () => standing, now: () => NOW });

async function status() {
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file], io, sources());
  return { code, out: io.out, err: io.err };
}

// Rewrite the file with codex-acme carrying a written label, and put the approval back in force.
function writeLabel(label: string) {
  const text = example.replace('    name: codex-acme\n', `    name: codex-acme\n    label: ${label}\n`);
  writeFileSync(file, text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the labelled fixture does not validate: ${parsed.errors[0]?.message}`);
  standing = verifiedOf(parsed.team, text, dir, NOW);
}

test('a default-label seat whose workspace carries the seat\'s own name stays silent', async () => {
  // The file wrote no label, so the expected title is the default spelling; a workspace that
  // carries the seat's name instead is not drift to report — the guard exists so renamed
  // workspaces do not cry drift on every run.
  live = { ...built(), workspaces: built().workspaces.map((w) => (w.id === 'w2' ? { ...w, label: 'codex-acme' } : w)) };
  const { code, out } = await status();
  expect(out, 'a workspace titled with the seat\'s name is not drift').not.toContain('its workspace is titled');
  expect(code).toBe(0);
});

test('a written label reports even when the drifted title is the seat\'s own name', async () => {
  writeLabel('builder-1');
  live = { ...built(), workspaces: built().workspaces.map((w) => (w.id === 'w2' ? { ...w, label: 'codex-acme' } : w)) };
  const { code, out } = await status();
  expect(out).toContain('difference: codex-acme: its workspace is titled "codex-acme"; the file says "builder-1"');
  expect(out).toContain('repair: herdr --session acme-web workspace rename w2 builder-1');
  expect(code).toBe(1);
});

test('a title with an escape sequence in it is reported clean', async () => {
  writeLabel('builder-1');
  live = { ...built(), workspaces: built().workspaces.map((w) => (w.id === 'w2' ? { ...w, label: 'evil\x1b]0;pwned\x07' } : w)) };
  const { out } = await status();
  expect(out).toContain('its workspace is titled "evil"');
  expect(out.includes('\x1b') || out.includes('\x07'), 'a raw escape byte reached the terminal').toBe(false);
  expect(out).not.toContain('pwned');
  // The repair names the expected title, never the drifted one.
  expect(out).toContain('repair: herdr --session acme-web workspace rename w2 builder-1');
});

test('the internal page\'s row is the sentence the run prints', async () => {
  writeLabel('builder-1');
  const { out } = await status();
  expect(out).toContain('codex-acme: its workspace is titled "gpt sol 6"; the file says "builder-1"');
  const page = readFileSync(new URL(PAGE, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  expect(page.includes('<seat>: its workspace is titled "x"; the file says "y"'), 'status.md lost the title-drift row').toBe(true);
  expect(page.includes('`herdr --session <s> workspace rename <workspace> <title>`'), 'status.md lost the row\'s repair').toBe(true);
});
