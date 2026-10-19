// The reconcile pass closes the crash gap a settings write leaves (OD-20261018-08): a signed
// record whose `config.changed` event never reached the log gets one event, marked reconciled,
// exactly once — across passes and across sessions.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendConfigChanged } from '../src/config/events.ts';
import { planConfigSet, readSeatConfigSource, writeConfigSet } from '../src/config/sources.ts';
import type { SignedConfigRecord } from '../src/config/record.ts';
import { readEvents } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { agentsDir, getAgent, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';

const PROJECT = 'teamcli';
const SESSION = 'teamcli';
const SEAT = 'builder-1';

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-reconcile-')));
  home = join(base, 'home');
  root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function init(overrides: Partial<AgentInit> = {}): AgentInit {
  return {
    name: 'Builder One',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    reach: { team: PROJECT, seat: SEAT, session: SESSION, pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
    ...overrides,
  };
}

/** A seat with one signed setting and no `config.changed` event: the crash gap. */
function seatWithSignedSetting(): { agentId: string; record: SignedConfigRecord } {
  const agentId = registerAgent(home, init()).id;
  upsertTeam(home, teamIdOf(root), {
    project: PROJECT,
    session: SESSION,
    root,
    lobby: '',
    roster: [{ agent: agentId, seat: SEAT, role: 'builder' }],
  });
  const plan = planConfigSet(home, {
    level: 'seat',
    target: agentId,
    settings: [{ key: 'model', value: 'claude-opus-5-5' }],
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error('plan refused');
  const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00Z') });
  expect(written.ok).toBe(true);
  if (!written.ok) throw new Error('write refused');
  const record = written.written[0]!;
  return { agentId, record };
}

function configEvents(session = SESSION) {
  const read = readEvents(PROJECT, root, home);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('unreadable log');
  return read.events.filter(
    (entry) => entry.payload.kind === 'config.changed' && entry.payload.session === session,
  );
}

describe('reconcile: a signed settings record with no config.changed event', () => {
  test('appends one event marked reconciled, naming the key, level and value', () => {
    const { agentId, record } = seatWithSignedSetting();
    const pass = reconcilePass({ project: PROJECT, root, session: SESSION, home });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;

    const events = configEvents();
    expect(events.length).toBe(1);
    const payload = events[0]!.payload;
    expect(payload.record_id).toBe(`config:seat:${agentId}:model:${record.generation}`);
    expect(payload.config_key).toBe('model');
    expect(payload.config_level).toBe('seat');
    expect(payload.config_new).toBe('claude-opus-5-5');
    expect(payload.config_old).toBeUndefined();
    expect(payload.reconciled).toBe('true');
    expect(payload.seat).toBe(SEAT);
    expect(payload.subject).toBe(SEAT);
    expect(payload.from).toBe('owner');
    expect(payload.ts).toBe(record.date);
  });

  test('a second pass appends nothing', () => {
    seatWithSignedSetting();
    expect(reconcilePass({ project: PROJECT, root, session: SESSION, home }).ok).toBe(true);
    const second = reconcilePass({ project: PROJECT, root, session: SESSION, home });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.raised.filter((entry) => entry.payload.kind === 'config.changed').length).toBe(0);
    expect(configEvents().length).toBe(1);
  });

  test('a write that did append its event gets no second, reconciled one', () => {
    const { agentId, record } = seatWithSignedSetting();
    const appended = appendConfigChanged(PROJECT, root, home, {
      ts: record.date,
      session: SESSION,
      level: 'seat',
      target: agentId,
      key: 'model',
      old: null,
      value: record.value,
      generation: record.generation,
      from: 'owner',
      seat: SEAT,
      subject: SEAT,
    });
    expect(appended.ok).toBe(true);
    expect(reconcilePass({ project: PROJECT, root, session: SESSION, home }).ok).toBe(true);

    const events = configEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.payload.reconciled).toBeUndefined();
  });

  test('an event appended by another session stands: reconcile appends none', () => {
    const { agentId, record } = seatWithSignedSetting();
    const appended = appendConfigChanged(PROJECT, root, home, {
      ts: record.date,
      session: 'other-session',
      level: 'seat',
      target: agentId,
      key: 'model',
      old: null,
      value: record.value,
      generation: record.generation,
      from: 'owner',
      seat: SEAT,
      subject: SEAT,
    });
    expect(appended.ok).toBe(true);
    expect(reconcilePass({ project: PROJECT, root, session: SESSION, home }).ok).toBe(true);

    // The signed generation is machine-wide: no session appends a second event for it.
    expect(configEvents(SESSION).length).toBe(0);
    expect(configEvents('other-session').length).toBe(1);
  });

  test('a tampered record raises nothing', () => {
    const { agentId, record } = seatWithSignedSetting();
    const path = join(agentsDir(home), `${agentId}.yaml`);
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace('claude-opus-5-5', 'claude-haiku-5-5'));

    expect(reconcilePass({ project: PROJECT, root, session: SESSION, home }).ok).toBe(true);
    expect(configEvents().length).toBe(0);
    // The record's signed generation is still the one on disk; nothing was invented for it.
    expect(record.value).toBe('claude-opus-5-5');
  });
});

const DECLARED = `format: 1
project: teamcli
coordinator: builder-1
operator: builder-1
workspace:
  mode: shared
seats:
  - role: builder
    name: builder-1
    label: builder-1
    cli: antigravity
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: agy
`;

const DECLARATION_GONE = `format: 1
project: teamcli
coordinator: builder-2
operator: builder-2
workspace:
  mode: shared
seats:
  - role: builder
    name: builder-2
    label: builder-2
    cli: antigravity
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: agy
`;

describe('reconcile: a seat record whose declaration is gone', () => {
  test('is marked orphaned and kept, its signed setting still verifies, and the mark does not move', () => {
    const repo = join(base, 'orphan-repo');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    execSync('git init -q -b main', { cwd: repo });
    const teamId = teamIdOf(repo);
    const agentId = registerAgent(home, init({
      reach: { team: teamId, seat: SEAT, session: SESSION, pane: 'w36:p1', address: null },
    })).id;
    writeFileSync(join(repo, '.agents', 'team.yaml'), DECLARED);
    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'nickname', value: 'b1' }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00Z') }).ok).toBe(true);

    // While the file declares the seat, a pass marks nothing.
    expect(reconcilePass({ project: PROJECT, root: repo, session: SESSION, home }).ok).toBe(true);
    expect(getAgent(home, agentId)?.orphaned_at).toBeUndefined();

    writeFileSync(join(repo, '.agents', 'team.yaml'), DECLARATION_GONE);
    expect(reconcilePass({ project: PROJECT, root: repo, session: SESSION, home, now: new Date('2026-10-19T12:00:00Z') }).ok).toBe(true);

    // Retained, not deleted; the signed word still verifies and reads.
    expect(existsSync(join(agentsDir(home), `${agentId}.yaml`))).toBe(true);
    expect(getAgent(home, agentId)?.orphaned_at).toBe('2026-10-19T12:00:00.000Z');
    const read = readSeatConfigSource(home, agentId, SEAT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.settings.map((entry) => [entry.key, entry.value])).toEqual([['nickname', 'b1']]);

    // A later pass leaves the mark where the removal was first seen.
    expect(reconcilePass({ project: PROJECT, root: repo, session: SESSION, home, now: new Date('2026-10-20T00:00:00Z') }).ok).toBe(true);
    expect(getAgent(home, agentId)?.orphaned_at).toBe('2026-10-19T12:00:00.000Z');
  });

  test('a re-declared seat that launches keeps its id and signed setting and loses the current mark', () => {
    const repo = join(base, 'reland-repo');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    execSync('git init -q -b main', { cwd: repo });
    const teamId = teamIdOf(repo);
    const agentId = registerAgent(home, init({
      reach: { team: teamId, seat: SEAT, session: SESSION, pane: 'w36:p1', address: null },
    })).id;
    writeFileSync(join(repo, '.agents', 'team.yaml'), DECLARED);
    const plan = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'nickname', value: 'b1' }] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00Z') }).ok).toBe(true);

    // The declaration goes away, the pass marks the record, and the seat comes back.
    writeFileSync(join(repo, '.agents', 'team.yaml'), DECLARATION_GONE);
    expect(reconcilePass({ project: PROJECT, root: repo, session: SESSION, home, now: new Date('2026-10-19T12:00:00Z') }).ok).toBe(true);
    expect(getAgent(home, agentId)?.orphaned_at).toBe('2026-10-19T12:00:00.000Z');
    writeFileSync(join(repo, '.agents', 'team.yaml'), DECLARED);
    const loaded = loadTeamFile(repo, { home });
    if (!loaded.ok) throw new Error('the restored team file does not load');
    const seat = loaded.team.seats.find((one) => one.name === SEAT);
    if (seat === undefined) throw new Error('the restored team file declares no seat');

    const launched = registerLaunch({ home, root: repo, team: loaded.team, by: 'team up', session: SESSION }, seat, 'w36:p9');

    expect('id' in launched ? launched.id : null).toBe(agentId);
    const after = getAgent(home, agentId);
    expect(after?.orphaned_at).toBeUndefined();
    expect(after?.lifecycle).toBe('running');
    expect(after?.reach.pane).toBe('w36:p9');
    const read = readSeatConfigSource(home, agentId, SEAT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.settings.map((entry) => [entry.key, entry.value])).toEqual([['nickname', 'b1']]);
  });

  test('a team file this build cannot read neither marks nor clears a record', () => {
    const repo = join(base, 'unreadable-repo');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    execSync('git init -q -b main', { cwd: repo });
    const agentId = registerAgent(home, init({
      reach: { team: teamIdOf(repo), seat: SEAT, session: SESSION, pane: 'w36:p1', address: null },
    })).id;
    writeFileSync(join(repo, '.agents', 'team.yaml'), 'format: [\n');

    expect(reconcilePass({ project: PROJECT, root: repo, session: SESSION, home, now: new Date('2026-10-19T12:00:00Z') }).ok).toBe(true);
    expect(getAgent(home, agentId)?.orphaned_at).toBeUndefined();
  });
});
