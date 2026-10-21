// The `--json` document of `team up`: one `team.up` envelope on stdout, stderr empty, the status
// saying what the run did; the dry-run plan as `plan` steps; a refusal — a real run's, or a dry
// run's that would be refused — as the `team.error` document named by the contract row. The
// harness is the one up-no-approve.test.ts uses: a two-seat file with absolute trust, herdr
// answered by closures.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { Terminal } from '../../src/launch/terminal.ts';
import { UP_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
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

const TWO = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead')}${SEAT('builder', 'builder-1')}`;

const owner = { kind: 'owner' } as const;
const other = { kind: 'seat', name: 'other', pane: 'w9:p1', session: 'acme' } as const;

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-up-json-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const lobby = join(home, '.config', 'team', 'lobby');
  writeFileSync(join(root, '.agents', 'team.yaml'), TWO.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${root}\nworkspace:\n`));
  return { base, root, home };
}

/** One herdr for one call: a session that starts, a workspace and a pane per seat, the watch. */
function launching(onLaunch: () => void): Launch {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  return {
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
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (pane: string) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
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

describe('team up --json', () => {
  test('the owner\'s dry run is one team.up document with the plan as steps', async () => {
    const here = place();
    try {
      const io = testIo(here.root, owner);
      const code = await runUp(['--dry-run', '--json'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code, io.err).toBe(0);
      expect(io.err).toBe('');
      const doc = assertMatchesOutputSchema<{
        schema: { name: string; version: number };
        dry_run: boolean;
        status: string;
        action_summary: string;
        project: string | null;
        session: string | null;
        seats: string[];
        plan: { step: string; detail: string; prefix?: string }[];
        notes: string[];
      }>(io.out, UP_OUTPUT_SCHEMA);
      expect(doc.schema).toEqual({ name: 'team.up', version: 1 });
      expect(doc.dry_run).toBe(true);
      expect(doc.status).toBe('dry-run');
      expect(doc.action_summary).toBe('dry run: nothing was run');
      expect(doc.project).toBe('acme');
      expect(doc.session).toBe('acme');
      expect(doc.seats).toEqual(['lead', 'builder-1']);
      expect(doc.plan.length).toBeGreaterThan(0);
      for (const step of doc.plan) {
        expect(step.step.length).toBeGreaterThan(0);
        expect(step.detail.length).toBeGreaterThan(0);
        if (step.prefix !== undefined) expect(['+', '!', 'skip']).toContain(step.prefix);
      }
      expect(Array.isArray(doc.notes)).toBe(true);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a ready run is one team.up document closing on its record', async () => {
    const here = place();
    try {
      let launches = 0;
      let clock = NOW.getTime();
      const host = launching(() => {
        launches += 1;
      });
      host.paneText = () => (launches >= 2 ? IDLE : '');
      host.sleep = async (ms: number) => {
        clock += ms;
      };
      host.now = () => new Date(clock);
      const io = testIo(here.root, owner);
      const code = await runUp(['--json'], io, {
        ...sources(here.home, host, terminal()),
        now: () => new Date(clock),
        sleep: host.sleep,
      });
      expect(code, io.err).toBe(0);
      expect(io.err).toBe('');
      const doc = assertMatchesOutputSchema<{
        schema: { name: string; version: number };
        dry_run: boolean;
        status: string;
        action_summary: string;
        seats: string[];
        notes: string[];
      }>(io.out, UP_OUTPUT_SCHEMA);
      expect(doc.schema).toEqual({ name: 'team.up', version: 1 });
      expect(doc.dry_run).toBe(false);
      expect(doc.status).toBe('ready');
      expect(doc.action_summary).toBe('0 seats repaired, 0 skipped (working), 0 refused');
      expect(doc.seats).toEqual(['lead', 'builder-1']);
      expect(doc.notes.some((line) => line === 'lead: ready')).toBe(true);
      expect(doc.notes.some((line) => line === 'builder-1: ready')).toBe(true);
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a caller the run does not admit is the team.error document, `deny`', async () => {
    const here = place();
    try {
      const io = testIo(here.root, other);
      const code = await runUp(['--json'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code).toBe(1);
      expect(io.err).toBe('');
      const doc = assertJsonErrorShape(io.out, { id: 'up.deny', messageContains: 'deny', repair: null });
      expect(doc.error.message).toBe('deny');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a flagged file by a caller the run does not admit names the flag row', async () => {
    const here = place();
    try {
      const io = testIo(here.root, other);
      const code = await runUp(['--session', 'acme', '--json'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code).toBe(1);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'up.not-owner', messageContains: 'deny', repair: null });
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a dry run that would be refused is the error document, not a plan', async () => {
    const here = place();
    try {
      const io = testIo(here.root, other);
      const code = await runUp(['--dry-run', '--json'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code).toBe(1);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'up.placement', messageContains: 'only the owner or `leads` starts the team' });
      expect(io.out).not.toContain('"plan"');
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });

  test('a bad invocation is the up.invocation document and exit 2', async () => {
    const here = place();
    try {
      const io = testIo(here.root, owner);
      const code = await runUp(['--json', '--nope'], io, sources(here.home, launching(() => {}), terminal()));
      expect(code).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'up.invocation' });
    } finally {
      rmSync(here.base, { recursive: true, force: true });
    }
  });
});
