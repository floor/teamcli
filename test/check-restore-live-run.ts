// `team check`'s own live read for a seat the terminal host restored: the shipped sources are
// driven with the host's readers stood in, so the scene measures what the command actually reads
// rather than a `Live` handed to it. Its own process, because the stand-in must be in place
// before the command loads (the convention `test/check-stuck-live-coverage-run.ts` follows). Only
// the host readers are stood in; the team, the state, the proof and the check are the real ones.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realHerdr from '../src/herdr.ts';
import type { HerdrAgent } from '../src/herdr.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const SESSION = 'acme';
const PANE = 'restored-pane';
const SPACE = 'restored-space';

const seats: HerdrAgent[] = [];
const screens: Record<string, string> = {};
const infos: Record<string, unknown> = {};

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: () => true,
  agentList: () => seats,
  workspaceList: () => [{ id: SPACE, label: 'worker' }],
  paneRead: (pane: string) => screens[pane] ?? '',
  paneProcessInfo: (pane: string) => infos[pane] ?? null,
  // The same reading through the older one-value reader, so a live read that asks for the
  // process identity alone still answers from this scene's stand-in rather than the host.
  paneProcesses: (pane: string) => realHerdr.paneProcessesOf(infos[pane] ?? null),
}));

const { realCheckSources, runTeamCheck } = await import('../src/check/team.ts');
const { verifiedOf } = await import('../src/approve/approval.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { testIo } = await import('./helpers.ts');

function teamText(lobby: string, root: string): string {
  return `format: 1
project: acme
session: ${SESSION}
operator: lead
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'check-restore-live-')));
const root = join(base, 'acme');
const home = join(base, 'home');
const lobby = join(home, '.config', 'team', 'lobby');
const dir = join(root, '.agents');
mkdirSync(dir, { recursive: true });
mkdirSync(lobby, { recursive: true });
const text = teamText(lobby, root);
writeFileSync(join(dir, 'team.yaml'), text);
const checked = validateTeamFile(text);
if (!checked.ok) throw new Error('the runner team fixture does not validate');

// The restored world: the host lists the recorded pane, without a name for it, and the seat's
// process reading is the replaced one the record does not name.
seats.push({ name: null, agent: 'codex', pane: PANE, workspace: SPACE, status: 'idle', cwd: null });
screens[PANE] = '';
infos[PANE] = {
  process_info: {
    shell_pid: 30,
    foreground_processes: [{ pid: 31, argv0: 'codex' }],
  },
};
updateState(dir, (state) => {
  const session = (state.sessions[SESSION] ??= emptySession());
  session.seats.worker = {
    stage: 'ready',
    pane: PANE,
    workspace: SPACE,
    launched: { shell: 20, cli: [22] },
  } as never;
});

const standing = verifiedOf(checked.team, text, root, NOW);
const io = testIo(root, { kind: 'owner' });
const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
  ...realCheckSources,
  branch: () => null,
  standing: () => standing,
  now: () => NOW,
  home: home,
});

rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify({ code, out: io.out }));
