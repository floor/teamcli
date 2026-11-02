// `team status` and `team check` say, in one sentence, why a declared Codex seat's last launch
// launched it unmanaged. The fallback is a reading worth acting on, never a silent state: both
// commands print the same words, and a note stays a note — it is not a difference, and it
// changes neither the count nor the exit.
import { expect, test } from 'bun:test';
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
const WHY = 'the Codex app-server did not start';
const NOTE = `note: codex-acme: the managed Codex endpoint did not start at its last launch: ${WHY}\n`;

// Panes are named by role in this scene, never by a window-and-pane shape.
function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}-pane`, workspace, status, cwd: null };
}

function differences(out: string): number {
  return out.split('difference: ').length - 1;
}

test('status and check print the same fallback sentence, and it changes no count or exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-endpoint-note-'));
  try {
    mkdirSync(join(dir, '.agents'));
    const file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, example);
    const checked = validateTeamFile(example);
    if (!checked.ok) throw new Error('the example fixture does not validate');
    const standing: Standing = verifiedOf(checked.team, example, dir, NOW);
    const live: Live = {
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
      screens: {},
    };
    const sources = (): StatusSources => ({ live: () => live, branch: () => 'main', standing: () => standing, now: () => NOW });
    const status = async () => {
      const io = testIo(dir, { kind: 'owner' });
      const code = await runStatus(['--file', file], io, sources());
      return { code, out: io.out };
    };
    const check = () => {
      const io = testIo(dir, { kind: 'owner' });
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, { ...sources(), home: dir });
      return { code, out: io.out };
    };
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['codex-acme'] = {
        stage: 'ready', pane: 'w2-pane', workspace: 'w2', cli: 'codex', last_active: '2026-10-03T14:06:00Z',
      };
      session.watch = { pid: 1, heartbeat: '2026-10-03T14:09:00Z' };
    });

    const statusBefore = await status();
    const checkBefore = check();
    expect(statusBefore.out).not.toContain(NOTE);
    expect(checkBefore.out).not.toContain(NOTE);

    updateState(join(dir, '.agents'), (state) => {
      const seat = state.sessions['acme-web']?.seats['codex-acme'];
      if (seat === undefined) throw new Error('the scene recorded no seat');
      seat.codex_endpoint_unmanaged = { why: WHY, at: NOW.toISOString() };
    });

    const statusAfter = await status();
    const checkAfter = check();
    expect(statusAfter.out).toContain(NOTE);
    expect(checkAfter.out).toContain(NOTE);
    // A note is a reading, not a difference: the count and the exit are the baseline's.
    expect(statusAfter.code).toBe(statusBefore.code);
    expect(checkAfter.code).toBe(checkBefore.code);
    expect(differences(statusAfter.out)).toBe(differences(statusBefore.out));
    expect(differences(checkAfter.out)).toBe(differences(checkBefore.out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
