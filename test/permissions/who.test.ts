// The bridge (src/permissions/who.ts): a walked caller read as the resolver's record. The
// scenes pin what every wired gate stands on — the owner is the owner; a pane, a no-terminal
// owner and an unplaced run stand for no record; a seat is its registry roster line, and where
// the registry holds no record of the team, the file's own declaration; a seat the roster does
// not list has no record, whatever the file declares; a registry that cannot be read refuses
// every seat closed, naming "the registry cannot be read", rather than fall back to the file;
// `leads` is the file's resolved lead (or the roster's mark); and the record the bridge hands
// over is the one the resolver decides from — grants included, which is why a file-fallback
// record, carrying no agent id, can be named by no seat grant.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachedRefusal, mayChangeTeamVerdict, mayPauseTeamVerdict, type Caller, type SeatStanding } from '../../src/caller.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { writeGrant } from '../../src/permissions/grants.ts';
import { COMMAND_GATES } from '../../src/permissions/map.ts';
import { callerRecordOf, gateVerdict, resolveCaller, rosterOf, type BridgeTeam } from '../../src/permissions/who.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';

const AGENT = 'agt_0123456789ab';
const NOW = new Date('2026-10-17T12:00:00.000Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project root and the home beside it: the root is real, so the team id is the registry's
 *  own hash of it, and grants and records resolve against the same paths the bridge reads. */
function world(): { root: string; home: string; id: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-who-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const root = join(base, 'acme');
  mkdirSync(root);
  return { root, home, id: teamIdOf(root) };
}

function seatCaller(name: string): Caller {
  return { kind: 'seat', name, pane: 'w0:p1', session: 'acme' };
}

/** The placement a seat's own state record holds: session `acme`, pane `w0:p1`, and ready. */
function placement(stage: 'launched' | 'named' | 'ready' = 'ready'): SeatStanding {
  return { session: 'acme', recordedPane: 'w0:p1', stage };
}

/** The roster lines a listed read hands the record — null where the registry holds no record of
 *  the team, which is the one answer the record reads as the file's own declaration. */
function lines(home: string, root: string) {
  const read = rosterOf(home, root);
  return read.kind === 'listed' ? read.roster : null;
}

/** The file's own side of the bridge: a team whose lead is `lead`, beside a plain seat. */
function fileTeam(id: string): BridgeTeam {
  return {
    id,
    orchestrator: 'lead',
    operator: 'operator',
    seats: [
      { name: 'lead', role: 'coordinator' },
      { name: 'worker', role: 'implementer' },
    ],
  };
}

/** The registry's side: the team registered for `root`, its roster the lines given. */
function register(root: string, home: string, roster: { agent: string; seat: string; role: string; leads?: boolean }[]): void {
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, roster });
}

describe('the owner and the placements that stand for no one', () => {
  test('the owner is the owner, whatever else stands', () => {
    expect(callerRecordOf({ kind: 'owner' }, fileTeam('aaaaaaaaaaaa'), null)).toEqual({ kind: 'owner' });
  });

  test('a no-terminal owner, a pane and an unplaced run are null — no record, and the resolver says so', () => {
    for (const caller of [
      { kind: 'owner-no-tty' } as Caller,
      { kind: 'pane', pane: 'w0:p1', session: 'acme' } as Caller,
      { kind: 'unplaced', reason: 'it runs under herdr' } as Caller,
    ]) {
      expect(callerRecordOf(caller, fileTeam('aaaaaaaaaaaa'), null)).toBeNull();
    }
    const { root, home, id } = world();
    const decision = resolveCaller({ kind: 'pane', pane: 'w0:p1', session: 'acme' }, fileTeam(id), root, home, 'remove', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'no-record' });
    expect(decision.why).toContain('admits the owner or `leads` for its own team');
  });
});

describe('a seat, where the registry holds no record of the team', () => {
  test("the file's own declaration stands: its role, its leads, and no agent id", () => {
    const team = fileTeam('aaaaaaaaaaaa');
    const lead = callerRecordOf(seatCaller('lead'), team, null);
    expect(lead).toMatchObject({ kind: 'seat', seat: 'lead', team: 'aaaaaaaaaaaa', role: 'coordinator', leads: true, bundle: [] });
    expect(lead).not.toBeNull();
    expect((lead as { agent: string }).agent).toBe('');
    const worker = callerRecordOf(seatCaller('worker'), team, null);
    expect(worker).toMatchObject({ kind: 'seat', role: 'implementer', leads: false });
  });

  test('a seat the file does not declare is null', () => {
    expect(callerRecordOf(seatCaller('stranger'), fileTeam('aaaaaaaaaaaa'), null)).toBeNull();
  });

  test('the lead is admitted to an operation row, and the plain seat is refused with the rule named', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    expect(resolveCaller(seatCaller('lead'), team, root, home, 'remove', placement(), NOW)).toMatchObject({ effect: 'allow', rule: 'leads' });
    const refused = resolveCaller(seatCaller('worker'), team, root, home, 'remove', placement(), NOW);
    expect(refused).toMatchObject({ effect: 'deny', rule: 'owner-or-leads' });
    expect(refused.why).toContain('holds no `leads`');
    // `add` is owner-only: not even the lead is admitted by the map.
    expect(resolveCaller(seatCaller('lead'), team, root, home, 'add', placement(), NOW)).toMatchObject({ effect: 'deny', rule: 'owner-only' });
    // `register` is a report: the seat's own team, and only its own.
    expect(resolveCaller(seatCaller('worker'), team, root, home, 'register', placement(), NOW)).toMatchObject({ effect: 'allow', rule: 'own-team' });
  });

  test('a coordinator-keyed file leads: the normalised lead decides, not a per-seat mark', () => {
    // The loader normalises both spellings — the top-level `coordinator:` key and a `leads: true`
    // mark — into `team.orchestrator`, and the bridge must read that: a coordinator-keyed lead
    // (some teams declare theirs this way) holds `leads` for the map's rows
    // without any mark on its seat.
    const text = [
      'format: 1',
      'project: acme',
      'session: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      '  base: main',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    label: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n');
    const validated = validateTeamFile(text);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.team.orchestrator).toBe('lead');
    const { root, home, id } = world();
    const team: BridgeTeam = { id, orchestrator: validated.team.orchestrator, operator: validated.team.operator, seats: validated.team.seats };
    expect(callerRecordOf(seatCaller('lead'), team, null)).toMatchObject({ kind: 'seat', leads: true });
    for (const command of ['up', 'down', 'restart', 'remove']) {
      expect(resolveCaller(seatCaller('lead'), team, root, home, command, placement(), NOW)).toMatchObject({ effect: 'allow', rule: 'leads' });
    }
  });

  test('a file-fallback record carries no agent id, so no seat grant can name it', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    writeGrant(home, { roots: [root], name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] }, { now: NOW });
    writeGrant(home, { roots: [root], name: 'team-envelope', kind: 'team', grantee: id, capabilities: ['merge'] }, { now: NOW });
    // The grant names an agent, and the record carries none: it does not name this caller at
    // all — absent, not merely outside the envelope the team grant carries.
    const decision = resolveCaller(seatCaller('worker'), team, root, home, 'merge', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
  });
});

describe('a seat, where the registry holds the team', () => {
  test('the roster line is the record: its agent, seat and role, and its own leads mark', () => {
    const { root, home, id } = world();
    register(root, home, [
      { agent: AGENT, seat: 'worker', role: 'implementer', leads: true },
      { agent: 'agt_ffffffffffff', seat: 'lead', role: 'coordinator' },
    ]);
    const team = fileTeam(id);
    const worker = callerRecordOf(seatCaller('worker'), team, lines(home, root));
    expect(worker).toMatchObject({ kind: 'seat', agent: AGENT, seat: 'worker', role: 'implementer', team: id, leads: true });
    // The file's resolved lead still leads — the roster of a sync written before the field
    // reads unchanged.
    const lead = callerRecordOf(seatCaller('lead'), team, lines(home, root));
    expect(lead).toMatchObject({ kind: 'seat', leads: true, agent: 'agt_ffffffffffff' });
    expect(resolveCaller(seatCaller('lead'), team, root, home, 'remove', placement(), NOW)).toMatchObject({ effect: 'allow', rule: 'leads' });
    // And the marks can cross: a seat the file declares as no lead, marked in the roster.
    expect(resolveCaller(seatCaller('worker'), team, root, home, 'down', placement(), NOW)).toMatchObject({ effect: 'allow', rule: 'leads' });
  });

  test('a seat the roster does not list has no record, whatever the file declares', () => {
    const { root, home, id } = world();
    register(root, home, [{ agent: AGENT, seat: 'worker', role: 'implementer' }]);
    const team = fileTeam(id);
    expect(callerRecordOf(seatCaller('lead'), team, lines(home, root))).toBeNull();
    const decision = resolveCaller(seatCaller('lead'), team, root, home, 'remove', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'no-record' });
    expect(decision.why).toContain('no registry record stands for this caller');
  });

  test('the roster record feeds the grants: a seat grant and the envelope admit, and the agent is the roster\'s', () => {
    const { root, home, id } = world();
    register(root, home, [{ agent: AGENT, seat: 'worker', role: 'implementer' }]);
    writeGrant(home, { roots: [root], name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] }, { now: NOW });
    writeGrant(home, { roots: [root], name: 'team-envelope', kind: 'team', grantee: id, capabilities: ['merge'] }, { now: NOW });
    expect(resolveCaller(seatCaller('worker'), fileTeam(id), root, home, 'merge', placement(), NOW)).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
  });

  test('an empty roster is a record that knows no seat, and a registry that cannot be read refuses closed', () => {
    const { root, home, id } = world();
    register(root, home, []);
    expect(rosterOf(home, root)).toEqual({ kind: 'listed', roster: [] });
    expect(callerRecordOf(seatCaller('lead'), fileTeam(id), lines(home, root))).toBeNull();
    // A registry file that does not parse is not a team the registry holds no record of: the
    // bridge refuses every seat closed rather than judge it from the file. The file declares
    // `lead` the coordinator, so the fallback would have admitted this `remove`.
    const { root: otherRoot, home: otherHome, id: otherId } = world();
    mkdirSync(join(otherHome, '.config', 'team'), { recursive: true });
    writeFileSync(join(otherHome, '.config', 'team', 'teams.yaml'), 'not: [a, registry\n');
    expect(rosterOf(otherHome, otherRoot)).toMatchObject({ kind: 'unreadable' });
    const decision = resolveCaller(seatCaller('lead'), fileTeam(otherId), otherRoot, otherHome, 'remove', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'unreadable' });
    expect(decision.why).toContain('the registry cannot be read');
  });
});

describe('each mapped row pins the module function its kind names', () => {
  /** The callers the verdict functions tell apart: the owner, the orchestrator's seat, the
   *  operator's seat, a plain seat, a seat on another pane, a pane with no agent, and the two
   *  placements a terminal requirement refuses or lets through. */
  function callers(): Caller[] {
    return [
      { kind: 'owner' },
      { kind: 'owner-no-tty' },
      { kind: 'seat', name: 'lead', pane: 'w0:p1', session: 'acme' },
      { kind: 'seat', name: 'operator', pane: 'w0:p1', session: 'acme' },
      { kind: 'seat', name: 'worker', pane: 'w0:p1', session: 'acme' },
      { kind: 'seat', name: 'worker', pane: 'w9:p9', session: 'acme' },
      { kind: 'pane', pane: 'w0:p1', session: 'acme' },
      { kind: 'unplaced', reason: 'it is run by an agent outside herdr' },
    ];
  }

  test('every `team-change` row is `mayChangeTeamVerdict`, for every placement', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    const rows = Object.entries(COMMAND_GATES).filter(([, gate]) => gate.kind === 'team-change');
    expect(rows.map(([command]) => command).sort()).toEqual([
      'hold',
      'swap:cancel',
      'swap:queue',
      'worktree',
      'worktree:list',
      'worktree:new',
      'worktree:remove',
    ]);
    for (const [command] of rows) {
      for (const caller of callers()) {
        const verdict = mayChangeTeamVerdict(caller, team, placement());
        expect(gateVerdict(caller, team, root, home, command, placement(), () => NOW), `${command} / ${callerWords(caller)}`).toEqual(verdict);
        const decision = resolveCaller(caller, team, root, home, command, placement(), NOW);
        if (verdict.kind === 'ok') expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'allow', rule: 'team-change' });
        else if (verdict.kind === 'refused') expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'deny', rule: 'team-change' });
        else expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'deny', rule: 'unplaced' });
      }
    }
  });

  test('the operator\'s seat is admitted and a `leads` seat that is neither lead nor operator is refused', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    // `hold` and every `worktree` verb: the operator's seat stands where the state records it.
    for (const command of ['hold', 'worktree:new']) {
      expect(gateVerdict({ kind: 'seat', name: 'operator', pane: 'w0:p1', session: 'acme' }, team, root, home, command, placement(), () => NOW)).toEqual({ kind: 'ok' });
      expect(resolveCaller({ kind: 'seat', name: 'operator', pane: 'w0:p1', session: 'acme' }, team, root, home, command, placement(), NOW)).toMatchObject({
        effect: 'allow',
        rule: 'team-change',
      });
      // A seat marked `leads` in the file is not one of the three callers the function admits.
      const refused = resolveCaller(seatCaller('worker'), team, root, home, command, placement(), NOW);
      expect(refused).toMatchObject({ effect: 'deny', rule: 'team-change' });
      expect(refused.why).toContain('neither the owner, the orchestrator\'s seat nor the operator\'s seat');
    }
  });

  test('every `team-pause` row is `mayPauseTeamVerdict`, for every placement', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    const rows = Object.entries(COMMAND_GATES).filter(([, gate]) => gate.kind === 'team-pause');
    expect(rows.map(([command]) => command).sort()).toEqual(['pause', 'resume']);
    for (const [command, gate] of rows) {
      for (const caller of callers()) {
        const verdict = mayPauseTeamVerdict(caller, team, placement());
        expect(gateVerdict(caller, team, root, home, command, placement(), () => NOW), `${command} / ${callerWords(caller)}`).toEqual(verdict);
        const decision = resolveCaller(caller, team, root, home, command, placement(), NOW);
        if (detachedRefusal(caller, gate.terminal as NonNullable<typeof gate.terminal>) !== undefined) {
          expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'deny', rule: 'terminal' });
        } else if (verdict.kind === 'ok') {
          expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'allow', rule: 'team-pause' });
        } else if (verdict.kind === 'refused') {
          expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'deny', rule: 'team-pause' });
        } else {
          expect(decision, `${command} / ${callerWords(caller)}`).toMatchObject({ effect: 'deny', rule: 'unplaced' });
        }
      }
    }
  });

  test("the operator's seat is not admitted to `team-pause`", () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    const decision = resolveCaller(seatCaller('operator'), team, root, home, 'pause', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'team-pause' });
    expect(decision.why).toContain("neither the owner nor the orchestrator's seat");
    expect(gateVerdict(seatCaller('operator'), team, root, home, 'resume', placement(), () => NOW)).toEqual({ kind: 'refused' });
  });

  test('every row carrying a terminal requirement refuses exactly what `detachedRefusal` refuses', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    const rows = Object.entries(COMMAND_GATES).filter(([, gate]) => gate.terminal !== undefined);
    expect(rows.map(([command]) => command).sort()).toEqual([
      'ack', 'approvals:revoke', 'bus', 'forget', 'pause', 'proc', 'proc:add', 'proc:done', 'resume', 'swap:now', 'watch',
    ]);
    const noTty: Caller = { kind: 'owner-no-tty' };
    for (const [command, gate] of rows) {
      const sentence = detachedRefusal(noTty, gate.terminal);
      expect(sentence).toBeString();
      expect(gateVerdict(noTty, team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'refused' });
      const decision = resolveCaller(noTty, team, root, home, command, placement(), NOW);
      expect(decision, command).toMatchObject({ effect: 'deny', rule: 'terminal' });
      expect(decision.why, command).toBe(sentence as string);
      // A caller with a terminal, and a seat on its recorded pane, are judged by the row itself.
      expect(gateVerdict({ kind: 'owner' }, team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'ok' });
      if (gate.kind === 'team-pause' || gate.kind === 'owner-or-leads') {
        // The orchestrator's seat is admitted, and a plain seat is not. `bus` is owner-or-leads:
        // the file's lead runs it from its own pane, and a seat that holds no `leads` does not.
        expect(gateVerdict(seatCaller('lead'), team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'ok' });
        expect(gateVerdict(seatCaller('worker'), team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'refused' });
      } else if (gate.kind === 'owner-only') {
        // The owner's word: a seat is refused even on its recorded pane.
        expect(gateVerdict(seatCaller('worker'), team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'refused' });
      } else {
        expect(gateVerdict(seatCaller('worker'), team, root, home, command, placement(), () => NOW), command).toEqual({ kind: 'ok' });
      }
    }
  });
});

/** A caller's own words, for a scene's failure message. */
function callerWords(caller: Caller): string {
  return caller.kind === 'seat' ? `${caller.name}@${caller.pane}` : caller.kind;
}
