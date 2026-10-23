// The daemon's `next` handler with a reservation store injected, over a STAND-IN store: the same
// shared exclusion as the command, at the daemon's own boundary, on both of its paths — a local
// file source and a broker-tracker read — plus release, renewal and the empty answer. Stand-in
// evidence about the handler only; the real-store pair is exercised in the race suite at the
// committed store head.
//
// Every scene is synthetic: a temp checkout, a state record, a task file, and for the tracker
// path a stub askBroker. No broker, socket, credential or machine daemon is touched.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerOutcome } from '../../src/broker/client.ts';
import { handleNext, type NextClaim, type NextHandlerDeps, type NextHandlerInput } from '../../src/daemon/next.ts';
import { routeOf, type HostedRoute } from '../../src/daemon/routes.ts';
import type { TeamFile } from '../../src/file/types.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { LEASE_MS } from '../../src/tasks/lease.ts';
import type { ItemIdentity } from '../../src/workflow/reservation/index.ts';
import { gitEnv } from '../helpers.ts';
import { StandInStore, standInKeyText } from './reservation-stand-in-store.ts';

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

function project(text = FILE_TEAM, tasks = '- id: m1\n  title: one\n- id: m2\n  title: two\n'): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-daemon-next-reservation-'));
  root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'tasks.yaml'), tasks);
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
  at = now,
): Promise<Awaited<ReturnType<typeof handleNext>>> {
  const input: NextHandlerInput = { route, team, caller, action, mine, now: at };
  return handleNext(input, deps);
}

function item(session = 'crew'): (id: string) => ItemIdentity {
  return (id) => ({ source: team.tasks?.source ?? 'file', project: team.project, team: session, id });
}

function holdOf(store: StandInStore, id = 'm1', session = 'crew') {
  const key = standInKeyText(item(session)(id));
  if (key === null) throw new Error('the fixture item is unkeyable');
  return store.index.get(key)?.hold;
}

function leaseNames(): string[] {
  try {
    return readdirSync(join(root, '.agents', 'leases')).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function lease(id = 'm1'): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.agents', 'leases', `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function reservation(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'reservation',
    item: 'k',
    owner: 'run-1/1',
    seat: 'worker',
    phase: 'pending',
    at: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    run: 'run-1',
    attempt: 1,
    thread: 'th-1',
    receiver: 'worker',
    pane: 'w2:p1',
    ...patch,
  };
}

describe('handleNext with a reservation store injected, file source', () => {
  test('a claim writes the lease and the store hold with one deadline', async () => {
    project();
    const store = new StandInStore();
    const answer = await call(lead, 'claim', false, { reservations: store });
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'm1', title: 'one' } });
    expect(lease()).toMatchObject({ id: 'm1', seat: 'lead', pane: 'w1:p1' });
    expect(Date.parse(String(lease().until))).toBe(now + LEASE_MS);
    expect(holdOf(store)).toMatchObject({
      kind: 'next-claim',
      owner: 'next:lead:w1:p1',
      expiresAt: new Date(now + LEASE_MS).toISOString(),
    });
  });

  test('a reserved item is skipped at the daemon boundary and its hold is untouched', async () => {
    project();
    const store = new StandInStore();
    store.seed(item()('m1'), { hold: reservation('m1') as never });
    const before = structuredClone(holdOf(store, 'm1'));
    const answer = await call(lead, 'claim', false, { reservations: store });
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'm2', title: 'two' } });
    expect(leaseNames()).toEqual(['m2.json']);
    expect(holdOf(store, 'm1')).toEqual(before);
  });

  test('a live run excludes its item, and the empty answer is the shipped shape', async () => {
    project(FILE_TEAM, '- id: m1\n  title: one\n');
    const store = new StandInStore();
    store.seed(item()('m1'), { live: 'run-1' });
    expect(await call(lead, 'claim', false, { reservations: store })).toEqual({ ok: true, kind: 'none', why: 'nothing-takeable' });
    expect(leaseNames()).toEqual([]);
  });

  test('release unlinks the lease and clears the store claim', async () => {
    project();
    const store = new StandInStore();
    expect(await call(lead, 'claim', false, { reservations: store })).toMatchObject({ ok: true, kind: 'claimed' });
    expect(await call(lead, 'release', false, { reservations: store })).toEqual({ ok: true, kind: 'released', id: 'm1' });
    expect(leaseNames()).toEqual([]);
    expect(existsSync(join(root, '.agents', 'leases'))).toBe(true);
    expect(holdOf(store)).toBeUndefined();
  });

  test('a live lease renews the store claim with it', async () => {
    project();
    const store = new StandInStore();
    expect((await call(lead, 'claim', false, { reservations: store })).ok).toBe(true);
    const later = now + 60_000;
    const answer = await call(lead, 'claim', false, { reservations: store }, later);
    expect(answer).toMatchObject({ ok: true, kind: 'claimed', record: { id: 'm1' } });
    expect(Date.parse(String(lease().until))).toBe(later + LEASE_MS);
    expect(holdOf(store)).toMatchObject({ owner: 'next:lead:w1:p1', expiresAt: new Date(later + LEASE_MS).toISOString() });
    expect(store.calls.filter((call) => call.op === 'renewHold').length).toBe(1);
  });
});

describe('handleNext with a reservation store injected, broker source', () => {
  const records = (list: Array<{ id: string; title: string }>): BrokerOutcome => ({
    kind: 'read',
    read: { kind: 'records', records: list, refusals: [] },
  });

  test('a tracker claim takes the store hold, and release clears it', async () => {
    project(LINEAR_TEAM, '');
    const store = new StandInStore();
    const deps: NextHandlerDeps = { reservations: store, askBroker: async () => records([{ id: 'L1', title: 'tracker' }]) };
    const answer = await call(lead, 'claim', false, deps);
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'L1', title: 'tracker' } });
    expect(holdOf(store, 'L1')).toMatchObject({ kind: 'next-claim', owner: 'next:lead:w1:p1' });
    expect(holdOf(store, 'L1')?.expiresAt).toBe(new Date(now + LEASE_MS).toISOString());
    expect(await call(lead, 'release', false, deps)).toEqual({ ok: true, kind: 'released', id: 'L1' });
    expect(holdOf(store, 'L1')).toBeUndefined();
  });

  test('a reserved tracker item is skipped and the next record is claimed', async () => {
    project(LINEAR_TEAM, '');
    const store = new StandInStore();
    store.seed(item()('L1'), { hold: reservation('L1') as never });
    const deps: NextHandlerDeps = {
      reservations: store,
      askBroker: async () => records([{ id: 'L1', title: 'tracker one' }, { id: 'L2', title: 'tracker two' }]),
    };
    const answer = await call(lead, 'claim', false, deps);
    expect(answer).toEqual({ ok: true, kind: 'claimed', record: { id: 'L2', title: 'tracker two' } });
    expect(holdOf(store, 'L1')?.owner).toBe('run-1/1');
    expect(holdOf(store, 'L2')?.owner).toBe('next:lead:w1:p1');
  });
});
