import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSwap, type SwapCommandOptions } from '../src/commands/swap.ts';
import type { PerformInput } from '../src/commands/restart.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { validateDefinition } from '../src/launchers/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { SWAP_OUTPUT_SCHEMA } from '../src/output/index.ts';

const bases: string[] = [];
afterEach(() => { const paths = bases.splice(0); discardFixtures(paths, { roots: paths.map(dirname) }); }, 20_000);
const NOW = new Date('2026-11-08T09:00:00Z');
function world() {
  const base = fixtureBase('swap-preset-'); bases.push(base);
  const root = join(base, 'team'), home = join(base, 'home'), dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true }); mkdirSync(home);
  // Explicit file source in the synthetic home; reads and writes both use this choice.
  mkdirSync(join(home, '.config/team'), { recursive: true });
  writeFileSync(join(home, '.config/team/settings.yaml'), 'team-config.source: file\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root, env: gitEnv() });
  const path = join(dir, 'team.yaml');
  writeFileSync(path, `format: 1
project: example
session: example-session
entity: example-lab
coordinator: lead
operator: operator
trust:
  - ${root}
  - ${join(base, 'trees')}
  - ~/.config/team/lobbies/example-lab
workspace:
  mode: worktree
  path: ../trees/{task}
  branch: '{kind}/{task}'
  base: main
  limit: 2
  protected: ['.']
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: '5.5'
    launch: claude --model claude-opus-5-5
  - role: operator
    name: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: '5.5'
    launch: claude --model claude-opus-5-5
  - role: builder
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: '6.1'
    launch: codex -m gpt-6.1-sol
  - role: reviewer
    name: claude-preset
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: '5.5'
    launch: claude --model claude-opus-5-5
  - role: reviewer
    name: glm-preset
    cli: claude-code
    vendor: zai
    model: GLM
    version: '5.3'
    display: GLM 5.3
    launch: claude --model glm-5.3
`);
  const launchers = join(dir, 'launchers'); mkdirSync(launchers);
  writeFileSync(join(launchers, 'grok-preset.yaml'), `format: 1
name: grok-preset
kind: preset
harness: grok
args: [--model, grok-4.7]
writable_folders: [{path: '{root}'}]
seat: {vendor: xai, model: Grok, version: '4.7', display: Grok 4.7}
`);
  updateState(dir, s => { const one = s.sessions['example-session'] = emptySession(); one.seats.operator = { pane: 'pane-operator', stage: 'ready' }; });
  expect(readTeamConfig(root, { home })).toMatchObject({ ok: true });
  const calls: PerformInput[] = [];
  const options: SwapCommandOptions = { home, now: NOW,
    sources: { agents: () => [], screen: () => ({ kind: 'idle' }) } as unknown as NonNullable<SwapCommandOptions['sources']>,
    presetRestart: async input => {
      calls.push(input); expect(input.resume).toBeUndefined();
      const declared = input.declare?.(); expect(declared).toEqual({ ok: true });
      return { kind: 'ready', oldPane: 'pane-old', pane: 'pane-new', readBack: { kind: 'unread' } };
    },
  };
  const run = async (argv: string[], owner = false) => {
    const io = testIo(root, owner ? { kind: 'owner' } : { kind: 'seat', name: 'operator', pane: 'pane-operator', session: 'example-session' });
    const code = await runSwap(argv, io, options);return { code, out: io.out, err: io.err };
  };
  return { base, root, home, dir, path, calls, run, options };
}

function snapshot(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git') continue;
    const path = join(dir, d.name); if (d.isDirectory()) { out[path] = 'directory'; walk(path); } else if (d.isFile()) out[path] = readFileSync(path).toString('base64');
  } };walk(folder);return out;
}

test('a placed operator moves Codex to Grok, creates and records one own worktree, and rewrites the complete recipe once', async () => {
  const w = world(); const at = performance.now();
  const ran = await w.run(['worker', 'grok-preset', '--json']);
  expect(ran).toMatchObject({ code: 0, err: '' }); expect(w.calls).toHaveLength(1);
  expect(performance.now() - at).toBeLessThan(10_000);
  const read = readTeamConfig(w.root, { home: w.home }); expect(read.ok).toBe(true);
  if (!read.ok) return;
  const seat = read.team.seats.find(s => s.name === 'worker')!;
  expect([seat.cli, seat.model, seat.version, seat.display, seat.launch, seat.mode]).toEqual(['grok', 'Grok', '4.7', 'Grok 4.7', 'grok --model grok-4.7', 'worktree']);
  expect(existsSync(join(w.root, seat.cwd, '.git'))).toBe(true);
  const tree = readState(w.dir).sessions['example-session']!.worktrees['swap-worker']!;
  expect(tree.seat).toBe('worker'); expect(tree.path).toBe(seat.cwd);
  expect(JSON.parse(ran.out).fresh).toBe(true);
  assertMatchesOutputSchema(ran.out, SWAP_OUTPUT_SCHEMA);
});

test('the dry run prints every field and the planned worktree and writes no bytes', async () => {
  const w = world(), before = snapshot(w.base);
  const ran = await w.run(['worker', 'grok-preset', '--dry-run', '--json']);
  expect(ran.code).toBe(0); expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
  const doc = JSON.parse(ran.out); expect(doc.worktree.record.seat).toBe('worker');
  assertMatchesOutputSchema(ran.out, SWAP_OUTPUT_SCHEMA);
  for (const key of ['cli','model','version','display','launch','cwd','mode']) expect(doc.changes[key]).toBeDefined();
});

test('Grok to Claude retains the recorded worktree', async () => {
  const w = world(); expect((await w.run(['worker', 'grok-preset'])).code).toBe(0);
  const before = readState(w.dir).sessions['example-session']!.worktrees;
  expect((await w.run(['worker', 'claude-preset'])).code).toBe(0);
  expect(readState(w.dir).sessions['example-session']!.worktrees).toEqual(before);
  expect(w.calls[1]!.next!.cwd).toBe(w.calls[0]!.next!.cwd); expect(w.calls).toHaveLength(2);
});

test('Kimi to GLM on the same CLI still starts fresh and changes display and version together', async () => {
  const w = world(); writeFileSync(w.path, readFileSync(w.path, 'utf8').replace('cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: \'6.1\'\n    launch: codex -m gpt-6.1-sol', "cli: claude-code\n    vendor: moonshot\n    model: Kimi K2.5\n    version: '2.5'\n    launch: claude --model kimi-k2.5"));
  const ran = await w.run(['worker', 'glm-preset']); expect(ran.code).toBe(0);
  expect(w.calls[0]!.declared.model).toBe('Kimi K2.5');
  expect(w.calls[0]!.next!.display).toBe('GLM 5.3'); expect(w.calls[0]!.next!.launch).toBe('claude --model glm-5.3'); expect(w.calls[0]!.resume).toBeUndefined();
});

test('an owner model-rule deny refuses before worktree creation, writing or restart', async () => {
  const w = world(); const rule = writePolicySet(w.home, { level: 'entity', target: 'example-lab', name: 'model-rule', value: 'worker=openai' }, { now: NOW });expect(rule.ok).toBe(true);
  const before = snapshot(w.base); const ran = await w.run(['worker', 'grok-preset']);expect(ran.code).toBe(1);
  expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
});

test('an operator cannot swap its orchestrator and malformed recipes write nothing', async () => {
  const w = world(), before = snapshot(w.base);
  expect((await w.run(['lead', 'glm-preset'])).code).toBe(1);
  expect((await w.run(['worker', 'missing-preset'])).code).toBe(1);
  expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
});

test('preset metadata rejects missing and unknown fields; the full team validator enforces version/display consistency', async () => {
  const raw = { format: 1, name: 'grok-preset', kind: 'preset', harness: 'grok', seat: { vendor: 'xai', model: 'Grok', version: '4.7' } };
  expect(validateDefinition(raw).def).toBeNull();
  expect(validateDefinition({ ...raw, seat: { ...raw.seat, display: 'Grok 4.7', surprise: 'x' } }).def).toBeNull();
  const w = world(); const p = join(w.dir, 'launchers/grok-preset.yaml');writeFileSync(p, readFileSync(p, 'utf8').replace('display: Grok 4.7', 'display: Grok 4.6'));
  const before = snapshot(w.base);expect((await w.run(['worker', 'grok-preset'])).code).toBe(1); expect(snapshot(w.base)).toEqual(before);
});

test('a second own-folder swap reuses its worktree slot', async () => {
  const w = world(); expect((await w.run(['worker', 'grok-preset'])).code).toBe(0);
  const trees = readState(w.dir).sessions['example-session']!.worktrees;
  expect((await w.run(['worker', 'grok-preset'])).code).toBe(0);
  expect(readState(w.dir).sessions['example-session']!.worktrees).toEqual(trees);
});

test('a full worktree limit refuses without deleting another seat’s work', async () => {
  const w = world(); updateState(w.dir, state => {
    const s = state.sessions['example-session']!;
    for (const name of ['one', 'two']) s.worktrees[name] = { path: `../trees/${name}`, branch: `task/${name}`, seat: name, setup: 'ok' };
  });
  const before = snapshot(w.base); const ran = await w.run(['worker', 'grok-preset']);
  expect(ran.code).toBe(1); expect(ran.err).toContain('no free slot'); expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
});

test('the wrong caller pane has no authority to write even a valid recipe', async () => {
  const w = world(); updateState(w.dir, s => { s.sessions['example-session']!.seats.operator!.pane = 'pane-another'; });
  const before = snapshot(w.base); expect((await w.run(['worker', 'glm-preset'])).code).toBe(1);
  expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
});

test('an unreadable launcher catalogue refuses before all effects', async () => {
  const w = world(); writeFileSync(join(w.dir, 'launchers/broken.yaml'), 'format: 99\n');
  const before = snapshot(w.base); expect((await w.run(['worker', 'glm-preset'])).code).toBe(1);
  expect(snapshot(w.base)).toEqual(before); expect(w.calls).toHaveLength(0);
});

for (const kind of ['rate limit', 'provider error'] as const) {
  test(`a ${kind} pane is handed to restart as broken, without a resume`, async () => {
    const w = world();
    w.options.sources!.agents = () => [{ name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', agent: 'codex', status: 'idle', cwd: w.root }];
    w.options.sources!.screen = () => kind === 'rate limit' ? { kind, reset: null } : { kind };
    const restart = w.options.presetRestart!;
    w.options.presetRestart = async input => {
      expect(input.broken).toBe(true); expect(input.abandon).toBe(false); expect(input.resume).toBeUndefined();
      return restart(input);
    };
    expect((await w.run(['worker', 'grok-preset'])).code).toBe(0);
  });
}

test('a refused restart rolls back only the clean worktree and slot this swap allocated', async () => {
  const w = world(), before = snapshot(w.base);
  w.options.presetRestart = async () => ({ kind: 'not-ready', message: 'synthetic preflight refusal' });
  const ran = await w.run(['worker', 'grok-preset']);
  expect(ran.code).toBe(1); expect(ran.err).toContain('synthetic preflight refusal');
  expect(snapshot(w.base)).toEqual(before);
  expect(readState(w.dir).sessions['example-session']!.worktrees).toEqual({});
  expect(existsSync(join(w.base, 'trees/swap-worker'))).toBe(false);
  expect(() => execFileSync('git', ['show-ref', '--verify', 'refs/heads/swap/swap-worker'], { cwd: w.root, stdio: 'ignore' })).toThrow();
});

test('a refused restart preserves a reused worktree and peer slots', async () => {
  const w = world(); expect((await w.run(['worker', 'grok-preset'])).code).toBe(0);
  updateState(w.dir, state => { state.sessions['example-session']!.worktrees.peer = { path: '../trees/peer', branch: 'task/peer', seat: 'peer', setup: 'ok' }; });
  const before = snapshot(w.base);
  w.options.presetRestart = async () => ({ kind: 'busy', message: 'synthetic busy turn' });
  expect((await w.run(['worker', 'grok-preset'])).code).toBe(1);
  expect(snapshot(w.base)).toEqual(before);
});

test('a branch that moves after its worktree is removed clears the recorded slot', async () => {
  const w = world();
  const bin = join(w.base, 'bin');
  mkdirSync(bin);
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  // The shim's own commit names its identity: a CI runner has no git user configured, and an
  // identity-less commit-tree would leave the branch where it was.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
real=${JSON.stringify(real)}
if [ "$1" = worktree ] && [ "$2" = remove ]; then
  "$real" "$@"
  status=$?
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  tree=$("$real" rev-parse 'HEAD^{tree}')
  moved=$("$real" -c user.name=Test -c user.email=test@example.com commit-tree "$tree" -m moved)
  "$real" update-ref refs/heads/swap/swap-worker "$moved"
  exit 0
fi
exec "$real" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${saved === undefined ? '' : `:${saved}`}`;
  try {
    w.options.presetRestart = async () => ({ kind: 'not-ready', message: 'synthetic preflight refusal' });
    const ran = await w.run(['worker', 'grok-preset']);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('synthetic preflight refusal');
    expect(ran.err).toContain('the worktree record was cleared');
    expect(readState(w.dir).sessions['example-session']!.worktrees['swap-worker']).toBeUndefined();
    expect(existsSync(join(w.base, 'trees/swap-worker'))).toBe(false);
    expect(execFileSync(real, ['show-ref', '--verify', 'refs/heads/swap/swap-worker'], { cwd: w.root, encoding: 'utf8' })).toContain('refs/heads/swap/swap-worker');
    const again = await w.run(['worker', 'grok-preset']);
    expect(again.err).not.toContain('already recorded');
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

test('a worktree changed during the refusal is preserved rather than forced away', async () => {
  const w = world();
  w.options.presetRestart = async () => {
    writeFileSync(join(w.base, 'trees/swap-worker/held.txt'), 'unexpected work must survive\n');
    return { kind: 'not-ready', message: 'synthetic preflight refusal' };
  };
  const ran = await w.run(['worker', 'grok-preset']);
  expect(ran.code).toBe(1); expect(ran.err).toContain('allocation retained');
  expect(readFileSync(join(w.base, 'trees/swap-worker/held.txt'), 'utf8')).toBe('unexpected work must survive\n');
  expect(readState(w.dir).sessions['example-session']!.worktrees['swap-worker']?.seat).toBe('worker');
});
