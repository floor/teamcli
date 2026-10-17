// The permission-prompt difference at its boundaries. The difference moved: `compare()` emits it
// now, for seats the file knows and temporary seats alike, and the watch-side `viewOf` no longer
// carries a copy — a copy there would print the same line twice through `team check`. These pins
// hold the edges: exactly one line through check, the same words from status and check, a seat
// herdr calls working is still reported, a temporary seat is reported, and the internal page's
// repair row is the sentence the binary prints.
import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Standing } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');
const PAGE = '../docs/internal/status.md';

const PERMISSION = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
const DIFFERENCE = "waits at a permission prompt: its owner's to answer";
const REPAIR = 'the owner answers it in the pane';

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it, with codex-acme parked and quiet.
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
      { id: 'w6', label: 'gpt sol 6 tmp' },
    ],
    screens: { 'w1:p1': claudeScreen('Opus 5.5') },
  };
}

let dir: string;
let file: string;
let live: Live;
let standing: Standing;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-permission-bnd-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});

const sources = (): StatusSources => ({ live: () => live, branch: () => 'main', standing: () => standing, now: () => NOW });

async function status() {
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file], io, sources());
  return { code, out: io.out, err: io.err };
}

function check() {
  const io = testIo(dir, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, { ...sources(), home: dir });
  return { code, out: io.out, err: io.err };
}

test('through team check the permission difference appears exactly once', () => {
  live = { ...built(), screens: { ...built().screens, 'w2:p1': PERMISSION } };
  const { out, code } = check();
  const lines = out.split(`${DIFFERENCE}`).length - 1;
  expect(lines, 'check printed the permission difference more than once').toBe(1);
  expect(out).toContain(`difference: codex-acme ${DIFFERENCE}\n  repair: ${REPAIR}\n`);
  expect(code).toBe(1);
  // The summary counts exactly the lines above it — check may add differences status does not
  // carry (the rules file here), and every one of them must stay counted.
  const printed = out.split('difference: ').length - 1;
  const summary = Number(out.match(/^(\d+) differences?/m)?.[1] ?? NaN);
  expect(summary, 'the summary count parted from the printed lines').toBe(printed);
});

test('status and check say the same words, for a seat herdr calls working too', async () => {
  // herdr's word is not the gate: a seat held at a prompt may read working or idle, and the
  // difference is the screen's, not the status line's.
  live = {
    ...built(),
    agents: built().agents.map((one) => (one.name === 'codex-acme' ? agent('codex-acme', 'w2', 'working', 'codex') : one)),
    screens: { ...built().screens, 'w2:p1': PERMISSION },
  };
  const st = await status();
  expect(st.out).toContain(`difference: codex-acme ${DIFFERENCE}\n  repair: ${REPAIR}\n`);
  expect(st.code, 'a permission prompt is a difference, whatever herdr calls the seat').toBe(1);
  expect(st.out).toContain('1 difference, 1 for the owner\n');

  const ck = check();
  const pair = (out: string) => out.split('\n').filter((line) => line.includes(DIFFERENCE) || line.includes(REPAIR));
  expect(pair(ck.out)).toEqual(pair(st.out));
});

test('a temporary seat held at a prompt is the owner\'s difference too', async () => {
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['codex-acme-tmp-1'] = { stage: 'ready', pane: 'w6:p1', workspace: 'w6', temporary: { like: 'codex-acme', until: 'merged:fix/select-width' } };
  });
  live = {
    ...built(),
    agents: [...built().agents, agent('codex-acme-tmp-1', 'w6', 'working', 'codex')],
    screens: { ...built().screens, 'w6:p1': PERMISSION },
  };
  const { out, code } = await status();
  expect(out).toContain(`difference: codex-acme-tmp-1 ${DIFFERENCE}\n  repair: ${REPAIR}\n`);
  expect(out).toContain('note: codex-acme-tmp-1 is temporary, until merged:fix/select-width');
  expect(code).toBe(1);
});

test('the internal page\'s repair row is the sentence the binary prints', async () => {
  live = { ...built(), screens: { ...built().screens, 'w2:p1': PERMISSION } };
  const { out } = await status();
  // The row the page carries must be the very sentence a real run prints — seat name aside.
  expect(out).toContain(`codex-acme ${DIFFERENCE}`);
  expect(out).toContain(REPAIR);
  const page = readFileSync(new URL(PAGE, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  expect(page.includes(`<seat> ${DIFFERENCE}`), 'status.md lost the permission row').toBe(true);
  expect(page.includes(`\`${REPAIR}\``), 'status.md lost the row\'s repair').toBe(true);
});
