// The dev-mode role word is `lead`. A seat named lead, and a roster line whose role
// word is orchestrator, take nothing from that spelling: the resolved lead is admitted,
// and send follows the leads capability.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { devModeOwnerLift } from '../src/dev_mode.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { admitSend, type AdmitTeam } from '../src/send/admit.ts';
import { updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const SESSION = 'home-session';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(): string {
  const base = fixtureBase('lead-word-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function seat(role: string, name: string, leads: boolean): string {
  return `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${leads ? '    leads: true\n' : ''}`;
}

function fileText(how: 'coordinator' | 'mark'): string {
  const key = how === 'coordinator' ? 'coordinator: keeper\n' : '';
  return `format: 1
project: alpha
entity: floor
operator: worker
${key}session: ${SESSION}
trust: []
workspace:
  mode: shared
seats:
${seat('implementer', 'keeper', how === 'mark')}${seat('orchestrator', 'lead', false)}${seat('implementer', 'worker', false)}`;
}

function teamOf(how: 'coordinator' | 'mark'): TeamFile {
  const parsed = validateTeamFile(fileText(how));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function placed(dir: string): void {
  mkdirSync(dir, { recursive: true });
  updateState(dir, (state) => {
    state.sessions[SESSION] = {
      seats: {
        keeper: { stage: 'ready', pane: 'fixture-pane-one' },
        lead: { stage: 'ready', pane: 'fixture-pane-two' },
        worker: { stage: 'ready', pane: 'fixture-pane-one' },
      },
      worktrees: {},
    };
  });
}

function lift(team: TeamFile, root: string, dir: string, name: string, pane: string) {
  return devModeOwnerLift({
    env: { TEAMCLI_DEV_MODE: '1' },
    stdinIsTTY: false,
    caller: { kind: 'seat', name, pane, session: SESSION },
  }, {
    command: 'grant',
    refusal: 'only the owner grants',
    team,
    root,
    dir,
    audit: 'later',
  });
}

describe('the lead role word', () => {
  test('a seat named lead is not admitted, and the resolved lead still is', () => {
    const base = scratch();
    const root = join(base, 'alpha');
    const dir = join(root, '.agents');
    mkdirSync(root, { recursive: true });
    placed(dir);
    for (const how of ['coordinator', 'mark'] as const) {
      const team = teamOf(how);
      expect(team.orchestrator).toBe('keeper');
      const named = lift(team, root, dir, 'lead', 'fixture-pane-two');
      expect(named.lifted).toBe(false);
      expect(named.role).toBeNull();
      const resolved = lift(team, root, dir, 'keeper', 'fixture-pane-one');
      expect(resolved.lifted).toBe(true);
      expect(resolved.role).toBe('lead');
    }
  });

  test('send follows the leads capability, not the role word or the seat name', () => {
    const byCapability: AdmitTeam = {
      project: 'alpha',
      entity: 'floor',
      roster: [
        { agent: 'agt_keeper', seat: 'keeper', role: 'implementer', leads: true },
        { agent: 'agt_named', seat: 'lead', role: 'orchestrator' },
      ],
    };
    const other: AdmitTeam = {
      project: 'beta',
      entity: 'floor',
      roster: [
        { agent: 'agt_other', seat: 'keeper', role: 'implementer', leads: true },
      ],
    };
    const teams = { home: byCapability, side: other };
    const named = admitSend(
      { seat: 'lead', team: 'home', role: 'orchestrator' },
      { seat: 'keeper', team: 'side' },
      teams,
    );
    expect(named.ok).toBe(false);
    const resolved = admitSend(
      { seat: 'keeper', team: 'home' },
      { seat: 'keeper', team: 'side' },
      teams,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.rule).toBe('an orchestrator to another orchestrator');

    const legacyName: AdmitTeam = {
      project: 'alpha',
      entity: 'floor',
      orchestrator: 'lead',
      roster: [
        { agent: 'agt_named', seat: 'lead', role: 'implementer', leads: true },
        { agent: 'agt_keeper', seat: 'keeper', role: 'orchestrator' },
      ],
    };
    const held = admitSend(
      { seat: 'lead', team: 'home' },
      { seat: 'keeper', team: 'side' },
      { home: legacyName, side: other },
    );
    expect(held.ok).toBe(true);
    const wordOnly = admitSend(
      { seat: 'keeper', team: 'home', role: 'orchestrator' },
      { seat: 'keeper', team: 'side' },
      { home: legacyName, side: other },
    );
    expect(wordOnly.ok).toBe(false);
  });
});
