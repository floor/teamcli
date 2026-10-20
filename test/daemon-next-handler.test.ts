// The machine daemon's `next` handler at its own boundary: a host-resolved route, the loaded
// team file, and a claimed (seat, pane). Every scene is synthetic — a temp checkout, a state
// record and a task file — and no broker, socket, credential or machine daemon is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEADLINE, NOT_RUNNING, WRONG_ANSWER, type BrokerOutcome } from '../src/broker/client.ts';
import type { BrokerRequest } from '../src/broker/protocol.ts';
import { handleNext, type NextHandlerDeps, type NextHandlerInput, type NextClaim } from '../src/daemon/next.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState, type State } from '../src/state.ts';
import { enqueueSwap } from '../src/swap/queue.ts';

const SEATS = `seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const FILE_TEAM = `format: 1
project: acme
session: crew
coordinator: lead
operator: lead
workspace:
  mode: shared
${SEATS}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const LINEAR_TEAM = `format: 1
project: acme
session: crew
coordinator: lead
operator: lead
workspace:
  mode: shared
${SEATS}tasks:
  source: linear
  linear:
    project: proj-1
    keychainService: team.linear.acme
`;

const TASKS = '- id: m1\n  title: the task title\n';
const lead: NextClaim = { seat: 'lead', pane: 'w1:p1' };
const now = Date.parse('2026-10-20T09:00:00.000Z');

let base: string;
let root: string;
let team: TeamFile;
let route: HostedRoute;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFrom(text: string): TeamFile {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

function project(text = FILE_TEAM, tasks: string | null = TASKS): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-daemon-next-'));
  root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  if (tasks !== null) writeFileSync(join(root, '.agents', 'tasks.yaml'), tasks);
  team = teamFrom(text);
  route = routeOf(realpathSync(root), team.project, team.session, team.seats.map((seat) => seat.name));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

async function call(
  caller: NextClaim = lead,
  action: 'claim' | 'release' = 'claim',
  mine = false,
  deps: NextHandlerDeps = {},
): Promise<Awaited<ReturnType<typeof handleNext>>> {
  const input: NextHandlerInput = { route, team, caller, action, mine, now };
  return handleNext(input, deps);
}

function leaseNames(): string[] {
  try {
    return readdirSync(join(root, '.agents', 'leases')).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
}

function lease(id = 'm1'): { seat: string; pane: string; id: string } {
  return JSON.parse(readFileSync(join(root, '.agents', 'leases', `${id}.json`), 'utf8'));
}

describe('handleNext, file and local sources', () => {
  test('a verified claim takes one record and writes the local lease', async () => {
    project();
    const answer = await call();
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'm1', title: 'the task title' } });
    expect(lease()).toMatchObject({ id: 'm1', seat: 'lead', pane: 'w1:p1' });
    // The task file is the owner's; a claim never writes it.
    expect(readFileSync(join(root, '.agents', 'tasks.yaml'), 'utf8')).toBe(TASKS);
  });

  test('another pane on a declared seat is refused and claims nothing', async () => {
    project();
    const answer = await call({ seat: 'lead', pane: 'w9:p1' });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.code).toBe('next.caller');
    expect(answer.message).toContain('records pane w1:p1');
    expect(leaseNames()).toEqual([]);
  });

  test('an undeclared seat is refused and claims nothing', async () => {
    project();
    const answer = await call({ seat: 'stranger', pane: 'w1:p1' });
    expect(answer).toMatchObject({ ok: false, code: 'next.caller' });
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.message).toContain('"stranger" is not one');
    expect(leaseNames()).toEqual([]);
  });

  test('a seat the state records no pane for is refused, not guessed', async () => {
    project();
    updateState(join(root, '.agents'), (state) => {
      delete state.sessions.crew?.seats.worker;
    });
    const answer = await call({ seat: 'worker', pane: 'w2:p1' });
    expect(answer).toMatchObject({ ok: false, code: 'next.caller' });
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.message).toContain('no pane is recorded for seat worker');
    expect(leaseNames()).toEqual([]);
  });

  test('a paused team refuses a claim before the source, and still lets the seat release', async () => {
    project();
    expect((await call()).ok).toBe(true);
    updateState(join(root, '.agents'), (state) => {
      state.pause = { by: 'owner', at: new Date(now).toISOString(), stops: [] };
    });
    const refused = await call();
    expect(refused).toMatchObject({ ok: false, code: 'next.paused', hint: 'team resume' });
    expect(leaseNames()).toEqual(['m1.json']);
    const released = await call(lead, 'release');
    expect(released).toEqual({ ok: true, kind: 'released', id: 'm1' });
    expect(leaseNames()).toEqual([]);
  });

  test('a seat waiting on a swap is refused and claims nothing', async () => {
    project();
    enqueueSwap(join(root, '.agents'), {
      seat: 'lead',
      from: { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' },
      to: { cli: 'claude-code', vendor: 'deepseek', model: 'DeepSeek Flash', version: '4.0', display: 'DeepSeek Flash 4.0', launch: 'claude --model deepseek-flash' },
      reason: 'owner',
      waitSeconds: 1800,
      waitFor: 'the seat boundary',
      now: new Date(now),
    });
    const answer = await call();
    expect(answer).toMatchObject({ ok: false, code: 'next.swap', hint: 'team swap cancel lead' });
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.message).toContain('lead waits on a swap');
    expect(leaseNames()).toEqual([]);
  });

  test('--mine takes only the seat own records', async () => {
    project(FILE_TEAM, '- id: m1\n  title: open one\n- id: m2\n  title: worker one\n  assignee: worker\n');
    const mine = await call(lead, 'claim', true);
    expect(mine).toEqual({ ok: true, kind: 'none', why: 'nothing-assigned' });
    expect(leaseNames()).toEqual([]);
    const any = await call(lead, 'claim', false);
    expect(any).toMatchObject({ ok: true, kind: 'claimed', record: { id: 'm1' } });
  });

  test('release reports the record it unlinked, and nothing-held when there is none', async () => {
    project();
    expect(await call(lead, 'release')).toEqual({ ok: true, kind: 'none', why: 'nothing-held' });
    expect((await call()).ok).toBe(true);
    expect(await call(lead, 'release')).toEqual({ ok: true, kind: 'released', id: 'm1' });
    expect(existsSync(join(root, '.agents', 'leases', 'm1.json'))).toBe(false);
  });

  test('a route and team file that disagree are refused before any read', async () => {
    project();
    const other = { ...team, session: 'somewhere-else' };
    const answer = await handleNext({ route, team: other, caller: lead, action: 'claim', mine: false, now });
    expect(answer).toMatchObject({ ok: false, code: 'next.file' });
    expect(leaseNames()).toEqual([]);
  });

  test('a missing declared task file is next.missing', async () => {
    project(FILE_TEAM, null);
    const answer = await call();
    expect(answer).toMatchObject({ ok: false, code: 'next.missing' });
    expect(leaseNames()).toEqual([]);
  });

  test('a task file that is not a list is next.shape', async () => {
    project(FILE_TEAM, 'owner: value\n');
    const answer = await call();
    expect(answer).toMatchObject({ ok: false, code: 'next.shape' });
    expect(leaseNames()).toEqual([]);
  });

  test('refused records with nothing held are one shape refusal', async () => {
    project(FILE_TEAM, '- id: bad id!\n  title: a bad record\n');
    const answer = await call();
    expect(answer).toMatchObject({ ok: false, code: 'next.shape' });
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.message).toContain('is not a task:');
    expect(leaseNames()).toEqual([]);
  });
});

describe('handleNext, tracker sources and the broker proxy', () => {
  function records(records: Array<{ id: string; title: string }>): BrokerOutcome {
    return { kind: 'read', read: { kind: 'records', records, refusals: [] } };
  }

  test('with no proxy the daemon refuses and claims nothing', async () => {
    project(LINEAR_TEAM);
    const answer = await call();
    expect(answer).toMatchObject({ ok: false, code: 'next.broker' });
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.message).toContain('no tracker reader');
    expect(leaseNames()).toEqual([]);
  });

  test('the proxy is asked with the verified claim and the read claims a local lease', async () => {
    project(LINEAR_TEAM);
    const asked: { root: string; request: BrokerRequest }[] = [];
    const answer = await call(lead, 'claim', false, {
      askBroker: async (askedRoot, request) => {
        asked.push({ root: askedRoot, request });
        return records([{ id: 'L1', title: 'the tracker task' }]);
      },
    });
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'L1', title: 'the tracker task' } });
    expect(asked).toEqual([{ root: route.root, request: { op: 'read', seat: 'lead', pane: 'w1:p1' } }]);
    expect(lease('L1')).toMatchObject({ id: 'L1', seat: 'lead', pane: 'w1:p1' });
  });

  test('the broker read notice rides the answer', async () => {
    project(LINEAR_TEAM);
    const answer = await call(lead, 'claim', false, {
      askBroker: async () => ({ kind: 'read', read: { kind: 'records', records: [{ id: 'L1', title: 'one' }], refusals: [] }, notice: 'only page 1 was read' }),
    });
    expect(answer).toMatchObject({ ok: true, kind: 'claimed', notice: 'only page 1 was read' });
  });

  test('an unverified claim never reaches the broker', async () => {
    project(LINEAR_TEAM);
    let asked = 0;
    const answer = await call({ seat: 'lead', pane: 'w9:p1' }, 'claim', false, {
      askBroker: async () => {
        asked += 1;
        return records([{ id: 'L1', title: 'one' }]);
      },
    });
    expect(answer).toMatchObject({ ok: false, code: 'next.caller' });
    expect(asked).toBe(0);
    expect(leaseNames()).toEqual([]);
  });

  test.each([
    ['unavailable', { kind: 'unavailable' } as BrokerOutcome, 'next.broker', NOT_RUNNING],
    ['wrong', { kind: 'wrong' } as BrokerOutcome, 'next.broker', WRONG_ANSWER],
    ['deadline', { kind: 'deadline' } as BrokerOutcome, 'next.broker', DEADLINE],
    ['caller refusal', { kind: 'refused', at: 'caller', message: 'not this seat' } as BrokerOutcome, 'next.caller', 'not this seat'],
    ['read refusal', { kind: 'refused', at: 'read', message: 'the read failed' } as BrokerOutcome, 'next.read', 'the read failed'],
    ['another read kind', { kind: 'read', read: { kind: 'missing' } } as BrokerOutcome, 'next.broker', WRONG_ANSWER],
  ])('a %s from the broker maps to %s without claiming', async (_name, outcome, code, message) => {
    project(LINEAR_TEAM);
    const answer = await call(lead, 'claim', false, { askBroker: async () => outcome });
    expect(answer).toMatchObject({ ok: false, code, message });
    expect(leaseNames()).toEqual([]);
  });

  test('release never asks the broker', async () => {
    project(LINEAR_TEAM);
    let asked = 0;
    const deps: NextHandlerDeps = {
      askBroker: async () => {
        asked += 1;
        return records([{ id: 'L1', title: 'the tracker task' }]);
      },
    };
    expect(await call(lead, 'release', false, deps)).toEqual({ ok: true, kind: 'none', why: 'nothing-held' });
    expect(asked).toBe(0);
    expect((await call(lead, 'claim', false, deps)).ok).toBe(true);
    expect(await call(lead, 'release', false, deps)).toEqual({ ok: true, kind: 'released', id: 'L1' });
    expect(asked).toBe(1);
  });
});
