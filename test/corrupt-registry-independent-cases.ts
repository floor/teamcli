// Registry faults with a valid, owner-signed dev-mode-on file as the stale fallback trap.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runRestart } from '../src/commands/restart.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { runSwap } from '../src/commands/swap.ts';
import { readLaunchedTeam, teamPlace, writeTeamText } from '../src/file/team-text.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { readTeamPolicySource } from '../src/policy/sources.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readStoredTeamConfig, teamConfigRecordPath } from '../src/registry/team-config-store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './corrupt-registry-home-fixture.ts';
const NOW = new Date('2026-11-02T12:00:00.000Z'), SESSION = 'corrupt-scene';
const owned: string[] = [], restores: { mockRestore(): void }[] = [];
const restore = () => { for (const s of restores.splice(0).reverse()) s.mockRestore(); };
afterEach(() => { restore(); for (const p of owned.splice(0)) releaseIndependentFixture(p); });
test('faults run only after synthetic HOME startup', assertIndependentHome);
function snapshot(at: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (path: string, key: string) => {
    for (const e of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(path, e.name), k = key + '/' + e.name;
      if (e.isDirectory()) { out[k] = 'dir'; visit(p, k); }
      else if (e.isFile()) { const st = fs.lstatSync(p, { bigint: true }); out[k] = createHash('sha256').update(fs.readFileSync(p)).digest('hex') + ':' + String(st.ino) + ':' + String(st.mtimeNs); }
    }
  }; visit(at, ''); return out;
}
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'corrupt-registry-scene-'))); owned.push(base);
  const root = join(base, 'project'), dir = join(root, '.agents'), home = join(base, 'home'), file = join(dir, 'team.yaml');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv() });
  const text = `format: 1
project: corruption-fixture
session: ${SESSION}
operator: captain
workspace:
  mode: shared
seats:
  - name: captain
    role: orchestrator
    leads: true
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
  - name: worker
    role: worker
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`;
  fs.writeFileSync(file, text);
  expect(writeTeamText(file, text, { home, source: 'registry', create: true })).toEqual({ ok: true, target: 'registry' });
  const id = teamIdOf(root);
  upsertTeam(home, id, { root, project: 'corruption-fixture', session: SESSION, roster: [{ agent: 'agt_9f6482b31c70', seat: 'captain', role: 'orchestrator', leads: true }] });
  expect(writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW }).ok).toBe(true);
  const stale = readStoredTeamConfig(home, id)!; fs.writeFileSync(file, stale.text);
  expect(writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'off' }, { now: NOW }).ok).toBe(true);
  updateState(dir, state => { const s = state.sessions[SESSION] ??= emptySession(); s.seats.worker = { stage: 'ready', pane: 'owned-pane', workspace: 'owned-space', start_cwd: root }; });
  const record = teamConfigRecordPath(home, id);
  return { base, root, dir, home, file, record };
}
type World = ReturnType<typeof world>;
function harness(w: World) {
  const effects: string[] = [];
  const effect = (name: string) => (..._args: unknown[]) => { effects.push(name); return true; };
  const launch: any = new Proxy({ sleep: async () => {}, now: () => NOW, agentPanes: () => [], createWorkspace: (..._args: unknown[]) => { effects.push('create'); return { pane: 'new-pane', workspace: 'new-space' }; } }, { get(target, key: string) { return key in target ? (target as any)[key] : effect(key); } });
  const sources: any = { home: w.home, now: () => NOW, sessionState: () => 'running', sessionRunning: () => true, workspaces: () => [{ id: 'owned-space' }], agents: () => [{ name: 'worker', agent: 'codex', pane: 'owned-pane', workspace: 'owned-space', status: 'idle', cwd: w.root }], alive: () => true, screen: () => ({ kind: 'idle' }), screenText: () => '', status: () => 'idle', foreground: () => ['codex'], sleep: async () => {}, launch, upLaunch: launch, doctor: new Proxy({}, { get: (_t, key: string) => effect('doctor:' + key) }) };
  return { effects, sources };
}
type Fault = 'bad-json' | 'bad-digest' | 'eacces-folder';
function inject(w: World, fault: Fault) {
  if (fault === 'bad-json') { fs.writeFileSync(w.record, '{"format":1,"text":'); return; }
  if (fault === 'bad-digest') { const record = JSON.parse(fs.readFileSync(w.record, 'utf8')); record.text_sha256 = '0'.repeat(64); fs.writeFileSync(w.record, JSON.stringify(record)); return; }
  const folder = dirname(w.record), under = (value: unknown) => typeof value === 'string' && (resolve(value) === folder || resolve(value).startsWith(folder + '/'));
  const denied = (path: unknown): never => { throw Object.assign(new Error('EACCES: synthetic registry folder cannot be searched, ' + String(path)), { code: 'EACCES', path }); };
  const exists = fs.existsSync, read = fs.readFileSync, stat = fs.lstatSync, write = fs.writeFileSync;
  restores.push(spyOn(fs, 'existsSync').mockImplementation(path => under(path) ? false : exists(path)));
  restores.push(spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => under(args[0]) ? denied(args[0]) : Reflect.apply(read, fs, args)) as never));
  restores.push(spyOn(fs, 'lstatSync').mockImplementation(((...args: any[]) => under(args[0]) ? denied(args[0]) : Reflect.apply(stat, fs, args)) as never));
  restores.push(spyOn(fs, 'writeFileSync').mockImplementation(((...args: any[]) => under(args[0]) ? denied(args[0]) : Reflect.apply(write, fs, args)) as never));
}
async function command(w: World, action: string, sources: any) {
  const io = testIo(w.root, { kind: 'owner' });
  try {
    const code = action.startsWith('restart')
      ? await runRestart(['worker', ...(action.includes('file') ? ['--file', w.file] : []), ...(action.includes('dry') ? ['--dry-run'] : [])], io, sources)
      : action === 'policy' ? await runPolicy([], io, { home: w.home, now: NOW })
      : await runSwap(action === 'swap-run' ? ['--run'] : action === 'swap-queue' ? ['queue', 'worker', '--to', 'codex:fixture'] : [], io, { home: w.home, now: NOW, sources });
    return { code, text: io.out + io.err, thrown: false };
  } catch (error) { return { code: -1, text: String(error), thrown: true }; }
}
for (const fault of ['bad-json', 'bad-digest', 'eacces-folder'] as const) {
  for (const action of ['restart-file-live', 'restart-file-dry', 'restart-live', 'restart-dry', 'policy', 'swap-list', 'swap-queue', 'swap-run']) test(`${fault}: ${action} refuses plainly with no host or data rewrite`, async () => {
    const w = world(), h = harness(w); inject(w, fault);
    // Read the expected bytes only before a fault seam would hide them.
    restore(); const before = snapshot(w.base); if (fault === 'eacces-folder') inject(w, fault);
    const result = await command(w, action, h.sources); restore();
    expect(result.thrown, result.text).toBe(false); expect(result.code, result.text).toBe(2);
    expect(result.text.toLowerCase()).toContain('registry'); expect(result.text).not.toMatch(/\n\s+at |TeamConfigStoreError:|TypeError:/);
    expect(h.effects).toEqual([]); expect(snapshot(w.base)).toEqual(before);
  });
  test(`${fault}: the raw policy source refuses instead of enabling stale dev-mode`, () => {
    const w = world(); inject(w, fault); let result: any, thrown = false;
    try { result = readTeamPolicySource(w.home, w.root, null); } catch { thrown = true; }
    restore();
    const on = result?.ok === true && result.policies.some((p: any) => p.name === 'dev-mode' && p.value === 'on');
    expect({ thrown, ok: result?.ok, staleDevModeOn: on }).toEqual({ thrown: false, ok: false, staleDevModeOn: false });
    expect(result.why.toLowerCase()).toContain('registry');
  });
  test(`${fault}: a launched-team read refuses and never selects the stale file`, () => {
    const w = world(); inject(w, fault); let result: any, thrown = false;
    try { result = readLaunchedTeam(w.file, { home: w.home, source: 'registry' }); } catch { thrown = true; }
    restore(); expect({ thrown, ok: result?.ok }).toEqual({ thrown: false, ok: false });
    expect(JSON.stringify(result.errors).toLowerCase()).toContain('registry');
  });
  test(`${fault}: refusal wording still identifies the registry rather than throwing`, () => {
    const w = world(); inject(w, fault); let text = '', thrown = false;
    try { text = teamPlace(w.file, { home: w.home }); } catch { thrown = true; }
    restore(); expect({ thrown, text }).toEqual({ thrown: false, text: "the registry's record" });
  });
}
test('the healthy registry is off while its valid signed stale file is on', () => {
  const w = world(), healthy = readTeamPolicySource(w.home, w.root, null), file = readTeamConfig(w.root, { file: w.file, home: w.home, source: 'file' });
  expect(healthy.ok).toBe(true); if (!healthy.ok) throw Error(healthy.why);
  expect(healthy.policies.find(p => p.name === 'dev-mode')?.value).toBe('off');
  expect(file.ok).toBe(true); if (!file.ok) throw Error('stale trap must validate');
  const stale = readTeamPolicySource(w.home, w.root, file.team); expect(stale.ok).toBe(true);
  if (stale.ok) expect(stale.policies.find(p => p.name === 'dev-mode')?.value).toBe('on');
});
