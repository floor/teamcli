// A prompt that does not clear never goes silent: a team's lead at a prompt climbs to the
// entity's lead and the owner at once, and any other seat's prompt climbs when its lead has not
// cleared it within `prompt_escalation_seconds`. The climb is an event and a signed runtime
// record in the entity lead's own mailbox, and it is never a keystroke.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OWNER_AT_ONCE_KINDS,
  DEFAULT_PROMPT_ESCALATION_SECONDS,
  isOwnerAtOnce,
  isPrivilegedKind,
  recipientsForEvent,
} from '../src/bus/kinds.ts';
import type { EventAppendInput, EventPayload } from '../src/bus/log.ts';
import { escalatePromptReports, publishWatchReportsToBus, watchReportEvent } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { EVENT_ROUTING_DEFAULTS, EVENT_THRESHOLDS } from '../src/policy/events.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';

const MIN = 60_000;
const TS = '2026-10-18T12:00:00.000Z';

// The team a prompt stops: a lead, an operator, and one worker whose pane is a person's. The
// entity's own team sits in another root, as a real entity's does.
const CREW = `format: 1
project: crew
entity: acme
coordinator: crew-lead
operator: crew-op
session: crew
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
    human: true
`;

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const permission = 'Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n';

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function team(): TeamFile {
  const result = validateTeamFile(CREW);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// Three roots and a home: the crew's checkout, the entity's own team's checkout, and the
// registry that names both. The entity's lead is `head-lead`; it is marked `leads` in the roster,
// which is where `entityOrchestratorOf` reads it.
function scratch(withEntity = true): { crewRoot: string; entityRoot: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'prompt-escalation-')));
  dirs.push(base);
  const crewRoot = join(base, 'crew');
  const entityRoot = join(base, 'entity');
  const home = join(base, 'home');
  for (const root of [crewRoot, entityRoot]) mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  if (withEntity) {
    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'acme',
      entity: 'acme',
      session: 'acme',
      root: entityRoot,
      roster: [{ agent: 'agt_head000000', seat: 'head-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    upsertTeam(home, teamIdOf(crewRoot), {
      project: 'crew',
      entity: 'acme',
      session: 'crew',
      root: crewRoot,
      roster: [{ agent: 'agt_crew000000', seat: 'crew-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
  }
  return { crewRoot, entityRoot, home };
}

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The crew at work, with the lead and the worker where a scene puts them.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['crew-lead', 'w0', 'working', busy],
    ['crew-op', 'w1', 'working', busy],
    ['worker-1', 'w2', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

function at(live: Live, now: number, memory = newMemory()): ReturnType<typeof pass> {
  return pass({ team: team(), watch: team().watch, state: emptySession(), live, machine: fine, now, memory });
}

const event = (over: Partial<EventPayload>): EventPayload => ({
  v: 1,
  seq: 1,
  ts: TS,
  kind: 'seat.prompt-escalated',
  session: 'crew',
  record_id: 'watch:prompt-escalated:worker-1:2026-10-18T12:00:00.000Z',
  ...over,
});

describe('a prompt climbs to the entity orchestrator and the owner', () => {
  test('the release wiring: a default route to entity and owner, privileged, and at once', () => {
    expect(EVENT_ROUTING_DEFAULTS['seat.prompt-escalated']).toEqual(['entity', 'owner']);
    expect(EVENT_THRESHOLDS.prompt_escalation_seconds).toBe(300);
    expect(DEFAULT_PROMPT_ESCALATION_SECONDS).toBe(300);
    expect(isPrivilegedKind('seat.prompt-escalated')).toBe(true);
    expect(isOwnerAtOnce('seat.prompt-escalated')).toBe(true);
    expect([...DEFAULT_OWNER_AT_ONCE_KINDS]).toContain('seat.prompt-escalated');
  });

  test("a lead at a prompt is routed to the entity's lead and the owner from the start", () => {
    const roles = { orchestrator: 'crew-lead', operator: 'crew-op', entityOrchestrator: 'head-lead' };
    const to = recipientsForEvent(event({ kind: 'seat.at-prompt', seat: 'crew-lead', prompt: 'permission' }), roles);
    expect([...to].sort()).toEqual(['crew-lead', 'crew-op', 'head-lead', 'owner']);
  });

  test('a climbed prompt reaches the entity lead and the owner; with no entity lead, the owner stands', () => {
    const roles = { orchestrator: 'crew-lead', operator: 'crew-op', entityOrchestrator: 'head-lead' };
    expect([...recipientsForEvent(event({}), roles)].sort()).toEqual(['head-lead', 'owner']);
    // Never silent: the registry may name no entity lead, and the owner is still routed.
    expect([...recipientsForEvent(event({}), { orchestrator: 'crew-lead' })]).toEqual(['owner']);
  });

  test("the lead's prompt leaves one signed record in the entity lead's own mailbox, and types nothing", () => {
    const { crewRoot, entityRoot, home } = scratch();
    const stuck = live({ 'crew-lead': { status: 'idle', screen: permission } });
    const memory = newMemory();
    const first = at(stuck, 0, memory);
    expect(first.reports).toContainEqual({
      key: 'blocked:crew-lead',
      text: "crew-lead waits at a permission prompt: its owner's to answer",
      to: 'owner',
    });
    // The climb itself is the lead's at-prompt, already above the team: no clock is kept for it.
    expect(at(stuck, 30 * MIN, memory).reports).toEqual([]);

    const climbed = escalatePromptReports(home, crewRoot, team(), 'crew', first.reports, TS);
    expect(climbed.failed).toEqual([]);
    expect(climbed.written.length).toBe(1);
    const path = climbed.written[0]!;
    expect(path.startsWith(join(entityRoot, '.agents', 'messages', 'head-lead'))).toBe(true);
    const sent = JSON.parse(readFileSync(path, 'utf8')) as {
      payload: { to: string; session: string; from: string; body: string };
    };
    expect(sent.payload.to).toBe('head-lead');
    expect(sent.payload.session).toBe('acme');
    expect(sent.payload.from).toBe('runtime');
    expect(sent.payload.body).toContain('crew:');
    expect(sent.payload.body).toContain('crew-lead waits at a permission prompt');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Nothing is typed anywhere: no drop is written under either root.
    expect(existsSync(join(crewRoot, '.agents', 'send-drops'))).toBe(false);
    expect(existsSync(join(entityRoot, '.agents', 'send-drops'))).toBe(false);
  });
});

describe("a non-lead's prompt climbs when the lead has not cleared it within N", () => {
  test('no climb before the window, one at it, and no second climb for the same spell', () => {
    const { crewRoot, home } = scratch();
    const stuck = live({ 'worker-1': { status: 'idle', screen: permission } });
    const memory = newMemory();
    expect(at(stuck, 0, memory).reports).toEqual([
      { key: 'blocked:worker-1', text: "worker-1 waits at a permission prompt: its owner's to answer", to: 'owner' },
    ]);
    expect(at(stuck, 5 * MIN - 1, memory).reports).toEqual([]);
    const climb = at(stuck, 5 * MIN, memory);
    expect(climb.reports).toEqual([{
      key: 'prompt-escalated:worker-1',
      text: "worker-1 is still at a permission prompt after 5 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told",
      to: 'owner',
    }]);
    expect(at(stuck, 60 * MIN, memory).reports).toEqual([]);

    // The report the watch raises is the event the routing sends above the team.
    const mapped = watchReportEvent(climb.reports[0]!, 'crew', TS);
    expect(mapped?.kind).toBe('seat.prompt-escalated');
    expect(mapped?.seat).toBe('worker-1');
    expect(mapped?.to).toBeUndefined();

    // And the climb is left in the entity lead's mailbox, with the climb's words.
    const written = escalatePromptReports(home, crewRoot, team(), 'crew', climb.reports, TS);
    expect(written.failed).toEqual([]);
    expect(written.written.length).toBe(1);
    const sent = JSON.parse(readFileSync(written.written[0]!, 'utf8')) as { payload: { to: string; body: string } };
    expect(sent.payload.to).toBe('head-lead');
    expect(sent.payload.body).toContain('worker-1 is still at a permission prompt after 5 minutes');
  });

  test('the event the watch publishes is one, addressed to the owner', async () => {
    const published: EventAppendInput[] = [];
    await publishWatchReportsToBus('crew', 'crew', [{
      key: 'prompt-escalated:worker-1',
      text: 'worker-1 is still at a permission prompt after 5 minutes',
      to: 'owner',
    }], TS, async (_root, event) => {
      published.push(event);
      return { kind: 'unavailable' };
    });
    expect(published.length).toBe(1);
    expect(published[0]!.kind).toBe('seat.prompt-escalated');
    expect(published[0]!.to).toBe('owner');
  });
});

describe('a lead acting stops the climb', () => {
  test('a prompt cleared before the window raises nothing, and the clock starts again if it returns', () => {
    const { crewRoot, home } = scratch();
    const memory = newMemory();
    const stuck = live({ 'worker-1': { status: 'idle', screen: permission } });
    const cleared = live({ 'worker-1': { status: 'working', screen: busy } });
    expect(at(stuck, 0, memory).reports.length).toBe(1);
    // The lead clears it two minutes in: the clock goes with the prompt.
    expect(at(cleared, 2 * MIN, memory).reports).toEqual([]);
    expect(at(cleared, 5 * MIN, memory).reports).toEqual([]);
    expect(at(cleared, 10 * MIN, memory).reports).toEqual([]);
    // The same prompt returns: a new spell, counting from its own first sight.
    expect(at(stuck, 12 * MIN, memory).reports.length).toBe(1);
    expect(at(stuck, 16 * MIN, memory).reports).toEqual([]);
    expect(at(stuck, 17 * MIN, memory).reports).toEqual([{
      key: 'prompt-escalated:worker-1',
      text: "worker-1 is still at a permission prompt after 5 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told",
      to: 'owner',
    }]);

    // The cleared spell never reached the entity lead.
    const clearedClimb = escalatePromptReports(home, crewRoot, team(), 'crew', [], TS);
    expect(clearedClimb).toEqual({ written: [], failed: [] });
    expect(existsSync(join(crewRoot, '.agents', 'messages'))).toBe(false);
  });

  test("a lead's own prompt keeps no clock: routing is the climb, not a timer", () => {
    const stuck = live({ 'crew-lead': { status: 'idle', screen: permission } });
    const memory = newMemory();
    at(stuck, 0, memory);
    for (const minutes of [5, 10, 60]) {
      expect(at(stuck, minutes * MIN, memory).reports.filter((report) => report.key.startsWith('prompt-escalated'))).toEqual([]);
    }
  });
});

describe("nothing is typed into a human's pane", () => {
  test('a human seat at a prompt is reported and climbed, with no work drop and nothing typed', () => {
    const { crewRoot, entityRoot, home } = scratch();
    const stuck = live({ 'worker-1': { status: 'idle', screen: permission } });
    const memory = newMemory();
    const first = at(stuck, 0, memory);
    const climb = at(stuck, 5 * MIN, memory);
    // The human's pane is reported like any other, and it is never a work-drop target.
    expect(first.reports.map((report) => report.key)).toEqual(['blocked:worker-1']);
    expect(first.work).toEqual([]);
    expect(first.ring).toBeNull();
    expect(climb.work).toEqual([]);
    expect(climb.ring).toBeNull();
    // The climb writes to the entity lead only: the human's mailbox stays empty, and no drop,
    // typed line or send-drop is written anywhere.
    const written = escalatePromptReports(home, crewRoot, team(), 'crew', climb.reports, TS);
    expect(written.written.length).toBe(1);
    expect(readdirSync(join(entityRoot, '.agents', 'messages'))).toEqual(['head-lead']);
    expect(existsSync(join(crewRoot, '.agents', 'messages', 'worker-1'))).toBe(false);
    expect(existsSync(join(crewRoot, '.agents', 'send-drops'))).toBe(false);
  });

  test('with no entity lead in the registry the climb is still the owner-routed event, and writes nothing', () => {
    const { crewRoot, home } = scratch(false);
    const report = {
      key: 'prompt-escalated:worker-1',
      text: 'worker-1 is still at a permission prompt after 5 minutes',
      to: 'owner',
    };
    expect(escalatePromptReports(home, crewRoot, team(), 'crew', [report], TS)).toEqual({ written: [], failed: [] });
    expect(existsSync(join(crewRoot, '.agents', 'messages'))).toBe(false);
    expect(recipientsForEvent(event({ kind: 'seat.prompt-escalated', seat: 'worker-1' }), {})).toEqual(new Set(['owner']));
  });
});
