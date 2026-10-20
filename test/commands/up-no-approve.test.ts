// `team up` with no approval record: the owner and a seat the live file names may launch,
// anyone else is told `deny`, and five seats come up together without a prompt.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd } from '../../src/commands/add.ts';
import { runDown } from '../../src/commands/down.ts';
import { runRemove } from '../../src/commands/remove.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { Terminal } from '../../src/launch/terminal.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath } from '../../src/store/store.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-15T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const AMPLE: Machine = {
  loadPerCore: 0.2, memoryFree: 80, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};

const SEAT = (role: string, name: string) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const FIVE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead')}${SEAT('builder', 'builder-1')}${SEAT('builder', 'builder-2')}${SEAT('tester', 'tester-1')}${SEAT('tester', 'tester-2')}delivery_order: [mcp-inbox, typed]
grant:
  session: acme
  seat: lead
  scope:
    - up
`;

const TWO = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead')}${SEAT('builder', 'builder-1')}delivery_order: [mcp-inbox, typed]
`;

const lead = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
const other = { kind: 'seat', name: 'other', pane: 'w9:p1', session: 'acme' } as const;
const owner = { kind: 'owner' } as const;
const delegate = { kind: 'seat', name: 'pilot', pane: 'w1:p1', session: 'main' } as const;

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-approve-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'owner@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Owner'], { cwd: root, stdio: 'ignore' });
  return { base, root, home, file: join(root, '.agents', 'team.yaml') };
}

function write(root: { file: string }, text: string): void {
  writeFileSync(root.file, text);
}

/** Absolute trust, so a missing record is not also the legacy-trust refusal. */
function trusted(text: string, root: string, home: string): string {
  const lobby = join(home, '.config', 'team', 'lobby');
  return text.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${root}\nworkspace:\n`);
}

function recordLead(root: string): void {
  updateState(join(root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'launched', pane: 'w1:p1' };
  });
}

function approval(root: string, home: string): string {
  return join(storePath('acme', root, home), 'approval.json');
}

function launching(onLaunch: () => void): Launch & { closed: number } {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  const host = {
    closed: 0,
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: '', agent: false });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session: string, pane: string) {
      onLaunch();
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
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return host;
}

function sources(home: string, launch: Launch, terminal: Terminal): UpSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: () => NOW,
    machine: () => AMPLE,
    terminal: () => terminal,
    launch,
  };
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

describe('team up without an approval record', () => {
  test('a seat the file does not name is denied', async () => {
    const here = place();
    try {
      write(here, trusted(FIVE, here.root, here.home));
      const before = readFileSync(here.file, 'utf8');
      const io = testIo(here.root, other);
      const code = await runUp([], io, sources(here.home, launching(() => {}), terminal()));
      expect(code).toBe(1);
      expect(io.err).toBe('deny\n');
      expect(io.out).toBe('');
      expect(readFileSync(here.file, 'utf8')).toBe(before);
      expect(existsSync(approval(here.root, here.home))).toBe(false);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('the grant seat dry-run prints a plan and writes no record', async () => {
    const here = place();
    try {
      write(here, trusted(FIVE, here.root, here.home));
      recordLead(here.root);
      const io = testIo(here.root, lead);
      const code = await runUp(['--dry-run'], io, sources(here.home, launching(() => {}), terminal()));
      expect(io.err, io.out).toBe('');
      expect(code).toBe(0);
      expect(io.out).toContain('builder-1');
      expect(io.out).not.toContain('deny');
      expect(existsSync(approval(here.root, here.home))).toBe(false);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a delegates pane whose commands include up dry-runs with no record', async () => {
    const here = place();
    try {
      write(here, trusted(`${TWO}delegates:\n  - pane: main/w1:p1\n    commands: [up]\n`, here.root, here.home));
      const io = testIo(here.root, delegate);
      const code = await runUp(['--dry-run'], io, sources(here.home, launching(() => {}), terminal()));
      expect(io.err, io.out).toBe('');
      expect(code).toBe(0);
      expect(io.out).toContain('lead');
      expect(existsSync(approval(here.root, here.home))).toBe(false);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('the owner dry-runs with no record', async () => {
    const here = place();
    try {
      write(here, trusted(TWO, here.root, here.home));
      const io = testIo(here.root, owner);
      const code = await runUp(['--dry-run'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code, io.err).toBe(0);
      expect(io.out).toContain('lead');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('five seats launch together, with no prompt, and one can take a brief', async () => {
    const here = place();
    try {
      write(here, trusted(FIVE, here.root, here.home));
      recordLead(here.root);
      expect(existsSync(approval(here.root, here.home))).toBe(false);
      let launches = 0;
      let idleAt: number | null = null;
      let clock = NOW.getTime();
      const host = launching(() => {
        launches += 1;
      });
      host.paneText = () => {
        if (launches < 5) return '';
        if (idleAt === null) idleAt = launches;
        return IDLE;
      };
      host.sleep = async (ms) => {
        clock += ms;
      };
      host.now = () => new Date(clock);
      const keys = terminal();
      const io = testIo(here.root, lead);
      const code = await runUp([], io, {
        ...sources(here.home, host, keys),
        now: () => new Date(clock),
        sleep: host.sleep,
      });
      expect(code, `${io.err}${io.out}`).toBe(0);
      expect(launches).toBeGreaterThanOrEqual(5);
      expect(idleAt).not.toBeNull();
      expect(idleAt!).toBeGreaterThanOrEqual(5);
      expect(keys.reads).toBe(0);
      expect(host.closed).toBe(0);
      const said = `${io.out}${io.err}`.toLowerCase();
      expect(said).not.toContain('permission');
      expect(said).not.toContain('trust');
      expect(said).not.toContain('approve');
      const seats = readState(join(here.root, '.agents')).sessions.acme?.seats ?? {};
      for (const name of ['lead', 'builder-1', 'builder-2', 'tester-1', 'tester-2']) {
        expect(seats[name]?.stage, name).toBe('ready');
      }
      expect(existsSync(approval(here.root, here.home))).toBe(false);
      // The owner sends: an orchestrator has no reach to its own team's seats (a send down needs
      // an owner-signed grant naming it), and this scene is about a launched seat taking work
      // with no approval record, not about who may send.
      const sendIo = testIo(here.root, owner);
      // The seat takes the brief: idle until the Enter, working after it.
      let working = false;
      const sendHost: SendHost = {
        agents: () => [{ name: 'builder-1', pane: seats['builder-1']?.pane ?? 'w2:p1' }],
        processInfo: () => ({ shell: 1, foreground: [2] }),
        socketsDir: join(here.base, 'socks'),
        deliver: async () => ({ ok: true }),
        native: {
          typeText: () => true,
          pressEnter: () => {
            working = true;
            return true;
          },
          status: () => (working ? 'working' : 'idle'),
          wait: async () => {},
        },
        now: () => NOW,
        home: here.home,
        daemonSocket: join(here.base, 'no-daemon.sock'),
      };
      mkdirSync(sendHost.socketsDir, { recursive: true });
      const sent = await runSend(['builder-1', 'first brief'], sendIo, sendHost);
      expect(sent, `${sendIo.err}${sendIo.out}`).toBe(0);
      // No socket file under the host's sockets folder: a plain send is the typed trigger, and
      // the outcome names the trigger sent, never a read.
      expect(sendIo.out).toBe(
        'team acme, session "acme"\nbuilder-1: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
      );
      expect(existsSync(approval(here.root, here.home))).toBe(false);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });
});

describe('add, remove and down with no approval record', () => {
  test('add gets past the missing record', async () => {
    const here = place();
    try {
      write(here, TWO);
      const io = testIo(here.root, owner);
      const code = await runAdd(['missing'], io, {
        home: here.home,
        sessionState: () => 'absent',
        agents: () => [],
        workspaces: () => [],
        now: () => NOW,
        doctor: {
          version: () => '2.1.288',
          onPath: () => true,
          loggedIn: () => true,
          herdrVersion: () => '0.7.1',
          sessionRunning: () => false,
          now: () => NOW,
          home: here.home,
        },
        launch: launching(() => {}),
      });
      expect(code).toBe(1);
      expect(io.err).toContain('no seat "missing"');
      expect(io.err).not.toContain('never approved');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('remove gets past the missing record', async () => {
    const here = place();
    try {
      write(here, TWO);
      const io = testIo(here.root, owner);
      const code = await runRemove(['missing'], io, {
        home: here.home,
        sessionRunning: () => false,
        agents: () => [],
        alive: () => false,
        screen: () => ({ kind: 'idle' }),
        screenText: () => undefined,
        status: () => 'idle',
        foreground: () => ['claude'],
        now: () => NOW,
      });
      expect(code).toBe(1);
      expect(io.err).not.toContain('never approved');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('down gets past the missing record', async () => {
    const here = place();
    try {
      write(here, TWO);
      const io = testIo(here.root, owner);
      const code = await runDown([], io, {
        home: here.home,
        sessionRunning: () => false,
        agents: () => [],
        alive: () => false,
        screen: () => ({ kind: 'idle' }),
        screenText: () => undefined,
        status: () => 'idle',
        foreground: () => ['claude'],
        now: () => NOW,
      });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      expect(io.out).toContain('nothing to stop');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });
});
