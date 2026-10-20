// Independent acceptance for the no-op `team up` claim fix: on a second run with nothing changed,
// a recordless seat's ready claim under this build's brief is left exactly as it is, while a
// missing, not-ready or older-build claim is delivered again. The harness is the same fake Launch
// the two-run scene uses; no pane, owner or live service is touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { GENERAL_BRIEF_SHA256 } from '../../src/launch/general-brief.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { readState } from '../../src/state.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const SEAT = 'codex-acme';

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'b7-up-idem-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n\nworkspace:`,
  ));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function approve(): Promise<void> {
  const io = testIo(root, { kind: 'owner' });
  expect(await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home })).toBe(0);
}

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? pane, status: 'idle', cwd: null };
}

type World = {
  launch: Launch;
  creates: string[];
  session: 'absent' | 'running';
  workspaceList(): { id: string; label: string }[];
};

function world(): World {
  const state: World = {
    launch: {} as Launch,
    creates: [],
    session: 'absent',
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      const pane = `w${String(n)}:p1`;
      panes.set(pane, { text: CLAUDE_IDLE, agent: false });
      spaces.set(`w${String(n)}`, label);
      state.creates.push(label);
      return { pane, workspace: `w${String(n)}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`)),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    focus: () => true,
    deleteSession: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    workspaces: () => made.workspaceList(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

const statePath = () => join(root, '.agents/team.state.json');
const stateOf = () => readState(join(root, '.agents'));
const sessionOf = () => stateOf().sessions['acme-web'];

const alive = () => [
  agent('claude-coordinator-acme', 'w1:p1'),
  agent('deepseek-acme', 'w2:p1'),
  agent('deepseek-acme-2', 'w3:p1'),
];

/** Runs `up` once and leaves the watch record a second run would see as running. */
async function first(): Promise<World> {
  await approve();
  const made = world();
  expect(await runUp(FILE, testIo(root, { kind: 'owner' }), sources({}, made))).toBe(0);
  const seeded = JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>;
  const sessions = seeded.sessions as Record<string, Record<string, unknown>>;
  sessions['acme-web']!.watch = { pid: 4242, heartbeat: '2026-10-03T14:01:30Z' };
  writeFileSync(statePath(), JSON.stringify(seeded));
  return made;
}

async function second(made: World): Promise<number> {
  made.launch.agents = alive;
  return runUp(FILE, testIo(root, { kind: 'owner' }), sources({
    sessionState: () => 'running',
    alive: () => true,
    agents: alive,
  }, made));
}

/** The seat's drop folder as a seat would read it: file names and exact bytes. */
function dropBytes(): Record<string, string> {
  const dir = join(root, '.agents', 'send-drops', 'acme-web', SEAT);
  try {
    return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
  } catch {
    return {};
  }
}

describe('a ready claim under this brief survives an unchanged second run', () => {
  test('the claim id, the drop bytes and the whole session record are unchanged', async () => {
    const made = await first();
    const claim = sessionOf()?.briefs?.[SEAT];
    expect(claim?.stage).toBe('ready');
    expect(claim?.sha256).toBe(GENERAL_BRIEF_SHA256);
    const before = JSON.parse(readFileSync(statePath(), 'utf8')) as { sessions: Record<string, unknown> };
    const beforeSession = JSON.parse(JSON.stringify(before.sessions['acme-web']));
    const beforeDrops = dropBytes();
    expect(Object.keys(beforeDrops).length).toBeGreaterThan(0);

    expect(await second(made)).toBe(0);
    // The whole session record — briefs, seats, watchdog, watch — is the same down to its JSON.
    expect(sessionOf()).toEqual(beforeSession as ReturnType<typeof sessionOf>);
    // The delivery was not even rewritten: every drop file still holds the same bytes.
    expect(dropBytes()).toEqual(beforeDrops);
    expect(sessionOf()?.briefs?.[SEAT]?.id).toBe(claim?.id);
  });
});

describe('a claim that does not stand is delivered again', () => {
  const cases: Array<[string, (briefs: Record<string, Record<string, unknown>>) => void]> = [
    ['missing', (briefs) => { delete briefs[SEAT]; }],
    ['not ready', (briefs) => { briefs[SEAT]!.stage = 'claimed'; }],
    ['older build', (briefs) => { briefs[SEAT]!.sha256 = 'a'.repeat(64); }],
  ];
  for (const [name, mutate] of cases) {
    test(`a ${name} claim is replaced by a fresh ready claim`, async () => {
      const made = await first();
      const was = sessionOf()?.briefs?.[SEAT]?.id;
      expect(typeof was).toBe('string');
      const seeded = JSON.parse(readFileSync(statePath(), 'utf8')) as {
        sessions: Record<string, { briefs: Record<string, Record<string, unknown>> }>;
      };
      mutate(seeded.sessions['acme-web']!.briefs);
      writeFileSync(statePath(), JSON.stringify(seeded));

      expect(await second(made)).toBe(0);
      const now = sessionOf()?.briefs?.[SEAT];
      expect(now?.stage).toBe('ready');
      expect(now?.sha256).toBe(GENERAL_BRIEF_SHA256);
      expect(now?.id).not.toBe(was);
    });
  }
});
