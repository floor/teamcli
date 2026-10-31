// The dispatch gates stacked on the port. An idle seat whose own picker offers nothing is not
// pushed, suppressed or given an episode, though the union count is nonzero; and a watch with no
// verified authority holds its direct work with a refusal and no transport. Both scenes are red
// on the stack base and green at the port tip. The direct-work route is exercised with fakes
// only: a throwing host seam for the gate, and the default watch source, which must refuse
// before any transport.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realWatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import { dispatchIdleWork, forgetIdleEpisodes } from '../src/watch/dispatch.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

// A self-pull crew: no `tasks:` block, so the local queue is the source.
const CREW = `format: 1
project: acme-web
entity: acme
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-2
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

let base: string;
let root: string;
let home: string;

function team() {
  const parsed = validateTeamFile(CREW);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function live() {
  const agents = [
    { name: 'worker-1', agent: 'claude', pane: 'fixture:worker-1', workspace: 'fixture-worker-1', status: 'idle', cwd: null },
    { name: 'worker-2', agent: 'claude', pane: 'fixture:worker-2', workspace: 'fixture-worker-2', status: 'idle', cwd: null },
  ];
  const screens: Record<string, string> = { 'fixture:worker-1': idleScreen, 'fixture:worker-2': idleScreen };
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name })), screens };
}

/** Writes two idle seats ten minutes past the threshold and returns the session the pass reads. */
function seedState(): SessionState {
  const stamp = new Date(NOW - 10 * MIN).toISOString();
  const state = emptySession();
  state.seats['worker-1'] = { stage: 'ready', last_active: stamp };
  state.seats['worker-2'] = { stage: 'ready', last_active: stamp };
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { crew: state } }, null, 2)}\n`,
  );
  return readState(join(root, '.agents')).sessions.crew ?? emptySession();
}

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-dispatch-gates-')));
  root = join(base, 'crew');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

describe('the dispatch gates', () => {
  test('a seat its own picker offers nothing is not pushed, suppressed or given an episode', async () => {
    // Every record is assigned to worker-1. worker-2 may take nothing under pull: self, while
    // the union count stays nonzero.
    writeFileSync(
      join(root, '.agents', 'queue.yaml'),
      '- id: t1\n  title: "First"\n  assignee: worker-1\n- id: t2\n  title: "Second"\n  assignee: worker-1\n',
    );
    const calls: string[] = [];
    const result = await dispatchIdleWork({
      root,
      dir: join(root, '.agents'),
      team: team(),
      state: seedState(),
      live: live(),
      now: new Date(NOW),
      home,
      body: (seat: string) => `body for ${seat}`,
      push: async (request) => {
        calls.push(request.seat);
        return { ok: true, outcome: 'observed' };
      },
    });
    expect(calls).toEqual(['worker-1']);
    expect(result.suppressed).toEqual(['worker-1']);
    expect(result.pushed.map((one) => one.seat)).toEqual(['worker-1']);
  });

  test('a watch without verified authority holds the direct work with no transport', async () => {
    const mod = (await import('../src/watch/direct-send.ts')) as Record<string, unknown>;
    // This scene is red on the stack base, where the gate export is absent.
    expect(typeof mod.watchPushWork).toBe('function');
    const gate = mod.watchPushWork as (
      context: null,
      host: unknown,
    ) => (request: unknown) => Promise<{ ok: boolean; refused?: string }>;
    const touched: string[] = [];
    const host = new Proxy({}, {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`the host seam was touched: ${String(property)}`);
      },
    });
    const refusal = {
      ok: false,
      refused: 'this watch holds no verified watch authority, so the work wake is held and nothing was typed',
    } as const;
    expect(await gate(null, host)({ seat: 'worker-1', pane: 'fixture:worker-1', cli: 'claude-code', body: 'x' })).toEqual(refusal);
    expect(touched).toEqual([]);
    // The default watch source is wired to that gate, not to a sender: its own route refuses
    // with the same words and walks nothing.
    const request = { seat: 'worker-1', pane: 'fixture:worker-1', cli: 'claude-code', body: 'x' };
    expect(await realWatchSources.pushWork?.(request)).toEqual(refusal);
  });
});
