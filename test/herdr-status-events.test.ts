import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEventKind, EVENT_KINDS } from '../src/bus/kinds.ts';
import { readEvents, verifySignedEvent, type SignedEventRecord } from '../src/bus/log.ts';
import { EVENT_ROUTING_DEFAULTS } from '../src/policy/events.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  parseWaitAgentStatusOutput,
  setHerdrWaitExec,
  waitAgentStatus,
} from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  classifyPromptKind,
  createSeatStatusEngine,
  herdrStatusSource,
  isStatusWaiterSeat,
  shouldReadScreenForStatus,
  type PromptKind,
  type StatusSource,
  type StatusTarget,
} from '../src/watch/status-events.ts';

const dirs: string[] = [];

function makeScratch(): { base: string; root: string; entityRoot: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-herdr-status-events-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  return { base, root, entityRoot, home };
}

function readVerifiedLog(project: string, root: string, home: string): SignedEventRecord[] {
  const res = readEvents(project, root, home);
  if (!res.ok) throw new Error(res.reason);
  expect(res.unverified).toBe(0);
  for (const record of res.events) {
    expect(verifySignedEvent(record, home)).toBe(true);
  }
  return res.events;
}

afterEach(() => {
  setHerdrWaitExec(null);
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

const TEAM_YAML = `format: 1
entity: floor
project: acme
session: acme-dev
coordinator: crew-lead
operator: op-1
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: op-1
    role: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: worker-1
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: jules-1
    role: builder
    cli: jules
    vendor: google
    model: Gemini Pro
    version: "4.0"
    launch: jules
  - name: owner-pane
    role: human-observer
    human: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function parseTeam(yaml = TEAM_YAML): TeamFile {
  const res = validateTeamFile(yaml);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.team;
}

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const PERMISSION_SCREEN = `Bash command\n\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`;
const TRUST_SCREEN = `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`;
const QUESTION_SCREEN = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const GUARD_SCREEN = `team guard hook blocked command: forbidden flags\nAllow guard prompt to proceed? [y/N]\n`;
const LOGIN_SCREEN = `Session expired. Please sign in to authenticate your account.\n`;
const IDLE_SCREEN = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

describe('herdr wait agent-status CLI integration and output parser', () => {
  test('parses matched status change, timeout, and error outputs from herdr wait agent-status', () => {
    const matched = parseWaitAgentStatusOutput(
      0,
      '{"event":"pane.agent_status_changed","data":{"pane_id":"w2:p1","workspace_id":"w2","agent_status":"done","agent":"claude","display_agent":"Claude Opus 5.5"}}\n',
      '',
      'w2:p1',
      'done',
    );
    expect(matched).toEqual({
      outcome: 'changed',
      status: 'done',
      pane: 'w2:p1',
      workspace: 'w2',
      agent: 'claude',
    });

    const timedOut = parseWaitAgentStatusOutput(
      1,
      '',
      'timed out waiting for agent status change\n',
      'w2:p1',
      'done',
    );
    expect(timedOut).toEqual({ outcome: 'timeout' });

    const invalidPane = parseWaitAgentStatusOutput(
      1,
      '{"id":"cli:pane:get","error":{"code":"not_found","message":"pane w99:p1 not found"}}\n',
      '',
      'w99:p1',
      'blocked',
    );
    expect(invalidPane.outcome).toBe('error');
  });

  test('waitAgentStatus passes session, pane, status, and timeout to herdr and herdrStatusSource races { not } targets', async () => {
    const seenArgs: string[][] = [];
    setHerdrWaitExec(async (args, signal) => {
      seenArgs.push(args);
      const statusIdx = args.indexOf('--status');
      const requested = statusIdx >= 0 ? args[statusIdx + 1] : '';
      if (requested === 'blocked') {
        return {
          code: 0,
          stdout: JSON.stringify({
            event: 'pane.agent_status_changed',
            data: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked', agent: 'claude' },
          }),
          stderr: '',
        };
      }
      // Other candidates wait until aborted by the race winner.
      return await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ code: null, stdout: '', stderr: 'timed out waiting for agent status change' });
          return;
        }
        signal?.addEventListener(
          'abort',
          () => resolve({ code: null, stdout: '', stderr: 'timed out waiting for agent status change' }),
          { once: true },
        );
      });
    });

    const direct = await waitAgentStatus('w1:p1', 'blocked', 5000, 'acme-dev');
    expect(direct).toEqual({
      outcome: 'changed',
      status: 'blocked',
      pane: 'w1:p1',
      workspace: 'w1',
      agent: 'claude',
    });
    expect(seenArgs[0]).toEqual([
      '--session',
      'acme-dev',
      'wait',
      'agent-status',
      'w1:p1',
      '--status',
      'blocked',
      '--timeout',
      '5000',
    ]);

    const source = herdrStatusSource({ session: 'acme-dev', now: () => 1_700_000_000_000 });
    const raced = await source.waitStatus(
      { name: 'worker-1', pane: 'w1:p1', cli: 'claude-code' },
      { not: 'working' },
      5000,
    );
    expect(raced).toEqual({
      outcome: 'changed',
      status: 'blocked',
      at: 1_700_000_000_000,
    });
  });
});

describe('status-to-event mapping table and screen-module boundaries', () => {
  test('seat.unblocked is registered in EVENT_KINDS and routed to lead and operator by default', () => {
    expect(EVENT_KINDS).toContain('seat.unblocked');
    expect(isEventKind('seat.unblocked')).toBe(true);
    expect(EVENT_ROUTING_DEFAULTS['seat.unblocked']).toEqual(['lead', 'operator']);
  });

  test('classifyPromptKind distinguishes permission, trust, question, guard, login, and unknown', () => {
    expect(classifyPromptKind('claude-code', PERMISSION_SCREEN)).toBe('permission');
    expect(classifyPromptKind('claude-code', TRUST_SCREEN)).toBe('trust');
    expect(classifyPromptKind('claude-code', QUESTION_SCREEN)).toBe('question');
    expect(classifyPromptKind('claude-code', GUARD_SCREEN)).toBe('guard');
    expect(classifyPromptKind('claude-code', LOGIN_SCREEN)).toBe('login');
    expect(classifyPromptKind('claude-code', IDLE_SCREEN)).toBe('unknown');
    expect(classifyPromptKind('claude-code', undefined)).toBe('unknown');
  });

  test('maps blocked -> seat.at-prompt (with prompt kind), working after blocked -> seat.unblocked, done -> seat.done, idle past N -> seat.idle once per stretch, unknown -> no event', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    let clock = 1_700_000_000_000;
    let promptKindCalls = 0;
    const currentPromptKind: PromptKind = 'permission';

    const source: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: clock };
      },
      promptKind() {
        promptKindCalls += 1;
        return currentPromptKind;
      },
    };

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      source,
      now: () => clock,
      idleThresholdSeconds: 300,
      promptEscalationSeconds: 300,
      graceMs: 120_000,
    });

    // 1. `working` initially -> no event, screen not read.
    const s1 = await engine.observe('worker-1', 'working', clock);
    expect(s1.events).toHaveLength(0);
    expect(promptKindCalls).toBe(0);

    // 2. `blocked` -> `seat.at-prompt` with `prompt: 'permission'`; screen read ONCE via `promptKind`.
    clock += 5_000;
    const s2 = await engine.observe('worker-1', 'blocked', clock);
    expect(promptKindCalls).toBe(1);
    expect(s2.events).toHaveLength(1);
    expect(s2.events[0]!.input.kind).toBe('seat.at-prompt');
    expect(s2.events[0]!.input.seat).toBe('worker-1');
    expect(s2.events[0]!.input.prompt).toBe('permission');
    expect(s2.events[0]!.recipients).toEqual(new Set(['crew-lead', 'op-1']));
    expect(s2.events[0]!.notifiedOwner).toBe(false);

    // 3. `working` after `blocked` -> `seat.unblocked` (closes the open at-prompt notice).
    clock += 10_000;
    const s3 = await engine.observe('worker-1', 'working', clock);
    expect(promptKindCalls).toBe(1); // Not called again on working
    expect(s3.events).toHaveLength(1);
    expect(s3.events[0]!.input.kind).toBe('seat.unblocked');
    expect(s3.events[0]!.input.seat).toBe('worker-1');
    expect(s3.events[0]!.recipients).toEqual(new Set(['crew-lead', 'op-1']));

    // 4. `done` -> `seat.done` ("worker-1 finished its turn").
    clock += 20_000;
    const s4 = await engine.observe('worker-1', 'done', clock);
    expect(promptKindCalls).toBe(1); // Not called on done
    expect(s4.events).toHaveLength(1);
    expect(s4.events[0]!.input.kind).toBe('seat.done');
    expect(s4.events[0]!.input.reason).toBe('worker-1 finished its turn');
    expect(s4.events[0]!.recipients).toEqual(new Set(['crew-lead', 'op-1']));

    // 5. `idle` before N (300s) -> no event yet.
    clock += 60_000;
    const s5 = await engine.observe('worker-1', 'idle', clock);
    expect(s5.events).toHaveLength(0);
    expect(s5.nudgeDue).toBe(false);

    // 6. `idle` at N (300s since turn finished) -> `seat.idle` once + one nudge due.
    clock += 240_000;
    const s6 = await engine.observe('worker-1', 'idle', clock);
    expect(s6.events).toHaveLength(1);
    expect(s6.events[0]!.input.kind).toBe('seat.idle');
    expect(s6.events[0]!.input.seat).toBe('worker-1');
    expect(s6.nudgeDue).toBe(true);

    // 7. Staying `idle` for another 300s in the SAME stretch -> never repeated!
    clock += 300_000;
    const s7 = await engine.observe('worker-1', 'idle', clock);
    expect(s7.events).toHaveLength(0);
    expect(s7.nudgeDue).toBe(false);
    const tickIdle = await engine.tick(clock + 300_000);
    expect(tickIdle).toHaveLength(0);

    // 8. `unknown` -> no event, logged.
    const logs: string[] = [];
    const engineWithLog = createSeatStatusEngine({
      team,
      source,
      onLog: (seat, msg) => logs.push(`${seat}|${msg}`),
    });
    const sUnknown = await engineWithLog.observe('worker-1', 'unknown', clock);
    expect(sUnknown.events).toHaveLength(0);
    expect(logs).toEqual(['worker-1|worker-1: herdr reports the status "unknown"']);

    // 9. Verify durable signed records in `events.jsonl` — one per transition (4 total).
    expect(promptKindCalls).toBe(1);
    const records = readVerifiedLog('acme', root, home);
    expect(records.map((r) => r.payload.kind)).toEqual([
      'seat.at-prompt',
      'seat.unblocked',
      'seat.done',
      'seat.idle',
    ]);
  });
});

describe('lead-first prompt escalation and clearance', () => {
  test('lead blocked escalates immediately to entity orchestrator and owner with mailbox record and desktop notification', async () => {
    const { root, entityRoot, home } = makeScratch();
    const team = parseTeam();

    // Register the entity's own team (`project === entity === 'floor'`) so `readEntityOrchestrator` resolves it.
    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'floor',
      entity: 'floor',
      session: 'floor-hq',
      root: entityRoot,
      roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      entity: 'floor',
      session: 'acme-dev',
      root,
      roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });

    const notifications: string[] = [];
    const source: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: 1_000 };
      },
      promptKind: () => 'permission',
      notify(title, body) {
        notifications.push(`${title}: ${body}`);
      },
    };

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      source,
      now: () => 1_000,
    });

    const step = await engine.observe('crew-lead', 'blocked', 1_000);
    expect(step.events).toHaveLength(1);
    const ev = step.events[0]!;
    expect(ev.input.kind).toBe('seat.at-prompt');
    expect(ev.input.to).toBe('owner');
    expect(ev.notifiedOwner).toBe(true);
    expect(ev.recipients.has('owner')).toBe(true);
    expect(ev.recipients.has('entity-lead')).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('crew-lead waits at a permission prompt');
    expect(ev.escalatedMailboxPaths).toHaveLength(1);
    expect(existsSync(ev.escalatedMailboxPaths[0]!)).toBe(true);
  });

  test('non-lead blocked notifies lead at once, escalates after prompt_escalation_seconds if un-cleared, and cancels escalation if working arrives in time', async () => {
    const { root, entityRoot, home } = makeScratch();
    const team = parseTeam();

    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'floor',
      entity: 'floor',
      session: 'floor-hq',
      root: entityRoot,
      roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      entity: 'floor',
      session: 'acme-dev',
      root,
      roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });

    let clock = 10_000;
    const notifications: string[] = [];
    const source: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: clock };
      },
      promptKind: () => 'trust',
      notify(title, body) {
        notifications.push(`${title}: ${body}`);
      },
    };

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      source,
      now: () => clock,
      promptEscalationSeconds: 300,
    });

    // Case A: worker-1 enters `blocked`, then clears to `working` after 120s (before 300s).
    const blocked1 = await engine.observe('worker-1', 'blocked', clock);
    expect(blocked1.events).toHaveLength(1);
    expect(blocked1.events[0]!.input.kind).toBe('seat.at-prompt');
    expect(blocked1.events[0]!.recipients).toEqual(new Set(['crew-lead', 'op-1']));
    expect(blocked1.events[0]!.notifiedOwner).toBe(false);
    expect(notifications).toHaveLength(0);

    clock += 120_000;
    const unblocked1 = await engine.observe('worker-1', 'working', clock);
    expect(unblocked1.events).toHaveLength(1);
    expect(unblocked1.events[0]!.input.kind).toBe('seat.unblocked');

    // Advancing past 300s after clearing produces NO escalation.
    clock += 300_000;
    const afterClear = await engine.tick(clock);
    expect(afterClear).toHaveLength(0);
    expect(notifications).toHaveLength(0);

    // Case B: worker-1 enters `blocked` again (past grace) and stays blocked for 300s.
    clock += 200_000;
    const blocked2 = await engine.observe('worker-1', 'blocked', clock);
    expect(blocked2.events).toHaveLength(1);
    expect(blocked2.events[0]!.input.kind).toBe('seat.at-prompt');
    expect(notifications).toHaveLength(0);

    // At 299s: still within the lead's window.
    clock += 299_000;
    expect(await engine.tick(clock)).toHaveLength(0);
    expect(notifications).toHaveLength(0);

    // At 300s: escalates to entity orchestrator and owner with desktop notification and mailbox record.
    clock += 1_000;
    const escalated = await engine.tick(clock);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.input.kind).toBe('seat.prompt-escalated');
    expect(escalated[0]!.input.seat).toBe('worker-1');
    expect(escalated[0]!.notifiedOwner).toBe(true);
    expect(escalated[0]!.recipients).toEqual(new Set(['entity-lead', 'owner']));
    expect(escalated[0]!.escalatedMailboxPaths).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('worker-1 is still at a trust prompt after 5 minutes');

    // Subsequent ticks in the same prompt spell do not re-escalate.
    clock += 60_000;
    expect(await engine.tick(clock)).toHaveLength(0);
    expect(notifications).toHaveLength(1);
  });
});

describe('flicker grace, waiter timeout, unreliable herdr (jules), human seats, and error resilience', () => {
  test('flicker (blocked -> working -> blocked within the 1-pass grace) produces one seat.at-prompt event, not two', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    let clock = 1_000_000;
    let promptReads = 0;

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      graceMs: 120_000,
      source: {
        async waitStatus() {
          return { outcome: 'timeout', at: clock };
        },
        promptKind() {
          promptReads += 1;
          return 'permission';
        },
      },
      now: () => clock,
    });

    const first = await engine.observe('worker-1', 'blocked', clock);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.input.kind).toBe('seat.at-prompt');
    expect(promptReads).toBe(1);

    // 2 seconds later: brief flicker to `working` and back to `blocked` within the 120s grace window.
    clock += 2_000;
    const mid = await engine.observe('worker-1', 'working', clock);
    expect(mid.events.map((e) => e.input.kind)).toEqual(['seat.unblocked']);

    clock += 2_000;
    const second = await engine.observe('worker-1', 'blocked', clock);
    expect(second.events).toHaveLength(0);
    expect(promptReads).toBe(1);

    const log = readVerifiedLog('acme', root, home);
    expect(log.filter((r) => r.payload.kind === 'seat.at-prompt')).toHaveLength(1);
  });

  test('waitStatus timeout re-arms the waiter without emitting a transition event', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    let waitCalls = 0;
    const targets: StatusTarget[] = [];

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      source: {
        async waitStatus(_seat, target) {
          waitCalls += 1;
          targets.push(target);
          if (waitCalls === 1) {
            return { outcome: 'changed', status: 'working', at: 1_000 };
          }
          if (waitCalls === 2) {
            return { outcome: 'timeout', at: 31_000 };
          }
          return { outcome: 'changed', status: 'done', at: 45_000 };
        },
      },
    });

    const step1 = await engine.waitSeatOnce('worker-1', 30_000, 'w2:p1');
    expect(step1.outcome).toBe('changed');
    expect(step1.status).toBe('working');
    expect(step1.rearmed).toBe(true);
    expect(step1.events).toHaveLength(0);

    // Timeout on the second wait: re-arms without emitting any event.
    const step2 = await engine.waitSeatOnce('worker-1', 30_000, 'w2:p1');
    expect(step2.outcome).toBe('timeout');
    expect(step2.status).toBe('working');
    expect(step2.rearmed).toBe(true);
    expect(step2.events).toHaveLength(0);
    expect(targets[1]).toEqual({ not: 'working' });

    // Next wait after re-arming catches the `done` transition and emits `seat.done`.
    const step3 = await engine.waitSeatOnce('worker-1', 30_000, 'w2:p1');
    expect(step3.outcome).toBe('changed');
    expect(step3.status).toBe('done');
    expect(step3.rearmed).toBe(true);
    expect(step3.events.map((e) => e.input.kind)).toEqual(['seat.done']);
    expect(readVerifiedLog('acme', root, home).map((r) => r.payload.kind)).toEqual(['seat.done']);
  });

  test('herdr_status: unreliable CLI (jules) is skipped by herdr waiters and keeps the screen module', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    const julesSeat = team.seats.find((s) => s.name === 'jules-1')!;
    const claudeSeat = team.seats.find((s) => s.name === 'worker-1')!;

    expect(isStatusWaiterSeat(julesSeat)).toBe(false);
    expect(isStatusWaiterSeat(claudeSeat)).toBe(true);
    expect(shouldReadScreenForStatus(julesSeat, 'working', true)).toBe(true);
    expect(shouldReadScreenForStatus(claudeSeat, 'working', true)).toBe(false);
    expect(shouldReadScreenForStatus(claudeSeat, 'blocked', true)).toBe(true);

    let waitCalls = 0;
    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      idleThresholdSeconds: 60,
      source: {
        async waitStatus() {
          waitCalls += 1;
          return { outcome: 'timeout', at: 1_000 };
        },
        readUnreliableScreen() {
          return { kind: 'permission' };
        },
        promptKind() {
          return 'permission';
        },
      },
    });

    // `waitSeatOnce` never calls `waitStatus` for `jules-1`.
    const waited = await engine.waitSeatOnce('jules-1', 30_000, 'w4:p1');
    expect(waited.outcome).toBe('skipped');
    expect(waited.skipped).toBe('unreliable');
    expect(waitCalls).toBe(0);

    // `pollUnreliableSeat` uses the screen module for `jules-1`.
    const polled = await engine.pollUnreliableSeat('jules-1', undefined, 2_000, 'w4:p1');
    expect(polled.status).toBe('blocked');
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]!.input.kind).toBe('seat.at-prompt');
    expect(polled.events[0]!.input.prompt).toBe('permission');
  });

  test('human: true seat is never waited on, never emits nudges, and is never typed into', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    const humanSeat = team.seats.find((s) => s.name === 'owner-pane')!;
    expect(isStatusWaiterSeat(humanSeat)).toBe(false);

    let waitCalls = 0;
    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      idleThresholdSeconds: 0,
      source: {
        async waitStatus() {
          waitCalls += 1;
          return { outcome: 'changed', status: 'idle', at: 1_000 };
        },
      },
    });

    const waited = await engine.waitSeatOnce('owner-pane', 30_000, 'w5:p1');
    expect(waited.outcome).toBe('skipped');
    expect(waited.skipped).toBe('human');
    expect(waited.nudgeDue).toBe(false);
    expect(waitCalls).toBe(0);

    const observed = await engine.observe('owner-pane', 'idle', 10_000);
    expect(observed.skipped).toBe('human');
    expect(observed.events).toHaveLength(0);
    expect(observed.nudgeDue).toBe(false);

    const pool = engine.startWaiters({ 'owner-pane': 'w5:p1' }, { maxIterations: 3 });
    await pool.done;
    expect(waitCalls).toBe(0);
    expect(readVerifiedLog('acme', root, home)).toHaveLength(0);
  });

  test('unreachable herdr (wait agent-status error) fails cleanly with no crash and no event storm', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();
    const errors: string[] = [];
    let calls = 0;

    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      onLog: (seat, msg) => errors.push(`${seat}:${msg}`),
      source: {
        async waitStatus() {
          calls += 1;
          return { outcome: 'error', error: 'herdr socket connection refused', at: calls * 1_000 };
        },
      },
    });

    for (let i = 0; i < 5; i += 1) {
      const step = await engine.waitSeatOnce('worker-1', 5_000, 'w2:p1');
      expect(step.outcome).toBe('error');
      expect(step.rearmed).toBe(false);
      expect(step.events).toHaveLength(0);
    }
    expect(calls).toBe(5);
    expect(errors).toHaveLength(5);
    expect(readVerifiedLog('acme', root, home)).toHaveLength(0);
  });

  test('zero typing by waiters and one signed event per transition across repeated identical polls', async () => {
    const { root, home } = makeScratch();
    const team = parseTeam();

    // Verify statically and dynamically that status-events never imports or calls typeText, pressEnter, or sendKey.
    const statusEventsSource = readFileSync(
      new URL('../src/watch/status-events.ts', import.meta.url),
      'utf8',
    );
    expect(statusEventsSource).not.toMatch(/\b(typeText|pressEnter|sendKey)\b/);

    let clock = 1_000;
    const engine = createSeatStatusEngine({
      team,
      root,
      home,
      idleThresholdSeconds: 60,
      source: {
        async waitStatus() {
          return { outcome: 'timeout', at: clock };
        },
        promptKind: () => 'question',
      },
      now: () => clock,
    });

    // Repeated `working` polls -> 0 events.
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      expect((await engine.observe('worker-1', 'working', clock)).events).toHaveLength(0);
    }

    // Transition to `blocked` followed by 4 repeated `blocked` polls -> 1 `seat.at-prompt` event total.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await engine.observe('worker-1', 'blocked', clock);
    }

    // Transition to `working` followed by 3 repeated `working` polls -> 1 `seat.unblocked` event total.
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      await engine.observe('worker-1', 'working', clock);
    }

    // Transition to `done` followed by 3 repeated `done` polls -> 1 `seat.done` event total.
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      await engine.observe('worker-1', 'done', clock);
    }

    // Transition to `idle` and 5 repeated `idle` polls past 60s -> 1 `seat.idle` event total.
    for (let i = 0; i < 5; i += 1) {
      clock += 20_000;
      await engine.observe('worker-1', 'idle', clock);
    }

    const log = readVerifiedLog('acme', root, home);
    expect(log.map((r) => r.payload.kind)).toEqual([
      'seat.at-prompt',
      'seat.unblocked',
      'seat.done',
      'seat.idle',
    ]);

    // No send-drops or messages were typed into any worker pane.
    expect(existsSync(join(root, '.agents', 'send-drops')) ? readdirSync(join(root, '.agents', 'send-drops')) : []).toEqual([]);
  });
});
