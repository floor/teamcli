// A workspace title drifts when herdr shows a title the file does not stand behind — but the
// file stands behind more than its own label: an unwritten label tolerates the seat's name and
// the lowercase model default, a workspace with no title or one herdr did not list says nothing,
// and a written label ends every tolerance. These scenes hold each clause of that guard against
// its twin: the same live title, one field apart in the file, flips the verdict.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it, fully built: grok-acme is stopped in the file.
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

/** The team as herdr would show it with one workspace retitled. */
function retitled(id: string, label: string): Live {
  return { ...built(), workspaces: built().workspaces.map((one) => (one.id === id ? { ...one, label } : one)) };
}

let dir: string;
let file: string;
let live: Live | null;
let standing: Standing;
const sources: StatusSources = {
  live: () => live,
  branch: () => 'main',
  standing: () => standing,
  now: () => NOW,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-label-drift-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  live = built();
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

async function status() {
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file], io, sources);
  return { code, out: io.out, err: io.err };
}

/** Write `label` onto codex-acme and approve the file as it now stands. */
function labelCodex(label: string) {
  writeFileSync(file, example.replace('    name: codex-acme\n', `    name: codex-acme\n    label: ${label}\n`));
  const parsed = validateTeamFile(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(parsed.errors)}`);
  standing = verifiedOf(parsed.team, readFileSync(file, 'utf8'), dir, NOW);
}

describe('workspace title drift', () => {
  test('a workspace titled with the seat\'s own name is not drift, until the file writes a label', async () => {
    live = retitled('w2', 'codex-acme');
    const plain = await status();
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain('its workspace is titled');

    labelCodex('builder-1');
    const written = await status();
    expect(written.code).toBe(1);
    expect(written.out).toContain('difference: codex-acme: its workspace is titled "codex-acme"; the file says "builder-1"');
    expect(written.out).toContain('repair: herdr --session acme-web workspace rename w2 builder-1');
  });

  test('a workspace with no title, and one herdr did not list, say nothing', async () => {
    labelCodex('builder-1');
    live = retitled('w2', '');
    const empty = await status();
    expect(empty.code).toBe(0);
    expect(empty.out).not.toContain('its workspace is titled');

    live = {
      ...built(),
      agents: built().agents.map((one) => (one.name === 'codex-acme' ? agent('codex-acme', 'w7', 'idle', 'codex') : one)),
      workspaces: built().workspaces.filter((one) => one.id !== 'w2'),
    };
    const unlisted = await status();
    expect(unlisted.code).toBe(0);
    expect(unlisted.out).not.toContain('its workspace is titled');
  });

  test('the live title is cleaned in the difference; the repair carries the file\'s label', async () => {
    labelCodex('builder-1');
    live = retitled('w2', 'gp\x1b[31mt sol 6');
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain('difference: codex-acme: its workspace is titled "gpt sol 6"; the file says "builder-1"');
    expect(out).toContain('repair: herdr --session acme-web workspace rename w2 builder-1');
    expect(out).not.toContain('\x1b');
  });

  test('two drifted workspaces each carry their own rename', async () => {
    writeFileSync(file, example
      .replace('    name: codex-acme\n', '    name: codex-acme\n    label: builder-1\n')
      .replace('    name: deepseek-acme\n', '    name: deepseek-acme\n    label: reviewer-2\n'));
    const parsed = validateTeamFile(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(parsed.errors)}`);
    standing = verifiedOf(parsed.team, readFileSync(file, 'utf8'), dir, NOW);
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain('difference: codex-acme: its workspace is titled "gpt sol 6"; the file says "builder-1"');
    expect(out).toContain('repair: herdr --session acme-web workspace rename w2 builder-1');
    expect(out).toContain('difference: deepseek-acme: its workspace is titled "deepseek flash v4.1"; the file says "reviewer-2"');
    expect(out).toContain('repair: herdr --session acme-web workspace rename w3 reviewer-2');
    // The count: 2 seat carries the label with its instance suffix, like its name.
    expect(out).toContain('difference: deepseek-acme-2: its workspace is titled "deepseek flash v4.1-2"; the file says "reviewer-2-2"');
    expect(out).toContain('repair: herdr --session acme-web workspace rename w4 reviewer-2-2');
    expect(out).toContain('3 difference(s)');
  });
});
