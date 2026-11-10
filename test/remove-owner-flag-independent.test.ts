// Independent scenes for the remove owner-flag guards: the non-detached `--file` and
// `--session` refusals land before the target is resolved, so a seat that does not exist
// never answers first; a detached caller keeps the deferred refusal behind the gates that
// stand before it; a team with delegates hands the flag refusal to the delegate gate, whose
// verdict decides what the caller reads; and the owner's own `--file` never meets the flag
// refusal at all.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-10T08:00:00Z');
const other = { kind: 'seat', name: 'other', pane: 'pane9' } as const;
const leadSeat = { kind: 'seat', name: 'lead', pane: 'pane1', session: 'acme' } as const;
const owner = { kind: 'owner' } as const;
const noTty = { kind: 'owner-no-tty' } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = ReturnType<typeof world>;

/** A git project with a two-seat team; `delegates` adds the section that routes the owner-flag
 *  refusal through the delegate gate. */
function world(options: { delegates?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remove-owner-flag-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${options.delegates ? `delegates:
  - pane: main/pane2
    commands: [add, remove]
` : ''}seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`);
  return { base, home, root };
}

/** The sources a cold remove reads: no session runs, no panes exist, nothing is alive. */
function sources(w: World, over: Partial<RemoveSources> = {}): RemoveSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    home: w.home,
    ...over,
  };
}

async function remove(w: World, argv: string[], caller: typeof other | typeof leadSeat | typeof owner | typeof noTty, over: Partial<RemoveSources> = {}) {
  const io = testIo(w.root, caller);
  const code = await runRemove(argv, io, sources(w, over));
  return { code, said: io.out + io.err };
}

test('the --file refusal lands before the target is resolved, whatever the target', async () => {
  const w = world();
  for (const target of ['missing', 'worker']) {
    const run = await remove(w, [target, '--file', '.agents/team.yaml', '--json'], other);
    expect(run.code, target).toBe(1);
    expect(run.said, target).toContain("--file is the owner's");
    expect(run.said, target).toContain('remove.file-owner');
    // The refusal is decided before the seat is looked up: a missing seat never answers first.
    expect(run.said, target).not.toContain('no seat "missing"');
  }
});

test('the --session refusal is the non-owner\'s, before any session or seat is read', async () => {
  const w = world();
  const run = await remove(w, ['missing', '--session', 'other', '--json'], leadSeat);
  expect(run.code).toBe(1);
  expect(run.said).toContain("--session is the owner's");
  expect(run.said).toContain('remove.session-owner');
  expect(run.said).not.toContain('no seat "missing"');
});

test('a detached caller keeps the deferred flag refusal behind the gates before it', async () => {
  const w = world();
  const run = await remove(w, ['missing', '--file', '.agents/team.yaml', '--json'], noTty);
  expect(run.code).toBe(1);
  // A seat that does not exist never answers a detached caller either: the gate that stands
  // before the deferred flag refusal is what answers.
  expect(run.said).not.toContain('the team has no seat');
  expect(run.said).toContain('remove.detached');
});

test('a team with delegates hands the flag refusal to the delegate gate', async () => {
  const w = world({ delegates: true });
  const denied = await remove(w, ['worker', '--file', '.agents/team.yaml', '--json'], other, {
    delegateGate: () => ({ kind: 'refused', id: 'remove.delegate-approval', text: 'delegation needs a verified approval: the synthetic standing is not in force' }),
  });
  expect(denied.code).toBe(1);
  // The gate's verdict is what the caller reads; the flag refusal stands behind it.
  expect(denied.said).toContain('delegation needs a verified approval: the synthetic standing is not in force');
  expect(denied.said).not.toContain("--file is the owner's");
  // A gate that passes returns the flag refusal to the caller.
  const passed = await remove(w, ['worker', '--file', '.agents/team.yaml', '--json'], other, {
    delegateGate: () => ({ kind: 'passed', pane: 'main/pane2' }),
  });
  expect(passed.code).toBe(1);
  expect(passed.said).toContain("--file is the owner's");
});

test("the owner's own --file never meets the flag refusal", async () => {
  const w = world();
  const run = await remove(w, ['missing', '--file', '.agents/team.yaml', '--json'], owner);
  // The owner walks past the owner-only flags; the next thing that answers is the seat lookup.
  expect(run.code).toBe(1);
  expect(run.said).not.toContain("--file is the owner's");
  expect(run.said).toContain('the team has no seat');
  expect(run.said).toContain('remove.no-seat');
});
