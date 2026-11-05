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
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runBroker } from '../src/commands/broker.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runTempo } from '../src/commands/tempo.ts';
import type { Caller } from '../src/caller.ts';
import type { ServiceManager } from '../src/daemon/service.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { devModeOwnerLift, devModeOwnerRoleOf, leadGatesAdmitOperator } from '../src/dev_mode.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { keyOf } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { resolvePolicy, writePolicySet } from '../src/policy/index.ts';
import type { Screen } from '../src/watch/screen.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'pane1', session: 'acme' };
const OPS = { kind: 'seat' as const, name: 'ops', pane: 'pane3', session: 'acme' };
const OPS_ELSEWHERE = { kind: 'seat' as const, name: 'ops', pane: 'pane2', session: 'acme' };
const HELPER = { kind: 'seat' as const, name: 'helper', pane: 'pane2', session: 'acme' };
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
          lead: { stage: 'ready', pane: 'pane1' },
          ops: { stage: 'ready', pane: 'pane3' },
          helper: { stage: 'ready', pane: 'pane2' },
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
    const agents: HerdrAgent[] = [{ name: 'helper', agent: 'claude', pane: 'pane2', workspace: 'w2', status: 'idle', cwd: null }];
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

describe('independent adversarial checks: five command gates, tighten-only chain, and closed owner-only gates', () => {
  const fakeService: ServiceManager = {
    kind: 'system-service-manager',
    unitPath: (home: string) => join(home, 'daemon.unit'),
    plan: (home: string) => ({ unitPath: join(home, 'daemon.unit'), program: ['/bin/team', 'daemon', 'run'] }),
    install: (home: string) => ({ ok: true, unitPath: join(home, 'daemon.unit'), program: ['/bin/team', 'daemon', 'run'] }),
    restart: (home: string) => ({
      ok: true,
      unitPath: join(home, 'daemon.unit'),
      undo: () => ({ ok: false, reason: 'refused', why: 'not run', detail: null }),
    }),
    uninstall: (home: string) => ({ ok: true, unitPath: join(home, 'daemon.unit'), removed: true }),
    unit: () => null,
    job: () => null,
  };

  test('check --repair, down --abandon, and daemon restart admit the placed operator end-to-end with warning and audit line', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');

    // 1. `team check --repair`
    const checkSources: CheckSources = {
      home,
      now: () => NOW,
      standing: (r: string) => approvalStanding(r, home),
      branch: () => 'main',
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    };
    const checkIo = testIo(root, OPS);
    runTeamCheck({ repair: true }, checkIo, checkSources);
    expect(checkIo.err).toContain("warning: --repair is the owner's; dev mode continues (dev-mode on at team level)");
    expect(logOf(root)).toContain('check [ops]');
    expect(logOf(root)).toContain('admitted as operator');

    // 2. `team down --abandon --dry-run`
    const downSources: DownSources = {
      home,
      now: () => NOW,
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }) as Screen,
      screenText: () => '',
      status: () => 'idle',
      foreground: () => [],
      standing: (r: string) => approvalStanding(r, home),
    };
    const downIo = testIo(root, OPS);
    expect(await runDown(['--abandon', '--dry-run'], downIo, downSources)).toBe(0);
    expect(downIo.err).toContain('warning: only the owner abandons a team, from a terminal outside herdr; dev mode continues (dev-mode on at team level)');
    expect(logOf(root)).toContain('down [ops]');
    expect(logOf(root)).toContain('admitted as operator');

    // 3. `team daemon restart --dry-run`
    const restartIo = testIo(root, OPS);
    expect(await runDaemon(['restart', '--dry-run'], restartIo, { home, now: () => NOW, service: fakeService })).toBe(0);
    expect(restartIo.err).toContain('warning: only the owner, a general grant naming daemon, or a lead in development mode installs, restarts or removes the machine daemon; this call is ops; dev mode continues (dev-mode on at team level)');
    expect(logOf(root)).toContain('daemon [ops]');
  });

  test('owner-only and lead-only commands stay closed to the placed operator under lead+operator', async () => {
    const { root, home } = repo();
    devModeOn(home, root);
    leadGates(home, root, 'lead+operator');

    // `team delegate`
    const delegateIo = testIo(root, OPS);
    expect(await runDelegate(['other/pane9', '--commands', 'status'], delegateIo, { home })).toBe(1);
    expect(delegateIo.err).toContain(OWNER_GRANT);
    expect(delegateIo.err).not.toContain('dev mode continues');

    // `team revoke`
    const revokeIo = testIo(root, OPS);
    expect(await runRevoke(['grant'], revokeIo, { home })).toBe(1);
    expect(revokeIo.err).toContain(OWNER_GRANT);
    expect(revokeIo.err).not.toContain('dev mode continues');

    // `team broker`
    const brokerIo = testIo(root, OPS);
    expect(await runBroker([], brokerIo, { home })).toBe(1);
    expect(brokerIo.err).toContain('only the owner runs `broker`, from a terminal outside herdr; this call is ops');
    expect(brokerIo.err).not.toContain('dev mode continues');

    // `team tempo`
    const tempoIo = testIo(root, OPS);
    expect(await runTempo(['urgent'], tempoIo, { home })).toBe(1);
    expect(tempoIo.err).toContain('only the owner runs tempo, from a terminal outside herdr; this call is ops');
    expect(tempoIo.err).not.toContain('dev mode continues');

    // `team daemon install`, `uninstall`, `fault-watch`, and `run`
    for (const argv of [
      ['install', '--dry-run'],
      ['uninstall'],
      ['fault-watch', '--root', root, '--route', '0'.repeat(32)],
      ['run'],
    ]) {
      const daemonIo = testIo(root, OPS);
      expect(await runDaemon(argv, daemonIo, { home, now: () => NOW, service: fakeService }), argv.join(' ')).toBe(1);
      expect(daemonIo.err, argv.join(' ')).not.toContain('dev mode continues');
    }

    expect(logOf(root)).toBe('');
  });

  test('lead+operator without dev-mode on admits no operator at any gate', async () => {
    const { root, home } = repo();
    // `lead-gates: lead+operator` is set, but `dev-mode` is off.
    leadGates(home, root, 'lead+operator');

    const policyIo = testIo(root, OPS);
    expect(await runPolicy(['set', 'team', 'lead-gates', 'lead'], policyIo, { home })).toBe(1);
    expect(policyIo.err).not.toContain('dev mode continues');

    const restartIo = testIo(root, OPS);
    expect(await runDaemon(['restart', '--dry-run'], restartIo, { home, now: () => NOW, service: fakeService })).toBe(1);
    expect(restartIo.err).not.toContain('dev mode continues');
    expect(logOf(root)).toBe('');
  });

  test('tighten-only across entity -> project -> team, seat level refusal, and corrupt chain fail-closed', async () => {
    const { root, home } = repo();
    devModeOn(home, root);

    // Seat level is refused by both the resolver and `team policy set`.
    const seatResolved = resolvePolicy('lead-gates', [
      { name: 'lead-gates', value: 'lead', level: 'seat', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
    ]);
    expect(seatResolved.ok).toBe(false);
    if (!seatResolved.ok) {
      expect(seatResolved.refusals[0]?.message).toContain('allowed: entity, project, team');
    }
    const ownerIo = testIo(root, { kind: 'owner' });
    expect(await runPolicy(['set', 'seat:ops', 'lead-gates', 'lead'], ownerIo, { home })).toBe(2);
    expect(ownerIo.err).toContain('may not be set at level seat');

    // Entity `lead+operator` -> Project `lead` -> Team `lead+operator` is refused at load as a loosening.
    const projectTightenedThenTeamLoosened = resolvePolicy('lead-gates', [
      { name: 'lead-gates', value: 'lead+operator', level: 'entity', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
      { name: 'lead-gates', value: 'lead', level: 'project', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
      { name: 'lead-gates', value: 'lead+operator', level: 'team', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' },
    ]);
    expect(projectTightenedThenTeamLoosened.ok).toBe(false);
    if (!projectTightenedThenTeamLoosened.ok) {
      expect(projectTightenedThenTeamLoosened.refusals[0]).toMatchObject({
        kind: 'loosening',
        policy: 'lead-gates',
        higherLevel: 'project',
        lowerLevel: 'team',
      });
    }

    // Corrupting the entity policy file on disk makes `leadGatesAdmitOperator` fail closed.
    leadGates(home, root, 'lead+operator');
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('; '));
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(true);
    writeFileSync(join(home, '.config', 'team', 'entities.yaml'), 'acme:\n  policies: [unreadable\n');
    expect(leadGatesAdmitOperator(testIo(root, OPS), { home, team: loaded.team, root })).toBe(false);
  });

  test('the main-team cross-team route (roleElsewhere) admits a parent orchestrator and refuses a parent operator', () => {
    const parent = repo();
    const childRoot = join(parent.root, 'sub-team');
    const childFile = join(childRoot, '.agents', 'team.yaml');
    const lobby = resolveLobby(parent.home, { entity: 'acme' });
    mkdirSync(join(childRoot, '.agents'), { recursive: true });
    writeFileSync(childFile, `format: 1
project: sub-team
entity: acme
session: sub-team
coordinator: sub-lead
operator: sub-ops
trust:
  - ${lobby}
  - ${childRoot}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: sub-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: sub-ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
    writeFileSync(join(childRoot, '.agents', 'team.state.json'), `${JSON.stringify({
      format: 1,
      sessions: {
        'sub-team': {
          seats: {
            'sub-lead': { stage: 'ready', pane: 'sub-pane1' },
            'sub-ops': { stage: 'ready', pane: 'sub-pane2' },
          },
          worktrees: {},
        },
      },
    }, null, 2)}\n`);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: childRoot, env: gitEnv(), stdio: 'ignore' });

    const parentLoaded = loadTeamFile(parent.root, { home: parent.home });
    const childLoaded = loadTeamFile(childRoot, { home: parent.home });
    if (!parentLoaded.ok || !childLoaded.ok) throw new Error('failed to load parent or child team');

    upsertTeam(parent.home, teamIdOf(parent.root), {
      project: 'acme',
      root: parent.root,
      session: 'acme',
      entity: 'acme',
      projectId: 'acme',
      lifecycle: 'running',
      lobby,
      by: 'test',
      at: NOW.toISOString(),
    });

    devModeOn(parent.home, parent.root);
    devModeOn(parent.home, childRoot);
    leadGates(parent.home, parent.root, 'lead+operator', 'entity');
    leadGates(parent.home, parent.root, 'lead+operator', 'team');
    leadGates(parent.home, childRoot, 'lead+operator', 'team');

    // Parent's placed orchestrator (`LEAD` in session `acme`) IS admitted to the child's gate via `roleElsewhere`.
    const parentLeadLift = devModeOwnerLift(testIo(childRoot, LEAD), {
      command: 'check',
      refusal: "--repair is the owner's",
      home: parent.home,
      team: childLoaded.team,
      root: childLoaded.root,
      dir: join(childRoot, '.agents'),
      now: NOW,
      admitsOperator: true,
    });
    expect(parentLeadLift.lifted).toBe(true);
    expect(parentLeadLift.role).toBe('orchestrator');

    // Parent's placed operator (`OPS` in session `acme`) is REFUSED on the child's gate: `roleElsewhere` admits only `orchestrator`.
    const parentOpsLift = devModeOwnerLift(testIo(childRoot, OPS), {
      command: 'check',
      refusal: "--repair is the owner's",
      home: parent.home,
      team: childLoaded.team,
      root: childLoaded.root,
      dir: join(childRoot, '.agents'),
      now: NOW,
      admitsOperator: true,
    });
    expect(parentOpsLift.lifted).toBe(false);
  });
});

