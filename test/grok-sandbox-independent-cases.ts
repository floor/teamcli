// Plan and fake-host launch scenes; no Grok binary, real pane, or owner home is used.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step } from '../src/launch/plan.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { gitEnv } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './grok-sandbox-home-fixture.ts';
const owned: string[] = [];
const ambient = process.env.GROK_HOME;
afterEach(() => {
  if (ambient === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = ambient;
  for (const p of owned.splice(0)) releaseIndependentFixture(p);
});
test('sandbox scenes import the product only after synthetic HOME startup', assertIndependentHome);
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-scene-'))); owned.push(base);
  const home = join(base, 'home with "quote"'), root = join(base, 'project with space'), grok = join(home, '.grok');
  mkdirSync(join(home, '.config/team'), { recursive: true }); mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(grok);
  process.env.GROK_HOME = grok;
  return { base, home, root, grok, file: join(grok, 'sandbox.toml') };
}
type World = ReturnType<typeof world>;
function planned(w: World, command = 'grok', cli = 'grok') {
  const text = `format: 1
project: orbit
session: orbit-scene
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
  - name: scout
    role: worker
    cli: ${cli}
    vendor: fixture
    model: Fixture
    version: "1"
    launch: ${command}
`;
  const team = validateTeamFile(text, { root: w.root, home: w.home });
  if (!team.ok) throw new Error(team.errors.map(e => e.message).join('; '));
  const plan = upPlan({ root: w.root, home: w.home, team: team.team, session: 'orbit-scene', sessionRunning: true, watchAlive: true, watchLabel: 'synthetic watch', seats: [{ name: 'scout', cli, launch: command, cwd: w.root, label: 'scout', stopped: false, rules: 'fixture-rules', repairLine: 'synthetic repair' }] });
  const op = plan.find(step => step.do?.do === 'launch')?.do;
  if (op?.do !== 'launch') throw new Error('the plan must contain the synthetic seat launch');
  return op;
}
function parsed(w: World): any { return Bun.TOML.parse(readFileSync(w.file, 'utf8')); }
async function launch(w: World, command = 'grok') {
  const op = planned(w, command), runs: { command: string; argv: string[]; atRun: string | null }[] = [], said: string[] = [], recorded: unknown[] = [];
  const script = join(w.base, 'argv.py'), output = join(w.base, 'argv.json');
  writeFileSync(script, 'import json,sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))\n');
  const host: Host = {
    startServer: () => true, sessionUp: () => true, createWorkspace: () => ({ pane: 'owned-pane', workspace: 'owned-space' }),
    paneRun(_session, _pane, line) {
      const atRun = existsSync(w.file) ? readFileSync(w.file, 'utf8') : null;
      const code = `grok() { /usr/bin/python3 ${shellQuote(script)} ${shellQuote(output)} "$@"; }\n${line}`;
      execFileSync('/bin/sh', ['-c', code], { cwd: w.root, env: { ...gitEnv(), HOME: process.env.HOME } });
      runs.push({ command: line, argv: JSON.parse(readFileSync(output, 'utf8')), atRun }); return true;
    },
    typeLine: () => { throw new Error('unexpected terminal typing'); }, renameAgent: () => true,
    closeWorkspace: () => { throw new Error('unexpected workspace close'); }, stopSession: () => true,
    kill: () => { throw new Error('unexpected process signal'); }, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0,
    allow: () => null, record: () => {}, running: () => {}, drop: () => {}, say: text => { said.push(text); }, log: () => {},
    sessionStarted: (...args) => { recorded.push(args); },
  };
  const steps: Step[] = [{ kind: 'run', argv: [], do: { ...op, pane: 'owned-pane' } }, { kind: 'skip', text: 'scout ready', do: { do: 'ready', seat: 'scout', rules: 'option' } }];
  await executePlan(steps, 'orbit-scene', host);
  expect(runs).toHaveLength(1);
  return { op, run: runs[0]!, said: said.join(''), recorded };
}
function flag(argv: string[], name: string) { const pair = argv.indexOf(name); return pair < 0 ? argv.find(x => x.startsWith(name + '='))?.slice(name.length + 1) : argv[pair + 1]; }
function ownProfile(w: World) { return parsed(w).profiles['team-seat-orbit-scout']; }
function expectGrants(w: World) {
  const grants = ownProfile(w).read_write as string[];
  expect(ownProfile(w)).toMatchObject({
    extends: 'workspace',
    read_write: [
      realpathSync(w.root),
      join(w.root, '.agents', 'send-drops', 'orbit-scene', 'scout'),
      join(w.root, '.agents', 'messages', 'scout'),
      join(w.root, '.agents', 'seat-state', 'orbit-scene', 'scout.json'),
      join(w.root, '.agents', 'hooks', 'orbit-scene', 'scout.json'),
    ],
  });
  for (const wider of [realpathSync(join(w.home, '.config/team')), realpathSync(join(w.root, '.agents'))]) {
    expect(grants).not.toContain(wider);
  }
}
test('the dry plan writes nothing; the real launch writes the profile before its fake CLI runs', async () => {
  const w = world(), op = planned(w);
  expect(existsSync(w.file)).toBe(false);
  expect(op.command).toContain('--sandbox team-seat-orbit-scout');
  const out = await launch(w);
  expect(out.run.atRun).not.toBeNull(); expectGrants(w);
  expect(flag(out.run.argv, '--sandbox')).toBe('team-seat-orbit-scout');
  expect(statSync(w.file).mode & 0o777).toBe(0o600);
  expect(out.said).not.toContain('sandbox profile was not written');
});
test('the actual argv carries the measured unattended rules as whole arguments', async () => {
  const out = await launch(world());
  expect(out.run.argv).toContain('--trust'); expect(flag(out.run.argv, '--permission-mode')).toBe('auto');
  const rules = out.run.argv.flatMap((x, i) => x === '--allow' ? [out.run.argv[i + 1]] : []);
  expect(rules).toEqual(['Bash(bun *)', 'Bash(team *)', 'Bash(git *)']);
});
for (const command of ['grok --sandbox=personal', "grok --sandbox 'personal profile'"]) test(`a configured sandbox stays authoritative: ${command}`, async () => {
  const w = world(), original = '# owner config remains untouched\n'; writeFileSync(w.file, original);
  const out = await launch(w, command);
  expect(flag(out.run.argv, '--sandbox')).toBe(command.includes('=') ? 'personal' : 'personal profile');
  expect(readFileSync(w.file, 'utf8')).toBe(original);
  expect(out.said).not.toContain('sandbox profile was not written');
});
test('a multiline quoted profile is updated without losing neighboring fields, tables, or idempotence', async () => {
  const w = world();
  writeFileSync(w.file, `title = "kept"\n[profiles."team-seat-orbit-scout"]\nextends = "old"\nread_write = [\n  "/old", # retained bracket ] in comment\n  "/another[folder]",\n]\ncustom = "retain me"\n[profiles.personal]\nextends = "read-only"\nread_write = ["/personal"]\n`);
  const before = parsed(w); expect(before.profiles['team-seat-orbit-scout'].read_write).toHaveLength(2);
  await launch(w); expectGrants(w);
  const after = parsed(w); expect(after.title).toBe(before.title); expect(after.profiles.personal).toEqual(before.profiles.personal); expect(ownProfile(w).custom).toBe('retain me');
  const bytes = readFileSync(w.file), mtime = statSync(w.file, { bigint: true }).mtimeNs;
  await Bun.sleep(20); await launch(w);
  expect(readFileSync(w.file)).toEqual(bytes); expect(statSync(w.file, { bigint: true }).mtimeNs).toBe(mtime);
});
for (const header of ['[profiles.team-seat-orbit-scout] # keep this table comment', '[ profiles . "team-seat-orbit-scout" ]']) test(`a valid existing table header stays valid after update: ${header}`, async () => {
  const w = world(); writeFileSync(w.file, `${header}\nextends = "old"\nread_write = ["/old"]\ncustom = "kept"\n`);
  expect(ownProfile(w).custom).toBe('kept');
  await launch(w); expectGrants(w); expect(ownProfile(w).custom).toBe('kept');
});
for (const location of ['file', 'home', 'ancestor'] as const) test(`a link at the ${location} is never written through and the seat launches with one held report`, async () => {
  const w = world(), target = join(w.base, 'target'); mkdirSync(target);
  let sentinel: string;
  if (location === 'file') { sentinel = join(target, 'sandbox.toml'); writeFileSync(sentinel, '# untouched target\n'); symlinkSync(sentinel, w.file); }
  else if (location === 'home') { process.env.GROK_HOME = join(w.base, 'linked-home'); symlinkSync(target, process.env.GROK_HOME); sentinel = join(target, 'sandbox.toml'); }
  else { const real = join(target, 'nested'); mkdirSync(real); const linked = join(w.home, 'link'); symlinkSync(target, linked); process.env.GROK_HOME = join(linked, 'nested'); sentinel = join(real, 'sandbox.toml'); }
  const before = existsSync(sentinel) ? readFileSync(sentinel) : null;
  const out = await launch(w);
  expect(existsSync(sentinel) ? readFileSync(sentinel) : null).toEqual(before);
  expect(flag(out.run.argv, '--sandbox')).toBeUndefined();
  expect(out.said.match(/sandbox profile was not written/g)).toHaveLength(1);
  expect(out.said).toContain('launched without it');
  expect(JSON.stringify(out.recorded)).not.toContain('--sandbox team-seat-orbit-scout');
});
test('a regular file in the config-home position is reported and the appended flag is removed', async () => {
  const w = world(), blocked = join(w.base, 'blocked'); writeFileSync(blocked, 'keep exact bytes'); process.env.GROK_HOME = blocked;
  const out = await launch(w);
  expect(readFileSync(blocked, 'utf8')).toBe('keep exact bytes'); expect(flag(out.run.argv, '--sandbox')).toBeUndefined(); expect(out.said).toContain('launched without it');
});
test('fallback removes the appended option while preserving a prompt that quotes the same words', async () => {
  const w = world(), blocked = join(w.base, 'blocked'); writeFileSync(blocked, 'keep'); process.env.GROK_HOME = blocked;
  const prompt = 'preserve --sandbox team-seat-orbit-scout in this quoted prompt';
  const out = await launch(w, `grok -p ${shellQuote(prompt)}`);
  expect(out.run.argv[out.run.argv.indexOf('-p') + 1]).toBe(prompt);
  expect(flag(out.run.argv, '--sandbox')).toBeUndefined();
  expect(out.said).toContain('launched without it');
});
test('linked grant directories are named by their actual targets', async () => {
  const w = world(), actual = join(w.base, 'actual'); mkdirSync(actual);
  const linkedRoot = join(w.base, 'linked-project'); mkdirSync(linkedRoot); symlinkSync(actual, join(linkedRoot, '.agents'));
  const changed = { ...w, root: linkedRoot };
  await launch(changed);
  const grants = ownProfile(changed).read_write as string[];
  expect(grants).toContain(realpathSync(linkedRoot));
  for (const tail of ['send-drops/orbit-scene/scout', 'messages/scout', 'seat-state/orbit-scene/scout.json', 'hooks/orbit-scene/scout.json']) {
    expect(grants).toContain(join(realpathSync(actual), ...tail.split('/')));
  }
  expect(grants).not.toContain(realpathSync(join(w.home, '.config/team')));
  expect(grants).not.toContain(join(linkedRoot, '.agents'));
});
test('a non-Grok plan does not create or request a Grok profile', () => {
  const w = world(), op = planned(w, 'cursor-agent', 'cursor');
  expect(op.command).not.toContain('team-seat-orbit-scout'); expect(existsSync(w.file)).toBe(false);
});

test('a header-looking line inside a multiline string is preserved while the real profile is updated', async () => {
  const w = world();
  writeFileSync(w.file, 'notes = """\n[profiles.team-seat-orbit-scout]\nextends = "quoted prose"\nread_write = ["not a grant"]\n"""\n[profiles.team-seat-orbit-scout]\nextends = "old"\nread_write = ["/old"]\ncustom = "real table field"\n');
  const before = parsed(w);
  expect(before.notes).toContain('[profiles.team-seat-orbit-scout]');
  expect(before.profiles['team-seat-orbit-scout'].custom).toBe('real table field');
  await launch(w);
  const after = parsed(w);
  expect(after.notes).toBe(before.notes);
  expectGrants(w);
  expect(ownProfile(w).custom).toBe('real table field');
});
