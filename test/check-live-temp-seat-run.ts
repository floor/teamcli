// The production live read, end to end: a temporary seat is a seat of the team by its record
// alone, so `realCheckSources.live` must read its pane and `team check` must name it. This runs
// as its own process so the herdr stand-in is in place before the command loads (the convention
// `test/status-readonly-run.ts` follows); only readers are stood in, and the state and the live
// read are the real ones.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realHerdr from '../src/herdr.ts';

const PERMISSION = readFileSync(new URL('./fixtures/claude-code/2.1.302/permission.txt', import.meta.url), 'utf8');

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: () => true,
  agentList: () => [
    { name: 'claude-coordinator-acme', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'ready', cwd: null },
    { name: 'codex-acme', agent: 'codex', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
    { name: 'deepseek-acme', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'working', cwd: null },
    { name: 'deepseek-acme-2', agent: 'claude', pane: 'w4:p1', workspace: 'w4', status: 'idle', cwd: null },
    { name: 'claude-acme-tmp-1', agent: 'claude', pane: 'w6:p1', workspace: 'w6', status: 'working', cwd: null },
  ],
  workspaceList: () => [],
  paneRead: (pane: string) => (pane === 'w6:p1' ? PERMISSION : ''),
  paneProcesses: () => null,
}));

const { realCheckSources, runTeamCheck } = await import('../src/check/team.ts');
const { verifiedOf } = await import('../src/approve/approval.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { testIo } = await import('./helpers.ts');

const NOW = new Date('2026-10-03T14:10:00Z');
const AT = '2026-10-03T14:06:00Z'; // four minutes before NOW

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-live-')));
const root = join(base, 'acme');
mkdirSync(join(root, '.agents'), { recursive: true });
const text = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
writeFileSync(join(root, '.agents', 'team.yaml'), text);
const checked = validateTeamFile(text);
if (!checked.ok) throw new Error('the example fixture does not validate');
const standing = verifiedOf(checked.team, text, root, NOW);
updateState(join(root, '.agents'), (state) => {
  const session = (state.sessions['acme-web'] ??= emptySession());
  session.watch = { pid: 1, heartbeat: '2026-10-03T14:09:00Z' };
  session.seats['claude-acme-tmp-1'] = {
    stage: 'ready',
    pane: 'w6:p1',
    workspace: 'w6',
    last_active: AT,
    temporary: { like: 'deepseek-acme', until: 'merged:fix/select-width' },
  };
});

const io = testIo(root, { kind: 'owner' });
const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
  // The real live read; the store, the branch and the clock are stood in.
  ...realCheckSources,
  branch: () => null,
  standing: () => standing,
  now: () => NOW,
  home: root,
});
console.log(JSON.stringify({ code, out: io.out, err: io.err }));
rmSync(base, { recursive: true, force: true });
