// Real record writers and signed machine settings, entirely inside owned synthetic stores.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { runSettings } from '../src/commands/settings.ts';
import { readSeatConfigSource } from '../src/config/sources.ts';
import { readDevelopmentMode, writeDevelopmentMode } from '../src/development_mode.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { findAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { gitEnv, testIo } from './helpers.ts';
const NOW = new Date('2026-11-01T10:00:00Z');
const LEGACY = ['TEAMCLI', 'DEV', 'MODE'].join('_');
type Mode = 'off' | 'legacy' | 'machine-on' | 'machine-off';
type Actor = 'captain' | 'worker';
type Operation = 'config-set' | 'config-unset' | 'config-edit' | 'settings-set' | 'settings-unset';
const OPS: Operation[] = ['config-set', 'config-unset', 'config-edit', 'settings-set', 'settings-unset'];
const owned: string[] = [], drafts: string[] = [];
afterEach(() => {
  const paths = [...drafts.splice(0), ...owned.splice(0)].filter(p => fs.existsSync(p));
  if (paths.length) execFileSync('trash', paths);
});
function teamText() { return `format: 1
project: record-scene
session: records
operator: captain
workspace:
  mode: shared
rules:
  - original independent rule
seats:
  - role: orchestrator
    name: captain
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude
    # preserved declaration comment
    inbound: hold
`; }
async function world(mode: Mode, seedSetting = false) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dlw-'))); owned.push(base);
  const root = join(base, 'r'), home = join(base, 'h'), dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(dir, 'team.yaml'); fs.writeFileSync(file, teamText());
  updateState(dir, state => { const session = emptySession();
    session.seats.captain = { stage: 'ready', pane: 'synthetic-lead' };
    session.seats.worker = { stage: 'ready', pane: 'synthetic-worker' }; state.sessions.records = session; });
  keyOf(home);
  if (mode === 'machine-on' || mode === 'machine-off') {
    const seeded = writeDevelopmentMode({ home, mode: mode === 'machine-on' ? 'local-fast' : 'off', now: NOW, caller: 'synthetic-fixture' });
    expect(seeded.ok).toBe(true);
    expect(readDevelopmentMode(home).kind).toBe('set');
  } else expect(readDevelopmentMode(home).kind).toBe('absent');
  const env: Record<string, string> = { HOME: home, TEAM_CONFIG_SOURCE: 'file' };
  if (mode === 'legacy' || mode === 'machine-off') env[LEGACY] = '1';
  if (seedSetting) {
    const io = testIo(root, { kind: 'owner' }); io.env = { HOME: home, TEAM_CONFIG_SOURCE: 'file' };
    expect(await runSettings(['set', 'worker', 'nickname=OriginalWorker'], io, { home, now: NOW }), io.err).toBe(0);
  }
  return { base, root, home, dir, file, env, mode, editorCalls: [] as string[] };
}
type World = Awaited<ReturnType<typeof world>>;
function log(w: World) { const path = join(w.dir, 'team.log'); return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''; }
// Include byte identity and timestamps: rewriting identical state bytes still counts as a write.
function snapshot(w: World) {
  const result: Record<string, unknown> = {};
  const walk = (path: string): void => {
    const stat = fs.lstatSync(path, { bigint: true });
    result[path] = { kind: stat.isDirectory() ? 'dir' : 'file', ino: String(stat.ino), mode: String(stat.mode),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ...(stat.isFile() ? { bytes: fs.readFileSync(path).toString('base64') } : {}) };
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) walk(join(path, name));
  };
  walk(w.base);
  // Runtime compiler caches are outside the product's store; the global product store is watched too.
  const globalStore = join(homedir(), '.config', 'team');
  if (fs.existsSync(globalStore)) walk(globalStore); else result[globalStore] = { kind: 'missing' };
  return result;
}
function caller(actor: Actor) { return { kind: 'seat' as const, name: actor, pane: actor === 'captain' ? 'synthetic-lead' : 'synthetic-worker', session: 'records' }; }
function refusal(command: 'config' | 'settings', actor: Actor) {
  return command === 'config'
    ? `only the owner edits the team's record, from a terminal outside herdr; this call is ${actor}`
    : `only the owner sets a seat's settings, from a terminal outside herdr; this call is ${actor}`;
}
function warning(command: 'config' | 'settings', w: World) {
  return `warning: ${refusal(command, 'captain')}; dev mode continues${w.mode === 'machine-on' ? ' (dev-mode on at machine level)' : ''}\n`;
}
function argsFor(op: Operation): string[] {
  if (op === 'config-set') return ['set', 'seats.worker.inbound', 'accept'];
  if (op === 'config-unset') return ['unset', 'seats.worker.inbound'];
  if (op === 'config-edit') return ['edit'];
  if (op === 'settings-set') return ['set', 'worker', 'nickname=ChangedWorker'];
  return ['unset', 'worker', 'nickname'];
}
async function invoke(w: World, op: Operation, actor: Actor, json = false, override?: string[], editorMode: 'change' | 'same' | 'invalid' | 'abort' = 'change', displaced = false): Promise<{ code: number; io: ReturnType<typeof testIo>; command: 'config' | 'settings' }> {
  const who = caller(actor); if (displaced) who.pane = 'unrecorded-synthetic-pane';
  const io = testIo(w.root, who); io.env = w.env;
  const args = [...(override ?? argsFor(op)), ...(json ? ['--json'] : [])];
  const command = op.startsWith('config') ? 'config' : 'settings';
  const code = command === 'config'
    ? await runConfig(args, io, { home: w.home, env: w.env, now: () => NOW, present: false,
        editor: path => {
          w.editorCalls.push(path); drafts.push(dirname(path));
          expect(fs.realpathSync(path).startsWith(fs.realpathSync(tmpdir()) + '/')).toBe(true);
          if (editorMode === 'abort') return 7;
          if (editorMode !== 'same') fs.writeFileSync(path, editorMode === 'invalid' ? 'format: 88\n' : fs.readFileSync(path, 'utf8').replace('original independent rule', 'updated independent rule'));
          return 0;
        } })
    : await runSettings(args, io, { home: w.home, now: NOW });
  return { code, io, command };
}
function changed(w: World, op: Operation) {
  const text = fs.readFileSync(w.file, 'utf8'); const loaded = validateTeamFile(text); expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error('the real writer left invalid team text');
  expect(text).toContain('# preserved declaration comment');
  if (op === 'config-edit') { expect(loaded.team.rules).toContain('updated independent rule'); expect(w.editorCalls).toHaveLength(1); }
  else if (op.startsWith('config')) {
    expect(loaded.team.seats.find(s => s.name === 'worker')!.inbound).toBe(op === 'config-set' ? 'accept' : undefined);
  } else {
    const agent = findAgent(w.home, { team: teamIdOf(w.root), seat: 'worker' }); expect(agent).not.toBeNull();
    const source = readSeatConfigSource(w.home, agent?.id ?? null, 'worker'); expect(source.ok).toBe(true);
    expect(source.settings.filter(s => s.key === 'nickname').map(s => s.value)).toEqual(op === 'settings-set' ? ['ChangedWorker'] : []);
  }
}
test('the suite and all module defaults use the internally created HOME', () => { assertIndependentHome(); });
for (const op of OPS) for (const mode of ['off', 'legacy', 'machine-on', 'machine-off'] as const) for (const actor of ['captain', 'worker'] as const) {
  const forms = mode === 'off' && actor === 'captain' || mode === 'machine-on' ? [false, true] : [false];
  for (const json of forms) test(`${op}: ${mode}, ${actor}, json=${json}`, async () => {
    const w = await world(mode, op === 'settings-unset'); const before = snapshot(w); const previousLog = log(w);
    const run = await invoke(w, op, actor, json); const admitted = actor === 'captain' && (mode === 'legacy' || mode === 'machine-on');
    if (!admitted) {
      expect(run.code).toBe(1);
      if (json) { const output = JSON.parse(run.io.out); expect(output.error.id).toBe(`${run.command}.not-owner`); expect(output.error.message).toBe(refusal(run.command, actor)); expect(run.io.err).toBe(''); }
      else { expect(run.io.out).toBe(''); expect(run.io.err).toBe(`team ${run.command}: ${refusal(run.command, actor)}\n`); }
      expect(snapshot(w)).toEqual(before); expect(log(w)).toBe(previousLog); expect(w.editorCalls).toHaveLength(0);
    } else {
      expect(run.code, run.io.out + run.io.err).toBe(0); expect(run.io.err).toBe(warning(run.command, w));
      if (json) expect(JSON.parse(run.io.out).error).toBeUndefined();
      changed(w, op);
      const appended = log(w).slice(previousLog.length);
      expect(appended).toContain(`${run.command} [captain] ${warning(run.command, w).trim()}; admitted as orchestrator\n`);
      expect(appended.match(/admitted as orchestrator/g) ?? []).toHaveLength(1);
    }
  });
}
const effects: { name: string; op: Operation; args?: string[]; editor?: 'same' | 'invalid' | 'abort'; code: number; seed?: boolean }[] = [
  { name: 'config unknown seat', op: 'config-set', args: ['set', 'seats.absent.inbound', 'accept'], code: 1 },
  { name: 'config invalid CLI', op: 'config-set', args: ['set', 'seats.worker.cli', 'unmeasured-cli'], code: 1 },
  { name: 'config same value', op: 'config-set', args: ['set', 'seats.worker.inbound', 'hold'], code: 0 },
  { name: 'config absent value unset', op: 'config-unset', args: ['unset', 'seats.worker.nickname'], code: 0 },
  { name: 'editor unchanged', op: 'config-edit', editor: 'same', code: 0 },
  { name: 'editor invalid', op: 'config-edit', editor: 'invalid', code: 1 },
  { name: 'editor aborts', op: 'config-edit', editor: 'abort', code: 2 },
  { name: 'settings invalid key', op: 'settings-set', args: ['set', 'worker', 'unrecognized=1'], code: 2 },
  { name: 'settings invalid value', op: 'settings-set', args: ['set', 'worker', 'model=not-a-shipped-model'], code: 2 },
  { name: 'settings unknown seat', op: 'settings-set', args: ['set', 'absent', 'nickname=ChangedWorker'], code: 1 },
  { name: 'settings absent value unset', op: 'settings-unset', code: 1 },
  { name: 'settings set dry-run', op: 'settings-set', args: ['set', 'worker', 'nickname=ChangedWorker', '--dry-run'], code: 0 },
  { name: 'settings unset dry-run', op: 'settings-unset', args: ['unset', 'worker', 'nickname', '--dry-run'], code: 0, seed: true },
];
for (const effect of effects) for (const mode of ['legacy', 'machine-on'] as const) test(`${effect.name}: ${mode} leaves every record, state and audit unchanged`, async () => {
  const w = await world(mode, effect.seed); const before = snapshot(w); const previousLog = log(w);
  const run = await invoke(w, effect.op, 'captain', false, effect.args, effect.editor);
  expect(run.code, run.io.out + run.io.err).toBe(effect.code); expect(run.io.err).toContain(warning(run.command, w));
  expect(snapshot(w)).toEqual(before); expect(log(w)).toBe(previousLog);
});
for (const mode of ['legacy', 'machine-on'] as const) test(`settings --file cannot borrow the caller team's ${mode} lift for another record`, async () => {
  const w = await world(mode); const other = join(w.base, 'other', '.agents'); fs.mkdirSync(other, { recursive: true });
  const file = join(other, 'team.yaml'); fs.writeFileSync(file, teamText().replace('project: record-scene', 'project: other-record'));
  const before = snapshot(w); const run = await invoke(w, 'settings-set', 'captain', false, [...argsFor('settings-set'), '--file', file]);
  expect(run.code).toBe(1); expect(run.io.out).toBe(''); expect(run.io.err).toBe(`team settings: ${refusal('settings', 'captain')}\n`);
  expect(snapshot(w)).toEqual(before);
});
for (const op of ['config-set', 'settings-set'] as const) test(`${op}: a named lead on an unrecorded pane cannot take the lift`, async () => {
  const w = await world('machine-on'); const before = snapshot(w); const run = await invoke(w, op, 'captain', false, undefined, 'change', true);
  expect(run.code).toBe(1); expect(snapshot(w)).toEqual(before); expect(log(w)).toBe('');
});
