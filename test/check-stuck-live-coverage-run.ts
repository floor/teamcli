// The production live read for temporary seats, driven three ways: a record herdr no longer
// names on its pane (its pane must not be read at all), a record herdr names on its pane while
// the pane is back at its shell (the pane is read, for its process identity, and the check makes
// no prompt line from it), and a record whose recorded CLI pids are still in front (read, and
// named). This runs as its own process so the herdr stand-in is in place before the command
// loads (the convention `test/status-readonly-run.ts` follows); only the herdr readers are stood
// in, and the state and the check are the real ones.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realHerdr from '../src/herdr.ts';
import type { HerdrAgent } from '../src/herdr.ts';

const PERMISSION = readFileSync(new URL('./fixtures/claude-code/2.1.302/permission.txt', import.meta.url), 'utf8');
const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');
const AT = '2026-10-03T14:06:00Z';

const seats: HerdrAgent[] = [];
const screens: Record<string, string> = {};
const processes: Record<string, { shell: number; foreground: number[] } | null> = {};
let reads: string[] = [];

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: () => true,
  agentList: () => seats,
  workspaceList: () => [],
  paneRead: (pane: string) => {
    reads.push(pane);
    return screens[pane] ?? '';
  },
  paneProcesses: (pane: string) => processes[pane] ?? null,
}));

const { realCheckSources, runTeamCheck } = await import('../src/check/team.ts');
const { verifiedOf } = await import('../src/approve/approval.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { testIo } = await import('./helpers.ts');

const checked = validateTeamFile(EXAMPLE);
if (!checked.ok) throw new Error('the example fixture does not validate');
const team = checked.team;

function reset(): void {
  seats.length = 0;
  for (const key of Object.keys(screens)) delete screens[key];
  for (const key of Object.keys(processes)) delete processes[key];
  reads = [];
}

function scene(pane: string, extra: Record<string, unknown>): { code: number; out: string; reads: string[] } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-live-coverage-')));
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), EXAMPLE);
  const standing = verifiedOf(team, EXAMPLE, root, NOW);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.watch = { pid: 1, heartbeat: '2026-10-03T14:09:00Z' };
    session.seats['claude-acme-tmp-1'] = {
      stage: 'ready',
      pane,
      workspace: 'w6',
      last_active: AT,
      temporary: { like: 'deepseek-acme', until: 'merged:fix/select-width' },
      ...extra,
    } as never;
  });
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...realCheckSources,
    branch: () => null,
    standing: () => standing,
    now: () => NOW,
    home: root,
  });
  rmSync(base, { recursive: true, force: true });
  return { code, out: io.out, reads: [...reads] };
}

// A record herdr lists on another pane: the pane it names is not the state's, and the state's
// pane is not read either — a stale record reads nothing.
reset();
seats.push({ name: 'claude-acme-tmp-1', agent: 'claude', pane: 'w7:p1', workspace: 'w7', status: 'working', cwd: null });
screens['w6:p1'] = PERMISSION;
screens['w7:p1'] = PERMISSION;
const stale = scene('w6:p1', {});

// A record herdr lists on its own recorded pane, whose pane is back at its shell: the pane is
// read (the temporary seat is a seat by its record), and the process gate keeps the dialog from
// becoming a prompt.
reset();
seats.push({ name: 'claude-acme-tmp-1', agent: 'claude', pane: 'w6:p1', workspace: 'w6', status: 'idle', cwd: null });
screens['w6:p1'] = PERMISSION;
processes['w6:p1'] = { shell: 10, foreground: [10] };
const shell = scene('w6:p1', { launched: { shell: 10, cli: [11] } });

// The same record with the CLI pids the launch recorded still in front: read, and named.
reset();
seats.push({ name: 'claude-acme-tmp-1', agent: 'claude', pane: 'w6:p1', workspace: 'w6', status: 'idle', cwd: null });
screens['w6:p1'] = PERMISSION;
processes['w6:p1'] = { shell: 10, foreground: [10, 11] };
const held = scene('w6:p1', { launched: { shell: 10, cli: [11] } });

console.log(JSON.stringify({ stale, shell, held }));
