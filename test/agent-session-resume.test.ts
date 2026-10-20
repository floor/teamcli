// The seat's own recorded conversation, offered to a restart only when the two team-owned
// records agree on it: the agent registry's `reach.agent_session` and the seat state's own
// `agent_session`, bound to this team, seat, agent and CLI. A record that belongs to another
// agent, an orphaned one, one whose CLI changed, and a state that names another id are all
// refusals: no resume id is ever taken from a record that is not this seat's own current one.
// A missing record is not a refusal — it is a fresh launch, exactly as before.
//
// Synthetic homes and state objects only: no live registry, session or CLI home is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { SeatState } from '../src/state.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-session-resume-')));
  made.push(dir);
  return dir;
}

const SEAT_ID = 'seat_0123456789ab';
const OTHER_ID = 'seat_fedcba987654';

type World = { home: string; root: string; team: string };

function world(): World {
  const base = scratch();
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root, team: teamIdOf(root) };
}

type RecordFields = {
  team?: string;
  cli?: string;
  agentSession?: string | null;
  seatHandle?: string | null;
  orphanedAt?: string | null;
};

/** One agent registry record, written through the registry's own writer: the file a restart
 *  reads is exactly what `registerAgent` would have written at launch. */
function record(w: World, seat: string, fields: RecordFields = {}): string {
  const agent = registerAgent(w.home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: fields.cli ?? 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: fields.team ?? w.team,
      seat,
      session: 'acme',
      pane: 'w1:p1',
      address: null,
      ...(fields.agentSession === undefined ? {} : { agent_session: fields.agentSession }),
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    ...(fields.seatHandle === undefined ? {} : { seat_handle: fields.seatHandle }),
    ...(fields.orphanedAt === undefined ? {} : { orphaned_at: fields.orphanedAt }),
    by: 'team up',
  });
  return agent.id;
}

function state(fields: Partial<SeatState> = {}): SeatState {
  return { stage: 'ready', ...fields };
}

function read(w: World, seat: { name: string; cli: string }, recorded: SeatState | undefined, herdrSession = 'acme') {
  return recordedSeatSession({
    home: w.home,
    root: w.root,
    herdrSession,
    seat,
    state: recorded,
  });
}

const WORKER = { name: 'worker', cli: 'claude-code' };

describe('the bound resume id', () => {
  test('both records naming one id for this seat is a binding, with its endpoint', () => {
    const w = world();
    const id = record(w, 'worker', { agentSession: 'ses_bound', seatHandle: SEAT_ID });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }));
    expect(readBack.kind).toBe('bound');
    if (readBack.kind !== 'bound') return;
    expect(readBack.recorded).toEqual({
      agentId: id,
      seatHandle: SEAT_ID,
      sessionId: 'ses_bound',
      team: w.team,
      seat: 'worker',
      cli: 'claude-code',
      herdrSession: 'acme',
      pane: 'w1:p1',
      address: null,
    });
  });

  test('the record is looked up for this seat only, never for another seat of the team', () => {
    const w = world();
    record(w, 'lead', { agentSession: 'ses_lead' });
    expect(read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_lead' })).kind).toBe('none');
  });
});

describe('what is never resumed', () => {
  test('no agent record at all is a fresh launch, not a refusal', () => {
    const w = world();
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }));
    expect(readBack).toEqual({ kind: 'none', why: 'no agent record for this seat' });
  });

  test('an orphaned record is refused: its seat is no longer declared', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses_bound', orphanedAt: '2026-10-19T00:00:00Z' });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }));
    expect(readBack.kind).toBe('refused');
    if (readBack.kind !== 'refused') return;
    expect(readBack.why).toContain('orphaned');
  });

  test('a record written in another herdr session is refused, even for the same team root', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses_bound' });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }), 'other');
    expect(readBack).toEqual({ kind: 'refused', why: 'the record was written in herdr session acme' });
  });

  test('a record written by another CLI is refused: the seat now declares this one', () => {
    const w = world();
    record(w, 'worker', { cli: 'codex', agentSession: 'ses_bound' });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }));
    expect(readBack).toEqual({ kind: 'refused', why: 'the record ran codex, the seat now declares claude-code' });
  });

  test('a record carrying another stable seat handle is another agent for this seat', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses_bound', seatHandle: OTHER_ID });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }));
    expect(readBack).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });
  });

  test('a record that names no session is a fresh launch', () => {
    const w = world();
    record(w, 'worker', { agentSession: null });
    expect(read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_bound' }))).toEqual({
      kind: 'none',
      why: 'the record names no agent session',
    });
  });

  test('the seat state naming no session is not evidence: the registry alone never resumes', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses_bound', seatHandle: SEAT_ID });
    expect(read(w, WORKER, state({ id: SEAT_ID }))).toEqual({
      kind: 'none',
      why: 'the seat state names no agent session',
    });
    expect(read(w, WORKER, undefined)).toEqual({
      kind: 'none',
      why: 'the seat state names no agent session',
    });
  });

  test('records that name different sessions are refused, whichever one is stale', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses_bound', seatHandle: SEAT_ID });
    expect(read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses_other' }))).toEqual({
      kind: 'refused',
      why: 'the seat state and the agent record name different sessions',
    });
  });

  test('an id that is not one launch-line token is refused', () => {
    const w = world();
    record(w, 'worker', { agentSession: 'ses bound', seatHandle: SEAT_ID });
    const readBack = read(w, WORKER, state({ id: SEAT_ID, agent_session: 'ses bound' }));
    expect(readBack).toEqual({ kind: 'refused', why: 'the recorded id is not one session token' });
  });
});
