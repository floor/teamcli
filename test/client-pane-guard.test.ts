// The client pane guard on every grant-verified client form: `team up --client`, `team down
// --client`, `team status --client` and the bundle ops all pass through `verifyClientUp`, which
// places the caller before the grant or the key is read and refuses one inside a team pane. Dev
// mode, the owner's switch, lifts it with its warning; an external client outside herdr is never
// refused. Every seat, file, pane and home below is synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { clientPaneGuard } from '../src/client/pane-guard.ts';
import { enterClientForm } from '../src/client/client-form.ts';
import { verifyClientUp } from '../src/client/up-grant.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T09:00:00Z');
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const HELPER: Caller = { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' };
const REFUSAL = 'a client key is not used from inside a team pane';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-client-pane-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { acme: { seats: { lead: { stage: 'ready', pane: 'w1:p1' }, helper: { stage: 'ready', pane: 'w2:p1' } }, worktrees: {} } },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

const verifyAs = (root: string, home: string, caller: Caller, op: 'up' | 'down' | 'status', env: Record<string, string> = {}) => {
  const io = testIo(root, caller);
  io.env = env;
  const verified = verifyClientUp({ home, grantFile: join(root, 'missing-grant.json'), keyFile: join(root, 'missing.key'), cwd: root, now: NOW, op, io });
  return { verified, io };
};

for (const op of ['up', 'down', 'status'] as const) {
  test(`${op} --client from a seat is refused before the grant is read`, () => {
    const { root, home } = repo();
    const { verified } = verifyAs(root, home, HELPER, op);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.why).toContain(REFUSAL);
      expect(verified.identified).toBeNull();
    }
  });
}

test('an agentless team pane and a child under herdr are refused too', () => {
  const { root, home } = repo();
  for (const caller of [{ kind: 'pane', pane: 'w3:p1' }, { kind: 'unplaced', reason: 'it runs under herdr' }] as Caller[]) {
    const { verified } = verifyAs(root, home, caller, 'up');
    expect(verified.ok ? '' : verified.why).toContain(REFUSAL);
  }
});

test('an external client outside herdr passes the guard and meets the grant check', () => {
  const { root, home } = repo();
  for (const caller of [{ kind: 'owner-no-tty' }, { kind: 'owner' }, { kind: 'unplaced', reason: 'it is run by an agent (cursor-agent) outside herdr' }] as Caller[]) {
    const { verified } = verifyAs(root, home, caller, 'up');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.why).not.toContain(REFUSAL);
  }
});

test('dev mode lifts the guard for the placed orchestrator, with the warning', () => {
  const { root, home } = repo();
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  const verdict = clientPaneGuard(io, 'up', home);
  expect(verdict.ok).toBe(true);
  if (verdict.ok) expect(verdict.warning).toContain('dev mode continues');
  const { verified, io: run } = verifyAs(root, home, LEAD, 'up', { TEAMCLI_DEV_MODE: '1' });
  expect(verified.ok ? '' : verified.why).not.toContain(REFUSAL);
  expect(run.err).toContain('dev mode continues');
});

test('without dev mode the orchestrator is refused like any seat', () => {
  const { root, home } = repo();
  expect(clientPaneGuard(testIo(root, LEAD), 'up', home).ok).toBe(false);
});

test('the bundle ops entrance refuses a seat the same way', () => {
  const { root, home } = repo();
  for (const op of ['pause', 'resume', 'hold'] as const) {
    const entered = enterClientForm(
      { home, now: NOW, io: testIo(root, HELPER) },
      { op, values: { client: 'missing-grant.json', key: 'missing.key' }, cwd: root },
    );
    expect(entered.ok ? '' : entered.why).toContain(REFUSAL);
  }
});
