// The `lead-gates` policy (ruling D5, owner answer A3): the file's own `operator:` place is
// admitted to five of the dev-mode lead gates — `check --repair`, `remove --abandon`,
// `down --abandon`, `policy set` and `policy unset`, `daemon restart` — and to `team answer`,
// while dev mode is on and the effective value reads `lead+operator` for the caller's chain.
// The default `lead`, an unplaced operator, and every gate the policy does not name keep the
// refusal exactly as before; grants, delegation and the owner-only actions stay the lead's or
// the owner's. Every admitted run warns on stderr and writes the same audit line the lead's
// admission writes, with `admitted as operator` naming the role. Every seat, file, pane, home
// and policy record below is synthetic; no command here touches the live machine.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import type { Caller } from '../src/caller.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { devModeOwnerLift, devModeOwnerRoleOf, leadGatesAdmitOperator } from '../src/dev_mode.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { keyOf } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { writePolicySet } from '../src/policy/index.ts';
import type { Screen } from '../src/watch/screen.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'w1:p1', session: 'acme' };
const OPS = { kind: 'seat' as const, name: 'ops', pane: 'w3:p1', session: 'acme' };
const OPS_ELSEWHERE = { kind: 'seat' as const, name: 'ops', pane: 'w2:p1', session: 'acme' };
const HELPER = { kind: 'seat' as const, name: 'helper', pane: 'w2:p1', session: 'acme' };
const OWNER_GRANT = 'only the owner runs this, from a terminal outside herdr';

let made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository whose file names `lead` the coordinator and `ops` the operator, with `helper` an
 *  ordinary seat; all three panes recorded in the session state, and a synthetic home beside it
 *  whose entity lobby exists and is trusted. */
function repo(spelling = 'ops'): { root: string; home: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lead-gates-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const file = join(root, '.agents', 'team.yaml');
  const lobby = resolveLobby(home, { entity: 'acme' });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true });
  const seat = (name: string): string => `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  writeFileSync(file, `format: 1
project: acme
entity: acme
session: acme
coordinator: lead
operator: ${spelling}
trust:
  - ${lobby}
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
${seat('ops')}${seat('helper')}`);
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      acme: {
        seats: {
          lead: { stage: 'ready', pane: 'w1:p1' },
          ops: { stage: 'ready', pane: 'w3:p1' },
          helper: { stage: 'ready', pane: 'w2:p1' },
        },
        worktrees: {},
      },
    },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home, file };
}

function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** `dev-mode on` at team level, the chain route the lead gates already read. */
function devModeOn(home: string, root: string): void {
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
}

/** One `lead-gates` declaration at team level. */
function leadGates(home: string, root: string, value: 'lead' | 'lead+operator', level: 'entity' | 'team' = 'team'): void {
  const written = writePolicySet(
    home,
    level === 'team'
      ? { level, target: root, teamRoot: root, name: 'lead-gates', value }
      : { level, target: 'acme', name: 'lead-gates', value },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

/** The machine `local-fast` record, written the way the command writes it. */
function machineFast(home: string): void {
  keyOf(home);
  const written = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

describe('the policy itself', () => {
  test('accepts exactly its two words', () => {
    const { home, root } = repo();
    expect(writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'lead-gates', value: 'lead+operater' }, { now: NOW }).ok).toBe(false);
    expect(writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'lead-gates', value: 'operator' }, { now: NOW }).ok).toBe(false);
    leadGates(home, root, 'lead');
    leadGates(home, root, 'lead+operator');
  });

  test('a level that widens past a nearer level is refused before the write', async () => {
    const { root, home } = repo();
    leadGates(home, root, 'lead', 'entity');
    // The write gate the owner itself faces: a team value that widens the entity's is refused,
    // and the record it would have written is not on the chain afterwards.
    const io = testIo(root, { kind: 'owner' });
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead+operator'], io, { home })).toBe(1);
    expect(io.err).toContain('lead-gates');
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(false);
  });

  test('the reader fails closed: no declaration, and a nearer lead over a farther lead+operator, admit no operator', () => {
    const { root, home } = repo();
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(false);
    leadGates(home, root, 'lead+operator', 'entity');
    leadGates(home, root, 'lead');
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(false);
    leadGates(home, root, 'lead+operator');
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(true);
  });
});

describe('the five gates', () => {
  test('the default admits no operator: policy set and grant both refuse, and nothing is logged', async () => {
    const { root, home, file } = repo();
    devModeOn(home, root);
    const before = readFileSync(file, 'utf8');
    const policyIo = testIo(root, OPS);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], policyIo, { home })).toBe(1);
    expect(policyIo.err).toContain(OWNER_GRANT);
    expect(policyIo.err).not.toContain('dev mode continues');
    const grantIo = testIo(root, OPS);
    expect(await runGrant(['ops', '--scope', 'up'], grantIo, { home })).toBe(1);
    expect(grantIo.err).toBe(`team grant: ${OWNER_GRANT}; this call is ops\n`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(logOf(root)).toBe('');
  });

  test('lead+operator admits the placed operator to policy set: warning, audit, and the write lands', async () => {
    const { root, home, file } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], io, { home })).toBe(0);
    expect(io.err).toContain(`warning: ${OWNER_GRANT}; this call is ops; dev mode continues (dev-mode on at team level)`);
    expect(logOf(root)).toContain('policy [ops]');
    expect(logOf(root)).toContain('admitted as operator');
    // The write the admission carried: the policy it tightened now refuses the next operator run.
    const again = testIo(root, OPS);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead+operator'], again, { home })).toBe(1);
    expect(again.err).not.toContain('dev mode continues');
  });

  test('lead+operator admits the placed operator to policy unset, with the same audit line', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS);
    expect(await runPolicy(['unset', 'team', 'lead-gates'], io, { home })).toBe(0);
    expect(io.err).toContain('dev mode continues (dev-mode on at team level)');
    expect(logOf(root)).toContain('policy [ops]');
    expect(logOf(root)).toContain('admitted as operator');
  });

  test('grant stays the lead\'s under lead+operator: the operator is refused and nothing is logged', async () => {
    const { root, home, file } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const before = readFileSync(file, 'utf8');
    const io = testIo(root, OPS);
    expect(await runGrant(['ops', '--scope', 'up'], io, { home })).toBe(1);
    expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is ops\n`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(logOf(root)).toBe('');
  });

  test('an ordinary seat gains nothing from lead+operator', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, HELPER);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], io, { home })).toBe(1);
    expect(io.err).not.toContain('dev mode continues');
    expect(logOf(root)).toBe('');
  });

  test('the operator on a pane the state does not record for it is refused', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS_ELSEWHERE);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], io, { home })).toBe(1);
    expect(io.err).not.toContain('dev mode continues');
    expect(logOf(root)).toBe('');
  });

  test('the machine local-fast record carries the same admission, with its level note', async () => {
    const { root, home } = repo();
    machineFast(home);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], io, { home })).toBe(0);
    expect(io.err).toContain('dev mode continues (dev-mode on at machine level)');
    expect(logOf(root)).toContain('admitted as operator');
  });

  test('remove --abandon: the operator continues past the gate and the seat leaves the file', async () => {
    const { root, home, file } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, root, NOW), file: readFileSync(file, 'utf8') },
      loaded.team.seats,
      home,
      NOW,
    );
    const typed: string[] = [];
    const keys: string[] = [];
    const agents: HerdrAgent[] = [{ name: 'helper', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null }];
    let box = claudeBox('');
    const sources: RemoveSources = {
      home,
      sessionRunning: () => true,
      agents: () => agents,
      alive: () => false,
      screen: () => ({ kind: 'idle' }) as Screen,
      screenText: () => box,
      status: () => 'idle',
      now: () => NOW,
      sleep: async () => {},
      launch: {
        typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
        sendKey: (_session, _pane, key) => { keys.push(key); box = claudeBox(''); return true; },
        pressEnter: () => true,
        agentPanes: () => agents.map((agent) => agent.pane),
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
      foreground: () => [],
    };
    const io = testIo(root, OPS);
    expect(await runRemove(['helper', '--abandon'], io, sources)).toBe(0);
    expect(io.err).toContain('only the owner abandons a seat, from a terminal outside herdr');
    expect(io.err).toContain('dev mode continues (dev-mode on at team level)');
    expect(logOf(root)).toContain('remove [ops]');
    expect(logOf(root)).toContain('admitted as operator');
    expect(readFileSync(file, 'utf8')).not.toContain('name: helper');
  });
});

describe('the lift itself, gate by gate', () => {
  /** The lift asked directly, the way `check --repair` and `remove --abandon` ask it. */
  function lift(root: string, home: string, caller: Caller, command: string, admitsOperator?: boolean) {
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    return devModeOwnerLift(testIo(root, caller), {
      command,
      refusal: `only the owner runs ${command}`,
      home,
      team: loaded.team,
      root: loaded.root,
      dir: join(root, '.agents'),
      now: NOW,
      ...(admitsOperator !== undefined ? { admitsOperator } : {}),
    });
  }

  test('a gate that does not ask admits no operator, and one that asks admits the placed operator with its audit line', () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    // `down --abandon` asks; the daemon's install does not. (Which command a call site names is
    // the call site's choice — grant's site never asks, and the runGrant scene above pins that.)
    expect(lift(root, home, OPS, 'down', true).lifted).toBe(true);
    expect(lift(root, home, OPS, 'daemon').lifted).toBe(false);
    expect(lift(root, home, OPS, 'daemon', false).lifted).toBe(false);
    // `daemon restart` is the one daemon verb that asks.
    expect(lift(root, home, OPS, 'daemon', true).lifted).toBe(true);
    const admitted = lift(root, home, OPS, 'check', true);
    expect(admitted.role).toBe('operator');
    expect(admitted.warning).toContain('only the owner runs check');
    expect(admitted.warning).toContain('dev mode continues (dev-mode on at team level)');
    admitted.audit();
    expect(logOf(root)).toContain('check [ops]');
    expect(logOf(root)).toContain('admitted as operator');
  });

  test('the wrong pane is no admission, and the lead needs no policy', () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    expect(lift(root, home, OPS_ELSEWHERE, 'check', true).lifted).toBe(false);
    expect(lift(root, home, LEAD, 'check').lifted).toBe(true);
    expect(lift(root, home, LEAD, 'check').role).toBe('orchestrator');
  });

  test('a seat spelled both operator and lead is the lead, never the operator', () => {
    const { root, home } = repo('lead');
    devModeOn(home, root);
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    expect(devModeOwnerRoleOf('lead', loaded.team)).toBe('orchestrator');
    expect(devModeOwnerRoleOf('ops', loaded.team)).toBe(null);
    expect(devModeOwnerRoleOf('helper', loaded.team)).toBe(null);
  });
});

describe('team answer', () => {
  /** The answer host that carries a run only past the caller gate: everything a later gate would
   *  touch throws, so a scene that passes the gate lands on the dialogs.trust refusal. */
  function answerHost(home: string): AnswerHost {
    return {
      home,
      now: () => NOW,
      sleep: async () => {},
      version: () => { throw new Error('no version read in these scenes'); },
      agents: () => { throw new Error('no agent read in these scenes'); },
      pane: () => { throw new Error('no pane read in these scenes'); },
      sendKey: () => { throw new Error('no key is sent in these scenes'); },
      rename: () => false,
      foreground: () => null,
      foregroundCwd: () => null,
      list: () => [],
      status: () => 'idle',
      type: () => false,
      enter: () => false,
      standing: (root: string) => approvalStanding(root, home),
    };
  }

  test('the default keeps the refusal: no warning, no audit line', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    const io = testIo(root, OPS);
    expect(await runAnswer(['helper', 'trust'], io, answerHost(home))).toBe(1);
    expect(io.err).toContain('only the owner, or the orchestrator from its own seat, can answer');
    expect(io.err).not.toContain('dev mode continues');
    expect(logOf(root)).not.toContain('admitted as');
    expect(logOf(root)).not.toContain('dev mode continues');
  });

  test('lead+operator admits the placed operator past the caller gate, warns, and audits', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS);
    expect(await runAnswer(['helper', 'trust'], io, answerHost(home))).toBe(1);
    expect(io.err).toContain('warning: only the owner, or the orchestrator from its own seat, can answer; dev mode continues (dev-mode on at team level)');
    // The gate that refuses next is the one after the caller gate, not the caller gate itself.
    expect(io.err).toContain('dialogs.trust is off');
    expect(logOf(root)).toContain('answer [ops]');
    expect(logOf(root)).toContain('admitted as operator');
  });

  test('the operator on a pane the state does not record for it keeps the refusal', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');
    const io = testIo(root, OPS_ELSEWHERE);
    expect(await runAnswer(['helper', 'trust'], io, answerHost(home))).toBe(1);
    expect(io.err).not.toContain('dev mode continues');
    expect(logOf(root)).not.toContain('admitted as');
  });

  test('the lead needs no policy and leaves no admission line', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    const io = testIo(root, LEAD);
    expect(await runAnswer(['helper', 'trust'], io, answerHost(home))).toBe(1);
    expect(io.err).not.toContain('dev mode continues');
    expect(io.err).toContain('dialogs.trust is off');
    expect(logOf(root)).not.toContain('admitted as');
  });
});
