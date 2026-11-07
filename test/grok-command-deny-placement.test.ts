import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { grokCommandDenyLine, grokCommandDenyNotes, grokCommandDenyPolicy, writeCursorCommandDeny } from '../src/launch/grok-command-deny.ts';
import { upPlan, type UpSeat } from '../src/launch/plan.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { cliWordList } from '../src/profiles/profile.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { getRelativeDirOps } from '../src/send/drop-retention.ts';
import { cursorCommandDenyConfig, grokCommandDenyArgs, type GrokCommandDeny } from '../src/settings/grok-command-deny.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { OwnStartFolderInput } from '../src/worktree/place.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const made: string[] = [];
afterEach(() => { const held = made.splice(0); discardFixtures(held, { roots: held.map(dirname) }); });
const NOW = new Date('2026-11-06T21:00:00Z');

function world() {
  const base = fixtureBase('grok-deny-placement-'); made.push(base);
  const home = join(base, 'home'), root = join(base, 'project'), cwd = join(root, 'worker'), peer = join(base, 'peer'), lobby = join(base, 'lobby');
  for (const folder of [home, root, cwd, peer, lobby]) mkdirSync(folder);
  const place: OwnStartFolderInput = { cli: 'cursor', seat: 'worker', cwd, root, home, lobby, peers: [{ name: 'peer', cli: 'cursor', cwd: peer }] };
  const config = join(cwd, '.cursor', 'cli.json');
  return { base, home, root, cwd, peer, lobby, place, config };
}

test('placement merges and verifies only the seat file, repairs drift on the next launch, and is idempotent', () => {
  const w = world(); mkdirSync(dirname(w.config));
  const original = { editor: { vimMode: true }, permissions: { allow: ['Shell(git)'], deny: ['Read(.env*)'] } };
  writeFileSync(w.config, JSON.stringify(original));
  const peerFile = join(w.peer, '.cursor', 'cli.json'); mkdirSync(dirname(peerFile)); writeFileSync(peerFile, '{peer bytes}');
  expect(writeCursorCommandDeny('git-and-tests', w.place)).toEqual({ ok: true });
  const expected = cursorCommandDenyConfig('git-and-tests', original);
  expect(JSON.parse(readFileSync(w.config, 'utf8'))).toEqual(expected);
  expect(statSync(w.config).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(w.config, 'utf8');
  expect(writeCursorCommandDeny('git-and-tests', w.place)).toEqual({ ok: true });
  expect(readFileSync(w.config, 'utf8')).toBe(bytes);
  writeFileSync(w.config, JSON.stringify(original));
  expect(grokCommandDenyNotes('git-and-tests', [{ name: 'worker', cli: 'cursor', model: 'Grok' }], { worker: { start_cwd: w.cwd } })).toHaveLength(1);
  expect(writeCursorCommandDeny('git-and-tests', w.place)).toEqual({ ok: true });
  expect(grokCommandDenyNotes('git-and-tests', [{ name: 'worker', cli: 'cursor', model: 'Grok' }], { worker: { start_cwd: w.cwd } })).toEqual([]);
  expect(readFileSync(peerFile, 'utf8')).toBe('{peer bytes}');
  expect(existsSync(join(w.root, '.cursor'))).toBe(false);
  expect(existsSync(join(w.home, '.cursor'))).toBe(false);
});

test('off touches no path, even an unavailable or invalid placement', () => {
  const w = world();
  expect(writeCursorCommandDeny('off', { ...w.place, cwd: join(w.base, 'absent') }, null)).toEqual({ ok: true });
  expect(existsSync(dirname(w.config))).toBe(false);
});

for (const kind of ['malformed', 'oversized', 'leaf-link', 'parent-link', 'directory', 'hard-link'] as const) {
  test(`placement refuses ${kind} without changing its prior bytes or link target`, () => {
    const w = world(); mkdirSync(dirname(w.config));
    const other = join(w.base, 'outside.json'); writeFileSync(other, '{outside bytes}');
    if (kind === 'malformed') writeFileSync(w.config, 'cfg-marker-4c82');
    if (kind === 'oversized') writeFileSync(w.config, JSON.stringify({ padding: 'x'.repeat(64 * 1024) }));
    if (kind === 'leaf-link') symlinkSync(other, w.config);
    if (kind === 'hard-link') linkSync(other, w.config);
    if (kind === 'directory') mkdirSync(w.config);
    if (kind === 'parent-link') { renameSync(dirname(w.config), join(w.base, 'cursor-held')); symlinkSync(w.peer, dirname(w.config)); }
    const before = kind === 'directory' || kind === 'parent-link' ? null : readFileSync(w.config, 'utf8');
    const result = writeCursorCommandDeny('git', w.place);
    expect(result.ok).toBe(false);
    if (kind === 'malformed') {
      expect(result).toEqual({ ok: false, why: 'the seat config is not valid JSON; it was left unchanged' });
      expect(JSON.stringify(result)).not.toContain('cfg-marker-4c82');
    }
    if (before !== null) expect(readFileSync(w.config, 'utf8')).toBe(before);
    expect(readFileSync(other, 'utf8')).toBe('{outside bytes}');
    expect(existsSync(join(w.peer, 'cli.json'))).toBe(false);
  });
}

test('a shared or peer start and unavailable relative operations are refused before any file is made', () => {
  const w = world();
  for (const cwd of [w.root, w.lobby, w.peer]) expect(writeCursorCommandDeny('git', { ...w.place, cwd }).ok).toBe(false);
  expect(writeCursorCommandDeny('git', w.place, null).ok).toBe(false);
  expect(existsSync(dirname(w.config))).toBe(false);
});

test('a parent swapped after opening cannot redirect the write to another seat', () => {
  const w = world(); mkdirSync(dirname(w.config));
  const ops = getRelativeDirOps(); if (!ops) throw new Error('the synthetic writer requires the relative adapter');
  let swapped = false;
  const result = writeCursorCommandDeny('git', w.place, { ...ops, openat: (...args) => {
    const got = ops.openat(...args);
    if (args[1] === '.cursor' && got.fd >= 0 && !swapped) {
      swapped = true; renameSync(dirname(w.config), join(w.base, 'held-cursor')); symlinkSync(w.peer, dirname(w.config));
    }
    return got;
  } });
  expect(swapped).toBe(true);
  expect(result.ok).toBe(false);
  expect(existsSync(join(w.peer, 'cli.json'))).toBe(false);
});

test('a failed publish retains the original file and removes its own temporary', () => {
  const w = world(); mkdirSync(dirname(w.config)); writeFileSync(w.config, '{}');
  const ops = getRelativeDirOps(); if (!ops) throw new Error('the synthetic writer requires the relative adapter');
  expect(writeCursorCommandDeny('git', w.place, { ...ops, renameatReplace: () => ({ ok: false, errno: 1 }) }).ok).toBe(false);
  expect(readFileSync(w.config, 'utf8')).toBe('{}');
  expect(readdirSync(dirname(w.config))).toEqual(['cli.json']);
});

test('a file loosened immediately after publication fails read-back verification', () => {
  const w = world();
  const ops = getRelativeDirOps(); if (!ops) throw new Error('the synthetic writer requires the relative adapter');
  const result = writeCursorCommandDeny('git', w.place, { ...ops, renameatReplace: (...args) => {
    const wrote = ops.renameatReplace(...args); if (wrote.ok) writeFileSync(w.config, '{}'); return wrote;
  } });
  expect(result.ok).toBe(false);
});

test('native deny argv is inserted before the delimiter and never taken from prompt text', () => {
  for (const line of ['grok --model Grok -- prompt', "sh -lc 'grok --model Grok -- prompt'"]) {
    const got = grokCommandDenyLine('git-and-tests', line);
    expect(got.ok).toBe(true); if (!got.ok) continue;
    const words = cliWordList('grok', got.line)!;
    for (const rule of grokCommandDenyArgs('git-and-tests').filter(x => x !== '--deny')) {
      expect(words).toContain(rule);
      expect(words[words.indexOf(rule) - 1]).toBe('--deny');
      expect(words.indexOf(rule)).toBeLessThan(words.indexOf('--'));
    }
    expect(grokCommandDenyLine('git-and-tests', got.line)).toEqual(got);
  }
  const prompt = "grok --rules 'quoted --deny Bash(git)'";
  const got = grokCommandDenyLine('git', prompt); expect(got.ok).toBe(true);
  if (got.ok) expect(grokCommandDenyNotes('git', [{ name: 'native', cli: 'grok', model: 'Grok' }], { native: { launch_line: got.line } })).toEqual([]);
  expect(grokCommandDenyLine('git', 'unreadable-wrapper script.sh').ok).toBe(false);
  expect(grokCommandDenyLine('off', 'unreadable-wrapper script.sh')).toEqual({ ok: true, line: 'unreadable-wrapper script.sh' });
  for (const option of ['-p', '--single', '--system-prompt-override', '--append-system-prompt']) {
    expect(grokCommandDenyLine('git', `grok ${option} --deny 'Bash(git)' --deny 'Bash(git *)'`).ok).toBe(false);
  }
  expect(grokCommandDenyLine('git', 'grok --future-option value').ok).toBe(false);
});

function signed(w: ReturnType<typeof world>, cli: 'cursor' | 'grok', mode: GrokCommandDeny | 'unset' = 'git-and-tests', model = 'Grok') {
  mkdirSync(join(w.root, '.agents')); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: w.root, env: gitEnv() });
  const text = `format: 1\nproject: acme\nsession: morning\ncoordinator: captain\noperator: captain\nworkspace:\n  mode: shared\nseats:\n  - name: captain\n    role: coordinator\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n    human: true\n  - name: worker\n    role: implementer\n    cli: ${cli}\n    vendor: test\n    model: ${model}\n    version: "4.7"\n    launch: ${cli === 'grok' ? 'grok' : 'cursor-agent'}\n    cwd: worker\n`;
  const file = join(w.root, '.agents', 'team.yaml'); writeFileSync(file, text);
  const checked = validateTeamFile(text, { home: w.home, root: w.root }); if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', w.root, w.home), { approval: approvalOf(checked.team, w.root, NOW), file: text }, checked.team.seats, w.home, NOW);
  if (mode !== 'unset') {
    const wrote = writePolicySet(w.home, { level: 'team', target: teamIdOf(w.root), teamRoot: w.root, name: 'grok-command-deny', value: mode }, { now: NOW });
    if (!wrote.ok) throw new Error(wrote.why);
  }
  const loaded = readTeamConfig(w.root, { home: w.home, source: 'file' }); if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { team: loaded.team, file };
}

test('only a verified team declaration can govern placement', () => {
  const w = world(), s = signed(w, 'cursor');
  expect(grokCommandDenyPolicy(w.home, w.root, s.team)).toEqual({ ok: true, value: 'git-and-tests' });
  const policies = s.team.policies;
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) throw new Error('the signed fixture has no policy map');
  const entry = policies['grok-command-deny'];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('the signed fixture has no deny declaration');
  const tampered = { ...s.team, policies: { ...policies, 'grok-command-deny': { ...entry, value: 'off' } } };
  expect(grokCommandDenyPolicy(w.home, w.root, tampered).ok).toBe(false);
  const plan = upPlan({ root: w.root, home: w.home, team: tampered, session: 'morning', sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [{ name: 'worker', cli: 'cursor', model: 'Grok', launch: 'cursor-agent', cwd: w.cwd, label: 'worker', stopped: false, rules: 'Rules.', repairLine: 'repair' }] });
  expect(plan.some(step => step.do?.do === 'refuse')).toBe(true);
  expect(plan.some(step => step.do?.do === 'launch')).toBe(false);
  expect(existsSync(w.config)).toBe(false);
});

for (const [mode, model] of [['off', 'Grok'], ['git-and-tests', 'Other Model']] as const) {
  test(`${mode} with ${model} starts without a Cursor deny-file operation`, () => {
    const w = world(), s = signed(w, 'cursor', mode, model);
    const plan = upPlan({ root: w.root, home: w.home, team: s.team, session: 'morning', sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [{ name: 'worker', cli: 'cursor', model, launch: 'cursor-agent', cwd: w.cwd, label: 'worker', stopped: false, rules: 'Rules.', repairLine: 'repair' }] });
    const launch = plan.find(step => step.do?.do === 'launch')?.do;
    expect(launch?.do).toBe('launch');
    if (launch?.do === 'launch') expect(launch.cursorCommandDeny).toBeUndefined();
    expect(existsSync(w.config)).toBe(false);
  });
}

for (const cli of ['cursor', 'grok'] as const) {
  test(`${cli} plan and execution apply the policy before starting, and reapply after drift`, async () => {
    const w = world(), s = signed(w, cli);
    const seat: UpSeat = { name: 'worker', cli, model: 'Grok', launch: cli === 'grok' ? 'grok' : 'cursor-agent', cwd: w.cwd, label: 'worker', stopped: false, rules: 'Rules.', repairLine: 'repair' };
    const plan = upPlan({ root: w.root, home: w.home, team: s.team, teamFile: s.file, session: 'morning', sessionRunning: true, watchAlive: true, watchLabel: 'Watch', seats: [seat] });
    const launch = plan.find(step => step.do?.do === 'launch')?.do;
    expect(launch?.do).toBe('launch');
    if (launch?.do !== 'launch') return;
    if (cli === 'grok') {
      expect(grokCommandDenyNotes('git-and-tests', [{ name: 'worker', cli, model: 'Grok' }], { worker: { launch_line: launch.command } })).toEqual([]);
      expect(grokCommandDenyNotes('git-and-tests', [{ name: 'worker', cli, model: 'Grok' }], { worker: { launch_line: launch.recordLine } })).toEqual([]);
      return;
    }
    const checks: boolean[] = [];
    const host: Host = {
      startServer: () => true, sessionUp: () => true, createWorkspace: () => ({ pane: 'deny-worker-pane', workspace: 'deny-worker-space' }),
      paneRun: () => { checks.push(existsSync(w.config) && grokCommandDenyNotes('git-and-tests', [{ name: 'worker', cli, model: 'Grok' }], { worker: { start_cwd: w.cwd } }).length === 0); return true; },
      typeLine: () => false, deliverRules: async () => true, renameAgent: () => true, closeWorkspace: () => true,
      stopSession: () => true, kill: () => true, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0,
      allow: () => null, record: () => {}, running: () => {}, drop: () => {}, say: () => {}, log: () => {},
    };
    await executePlan(plan, 'morning', host); expect(checks).toEqual([true]);
    writeFileSync(w.config, '{}'); await executePlan(plan, 'morning', host); expect(checks).toEqual([true, true]);
    writeFileSync(w.config, '{broken');
    const refused = await executePlan(plan, 'morning', host);
    expect(checks).toEqual([true, true]);
    expect(refused.dropped).toContain('worker');
    expect(readFileSync(w.config, 'utf8')).toBe('{broken');
  });
}

// Run the actual source under plain Node, without inherited runtime options or CLI homes.
function plainNodeLaunch(mode: GrokCommandDeny | 'unset') {
  const w = world(); signed(w, 'cursor', mode);
  mkdirSync(dirname(w.config));
  const bytes = JSON.stringify({ editor: 'kept', permissions: { deny: ['Shell(rm)'] } });
  writeFileSync(w.config, bytes);
  const script = join(w.base, 'plain-node-launch.mjs');
  const imports = [
    ['readTeamConfig', '../src/file/team-config.ts'],
    ['upPlan', '../src/launch/plan.ts'],
    ['executePlan', '../src/launch/execute.ts'],
    ['getRelativeDirOps', '../src/send/drop-retention.ts'],
  ].map(([name, path]) => `import { ${name} } from ${JSON.stringify(new URL(path!, import.meta.url).href)};`).join('\n');
  writeFileSync(script, `${imports}
const {root,home,cwd}=JSON.parse(process.argv[2]);
const loaded=readTeamConfig(root,{home,source:'file'});
if(!loaded.ok) throw new Error('synthetic team did not load');
const input={root,home,team:loaded.team,session:'morning',sessionRunning:true,watchAlive:true,watchLabel:'Watch',seats:[{name:'worker',cli:'cursor',model:'Grok',launch:'cursor-agent',cwd,label:'worker',stopped:false,rules:'Rules.',repairLine:'repair'}]};
const plan=upPlan(input);
const launch=plan.find(step=>step.do?.do==='launch')?.do;
const baseline=upPlan({...input,team:undefined}).find(step=>step.do?.do==='launch')?.do;
const commands=[],said=[];
const host={startServer:()=>true,sessionUp:()=>true,createWorkspace:()=>({pane:'plain-node-pane',workspace:'plain-node-space'}),paneRun:(_session,_pane,command)=>{commands.push(command);return true;},typeLine:()=>false,deliverRules:async()=>true,renameAgent:()=>true,closeWorkspace:()=>true,stopSession:()=>true,kill:()=>true,agentPanes:()=>[],foreground:()=>['cursor-agent'],classify:()=>'idle',sleep:async()=>{},now:()=>0,allow:()=>null,record:()=>{},running:()=>{},drop:()=>{},say:line=>said.push(line),log:()=>{}};
const executed=await executePlan(plan,'morning',host);
console.log(JSON.stringify({runtime:process.release.name,execArgv:process.execArgv,relativeAvailable:getRelativeDirOps()!==null,commands,said,dropped:executed.dropped,marker:launch?.cursorCommandDeny??null,command:launch?.command,baseline:baseline?.command,recordLine:launch?.recordLine,baselineRecord:baseline?.recordLine}));
`);
  const output = execFileSync('node', [script, JSON.stringify({ root: w.root, home: w.home, cwd: w.cwd })], {
    cwd: w.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: w.home, USERPROFILE: w.home, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  });
  return { result: JSON.parse(output) as { runtime: string; execArgv: string[]; relativeAvailable: boolean; commands: string[]; said: string[]; dropped: string[]; marker: string | null; command: string; baseline: string; recordLine: string; baselineRecord: string }, bytes, after: readFileSync(w.config, 'utf8') };
}

for (const mode of ['unset', 'off'] as const) {
  test(`plain Node launches Cursor with policy ${mode} exactly as the existing launch`, () => {
    const { result, bytes, after } = plainNodeLaunch(mode);
    expect(result.runtime).toBe('node');
    expect(result.execArgv).toEqual([]);
    expect(result.relativeAvailable).toBe(false);
    expect(result.marker).toBeNull();
    expect(result.command).toBe(result.baseline);
    expect(result.recordLine).toBe(result.baselineRecord);
    expect(result.commands).toEqual([result.baseline]);
    expect(result.dropped, JSON.stringify(result)).toEqual([]);
    expect(after).toBe(bytes);
  });
}

test('plain Node refuses enabled Cursor placement with the reason and runtime repair in one line', () => {
  const { result, bytes, after } = plainNodeLaunch('git');
  expect(result.runtime).toBe('node');
  expect(result.execArgv).toEqual([]);
  expect(result.relativeAvailable).toBe(false);
  expect(result.marker).toBe('git');
  expect(result.commands).toEqual([]);
  expect(result.dropped).toContain('worker');
  expect(after).toBe(bytes);
  const refusal = result.said.find(line => line.includes('relative file operations are unavailable'));
  expect(refusal).toContain('run team on Bun or Node with --experimental-ffi');
  expect(refusal?.trimEnd()).not.toContain('\n');
});
