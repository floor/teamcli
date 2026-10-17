// `team down` and the delegate gate. Every verdict is injected through `DownSources.gate` and
// every audit line through `DownSources.audit`, so what this file proves is the command's own
// decisions: whether it asks the gate at all, what each verdict does to the plan and to the
// refusals, which session it reads, and exactly when the audit line is written.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runDown, type DownSources } from '../../src/commands/down.ts';
import type { DelegateVerdict } from '../../src/delegate.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { currentTeam } from '../../src/file/current.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-06T10:00:00Z');
const PANE = 'main/w1:p1';
/** A delegate runs in another herdr session, outside the team's: the walk can place it only as an
 *  unplaced caller, which is exactly the caller the gate is for. */
const CALLER: Caller = { kind: 'unplaced', reason: 'it runs under herdr' };
/** The ordinary refusal for that caller, byte for byte: the map admits the owner or `leads`. */
const ORDINARY = `only the owner or \`leads\` stops the team; this call is unplaced (it runs under herdr)`;
const GATE_DOWN = 'the gate refuses this caller (fixture)';
const GATE_COMMAND = "the approved delegate may not run 'down' (fixture)";
/** The gate's own wording for a prohibited flag. It is the gate's to write; what these tests
 *  pin is whose text appears — the gate's, never the ordinary rule's. */
const flagText = (flag: string): string => `a delegate may not pass --${flag} (fixture)`;
const PASSED: DelegateVerdict = { kind: 'passed', pane: PANE };

type GateInput = Parameters<NonNullable<DownSources['gate']>>[0];

const delegate = (commands: string[]): string =>
  ['delegates:', `  - pane: ${PANE}`, `    commands: [${commands.join(', ')}]`].join('\n');

let base: string;
let root: string;
let home: string;
let file: string;

/** The fixture with this machine's folders, and the delegate section when one is asked for. */
function teamFile(delegates: string | null): string {
  const trust = EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n\nworkspace:`,
  );
  return delegates === null ? trust : `${trust}${delegates}\n`;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegate-down-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(file, teamFile(delegate(['up', 'down'])));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const agent = (name: string, status = 'idle'): HerdrAgent => ({
  name, agent: 'claude', pane: `${name}:p1`, workspace: name, status, cwd: null,
});

const RUNNING = ['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2'];

function approveCurrent(): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) return;
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
}

function rig(overrides: Partial<DownSources> = {}, caller: Caller = CALLER) {
  approveCurrent();
  // The verdict function a test hands in is wrapped, never substituted: every run's gate call
  // is recorded, whatever verdict it returns — and a gate that throws still throws.
  const { gate: verdict = refusing('down.delegate', GATE_DOWN), ...rest } = overrides;
  const io = testIo(root, caller);
  const gateCalls: GateInput[] = [];
  const audits: { dir: string; pane: string; command: string; now: Date }[] = [];
  const typed: string[] = [];
  const keys: string[] = [];
  let box = claudeBox('');
  // Every session the command reads, at the two questions that name one.
  const read: string[] = [];
  const sources: DownSources = {
    sessionRunning: (session) => { read.push(session); return true; },
    agents: (session) => { read.push(session); return RUNNING.map((name) => agent(name)); },
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    // The pane is physical, as the live harness models it: the empty idle box before any
    // typing, the box holding the typed text after one, empty again after the clearing key —
    // the read-back the exit typing confirms against is what the pane would really show.
    screenText: () => box,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
      sendKey: (_session, _pane, key) => { keys.push(key); box = claudeBox(''); return true; },
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
    // Never the real gate: every verdict this file asserts on is handed in below.
    gate: (input) => { gateCalls.push(input); return verdict(input); },
    audit: (dir, pane, command, now = NOW) => { audits.push({ dir, pane, command, now }); },
    ...rest,
  };
  return { io, sources, gateCalls, audits, typed, keys, read, run: (argv: string[] = []) => runDown(argv, io, sources) };
}

/** A gate that refuses the given id, and fails the test if it is asked at all. */
const refusing = (id: string, text: string) => (input: GateInput): DelegateVerdict => {
  void input;
  return { kind: 'refused', id, text };
};
const neverAsked = (input: GateInput): DelegateVerdict => {
  throw new Error(`the gate must not be asked: ${input.command}`);
};

describe('a file with no delegate', () => {
  test('a refused down keeps today\'s bytes, and the gate is never asked', async () => {
    writeFileSync(file, teamFile(null));
    const withGate = rig({ gate: neverAsked });
    expect(await withGate.run()).toBe(1);
    // Byte for byte: the same run with no gate seam at all.
    const plain = rig({ gate: undefined });
    expect(await plain.run()).toBe(1);
    expect(withGate.io.out).toBe(plain.io.out);
    expect(withGate.io.err).toBe(plain.io.err);
    expect(withGate.io.err).toBe(`team down: ${ORDINARY}\n`);
    expect(withGate.io.out).not.toContain('/exit');
  });

  test('a dry run keeps today\'s would-refuse line and plan, and the gate is never asked', async () => {
    writeFileSync(file, teamFile(null));
    const r = rig({ gate: neverAsked });
    expect(await r.run(['--dry-run'])).toBe(1);
    expect(r.io.out).toContain(`! down would refuse: ${ORDINARY}\n`);
    expect(r.io.out).toContain('claude-coordinator-acme:p1 /exit');
  });

  test('the owner asks nothing', async () => {
    const r = rig({ gate: neverAsked }, { kind: 'owner' });
    expect(await r.run(['--dry-run'])).toBe(0);
    expect(r.io.out).toContain('claude-coordinator-acme:p1 /exit');
  });

  // A lead seat keeps its own authority with a delegates section in the file: the ordinary rule
  // lets it through, and a caller the ordinary rule accepts never enters the delegate branch.
  const COORDINATOR: Caller = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' };

  const recordStanding = (pane: string, session = 'acme-web', name = COORDINATOR.name): void => {
    updateState(join(root, '.agents'), (state) => {
      const held = (state.sessions[session] ??= emptySession());
      held.seats[name] = { stage: 'ready', pane };
    });
  };

  test('a standing coordinator asks nothing, and its plan keeps the team\'s own seats', async () => {
    recordStanding('w1:p1');
    const r = rig({ gate: neverAsked }, COORDINATOR);
    expect(await r.run(['--dry-run'])).toBe(0);
    expect(r.gateCalls).toEqual([]);
    expect(r.io.err).toBe('');
    // Today's plan for a seat: the coordinator and the operator are left running.
    expect(r.io.out).toContain('left running');
  });

  // The operator is no longer the rule's second leg: the map admits the owner or `leads` for
  // this team, and the operator seat holds neither. Its own call meets the ordinary sentence,
  // and the delegate branch — asked only when the ordinary rule refuses — answers it; with no
  // entry its pane can pass, that answer is the run's.
  test('the operator seat is refused by the map, and the delegate branch answers it', async () => {
    // A lead seat must be declared, single and running: the fixture's second seat is parked, so
    // this file names it as the operator and unpark it.
    writeFileSync(file, teamFile(delegate(['up', 'down']))
      .replace(/^operator: .*$/m, 'operator: codex-acme')
      .replace(/^    parked: true\s*$/m, ''));
    const OPERATOR: Caller = { kind: 'seat', name: 'codex-acme', pane: 'w2:p1', session: 'acme-web' };
    recordStanding('w2:p1', 'acme-web', OPERATOR.name);
    const r = rig({}, OPERATOR);
    expect(await r.run()).toBe(1);
    expect(r.gateCalls.length).toBe(1);
    expect(r.io.err).toBe(`team down: ${GATE_DOWN}\n`);
    // A refused caller writes no audit line, whatever the gate said, and nothing is typed.
    expect(r.audits).toEqual([]);
    expect(r.typed).toEqual([]);
  });

  test('a pane named like the coordinator but standing elsewhere is a delegate, and keeps nobody', async () => {
    recordStanding('w9:p9', 'work');
    // The name matches; the placement does not — the state recorded another pane, in a session
    // this call is not in. So the ordinary rule refuses it, the gate is asked, and the run it
    // passes is the delegate's: every seat is stopped, the name on the pane notwithstanding.
    const r = rig({ gate: () => PASSED }, { ...COORDINATOR, session: 'work' });
    expect(await r.run(['--dry-run'])).toBe(0);
    expect(r.gateCalls.length).toBe(1);
    for (const name of RUNNING) expect(r.io.out).toContain(`${name}:p1 /exit`);
    expect(r.io.out).not.toContain('left running');
  });
});

describe('a delegated down', () => {
  test('a dry run plans the whole team, asks the gate once, and writes no audit line', async () => {
    const r = rig({ gate: () => PASSED });
    expect(await r.run(['--dry-run'])).toBe(0);
    expect(r.io.err).toBe('');
    for (const name of RUNNING) expect(r.io.out).toContain(`${name}:p1 /exit`);
    // The delegate's plan keeps nobody back, coordinator and operator included.
    expect(r.io.out).not.toContain('left running');
    expect(r.audits).toEqual([]);
    expect(r.typed).toEqual([]);

    expect(r.gateCalls.length).toBe(1);
    const ask = r.gateCalls[0]!;
    expect(ask.command).toBe('down');
    expect([...ask.flags].sort()).toEqual(['dry-run']);
    expect(ask.team.delegates).toEqual([{ pane: PANE, commands: ['up', 'down'] }]);
    expect(ask.root).toBe(root);
    expect(ask.dir).toBe(join(root, '.agents'));
    expect(ask.io.caller).toEqual(CALLER);
  });

  test('a real run stops the whole team and leaves the audit line', async () => {
    const r = rig({ gate: () => PASSED });
    expect(await r.run()).toBe(0);
    expect(r.io.err).toBe('');
    expect(r.typed).toEqual(['/exit', '/exit', '/exit']);
    expect(r.audits).toEqual([{ dir: join(root, '.agents'), pane: PANE, command: 'down', now: NOW }]);
  });

  test('seats whose CLI exited are closed without typing: the delegate needs no --abandon', async () => {
    // The bug this fix closes: the panes are bare shells, the gate passes the caller and the
    // ordinary run closes every seat — nothing typed, `--abandon` never asked for — and the
    // session follows its last seat down.
    const r = rig({
      gate: () => PASSED,
      screen: () => ({ kind: 'unknown' }),
      foreground: () => ['zsh'],
      shellBack: () => true,
    });
    expect(await r.run()).toBe(0);
    expect(r.io.err).toBe('');
    expect(r.typed).toEqual([]);
    expect(r.keys).toEqual([]);
    for (const name of RUNNING) expect(r.io.out).toContain(`${name}: its CLI had exited; its workspace was closed\n`);
    // The rig answers `sessionRunning` with a constant `true`, so the clear retry ends where it
    // must; the line proves this run stopped the session itself.
    expect(r.io.out).toContain('session acme-web: stopped; it did not clear\n');
    expect(r.io.out).not.toContain('does not recognise');
    expect(r.audits).toEqual([{ dir: join(root, '.agents'), pane: PANE, command: 'down', now: NOW }]);
  });

  test('a live CLI on an unreadable screen keeps the delegate\'s refusal, byte for byte', async () => {
    // Nothing the gate lets through widens: with the CLI still in the foreground list, the same
    // delegated run keeps today's line for every seat and leaves the session up.
    const r = rig({ gate: () => PASSED, screen: () => ({ kind: 'unknown' }) });
    expect(await r.run()).toBe(0);
    expect(r.io.err).toBe('');
    expect(r.typed).toEqual([]);
    for (const name of RUNNING) expect(r.io.out).toContain(`${name}: shows a screen the profile does not recognise; left running\n`);
    expect(r.io.out).toContain('session acme-web: not stopped, 3 agents left in it\n');
  });

  test('an already-idle down stops nothing, asks nothing and writes no audit line', async () => {
    // It returns before any caller check, as today: the gate is not a caller check that happens
    // first, and a delegate's idle run is the same "nothing to stop" every caller gets.
    const r = rig({ gate: neverAsked, sessionRunning: () => false });
    expect(await r.run()).toBe(0);
    expect(r.io.out).toBe('session acme-web is not running: nothing to stop\n');
    expect(r.gateCalls).toEqual([]);
    expect(r.typed).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  // The three states a target session can be in, as `down` reads them: a stopped session and an
  // absent one are the same `false` from `sessionRunning`, and both are the idle answer every
  // caller gets — the gate is never asked, because the idle check comes before it. A herdr that
  // doesn't answer is the second state's own refusal, before the gate too. `neverAsked` is the
  // proof: it fails the test the moment the gate is reached.
  test('a target session that is stopped or absent is the idle answer, real and dry, gate unasked', async () => {
    for (const argv of [[], ['--dry-run']] as const) {
      const r = rig({ gate: neverAsked, sessionRunning: () => false });
      expect(await r.run([...argv])).toBe(0);
      expect(r.io.out).toBe(
        `session acme-web is not running: nothing to stop${argv.length === 0 ? '' : '\ndry run: nothing was run'}\n`,
      );
      expect(r.io.err).toBe('');
      expect(r.gateCalls).toEqual([]);
      expect(r.audits).toEqual([]);
      expect(r.typed).toEqual([]);
    }
  });

  test('a herdr that does not answer is exit 2 with its own line, gate unasked', async () => {
    for (const argv of [[], ['--dry-run']] as const) {
      const r = rig({ gate: neverAsked, sessionRunning: () => null });
      expect(await r.run([...argv])).toBe(2);
      expect(r.io.out).toBe('');
      expect(r.io.err).toBe("team down: herdr doesn't answer; is it installed and running?\n");
      expect(r.gateCalls).toEqual([]);
      expect(r.typed).toEqual([]);
    }
  });

  test('--wait is a delegate form: it waits, then stops the whole team', async () => {
    let clock = NOW.getTime();
    let working = true;
    const r = rig({
      gate: () => PASSED,
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; working = false; },
      agents: () => RUNNING.map((name) => agent(name, working ? 'working' : 'idle')),
    });
    expect(await r.run(['--wait'])).toBe(0);
    expect(r.gateCalls[0]!.flags).toContain('wait');
    expect(r.typed).toEqual(['/exit', '/exit', '/exit']);
    expect(r.audits.length).toBe(1);
  });
});

describe('a delegate\'s refused flags', () => {
  test('--abandon: the gate\'s words, and nothing is abandoned', async () => {
    const r = rig({ gate: refusing('down.delegate-flag', flagText('abandon')) });
    expect(await r.run(['--abandon'])).toBe(1);
    expect(r.io.err).toBe(`team down: ${flagText('abandon')}\n`);
    expect(r.io.out).toBe('');
    expect(r.typed).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  test('--abandon on a dry run: the refusal, then the plan, exit 1', async () => {
    const r = rig({ gate: refusing('down.delegate-flag', flagText('abandon')) });
    expect(await r.run(['--dry-run', '--abandon'])).toBe(1);
    const [first = '', ...rest] = r.io.out.split('\n');
    expect(first).toBe(`! down would refuse: ${flagText('abandon')}`);
    expect(r.io.out).toContain('/exit');
    expect(rest.join('\n')).not.toContain('abandon');
    expect(r.audits).toEqual([]);
  });

  test('--file: the gate\'s words, and the flagged path is never opened', async () => {
    const elsewhere = join(base, 'elsewhere');
    const r = rig({ gate: refusing('down.delegate-flag', flagText('file')) });
    expect(await r.run(['--file', join(elsewhere, 'team.yaml')])).toBe(1);
    expect(r.io.err).toBe(`team down: ${flagText('file')}\n`);
    expect(r.io.err).not.toContain('no team file at');
    expect(existsSync(elsewhere)).toBe(false);
  });

  test('--session: the gate\'s words, and only the file\'s session is read', async () => {
    const r = rig({ gate: refusing('down.delegate-flag', flagText('session')) });
    expect(await r.run(['--session', 'other'])).toBe(1);
    expect(r.io.err).toBe(`team down: ${flagText('session')}\n`);
    expect(r.read.length).toBeGreaterThan(0);
    expect(r.read.every((session) => session === 'acme-web')).toBe(true);
  });
});

// The order these three pin, read off runs of the branch: on an already-idle session the
// command's own `--file` refusal still comes first — the gate asked or not — and a placed
// delegate's gate refusal does not: it is held, and the idle return wins with its words unprinted.
describe('a flag aimed at an already-idle session', () => {
  const FILE_OWNER = "--file is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)";

  test('the command\'s own --file refusal comes first, and the gate is never asked', async () => {
    writeFileSync(file, teamFile(null));
    const elsewhere = join(base, 'elsewhere', 'team.yaml');
    const r = rig({ gate: neverAsked, sessionRunning: () => false });
    expect(await r.run(['--file', elsewhere])).toBe(1);
    expect(r.io.err).toBe(`team down: ${FILE_OWNER}\n`);
    expect(r.io.out).toBe('');
    expect(r.gateCalls).toEqual([]);
    expect(existsSync(join(base, 'elsewhere'))).toBe(false);
  });

  test('with a delegate section the gate is asked, and the same refusal still comes first', async () => {
    const elsewhere = join(base, 'elsewhere', 'team.yaml');
    const reads: string[] = [];
    // A gate that refuses without placing the caller: the delegates section's ordinary answer
    // for this caller. Its words never surface — the refusal printed is the command's own.
    const r = rig({
      gate: refusing('down.delegate', GATE_DOWN),
      sessionRunning: (session) => { reads.push(session); return false; },
      agents: (session) => { reads.push(session); return []; },
    });
    expect(await r.run(['--file', elsewhere])).toBe(1);
    expect(r.io.err).toBe(`team down: ${FILE_OWNER}\n`);
    expect(r.io.err).not.toContain(GATE_DOWN);
    expect(r.gateCalls.length).toBe(1);
    expect(reads).toEqual([]);
    expect(existsSync(join(base, 'elsewhere'))).toBe(false);
  });

  test('a placed delegate\'s --file: the gate is asked, its refusal is held, and idle wins', async () => {
    const elsewhere = join(base, 'elsewhere', 'team.yaml');
    const r = rig({ gate: refusing('down.delegate-flag', flagText('file')), sessionRunning: () => false });
    expect(await r.run(['--file', elsewhere])).toBe(0);
    expect(r.io.out).toBe('session acme-web is not running: nothing to stop\n');
    expect(r.io.err).toBe('');
    expect(r.gateCalls.length).toBe(1);
    expect(existsSync(join(base, 'elsewhere'))).toBe(false);
  });
});

describe('a refused gate', () => {
  test('its words take the ordinary refusal\'s place, and its dry run prints the plan', async () => {
    const real = rig({ gate: refusing('down.delegate', GATE_DOWN) });
    expect(await real.run()).toBe(1);
    expect(real.io.err).toBe(`team down: ${GATE_DOWN}\n`);
    expect(real.io.err).not.toContain('only the owner, the orchestrator or the operator');
    expect(real.typed).toEqual([]);

    const dry = rig({ gate: refusing('down.delegate', GATE_DOWN) });
    expect(await dry.run(['--dry-run'])).toBe(1);
    expect(dry.io.out).toContain(`! down would refuse: ${GATE_DOWN}\n`);
    expect(dry.io.out).toContain('/exit');
  });

  test('an unlisted down is refused, and its plan is still the delegate\'s', async () => {
    const real = rig({ gate: refusing('down.delegate-command', GATE_COMMAND) });
    expect(await real.run()).toBe(1);
    expect(real.io.err).toBe(`team down: ${GATE_COMMAND}\n`);

    const dry = rig({ gate: refusing('down.delegate-command', GATE_COMMAND) });
    expect(await dry.run(['--dry-run'])).toBe(1);
    const [first = ''] = dry.io.out.split('\n');
    expect(first).toBe(`! down would refuse: ${GATE_COMMAND}`);
    // The caller is the approved pane, so the plan it shows is the delegate's: nobody is kept.
    expect(dry.io.out).not.toContain('left running');
  });

  test('a refusal before placement leaves a flagged run with today\'s flag refusal', async () => {
    // The gate's preflight comes first: a caller it never placed is refused, for `--file`, by
    // the rule every non-owner meets today — and the flagged path is not opened either way.
    const elsewhere = join(base, 'elsewhere');
    const r = rig({ gate: refusing('down.delegate-approval', GATE_DOWN) });
    expect(await r.run(['--file', join(elsewhere, 'team.yaml')])).toBe(1);
    expect(r.io.err).toBe(
      `team down: --file is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n`,
    );
    expect(existsSync(elsewhere)).toBe(false);
  });
});

describe('the live file is the only delegate authority', () => {
  test('a file that does not load carries no delegate: the remembered copy runs the ordinary rule', async () => {
    // A good read first, so a valid copy — this one carrying the delegate — is remembered.
    expect(currentTeam(root, undefined, NOW, home).ok).toBe(true);
    writeFileSync(file, 'project: acme-web\nseats: [\n');
    const r = rig({ gate: neverAsked });
    expect(await r.run()).toBe(1);
    expect(r.io.out).toContain('using the copy of');
    expect(r.io.out).not.toContain('/exit');
    expect(r.io.err).toBe(`team down: ${ORDINARY}\n`);
  });

  test('a delegated run remembers nothing: `currentTeam` never ran', async () => {
    const r = rig({ gate: () => PASSED });
    expect(await r.run()).toBe(0);
    // The run's own effects write the state (a stopped seat is dropped from it), but neither
    // `currentTeam` nor anything else beside the live read remembers the file it acted on.
    const state: Record<string, unknown> = JSON.parse(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8'));
    expect(state.last_valid).toBeUndefined();
  });
});
