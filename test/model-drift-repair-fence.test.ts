// Author regressions for the two source counterexamples (lead, 2026-11-11 03:27Z).
// Synthetic registry, model frames and suspended reads only; no CLI, pane or hardware probe.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifiedOf } from '../src/approve/approval.ts';
import { runSend } from '../src/commands/send.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { agentsDir, findAgent, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { currentRunMemo } from '../src/run-memo.ts';
import { reportModelDrift } from '../src/send/model-drift.ts';
import type { Live } from '../src/status/compare.ts';
import { signedSeatModel } from '../src/status/statusline.ts';
import { unreadMachine } from '../src/watch/machine.ts';
import { wrapperPane } from './helpers.ts';
import { withHostedLoop } from './helpers/hosted-watch.ts';
import { fake, NOW, owner, quietNative, world } from './send-native-fixtures.ts';

const PANE = 'synthetic-pane';
const RECORDED = { model: 'GLM', version: '5.3' };
const DRIFT = { model: 'deepseek', version: 'v4.1' };
const CLI_SCREEN = '❯ \n────────────────\n  main · …/synthetic · Opus 5.5 · S: $1.2 · W: 12%\n';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const w = world(['drop']);
  cleanups.push(w.cleanup);
  const record = registerAgent(w.home, {
    name: 'synthetic lead', signing: { ...RECORDED, role: 'coordinator' }, lab: 'test',
    cli: 'claude-code', launcher: null, launch: 'claude-glm.sh',
    reach: { team: teamIdOf(w.root), seat: 'lead', session: 'acme', pane: PANE, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'synthetic fixture',
  });
  const loaded = readTeamConfig(w.root, { home: w.home, file: join(w.dir, 'team.yaml') });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const text = readFileSync(join(w.dir, 'team.yaml'), 'utf8');
  const episode = join(w.dir, 'model-drift', 'acme', 'lead.json');
  let notices = 0;
  const report = async (observed = DRIFT) => reportModelDrift({
    dir: w.dir, root: w.root, session: 'acme', seat: 'lead',
    drift: { recipient: record.id, recorded: RECORDED, observed }, lead: 'lead', leadId: record.id, now: NOW,
    send: async () => { notices += 1; return { ok: true, detail: 'synthetic notice accepted' }; },
  });
  const live = (screen: string): Live => ({
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: PANE, workspace: 'synthetic-window', status: 'idle', cwd: w.root }],
    workspaces: [{ id: 'synthetic-window', label: 'synthetic provider' }],
    screens: { [PANE]: screen }, processes: { [PANE]: { shell: 1, foreground: [2] } },
  });
  const sources = (frame: Live, patch: Partial<WatchSources> = {}): WatchSources => withHostedLoop({
    home: w.home, live: () => frame, machine: unreadMachine,
    standing: () => verifiedOf(loaded.team, text, w.root, NOW), readChecks: () => [],
    screen: () => frame.screens[PANE] ?? null, status: () => 'idle', foreground: () => ['claude'],
    processes: () => ({ shell: 1, foreground: [2] }), typeText: () => false, pressEnter: () => false,
    sleep: async () => {}, notify: () => {}, now: () => NOW, wait: async () => false,
    alive: () => false, pid: process.pid, ...patch,
  });
  const watch = (frame: Live, patch: Partial<WatchSources> = {}) =>
    runWatch(['--file', join(w.dir, 'team.yaml'), '--no-nudge', '--no-notify'], owner(w.root), sources(frame, patch));
  return { w, record, episode, report, live, watch, notices: () => notices };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('missing and ambiguous wrapper banners do not repair an episode or repeat its notice', async () => {
  const f = fixture();
  await f.report();
  const original = JSON.parse(readFileSync(f.episode, 'utf8')).id;
  const ambiguous = wrapperPane('glm-5.3') + wrapperPane('deepseek-v4.1') + CLI_SCREEN;
  for (const screen of [CLI_SCREEN, ambiguous]) {
    // Preserve the legacy display fallback, but never treat it as positive repair evidence.
    expect(signedSeatModel({ cli: 'claude-code', ...RECORDED, launch: 'claude-glm.sh' }, screen)).toEqual(RECORDED);
    const host = fake(f.w, {
      agents: () => [{ name: 'lead', pane: PANE, cli: 'claude' }],
      native: { ...quietNative(), paneText: () => screen },
    });
    await runSend(['lead', 'synthetic body'], owner(f.w.root), host);
    expect(existsSync(f.episode)).toBe(true);
    await f.watch(f.live(screen));
    expect(existsSync(f.episode)).toBe(true);
    expect(JSON.parse(readFileSync(f.episode, 'utf8')).id).toBe(original);
    await f.report();
    expect(f.notices()).toBe(1);
  }
});

test('a positive provider match ends the captured episode and allows the next drift notice', async () => {
  const f = fixture();
  await f.report();
  await f.watch(f.live(wrapperPane('glm-5.3') + CLI_SCREEN));
  expect(existsSync(f.episode)).toBe(false);
  await f.report();
  expect(f.notices()).toBe(2);
});

for (const sameEpisode of [false, true]) {
  test(`a suspended watch cannot clear a newer ${sameEpisode ? 'observation in the same episode' : 'drift episode'}`, async () => {
    const f = fixture();
    await f.report();
    const entered = deferred<void>();
    const resume = deferred<{ live: Live; next: number; cut: boolean }>();
    const pass = f.watch(f.live(wrapperPane('glm-5.3') + CLI_SCREEN), {
      liveAsync: async () => { entered.resolve(); return resume.promise; },
    });
    await Promise.race([entered.promise, pass.then(() => { throw new Error('watch exited before its suspended live read'); })]);
    // All fixture clocks stay equal: the fence must not rely on clock precision or ordering.
    const newer = sameEpisode ? DRIFT : { model: 'kimi', version: '2.5' };
    await f.report(newer);
    const id = JSON.parse(readFileSync(f.episode, 'utf8')).id;
    resume.resolve({ live: f.live(wrapperPane('glm-5.3') + CLI_SCREEN), next: 0, cut: false });
    await pass;
    expect(existsSync(f.episode)).toBe(true);
    expect(JSON.parse(readFileSync(f.episode, 'utf8')).id).toBe(id);
    const before = f.notices();
    await f.report(newer);
    expect(f.notices()).toBe(before);
  });
}

test('a family-only provider banner does not prove repair of version drift', async () => {
  const f = fixture();
  const observed = { model: 'GLM', version: '5.4' };
  await f.report(observed);
  const id = JSON.parse(readFileSync(f.episode, 'utf8')).id;
  const screen = wrapperPane('glm') + CLI_SCREEN;
  // The legacy display borrows the declaration's version; that field was never observed.
  expect(signedSeatModel({ cli: 'claude-code', ...RECORDED, launch: 'claude-glm.sh' }, screen)).toEqual(RECORDED);
  await runSend(['lead', 'synthetic body'], owner(f.w.root), fake(f.w, {
    agents: () => [{ name: 'lead', pane: PANE, cli: 'claude' }],
    native: { ...quietNative(), paneText: () => screen },
  }));
  expect(existsSync(f.episode)).toBe(true);
  await f.watch(f.live(screen));
  expect(existsSync(f.episode)).toBe(true);
  expect(JSON.parse(readFileSync(f.episode, 'utf8')).id).toBe(id);
  await f.report(observed);
  expect(f.notices()).toBe(1);
});

test('a registry binding replaced by an external atomic writer defeats a memoized repair clear', async () => {
  const f = fixture();
  await f.report();
  const file = join(agentsDir(f.w.home), `${f.record.id}.yaml`);
  const original = readFileSync(file, 'utf8');
  updateAgent(f.w.home, f.record.id, { reach: { pane: 'synthetic-pane-new' } });
  const next = readFileSync(file, 'utf8');
  const restore = `${file}.synthetic-restore`;
  writeFileSync(restore, original);
  renameSync(restore, file);
  let rewritten = false;
  const host = fake(f.w, {
    agents: () => [{ name: 'lead', pane: PANE, cli: 'claude' }],
    native: { ...quietNative(), paneText: () => {
      if (!rewritten) {
        expect(currentRunMemo()?.agents.get(f.w.home)?.find((agent) => agent.id === f.record.id)?.reach.pane).toBe(PANE);
        // A separate repository-owned process publishes a valid prebuilt record atomically;
        // it cannot invalidate this send's normal in-process registry memo.
        const writer = spawnSync(process.execPath, [join(import.meta.dir, 'helpers', 'model-drift-registry-writer.ts'), file, next],
          { cwd: join(import.meta.dir, '..'), encoding: 'utf8' });
        expect(writer.status, writer.stderr).toBe(0);
        expect(readFileSync(file, 'utf8')).toBe(next);
        expect(findAgent(f.w.home, { team: teamIdOf(f.w.root), seat: 'lead' })?.reach.pane).toBe(PANE);
        rewritten = true;
      }
      return wrapperPane('glm-5.3') + CLI_SCREEN;
    } },
  });
  await runSend(['lead', 'synthetic body'], owner(f.w.root), host);
  expect(rewritten).toBe(true);
  expect(existsSync(f.episode)).toBe(true);
  const before = f.notices();
  await f.report();
  expect(f.notices()).toBe(before);
});
