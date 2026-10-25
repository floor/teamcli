// A run a create-grant admitted trusts the folder a lead seat starts in — the project — in that
// seat's CLI record, so the CLI's folder dialog never meets a run with no terminal. The fake
// herdr below plays that dialog: a pane started in a folder `~/.claude.json` has not accepted
// shows the trust screen, so a missing record is a seat that never becomes ready.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { grantsDir } from '../src/grant.ts';
import { grantedFolderPretrust, type PretrustSeat } from '../src/launch/pretrust.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { readState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const TEAM = 'aaaaaaaaaaaa';

/** The seat the record names, as herdr places it. */
const grantedSeat = { kind: 'seat', name: 'orchestrator', pane: 'lead-pane', session: 'dispatch' } as const;
/** A placed seat no record names: registered nowhere, so it has no registry record. */
const strangerSeat = { kind: 'seat', name: 'builder-1', pane: 'builder-pane', session: 'dispatch' } as const;

const IDLE = CLAUDE_IDLE;
const TRUST_DIALOG = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');
const AMPLE: Machine = {
  loadPerCore: 0.2,
  memoryFree: 80,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

const SEAT = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

// These tests are about grants, so the team names its session: with the session omitted and an
// entity set, the session follows the entity (`<entity>-<project>`), and every expectation here
// reads the session under the project's own name.
function teamFile(project: string, trust: string[]): string {
  return `format: 1
project: ${project}
entity: beacon
session: ${project}
operator: orchestrator
trust:
${trust.map((entry) => `  - ${entry}`).join('\n')}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}`;
}

function makeSandbox() {
  const base = realpathSync(mkdtempSync('/tmp/gp-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  const code = join(home, 'Code', 'beacon');
  mkdirSync(code, { recursive: true });
  const lobby = join(home, '.config', 'team', 'lobbies', 'beacon');
  return { base, home, code, lobby };
}

function writeGrant(home: string, agentId: string, paths: string[]): void {
  const body = `entity: beacon\nagent: ${agentId}\npaths:\n${paths
    .map((entry) => `  - ${entry}`)
    .join('\n')}\nexpires: "${FUTURE}"\n`;
  writeFileSync(join(grantsDir(home), 'beacon.yaml'), body);
}

/** The seat the record names, registered where herdr places it. */
function registerSeat(home: string): string {
  return registerAgent(home, {
    name: 'orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: TEAM, seat: 'orchestrator', session: 'dispatch', pane: 'lead-pane', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }).id;
}

function project(sb: ReturnType<typeof makeSandbox>, name: string, trust: (root: string) => string[]): string {
  const root = join(sb.code, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(`beacon-${name}`, trust(root)));
  return root;
}

/** The CLI's own record, as the dialog reads it. */
function claudeTrusts(home: string, folder: string): boolean {
  const file = join(home, '.claude.json');
  if (!existsSync(file)) return false;
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  return doc.projects?.[folder]?.hasTrustDialogAccepted === true;
}

/** A herdr whose panes show the CLI's trust dialog until the record for their folder exists. */
function dialogHost(home: string) {
  let clock = NOW.getTime();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { cwd: string; agent: boolean }>();
  const host = {
    closed: 0,
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session: string, cwd: string) {
      n += 1;
      const pane = `seat-pane-${n}`;
      panes.set(pane, { cwd, agent: false });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session: string, pane: string) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    spawnWatch: () => 4242,
    renameAgent: () => true,
    closeWorkspace() {
      host.closed += 1;
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText(_session: string, pane: string) {
      const known = panes.get(pane);
      if (!known?.agent) return '';
      return claudeTrusts(home, known.cwd) ? IDLE : TRUST_DIALOG;
    },
    foreground: () => ['claude'],
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return host;
}

function terminal(): Terminal & { reads: number } {
  return {
    reads: 0,
    async key() {
      this.reads += 1;
      throw new Error('the pause read the terminal');
    },
    drain() {},
  };
}

function sourcesOf(home: string, host: Launch & { now(): Date; sleep(ms: number): Promise<void> }, term: Terminal): UpSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: host.now,
    sleep: host.sleep,
    machine: () => AMPLE,
    terminal: () => term,
    launch: host,
  };
}

describe('create-grant folder pretrust on up', () => {
  test('a registry-id grant writes the project folder into the CLI record and the lead is not left at the dialog', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, registerSeat(sb.home), ['~/Code/beacon']);
      const root = project(sb, 'v1', (r) => [sb.lobby, r]);
      const host = dialogHost(sb.home);
      const keys = terminal();
      const io = testIo(root, grantedSeat);
      const code = await runUp([], io, sourcesOf(sb.home, host, keys));
      expect(code, `${io.err}${io.out}`).toBe(0);
      expect(claudeTrusts(sb.home, root)).toBe(true);
      // The launch shows no trust wait: nothing was left at the dialog, nothing read the terminal.
      expect(io.out + io.err).not.toContain('trust (no terminal for owner)');
      expect(keys.reads).toBe(0);
      expect(host.closed).toBe(0);
      const seats = readState(join(root, '.agents')).sessions['beacon-v1']?.seats ?? {};
      expect(seats.orchestrator?.stage).toBe('ready');
      expect(seats['builder-1']?.stage).toBe('ready');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a caller the grant does not admit writes no project record', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, registerSeat(sb.home), ['~/Code/beacon']);
      const root = project(sb, 'v2', (r) => [sb.lobby, r]);
      const host = dialogHost(sb.home);
      const io = testIo(root, strangerSeat);
      const code = await runUp([], io, sourcesOf(sb.home, host, terminal()));
      expect(code).toBe(1);
      expect(claudeTrusts(sb.home, root)).toBe(false);
      expect(existsSync(join(sb.home, '.claude.json'))).toBe(false);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a folder the team file does not list is not trusted, even under an admitting grant', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, registerSeat(sb.home), ['~/Code/beacon']);
      const root = project(sb, 'v3', () => [sb.lobby]);
      const host = dialogHost(sb.home);
      const io = testIo(root, grantedSeat);
      await runUp([], io, sourcesOf(sb.home, host, terminal()));
      expect(claudeTrusts(sb.home, root)).toBe(false);
      const seats = readState(join(root, '.agents')).sessions['beacon-v3']?.seats ?? {};
      expect(seats.orchestrator?.stage).not.toBe('ready');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a dry run writes no record', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, registerSeat(sb.home), ['~/Code/beacon']);
      const root = project(sb, 'v4', (r) => [sb.lobby, r]);
      const host = dialogHost(sb.home);
      const io = testIo(root, grantedSeat);
      const code = await runUp(['--dry-run'], io, sourcesOf(sb.home, host, terminal()));
      expect(code, `${io.err}${io.out}`).toBe(0);
      expect(existsSync(join(sb.home, '.claude.json'))).toBe(false);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      stdio: 'ignore',
      env: gitEnv(),
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'initial');
}

describe('create-grant folder pretrust after init', () => {
  test("a grant-created team's skeleton trust: already lists the project, so up trusts it with no edit", async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, registerSeat(sb.home), ['~/Code/beacon']);
      const root = join(sb.code, 'v5');
      initGitRepo(root);
      const initIo = testIo(root, grantedSeat);
      const login = { loggedIn: (profile: { cli: string }) => profile.cli === 'claude-code', now: () => NOW };
      expect(await runInit([], initIo, sb.home, undefined, login), `${initIo.err}${initIo.out}`).toBe(0);
      const file = join(root, '.agents', 'team.yaml');
      const skeleton = readFileSync(file, 'utf8');
      expect(skeleton).toContain(`trust:\n  - ~/.config/team/lobby\n  - ${root}\n`);

      const host = dialogHost(sb.home);
      const keys = terminal();
      const upIo = testIo(root, grantedSeat);
      const code = await runUp([], upIo, sourcesOf(sb.home, host, keys));
      expect(code, `${upIo.err}${upIo.out}`).toBe(0);
      // The file is the skeleton `init` wrote: trust: was never edited to make this work.
      expect(readFileSync(file, 'utf8')).toBe(skeleton);
      expect(claudeTrusts(sb.home, root)).toBe(true);
      expect(keys.reads).toBe(0);
      const seats = readState(join(root, '.agents')).sessions['v5']?.seats ?? {};
      expect(seats.orchestrator?.stage).toBe('ready');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe('grantedFolderPretrust', () => {
  const lead = (cwd: string, extra: Partial<PretrustSeat> = {}): PretrustSeat => ({ cli: 'claude-code', cwd, ...extra });

  function folderOf() {
    const base = realpathSync(mkdtempSync('/tmp/gp-unit-'));
    const home = join(base, 'home');
    const folder = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(folder, { recursive: true });
    return { base, home, folder: realpathSync(folder) };
  }
  const yes = { covers: () => true, listed: () => true };

  test('writes the folder when the grant covers it and the file lists it', () => {
    const f = folderOf();
    try {
      expect(grantedFolderPretrust(lead(f.folder), f.home, { now: NOW, grant: yes })).toBe(true);
      expect(claudeTrusts(f.home, f.folder)).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test('writes nothing for a folder outside the grant or outside the file trust', () => {
    const f = folderOf();
    try {
      for (const grant of [
        { covers: () => false, listed: () => true },
        { covers: () => true, listed: () => false },
      ]) {
        expect(grantedFolderPretrust(lead(f.folder), f.home, { now: NOW, grant })).toBe(false);
      }
      expect(existsSync(join(f.home, '.claude.json'))).toBe(false);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test('writes nothing for a lobby seat, a seat that does not start now, or an unknown CLI', () => {
    const f = folderOf();
    try {
      const skipped: PretrustSeat[] = [
        lead(f.folder, { lobby: true }),
        lead(f.folder, { stopped: true }),
        lead(f.folder, { launchProblem: 'refused' }),
        lead(f.folder, { stage: 'ready', pane: 'p1', agentLive: true }),
        lead(f.folder, { budget: { kind: 'refuse' } }),
        { cli: 'antigravity', cwd: f.folder },
        lead('relative/folder'),
      ];
      for (const seat of skipped) expect(grantedFolderPretrust(seat, f.home, { now: NOW, grant: yes })).toBe(false);
      expect(existsSync(join(f.home, '.claude.json'))).toBe(false);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});
