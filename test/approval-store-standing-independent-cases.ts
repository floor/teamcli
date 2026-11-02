// Approval history belongs to the project even when one of its files disappears.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { generationsFolder, keyFolder } from '../src/store/keys.ts';
import { approvalStanding, storePath, storesFolder, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './approval-store-home-fixture.ts';

const NOW = new Date('2026-11-01T20:00:00.000Z');
const owned: string[] = [];
function withMask<T>(body: () => T): T { const mask = process.umask(0); try { return body(); } finally { process.umask(mask); } }
function folder(path: string, mode = 0o700): void { withMask(() => mkdirSync(path, { recursive: true, mode })); }
afterEach(() => { for (const path of owned.splice(0)) releaseIndependentFixture(path); });
test('the suite creates its HOME before importing product modules', assertIndependentHome);
function world(signed = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'approval-independent-'))); owned.push(base);
  const root = join(base, 'checkout'), home = join(base, 'home'), dir = join(root, '.agents'), file = join(dir, 'team.yaml'), lobby = join(home, '.config/team/lobby');
  folder(dir); folder(lobby); folder(join(process.env.HOME!, '.config/team/lobby'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const yaml = `format: 1\nproject: approval-fixture\nsession: approval-session\noperator: captain\ntrust:\n  - ${root}\n  - ${lobby}\n  - ${join(process.env.HOME!, '.config/team/lobby')}\nworkspace:\n  mode: shared\nseats:\n  - name: captain\n    role: orchestrator\n    leads: true\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n`;
  writeFileSync(file, yaml); const parsed = readTeamConfig(root, { file, home }); if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const store = storePath(parsed.team.project, root, home), record = join(store, 'approval.json');
  if (signed) writeApproval(store, { approval: approvalOf(parsed.team, root, NOW), file: yaml }, parsed.team.seats, home, NOW);
  const generation = join(generationsFolder(home), createHash('sha256').update(root).digest('hex').slice(0,12) + '.json');
  return { base, root, home, file, yaml, store, record, generation };
}
type World = ReturnType<typeof world>;
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string): void { const stat = lstatSync(path); const key = relative(root, path); result[key] = stat.isDirectory() ? `dir:${stat.mode}` : `${stat.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`; if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child)); }
  walk(root); return result;
}
function refused(w: World): string { const read = approvalStanding(w.root, w.home); expect(read.kind).toBe('refused'); if (read.kind !== 'refused') throw new Error(`standing was ${read.kind}`); return read.why; }
function hold(w: World, path: string, name: string): string { const saved = join(w.base, name); renameSync(path, saved); return saved; }
for (const signed of [false, true]) test(`${signed ? 'signed' : 'virgin'} approval reads preserve all file bytes and directory modes`, () => {
  const w = world(signed), before = snapshot(w.home); const first = approvalStanding(w.root, w.home), second = approvalStanding(w.root, w.home);
  expect(first.kind).toBe(signed ? 'verified' : 'none'); expect(second).toEqual(first); expect(snapshot(w.home)).toEqual(before); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml);
});

async function up(w: World, dev: boolean) {
  let started = false, clock = NOW.getTime(); const launches: string[] = [], hostEffects: string[] = [];
  const agents = () => started ? [{ name: 'captain', agent: 'claude-code', pane: 'worker-pane', workspace: 'worker-space', status: 'idle', cwd: w.home }] : [];
  const sleep = async (ms: number) => { clock += ms; }, now = () => new Date(clock);
  const launch: Launch = { sessionState: () => 'absent', startServer: () => { hostEffects.push('server'); return true; }, sessionUp: () => true,
    createWorkspace: (_s, _cwd, label) => label.toLowerCase().includes('watch') ? { pane: 'watch-pane', workspace: 'watch-space' } : { pane: 'worker-pane', workspace: 'worker-space' },
    paneRun: (_s, pane, command) => { if (pane === 'worker-pane') { started = true; launches.push(command); } return true; }, renameAgent: () => true,
    closeWorkspace: () => { throw new Error('synthetic launch must become ready'); }, agentPanes: () => agents().map(a => a.pane), agents, paneText: () => CLAUDE_IDLE, foreground: () => ['claude'], agentStatus: () => 'idle', processInfo: () => ({ shell: 601, foreground: [602] }), now, sleep };
  const machine = () => ({ loadPerCore: 0.1, memoryFree: 80, diskFree: 1024 ** 4, swapTotal: 1024 ** 3, swapFree: 1024 ** 3, swapUsed: 0, pressure: 'normal' as const });
  const sources: UpSources = { home: w.home, sessionRunning: () => false, sessionState: () => 'absent', agents: () => [], alive: () => false, now, sleep, machine, launch,
    doctor: { home: w.home, version: () => '2.1.302', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now, machine } };
  const io = testIo(w.root, { kind: 'owner' }); if (dev) io.env[['TEAMCLI','DEV','MODE'].join('_')] = '1';
  const prior = process.env.TEAM_CONFIG_SOURCE; process.env.TEAM_CONFIG_SOURCE = 'file';
  try { return { code: await runUp([], io, sources), io, launches, hostEffects }; }
  finally { if (prior === undefined) delete process.env.TEAM_CONFIG_SOURCE; else process.env.TEAM_CONFIG_SOURCE = prior; }
}
for (const signed of [false,true]) for (const dev of [false,true]) test(`up admits a ${signed ? 'signed' : 'virgin'} team with development mode ${dev ? 'on' : 'off'}`, async () => {
  const w = world(signed), beforeRecord = signed ? readFileSync(w.record) : null, beforeGeneration = signed ? readFileSync(w.generation) : null;
  const result = await up(w, dev); expect(result.code, result.io.out + result.io.err).toBe(0); expect(result.launches).toHaveLength(1);
  if (!signed && dev) expect(result.io.out + result.io.err).toContain('has no approval record');
  if (signed) { expect(readFileSync(w.record)).toEqual(beforeRecord!); expect(readFileSync(w.generation)).toEqual(beforeGeneration!); }
  expect(approvalStanding(w.root, w.home).kind).toBe(signed ? 'verified' : 'none'); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml);
});

const damage = ['record-removed','store-removed','index-removed','refused-then-removed','generations-file','key-folder-file','generation-directory','generation-json','store-file','index-file'] as const;
for (const kind of damage) test(`approval history refuses ${kind} instead of becoming a virgin project`, () => {
  const w = world();
  switch(kind) {
    case 'record-removed': hold(w,w.record,'held-record'); break;
    case 'store-removed': hold(w,w.store,'held-store'); break;
    case 'index-removed': hold(w,storesFolder(w.home),'held-index'); break;
    case 'refused-then-removed': { const value = JSON.parse(readFileSync(w.record,'utf8')); value.signature = '00'.repeat(64); writeFileSync(w.record,JSON.stringify(value)); expect(approvalStanding(w.root,w.home).kind).toBe('refused'); hold(w,w.record,'held-record'); break; }
    case 'generations-file': hold(w,generationsFolder(w.home),'held-generations'); writeFileSync(generationsFolder(w.home),'wrong shape'); hold(w,w.store,'held-store'); break;
    case 'key-folder-file': hold(w,keyFolder(w.home),'held-key-folder'); writeFileSync(keyFolder(w.home),'wrong shape'); hold(w,w.store,'held-store'); break;
    case 'generation-directory': hold(w,w.generation,'held-generation'); folder(w.generation); break;
    case 'generation-json': writeFileSync(w.generation,'[]'); break;
    case 'store-file': hold(w,w.store,'held-store'); writeFileSync(w.store,'wrong shape'); break;
    case 'index-file': hold(w,storesFolder(w.home),'held-index'); writeFileSync(storesFolder(w.home),'wrong shape'); break;
  }
  const reason = refused(w); expect(reason.length).toBeGreaterThan(0); expect(readFileSync(w.file,'utf8')).toBe(w.yaml);
  if (kind === 'generations-file') expect(reason).toContain(generationsFolder(w.home));
  if (kind === 'key-folder-file') expect(reason).toContain(keyFolder(w.home));
  if (kind === 'generation-directory') expect(reason).toContain(w.generation);
});
function target(w: World, part: string): string { switch(part) { case 'record': return w.record; case 'store': return w.store; case 'index': return storesFolder(w.home); case 'generation': return w.generation; case 'generations': return generationsFolder(w.home); default:return keyFolder(w.home); } }
for (const part of ['record','store','index','generation','generations','key-folder']) test(`the ${part} path rejects an actual link to otherwise valid signed files`, () => {
  const w = world(), path = target(w,part), saved = hold(w,path,'held-link-target'); symlinkSync(saved,path);
  const reason = refused(w); expect(reason).toContain('link'); expect(reason).toContain(path); expect(lstatSync(path).isSymbolicLink()).toBe(true);
});
for (const part of ['record','index','generations']) test(`an actual access refusal at ${part} is reported without reading it as absent`, () => {
  expect(process.getuid?.()).not.toBe(0); const w = world(), path = target(w,part), saved = hold(w,path,'held-access-target');
  if (part === 'record') withMask(() => writeFileSync(path,readFileSync(saved),{mode:0})); else folder(path,0);
  expect(lstatSync(path).mode & 0o777).toBe(0); const reason = refused(w); expect(reason).toContain('cannot be read'); expect(reason).toContain(path);
});
// The brief requires a refusal to identify the path the owner must restore.
for (const part of ['record','store','generation-json']) test(`the ${part} refusal identifies the affected absolute path`, () => {
  const w = world(); const path = part === 'record' ? w.record : part === 'store' ? w.store : w.generation;
  if (part === 'generation-json') writeFileSync(path,'[]'); else hold(w,path,'held-diagnostic-target');
  expect(refused(w)).toContain(path);
});
