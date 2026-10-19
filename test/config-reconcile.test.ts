// The reconcile pass closes the crash gap a settings write leaves (OD-20261018-08): a signed
// record whose `config.changed` event never reached the log gets one event, marked reconciled,
// exactly once — across passes and across sessions.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendConfigChanged } from '../src/config/events.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import type { SignedConfigRecord } from '../src/config/record.ts';
import { readEvents } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { agentsDir, registerAgent, type AgentInit } from '../src/registry/agents.ts';
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

function init(): AgentInit {
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
