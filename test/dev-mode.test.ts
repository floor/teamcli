// TEAMCLI_DEV_MODE=1 turns the no-approval refusal, the approved-copy mismatch, and the
// caller-placement refusal into one warning and mounts the live file. `team down`, `team tempo`
// and `team broker` turn their caller-placement refusal into the same kind of warning — the
// file's own orchestrator and operator excepted, refused in every mode. Unset, each refusal
// stands. The run writes no approval, no signing key and no grant.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runBroker } from '../src/commands/broker.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runTempo } from '../src/commands/tempo.ts';
import { brokerSocket } from '../src/broker/protocol.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { keyFolder } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readState } from '../src/state.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const IDLE = CLAUDE_IDLE;
const NOW = new Date('2026-10-15T12:00:00Z');
const UNPLACED = { kind: 'unplaced' as const, reason: 'it runs under herdr' };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string): string {
  return `format: 1
project: acme
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
`;
}

function repo(builder: (root: string) => string = file): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-mode-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), builder(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const panes: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.push(pane);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => panes,
    agents: () => [],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
    spawnWatch: () => 1,
  };
  return { launch, runs };
}

function sources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(home),
    launch,
    now: () => NOW,
  };
}

/** Approval records, the signing key, and a grant file. A rules file or a pane pointer is a mount. */
function approvalArtifacts(home: string, root: string): string[] {
  const found: string[] = [];
  if (existsSync(keyFolder(home))) found.push(keyFolder(home));
  const store = storePath('acme', root, home);
  for (const name of ['approval.json', 'approved.yaml']) {
    const path = join(store, name);
    if (existsSync(path)) found.push(path);
  }
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name === 'approval.json' || name === 'approved.yaml' || name === 'grant.json') found.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // A name that vanished between the read and the stat is not an artifact.
      }
    }
  };
  walk(home);
  return found;
}

test('an unapproved file refuses, and the same file mounts when TEAMCLI_DEV_MODE=1', async () => {
  const refused = repo();
  const refusedWorld = world();
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runUp([], refusedIo, sources(refused.home, refusedWorld.launch));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toBe('deny\n');
  expect(refusedIo.out).toBe('');
  expect(refusedWorld.runs).toEqual([]);
  expect(approvalArtifacts(refused.home, refused.root)).toEqual([]);

  const mounted = repo();
  const mountedWorld = world();
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const mountedCode = await runUp([], mountedIo, sources(mounted.home, mountedWorld.launch));
  expect(mountedCode).toBe(0);
  expect(mountedIo.err).toContain('team up: warning:');
  expect(mountedIo.err).toContain('only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr)');
  expect(mountedIo.err).toContain('the file was never approved on this machine');
  expect(mountedIo.err).not.toContain('team approve');
  expect(mountedIo.err).not.toContain('team up: only the owner runs `up`');
  expect(mountedIo.err).not.toContain('team up: the file was never approved');
  expect(mountedIo.err).not.toContain('team up: run `team approve`');
  expect(mountedWorld.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
  expect(readState(join(mounted.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  expect(approvalArtifacts(mounted.home, mounted.root)).toEqual([]);
});

/** Bytes of every approval, key, and grant under home. A rules file is not one of these. */
function durableBytes(home: string): string {
  const found: string[] = [];
  const take = (path: string) => {
    found.push(`${path}\n${readFileSync(path)}`);
  };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (directory) walk(path);
      else if (name === 'approval.json' || name === 'approved.yaml' || name === 'grant.json') take(path);
    }
  };
  walk(home);
  const keys = keyFolder(home);
  if (existsSync(keys)) {
    const walkKey = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walkKey(path);
        else take(path);
      }
    };
    walkKey(keys);
  }
  return found.sort().join('\n---\n');
}

function approve(home: string, root: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const text = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

test('an approved file that has since changed refuses, and the same file mounts when TEAMCLI_DEV_MODE=1', async () => {
  const refused = repo();
  approve(refused.home, refused.root);
  const refusedPath = join(refused.root, '.agents', 'team.yaml');
  writeFileSync(refusedPath, readFileSync(refusedPath, 'utf8').replace(
    'claude --model claude-opus-5-5',
    'claude --model claude-opus-5-5 --live-mount',
  ));
  const before = durableBytes(refused.home);
  const refusedWorld = world();
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runUp([], refusedIo, sources(refused.home, refusedWorld.launch));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toBe('deny\n');
  expect(refusedIo.out).toBe('');
  expect(refusedWorld.runs).toEqual([]);
  expect(durableBytes(refused.home)).toBe(before);

  const mounted = repo();
  approve(mounted.home, mounted.root);
  const mountedPath = join(mounted.root, '.agents', 'team.yaml');
  writeFileSync(mountedPath, readFileSync(mountedPath, 'utf8').replace(
    'claude --model claude-opus-5-5',
    'claude --model claude-opus-5-5 --live-mount',
  ));
  const mountedBefore = durableBytes(mounted.home);
  const mountedWorld = world();
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const mountedCode = await runUp([], mountedIo, sources(mounted.home, mountedWorld.launch));
  expect(mountedCode).toBe(0);
  expect(mountedIo.err).toContain('team up: warning:');
  expect(mountedIo.err).toContain('only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr)');
  expect(mountedIo.err).not.toContain('not the approved one');
  expect(mountedIo.err).not.toContain('team approve');
  expect(mountedWorld.runs.map((run) => run.command).join('\n')).toContain('--live-mount');
  expect(readState(join(mounted.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  expect(durableBytes(mounted.home)).toBe(mountedBefore);
  expect(durableBytes(mounted.home)).not.toContain('grant.json');
});

test('team down refuses an unplaced caller, and the same call stops the team when TEAMCLI_DEV_MODE=1', async () => {
  const placement = 'only the owner or `leads` stops the team; this call is unplaced (it runs under herdr)';
  const refused = repo();
  approve(refused.home, refused.root);
  const refusedBefore = durableBytes(refused.home);
  const refusedStopped = { n: 0 };
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runDown([], refusedIo, downSources(refused.home, refusedStopped));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toContain(`team down: ${placement}\n`);
  expect(refusedStopped.n).toBe(0);
  expect(durableBytes(refused.home)).toBe(refusedBefore);

  const stopped = repo();
  approve(stopped.home, stopped.root);
  const stoppedBefore = durableBytes(stopped.home);
  const didStop = { n: 0 };
  const stoppedIo = testIo(stopped.root, UNPLACED);
  stoppedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const stoppedCode = await runDown([], stoppedIo, downSources(stopped.home, didStop));
  expect(stoppedCode).toBe(0);
  expect(stoppedIo.err).toContain('team down: warning:');
  expect(stoppedIo.err).toContain(placement);
  expect(stoppedIo.err).not.toContain('team down: only the owner, the orchestrator or the operator stops the team');
  expect(didStop.n).toBe(1);
  expect(durableBytes(stopped.home)).toBe(stoppedBefore);
  expect(durableBytes(stopped.home)).not.toContain('grant.json');
});

function downSources(home: string, stopped: { n: number }): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => {
        stopped.n += 1;
        return true;
      },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

/** The file with a Linear task source, the one shape `team broker` will serve. */
function linear(root: string): string {
  return `${file(root)}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
`;
}

test('team tempo refuses an unplaced caller, and the same call writes the word when TEAMCLI_DEV_MODE=1', async () => {
  const placement = 'only the owner runs tempo, from a terminal outside herdr; this call is unplaced (it runs under herdr)';
  const refused = repo();
  const refusedPath = join(refused.root, '.agents', 'team.yaml');
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runTempo(['urgent'], refusedIo, { home: refused.home })).toBe(1);
  expect(refusedIo.err).toBe(`team tempo: ${placement}\n`);
  expect(readFileSync(refusedPath, 'utf8')).not.toContain('tempo:');

  const mounted = repo();
  const mountedPath = join(mounted.root, '.agents', 'team.yaml');
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], mountedIo, { home: mounted.home })).toBe(0);
  expect(mountedIo.err).toContain(`team tempo: warning: ${placement}; dev mode continues\n`);
  expect(readFileSync(mountedPath, 'utf8')).toContain('tempo: urgent');

  // The file's own orchestrator and operator stay refused in every mode.
  const lead = repo();
  const leadPath = join(lead.root, '.agents', 'team.yaml');
  const leadIo = testIo(lead.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
  leadIo.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], leadIo, { home: lead.home })).toBe(1);
  expect(leadIo.err).toBe('team tempo: only the owner runs tempo, from a terminal outside herdr; this call is lead\n');
  expect(readFileSync(leadPath, 'utf8')).not.toContain('tempo:');
});

test('team broker refuses an unplaced caller, and the same call reaches the socket when TEAMCLI_DEV_MODE=1', async () => {
  const placement = 'only the owner runs `broker`, from a terminal outside herdr; this call is unplaced (it runs under herdr)';
  const keyReader = async () => ({ ok: true as const, key: 'test-key-not-real' });
  // A regular file where the socket belongs: a run past every gate ends on that one line, and
  // the credential read stands between the placement gate and it.
  const refused = repo(linear);
  writeFileSync(brokerSocket(refused.root), 'not a socket');
  const reads = { n: 0 };
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runBroker([], refusedIo, {
    home: refused.home,
    keyReader: async () => {
      reads.n += 1;
      return { ok: true as const, key: 'test-key-not-real' };
    },
  })).toBe(1);
  expect(refusedIo.err).toBe(`team broker: ${placement}\n`);
  expect(reads.n).toBe(0);

  const mounted = repo(linear);
  writeFileSync(brokerSocket(mounted.root), 'not a socket');
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runBroker([], mountedIo, {
    home: mounted.home,
    keyReader: async () => {
      reads.n += 1;
      return { ok: true as const, key: 'test-key-not-real' };
    },
  })).toBe(1);
  expect(mountedIo.err).toContain(`team broker: warning: ${placement}; dev mode continues\n`);
  expect(mountedIo.err).toContain('team broker: the socket could not be bound\n');
  expect(reads.n).toBe(1);

  // The file's own orchestrator and operator stay refused in every mode, before the credential.
  const lead = repo(linear);
  writeFileSync(brokerSocket(lead.root), 'not a socket');
  const leadIo = testIo(lead.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
  leadIo.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runBroker([], leadIo, { home: lead.home, keyReader })).toBe(1);
  expect(leadIo.err).toBe('team broker: only the owner runs `broker`, from a terminal outside herdr; this call is lead\n');
  expect(reads.n).toBe(1);
});

function separateOperator(root: string): string {
  return file(root).replace('operator: lead', 'operator: operator') + `  - role: operator
    name: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

for (const name of ['lead', 'operator']) {
  test(`dev mode keeps ${name}'s own tempo and broker placement guards`, async () => {
    const made = repo(separateOperator);
    const path = join(made.root, '.agents', 'team.yaml');
    const before = readFileSync(path, 'utf8');
    const caller = { kind: 'seat' as const, name, pane: 'w1:p1', session: 'acme' };
    const tempoIo = testIo(made.root, caller);
    tempoIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runTempo(['urgent'], tempoIo, { home: made.home })).toBe(1);
    expect(tempoIo.err).toContain(`this call is ${name}`);
    expect(tempoIo.err).not.toContain('dev mode continues');
    expect(readFileSync(path, 'utf8')).toBe(before);

    const brokerIo = testIo(made.root, caller);
    brokerIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runBroker([], brokerIo, {
      home: made.home,
      keyReader: async () => { throw new Error('a refused seat read credentials'); },
    })).toBe(1);
    expect(brokerIo.err).toContain(`this call is ${name}`);
    expect(brokerIo.err).not.toContain('dev mode continues');
  });
}

for (const value of ['', '0', 'true']) {
  test(`dev mode ${JSON.stringify(value)} does not waive tempo or broker placement`, async () => {
    const made = repo();
    const tempoIo = testIo(made.root, UNPLACED);
    tempoIo.env = { TEAMCLI_DEV_MODE: value };
    expect(await runTempo(['urgent'], tempoIo, { home: made.home })).toBe(1);
    expect(tempoIo.err).not.toContain('dev mode continues');
    const brokerIo = testIo(made.root, UNPLACED);
    brokerIo.env = { TEAMCLI_DEV_MODE: value };
    expect(await runBroker([], brokerIo, {
      home: made.home,
      keyReader: async () => { throw new Error('a refused caller read credentials'); },
    })).toBe(1);
    expect(brokerIo.err).not.toContain('dev mode continues');
  });
}
