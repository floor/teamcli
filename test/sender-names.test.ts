// Readable sender names: how one sender reads in the headline a person reads — the drop body's
// first line, the mailbox's FROM cell, the feed's SEAT cell, a seat's own session name.
//
// The record keeps the seat and the registry id; only the headline changes. The word that picks
// the headline is the project's `sender_name`, resolved nearest first (the reading seat's key,
// the team file's key, the project registry's word, then `auto`). `auto` names a sender by its
// nickname inside its own team (the seat name when the file writes none) and by `seat@team` from
// another, because a nickname is unique only inside one team. These are fixtures: literal
// rosters and a temporary home, so no live registry or session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ofTeam, projectsFile, upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam, type RosterEntry, type TeamRecord } from '../src/registry/teams.ts';
import {
  defaultNaming,
  namingAcross,
  namingFor,
  senderDisplayName,
  senderNameModeAt,
  senderNameModeFor,
  senderNameModeOf,
  sessionDisplayName,
  type SenderNaming,
} from '../src/send/names.ts';

const AT = '2026-10-18T06:00:00.000Z';

const FLOOR = 'aaaaaaaaaaaa';
const LABS = 'bbbbbbbbbbbb';

function teamRecord(id: string, project: string, roster: RosterEntry[]): TeamRecord {
  return {
    id,
    project,
    projectId: null,
    entity: null,
    session: project,
    root: `/roots/${project}`,
    lobby: `/lobbies/${project}`,
    lobbies: { [project]: `/lobbies/${project}` },
    roster,
    lifecycle: 'running',
    provenance: { registered_by: 'team', registered_at: AT, updated_at: AT },
  };
}

/** Two registered teams. `floor` holds a seat with a nickname and one without; `labs` holds a
 *  nickname the senders below carry, to prove a cross-team nickname is not read bare. */
const TEAMS: Record<string, TeamRecord> = {
  [FLOOR]: teamRecord(FLOOR, 'floor', [
    { agent: 'agt_0f1e2d3c4b5a', seat: 'orchestrator', role: 'orchestrator', nickname: 'Atlas' },
    { agent: 'agt_1a2b3c4d5e6f', seat: 'builder', role: 'builder' },
  ]),
  [LABS]: teamRecord(LABS, 'labs', [
    { agent: 'agt_2b3c4d5e6f70', seat: 'helper', role: 'helper', nickname: 'Iris' },
  ]),
};

function naming(mode: SenderNaming['mode'], viewerTeam: string | null = FLOOR): SenderNaming {
  return { mode, viewerTeam, teams: TEAMS };
}

const FLOOR_LEAD = { seat: 'orchestrator', team: FLOOR, id: 'agt_0f1e2d3c4b5a' };
const FLOOR_BUILDER = { seat: 'builder', team: FLOOR, id: 'agt_1a2b3c4d5e6f' };
const LABS_HELPER = { seat: 'helper', team: LABS, id: 'agt_2b3c4d5e6f70' };

describe('senderDisplayName', () => {
  test('auto reads the nickname inside the sender’s own team', () => {
    expect(senderDisplayName(FLOOR_LEAD, naming('auto'))).toBe('Atlas');
    // The same seat with no nickname in the file reads as its seat name.
    expect(senderDisplayName(FLOOR_BUILDER, naming('auto'))).toBe('builder');
  });

  test('auto reads seat@team from another team, never the other team’s nickname', () => {
    expect(senderDisplayName(LABS_HELPER, naming('auto'))).toBe('helper@labs');
    // The team is found from the registry id when the record carries no team of its own.
    expect(senderDisplayName({ seat: 'helper', id: 'agt_2b3c4d5e6f70' }, naming('auto'))).toBe('helper@labs');
  });

  test('an unregistered team is no answer, and the id’s roster line is the team that stands', () => {
    // The record can carry a team id this machine's registry does not hold (a `reach.team` naming
    // a project, say). The registry id is unique across the registry, so its roster line names
    // both the team and the nickname — the stale team field does not hide it. The fixture's line
    // carries a nickname, so the two orders read differently and the scene proves which one wins.
    const stray = { seat: 'orchestrator', team: 'unheard-of', id: 'agt_0f1e2d3c4b5a' };
    expect(senderDisplayName(stray, naming('auto'))).toBe('Atlas');
    // The same sender read from another team is its address, resolved through the id's team.
    expect(senderDisplayName(stray, naming('auto', LABS))).toBe('orchestrator@floor');
    // A sender the id answers for in no roster falls back to its own team field, as before.
    expect(senderDisplayName({ seat: 'builder', team: 'unheard-of', id: 'agt_ffffffffffff' }, naming('auto'))).toBe('builder');
  });

  test('a seat name two teams hold and no id to tell them apart reads as the seat alone', () => {
    const shared = teamRecord('cccccccccccc', 'gamma', [{ agent: 'agt_3c4d5e6f7081', seat: 'helper', role: 'helper' }]);
    const teams = { ...TEAMS, cccccccccccc: shared };
    // The reader's team does not hold `helper`, and two others do: no answer, so the seat stands.
    expect(senderDisplayName({ seat: 'helper' }, { mode: 'auto', viewerTeam: FLOOR, teams })).toBe('helper');
  });

  test('nickname always reads the nickname, or the seat name when the file writes none', () => {
    expect(senderDisplayName(LABS_HELPER, naming('nickname'))).toBe('Iris');
    expect(senderDisplayName(FLOOR_BUILDER, naming('nickname'))).toBe('builder');
    expect(senderDisplayName({ seat: 'stranger' }, naming('nickname'))).toBe('stranger');
  });

  test('seat always reads the seat name, and seat@team always the address', () => {
    expect(senderDisplayName(LABS_HELPER, naming('seat'))).toBe('helper');
    expect(senderDisplayName(LABS_HELPER, naming('seat@team'))).toBe('helper@labs');
    // A team no registry record names reads as its id, the spelling an earlier build printed.
    expect(senderDisplayName({ seat: 'helper', team: 'dddddddddddd' }, naming('seat@team'))).toBe('helper@dddddddddddd');
    // No team any roster answers for: the address has nothing to append.
    expect(senderDisplayName({ seat: 'stranger' }, naming('seat@team'))).toBe('stranger');
  });

  test('no word the registry cannot answer falls back to the seat, and the id never prints', () => {
    for (const mode of ['auto', 'nickname', 'seat', 'seat@team'] as const) {
      for (const sender of [FLOOR_LEAD, FLOOR_BUILDER, LABS_HELPER]) {
        expect(senderDisplayName(sender, { mode, viewerTeam: null, teams: {} })).not.toContain('agt_');
      }
    }
    expect(senderDisplayName(LABS_HELPER, defaultNaming())).toBe('helper');
  });
});

describe('sessionDisplayName', () => {
  test('auto and nickname name the session by its nickname, the seat name when none is written', () => {
    expect(sessionDisplayName({ seat: 'orchestrator', nickname: 'Atlas', team: FLOOR, teamName: 'floor', mode: 'auto' })).toBe('Atlas');
    expect(sessionDisplayName({ seat: 'builder', nickname: null, team: FLOOR, teamName: 'floor', mode: 'auto' })).toBe('builder');
    expect(sessionDisplayName({ seat: 'builder', nickname: null, team: FLOOR, teamName: 'floor', mode: 'nickname' })).toBe('builder');
  });

  test('seat and seat@team read the seat name and the address', () => {
    expect(sessionDisplayName({ seat: 'orchestrator', nickname: 'Atlas', team: FLOOR, teamName: 'floor', mode: 'seat' })).toBe('orchestrator');
    expect(sessionDisplayName({ seat: 'orchestrator', nickname: 'Atlas', team: FLOOR, teamName: 'floor', mode: 'seat@team' })).toBe('orchestrator@floor');
    // With no team name at hand the id is the address, and with no team at all the seat stands.
    expect(sessionDisplayName({ seat: 'orchestrator', nickname: 'Atlas', team: FLOOR, mode: 'seat@team' })).toBe(`orchestrator@${FLOOR}`);
    expect(sessionDisplayName({ seat: 'orchestrator', nickname: 'Atlas', team: null, mode: 'seat@team' })).toBe('orchestrator');
  });
});

describe('the sender_name chain', () => {
  let base = '';
  let home = '';
  let root = '';

  // The smallest file the loader accepts: the four words are read beside it.
  const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
`;
  const LEAD_LAUNCH = '    launch: claude --model claude-opus-5-5\n';

  function fileRoot(text = TEAM): void {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
  }

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = '';
  });

  function fresh(): void {
    base = mkdtempSync(join(tmpdir(), 'team-sender-names-'));
    home = join(base, 'home');
    root = join(base, 'acme');
    mkdirSync(home);
  }

  test('an omitted word reads auto everywhere', () => {
    fresh();
    fileRoot();
    expect(senderNameModeFor({ home, root })).toBe('auto');
    expect(senderNameModeAt(home, root)).toBe('auto');
    expect(senderNameModeOf(null)).toBe('auto');
  });

  test('the file’s word and a seat’s word are read, the seat’s nearest', () => {
    fresh();
    fileRoot(`${TEAM}sender_name: nickname\n`);
    expect(senderNameModeFor({ home, root })).toBe('nickname');
    expect(senderNameModeFor({ home, root, seat: 'lead' })).toBe('nickname');
    // The seat's own key wins over the file's.
    fileRoot(TEAM.replace(LEAD_LAUNCH, `${LEAD_LAUNCH}    sender_name: seat@team\n`) + 'sender_name: nickname\n');
    expect(senderNameModeFor({ home, root, seat: 'lead' })).toBe('seat@team');
    // A seat the file does not hold has no word of its own, so the file's stands.
    expect(senderNameModeFor({ home, root, seat: 'builder' })).toBe('nickname');
  });

  test('the project registry’s word stands under the team file’s, and over auto', () => {
    fresh();
    fileRoot();
    upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, at: AT });
    upsertProject(home, 'acme', { name: 'Acme', teams: [teamIdOf(root)], senderName: 'seat', at: AT });
    expect(senderNameModeFor({ home, root })).toBe('seat');
    // The team file's word is nearer than the project's.
    fileRoot(`${TEAM}sender_name: nickname\n`);
    expect(senderNameModeFor({ home, root })).toBe('nickname');
  });

  test('every read is tolerant: a root that does not load and a registry that cannot answer are auto', () => {
    fresh();
    mkdirSync(root);
    expect(senderNameModeFor({ home, root })).toBe('auto');
    // A registry file that does not read as a project registry is no word, never a failed launch.
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(projectsFile(home), 'projects: [\n');
    expect(senderNameModeAt(home, root)).toBe('auto');
  });

  test('namingFor carries the word and the registry a reading resolves names from', () => {
    fresh();
    fileRoot(`${TEAM}sender_name: nickname\n`);
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      roster: [{ agent: 'agt_4d5e6f708192', seat: 'lead', role: 'coordinator', nickname: 'Ada' }],
      at: AT,
    });
    const read = namingFor({ home, root });
    expect(read.mode).toBe('nickname');
    expect(read.viewerTeam).toBe(teamIdOf(root));
    expect(senderDisplayName({ seat: 'lead', id: 'agt_4d5e6f708192' }, read)).toBe('Ada');
  });

  test('a reading across teams names a registered sender by its address and an unknown one by its seat', () => {
    fresh();
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      roster: [{ agent: 'agt_4d5e6f708192', seat: 'lead', role: 'coordinator', nickname: 'Ada' }],
      at: AT,
    });
    const read = namingAcross(home);
    expect(read.viewerTeam).toBeNull();
    // No own team to compare against, so a registered sender reads by its full address.
    expect(senderDisplayName({ seat: 'lead', team: teamIdOf(root) }, read)).toBe('lead@acme');
    expect(senderDisplayName({ seat: 'stranger' }, read)).toBe('stranger');
  });
});

describe('the project record’s sender_name word', () => {
  let base = '';
  let home = '';

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = '';
  });

  function fresh(): void {
    base = mkdtempSync(join(tmpdir(), 'team-sender-word-'));
    home = base;
  }

  test('a written word reads back, and the record file carries it under sender_name', () => {
    fresh();
    upsertProject(home, 'acme', { name: 'Acme', teams: ['acme-team'], senderName: 'seat@team', at: AT });
    expect(ofTeam(home, 'acme-team')?.senderName).toBe('seat@team');
    expect(senderNameModeOf(ofTeam(home, 'acme-team'))).toBe('seat@team');
    expect(readFileSync(projectsFile(home), 'utf8')).toContain('sender_name: seat@team');
    // An upsert that names no word keeps the one written.
    upsertProject(home, 'acme', { teams: ['acme-team', 'other-team'], at: AT });
    expect(ofTeam(home, 'acme-team')?.senderName).toBe('seat@team');
  });

  test('a word this build cannot read is refused, naming the four it reads', () => {
    fresh();
    expect(() => upsertProject(home, 'acme', { name: 'Acme', senderName: 'full' as never, at: AT })).toThrow(
      '"sender_name" must be one of: auto, nickname, seat, seat@team',
    );
    // A hand-written bad word is refused when the registry is read, not guessed at.
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(projectsFile(home), 'projects:\n  acme:\n    name: Acme\n    sender_name: full\n');
    expect(() => ofTeam(home, 'acme-team')).toThrow('"sender_name" must be one of: auto, nickname, seat, seat@team');
  });
});
