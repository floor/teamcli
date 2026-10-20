// The agent session id herdr reports, and where the launch keeps it.
//
// Herdr 0.7.1 reports `agent_session` as `{agent, kind, source, value}` with `kind: 'id'`;
// older builds sent the id string itself. The reading takes either and nothing else: another
// kind names something that is not a session id, and an arbitrary object is never coerced.
// The same measured id lands in the seat state and in the agent registry's
// `reach.agent_session`, where a later read (the registry's own file parser, the state door)
// hands back exactly the string the reading produced.
//
// Fake herdr, a temporary home and a pinned caller: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { agentList, type HerdrAgent } from '../src/herdr.ts';
import { replacedSeat } from '../src/launch/identity.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { agentsDir, findAgent, getAgent, recordAgentSession, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readState, STATE_FILE, type State } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T18:30:00Z');
const OWNER = { kind: 'owner' as const };
const made: string[] = [];

afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** One herdr agent entry with the raw `agent_session` a build sent. The listing wrapper is what
 *  `agentList` reads, so the raw value goes through the same map a live herdr runs. */
function listing(raw: unknown, pane = 'w1:p1'): Record<string, unknown> {
  return {
    name: 'lead',
    agent: 'claude',
    pane_id: pane,
    workspace_id: 'ws-1',
    agent_status: 'idle',
    cwd: null,
    agent_session: raw,
  };
}

function sessionsOf(raws: unknown[]): HerdrAgent[] {
  setHerdrRun(() => ({ agents: raws }));
  return agentList('acme') ?? [];
}

describe('the reading of herdr agent_session', () => {
  test('takes the id from the 0.7.1 object and from the legacy string', () => {
    const [object, legacy] = sessionsOf([
      listing({ agent: 'claude', kind: 'id', source: 'cli', value: 'obj-session-1' }),
      listing('legacy-session-1', 'w1:p2'),
    ]);
    expect(object?.session).toBe('obj-session-1');
    expect(legacy?.session).toBe('legacy-session-1');
  });

  test('reads no id from another kind, a malformed object or an empty value', () => {
    const raws: unknown[] = [
      { agent: 'claude', kind: 'pid', source: 'proc', value: '4242' },
      { agent: 'claude', kind: 'id', source: 'cli', value: '' },
      { agent: 'claude', kind: 'id', source: 'cli', value: 17 },
      { agent: 'claude', value: 'no-kind' },
      { agent: 'claude', kind: 'id' },
      [{ agent: 'claude', kind: 'id', value: 'array' }],
      null,
      '',
      7,
    ];
    const read = sessionsOf(raws.map((raw, index) => listing(raw, `w1:p${String(index + 1)}`)));
    expect(read.map((agent) => agent.session)).toEqual(raws.map(() => undefined));
  });

  test('one unreadable entry does not take the whole listing with it', () => {
    const read = sessionsOf([
      listing({ agent: 'claude', kind: 'socket', value: 'sock-1' }, 'w1:p1'),
      listing({ agent: 'claude', kind: 'id', source: 'cli', value: 'obj-session-2' }, 'w1:p2'),
    ]);
    expect(read.map((agent) => agent.session)).toEqual([undefined, 'obj-session-2']);
  });

  test('the id the object carries is the one continuity compares, so a resumed seat is restored', () => {
    const [live] = sessionsOf([listing({ agent: 'claude', kind: 'id', source: 'cli', value: 'kept-session' })]);
    expect(replacedSeat('replaced', {
      asked: true,
      namedOnPane: true,
      recordedSession: 'kept-session',
      liveSession: live?.session,
    })).toBe('restored');
    expect(replacedSeat('replaced', {
      asked: true,
      namedOnPane: true,
      recordedSession: 'other-session',
      liveSession: live?.session,
    })).toBe('doubt');
  });
});

describe('the state door', () => {
  test('keeps a measured id and drops anything that is not one', () => {
    const dir = scratch('agent-session-state-');
    const state = {
      format: 1,
      sessions: {
        acme: {
          seats: {
            kept: { stage: 'ready', agent_session: 'ses_keep' },
            object: { stage: 'ready', agent_session: { kind: 'id', value: 'x' } },
            empty: { stage: 'ready', agent_session: '' },
            numeric: { stage: 'ready', agent_session: 7 },
          },
          worktrees: {},
        },
      },
    };
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state));
    const read = readState(dir) as State;
    const seats = read.sessions.acme?.seats ?? {};
    expect(seats.kept?.agent_session).toBe('ses_keep');
    expect(seats.object?.agent_session).toBeUndefined();
    expect(seats.empty?.agent_session).toBeUndefined();
    expect(seats.numeric?.agent_session).toBeUndefined();
  });
});

describe('the registry reading and writing', () => {
  function seeded(): { home: string; id: string } {
    const home = scratch('agent-session-reg-');
    const agent = registerAgent(home, {
      name: 'lead',
      signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: { team: 'acme', seat: 'lead', session: 'acme', pane: 'w1:p1', address: null, agent_session: 'ses_reg' },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    return { home, id: agent.id };
  }

  test('a measured id survives the writer and the reader', () => {
    const { home, id } = seeded();
    const text = readFileSync(join(agentsDir(home), `${id}.yaml`), 'utf8');
    expect(text).toContain('agent_session: "ses_reg"');
    expect(getAgent(home, id)?.reach.agent_session).toBe('ses_reg');
  });

  test('a re-point keeps the id, the rest of reach and the record identity', () => {
    const { home, id } = seeded();
    const before = getAgent(home, id)!;
    const moved = updateAgent(home, id, { reach: { pane: 'w2:p2' } });
    expect(moved.reach).toMatchObject({
      team: 'acme', seat: 'lead', session: 'acme', pane: 'w2:p2', address: null, agent_session: 'ses_reg',
    });
    expect(moved.id).toBe(before.id);
    expect(moved.provenance.registered_by).toBe(before.provenance.registered_by);
    expect(moved.provenance.registered_at).toBe(before.provenance.registered_at);
  });

  test('clearing writes null, and a null reads back as no id at all', () => {
    const { home, id } = seeded();
    const cleared = recordAgentSession(home, id, null);
    expect(cleared.reach.agent_session).toBeNull();
    expect(readFileSync(join(agentsDir(home), `${id}.yaml`), 'utf8')).toContain('agent_session: null');
    expect(getAgent(home, id)?.reach.agent_session).toBeUndefined();
  });

  test('a hand-edited value of the wrong shape is not handed out', () => {
    const { home, id } = seeded();
    const file = join(agentsDir(home), `${id}.yaml`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('agent_session: "ses_reg"', 'agent_session: 5'));
    expect(getAgent(home, id)).toBeNull();
  });
});

// ---- the register path ---------------------------------------------------------------------

type World = { base: string; home: string; root: string; dir: string };

function world(): World {
  const base = scratch('agent-session-reg-');
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`);
  return { base, home, root, dir: join(root, '.agents') };
}

function sources(seat: string, pane: string, sessionId: string, shell: number): RegisterSources {
  return {
    home: '',
    sessionState: () => 'running',
    agents: () => [{ name: seat, agent: 'claude', pane, workspace: `ws-${seat}`, status: 'idle', cwd: null, session: sessionId }],
    processInfo: () => ({ shell, foreground: [shell + 1] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
  };
}

describe('register writes the same measured id to both records', () => {
  test('the state seat and the registry agent hold one id per seat, never the other seat\'s', async () => {
    const w = world();
    const io = testIo(w.root, OWNER);
    expect(await runRegister(['lead'], io, { ...sources('lead', 'w1:p1', 'obj-session-lead', 400), home: w.home })).toBe(0);
    const io2 = testIo(w.root, OWNER);
    expect(await runRegister(['worker'], io2, { ...sources('worker', 'w2:p1', 'obj-session-worker', 500), home: w.home })).toBe(0);

    const seats = readState(w.dir).sessions.acme?.seats ?? {};
    expect(seats.lead?.agent_session).toBe('obj-session-lead');
    expect(seats.worker?.agent_session).toBe('obj-session-worker');

    const team = teamIdOf(w.root);
    expect(findAgent(w.home, { team, seat: 'lead' })?.reach.agent_session).toBe('obj-session-lead');
    expect(findAgent(w.home, { team, seat: 'worker' })?.reach.agent_session).toBe('obj-session-worker');
  });

  test('a herdr entry with no usable id writes none, and the seat state carries no key', async () => {
    const w = world();
    // The listing names the seat but its `agent_session` is an object of another kind: the
    // adapter reads no id, and neither the state nor the registry invents one.
    setHerdrRun(() => ({
      agents: [{
        name: 'lead', agent: 'claude', pane_id: 'w1:p1', workspace_id: 'ws-lead',
        agent_status: 'idle', cwd: null, agent_session: { agent: 'claude', kind: 'socket', value: 'sock-1' },
      }],
    }));
    const base = sources('lead', 'w1:p1', 'unused', 400);
    // The command's own sources hand back a parsed listing, as `runRegister` reads it: the id
    // here is what the adapter produced, which is nothing.
    const read = agentList('acme')?.[0];
    const io = testIo(w.root, OWNER);
    expect(await runRegister(['lead'], io, { ...base, home: w.home, agents: () => (read ? [read] : []) })).toBe(0);

    const seat = readState(w.dir).sessions.acme?.seats.lead;
    expect(seat?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' })?.reach.agent_session).toBeUndefined();
  });
});
