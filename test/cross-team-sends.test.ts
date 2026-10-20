// Cross-team send acceptance for a team's leads, from the requested behaviour and not from the
// implementation: a lead reaches another team's lead inside one entity; the entity's coordinator
// — the lead of the team whose own project is the entity — is reached as any other team lead, both
// ways; a lead pair across entities is refused; and a seat that leads nothing reaches the teams of
// its entity like any other seat, while no seat of another entity is in reach. A lead is the
// file's `leads` mark, a place in the chain, never a role
// word: every lead here is spelled with an everyday role, and one non-lead is spelled `lead`, so a
// rule reading words instead of marks would show.
//
// Every scene runs the real admission (`runSend`, in a dry run, so nothing is written), against
// the team records a temporary home holds. The records are written by the launch path itself, so
// each team's roster carries the same `leads` capability a real registration leaves, and each
// team's file names its `entity:`. Every scene pins its caller: a seat of the team whose file is
// the working folder, standing on the pane the state records for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { updateState } from '../src/state.ts';
import { updateAgent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { readTeams, setRoster, teamIdOf } from '../src/registry/teams.ts';
import { historyPath } from '../src/send/history.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { installKey } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

type SeatSpec = { name: string; role: string; leads?: boolean; nickname?: string };
type TeamSpec = { project: string; entity: string; session: string; seats: SeatSpec[]; legacyLead?: string };

/** Two entities. `acme` is four teams: the entity's own team (its project is the entity's name),
 *  two teams under it, and `legacy`, upgraded from 0.3.5/0.4 — its file names its lead with the
 *  legacy `coordinator:` key, its lead carries the legacy role word, and its registry roster (see
 *  `beforeEach`) was written before the `leads` capability existed; `beta` holds two more. The
 *  lead seats carry everyday roles, and the seats spelled `lead` and `coordinator` hold no mark:
 *  the shape a rule reading role words would get wrong. */
const TEAMS: Record<string, TeamSpec> = {
  acme: {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    seats: [
      { name: 'coord', role: 'facilitator', leads: true },
      { name: 'acme-helper', role: 'builder' },
    ],
  },
  web: {
    project: 'web',
    entity: 'acme',
    session: 'web',
    seats: [
      { name: 'web-lead', role: 'guide', leads: true },
      { name: 'web-helper', role: 'lead', nickname: 'hephaestus' },
    ],
  },
  api: {
    project: 'api',
    entity: 'acme',
    session: 'api',
    seats: [
      { name: 'api-lead', role: 'guide', leads: true, nickname: 'zeus' },
      { name: 'api-helper', role: 'coordinator' },
    ],
  },
  legacy: {
    project: 'legacy',
    entity: 'acme',
    session: 'legacy',
    legacyLead: 'steward',
    seats: [
      { name: 'steward', role: 'coordinator' },
      { name: 'legacy-helper', role: 'builder' },
    ],
  },
  beta: {
    project: 'beta',
    entity: 'beta',
    session: 'beta',
    seats: [{ name: 'beta-lead', role: 'guide', leads: true, nickname: 'hermes' }],
  },
  data: {
    project: 'data',
    entity: 'beta',
    session: 'data',
    seats: [
      { name: 'data-lead', role: 'guide', leads: true },
      { name: 'data-helper', role: 'builder' },
    ],
  },
};

type World = { base: string; home: string; roots: Record<string, string>; files: Record<string, TeamFile> };

function teamText(spec: TeamSpec): string {
  const marked = spec.seats.find((seat) => seat.leads === true);
  const lead = marked?.name ?? spec.legacyLead;
  if (lead === undefined) throw new Error('a test team needs a seat that leads');
  const seats = spec.seats
    .map(
      (seat) => `  - role: ${seat.role}
    name: ${seat.name}
    label: ${seat.name}
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
${seat.nickname === undefined ? '' : `    nickname: ${seat.nickname}\n`}${seat.leads === true ? '    leads: true\n' : ''}`,
    )
    .join('');
  return `format: 1
project: ${spec.project}
entity: ${spec.entity}
session: ${spec.session}
coordinator: ${lead}
operator: ${lead}
workspace:
  mode: shared
seats:
${seats}`;
}

function parsed(spec: TeamSpec, key: string): TeamFile {
  const checked = validateTeamFile(teamText(spec));
  if (!checked.ok) throw new Error(`the test's own file for ${key} does not validate: ${JSON.stringify(checked.errors)}`);
  return checked.team;
}

let base: string;
let world: World;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-cross-team-sends-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots: Record<string, string> = {};
  const files: Record<string, TeamFile> = {};
  for (const [key, spec] of Object.entries(TEAMS)) {
    const root = join(base, key);
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(spec));
    files[key] = parsed(spec, key);
    roots[key] = root;
  }
  world = { base, home, roots, files };
  for (const [key, spec] of Object.entries(TEAMS)) {
    for (const seat of spec.seats) launch(key, seat.name);
    // A team upgraded from 0.3.5/0.4: its registry roster was written before the `leads`
    // capability existed, so no line carries the mark even though its file names its lead — the
    // state the fix reads, where the record alone cannot say who leads the team.
    if (spec.legacyLead !== undefined) unmarkLeads(key);
  }
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const paneOf = (team: string, seat: string): string => `${team}:${seat}`;

/** One seat launched where a real launch would leave it: an agent record, running, on its pane;
 *  the team's registry roster rewritten with the file's own `leads` mark; and the state recording
 *  the seat on that pane, the proof admission binds a caller by. */
function launch(team: string, seat: string): void {
  const file = world.files[team] as TeamFile;
  const one = file.seats.find((candidate) => candidate.name === seat);
  if (!one) throw new Error(`the test's own team ${team} has no seat ${seat}`);
  const written = registerLaunch({ home: world.home, team: file, root: world.roots[team] as string, by: 'up' }, one, paneOf(team, seat));
  if ('note' in written) throw new Error(`the test's own registration failed: ${written.note}`);
  updateState(join(world.roots[team] as string, '.agents'), (state) => {
    const session = state.sessions[file.session] ?? { seats: {}, worktrees: {} };
    session.seats[seat] = { stage: 'launched', pane: paneOf(team, seat), workspace: 'w1' };
    state.sessions[file.session] = session;
  });
}

/** One registry roster as a build before the `leads` capability wrote it: every line kept, no
 *  line carrying the mark. The team's file still names its lead, so only the file can say it. */
function unmarkLeads(team: string): void {
  const id = teamIdOf(world.roots[team] as string);
  const record = readTeams(world.home)[id];
  if (!record) throw new Error(`the test world has no registry record for ${team}`);
  setRoster(
    world.home,
    id,
    record.roster.map((line) => ({
      agent: line.agent,
      seat: line.seat,
      role: line.role,
      ...(line.nickname === undefined ? {} : { nickname: line.nickname }),
    })),
  );
}

/** The send host the scenes are handed: no live session is read, because every record carries its
 *  pane; and a dry run never reaches the delivery walk. */
function host(): SendHost {
  return {
    agents: () => null,
    processInfo: () => ({ shell: 1, foreground: [2] }),
    socketsDir: join(world.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => null,
      wait: async () => {},
    },
    now: () => NOW,
    home: world.home,
  };
}

type Reading = { code: number; out: string; err: string };

/** One scene's send, through the real admission: the caller is a pinned seat of `team`, standing
 *  on its recorded pane, and the spec is the one a person would type. The dry run writes nothing. */
async function send(from: { team: string; seat: string }, spec: string): Promise<Reading> {
  const file = world.files[from.team] as TeamFile;
  const caller: Caller = { kind: 'seat', name: from.seat, pane: paneOf(from.team, from.seat), session: file.session };
  const io = testIo(world.roots[from.team] as string, caller);
  const code = await runSend([spec, 'a status line', '--dry-run'], io, host());
  return { code, out: io.out, err: io.err };
}

function admitted(reading: Reading): void {
  if (reading.code !== 0 || !reading.out.includes(': dry-run:')) {
    throw new Error(`expected admitted, got exit ${reading.code}: ${reading.err.trim() || reading.out.trim()}`);
  }
}

function refused(reading: Reading): void {
  expect(reading.code).toBe(1);
  expect(reading.err).toContain('may not send to');
  expect(reading.err).toContain('no rule admits it');
}

/** One `--list` run from a team's own folder: the same pinned caller a send scene uses. */
async function list(from: { team: string; seat: string }, extra: string[] = []): Promise<Reading> {
  const file = world.files[from.team] as TeamFile;
  const caller: Caller = { kind: 'seat', name: from.seat, pane: paneOf(from.team, from.seat), session: file.session };
  const io = testIo(world.roots[from.team] as string, caller);
  const code = await runSend(['--list', ...extra], io, host());
  return { code, out: io.out, err: io.err };
}

/** One `--record` run from a team's own folder, with the caller pinned the same way. */
async function record(from: { team: string; seat: string }, spec: string, extra: string[] = []): Promise<Reading> {
  const file = world.files[from.team] as TeamFile;
  const caller: Caller = { kind: 'seat', name: from.seat, pane: paneOf(from.team, from.seat), session: file.session };
  const io = testIo(world.roots[from.team] as string, caller);
  const code = await runSend(['--record', spec, '--channel', 'native', '--ms', '812', ...extra], io, host());
  return { code, out: io.out, err: io.err };
}

describe('cross-team sends inside an entity', () => {
  test('a team lead reaches another team lead of the same entity', async () => {
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'api-lead@api'));
  });

  test("the entity's coordinator and a team lead reach each other", async () => {
    // The coordinator is the lead of the team whose project is the entity itself.
    admitted(await send({ team: 'acme', seat: 'coord' }, 'api-lead@api'));
    admitted(await send({ team: 'api', seat: 'api-lead' }, 'coord@acme'));
  });

  test('a lead pair across entities is refused, both ways', async () => {
    refused(await send({ team: 'api', seat: 'api-lead' }, 'data-lead@data'));
    refused(await send({ team: 'data', seat: 'data-lead' }, 'api-lead@api'));
  });

  test('a seat that leads nothing reaches the teams of its entity, and another entity is out of reach', async () => {
    // Same entity: to a team's lead, and to a plain seat — the entity's seat rule admits both,
    // whatever the caller leads.
    admitted(await send({ team: 'web', seat: 'web-helper' }, 'api-lead@api'));
    admitted(await send({ team: 'web', seat: 'web-helper' }, 'api-helper@api'));
    // Another entity: to a team's lead, and to a plain seat.
    refused(await send({ team: 'web', seat: 'web-helper' }, 'data-lead@data'));
    refused(await send({ team: 'web', seat: 'web-helper' }, 'data-helper@data'));
  });

  test('a nickname is an address like the seat it names, and admission judges that seat', async () => {
    // The lead by its human name, from a lead of the same entity: the seat `zeus@api` would
    // reach is the one the rule judges.
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'zeus@api'));
    // The same name from a seat that leads nothing: the name confers nothing, and admission
    // reads the seat it names — a seat of the entity, so the entity's rule admits it.
    admitted(await send({ team: 'web', seat: 'web-helper' }, 'zeus@api'));
    // Another entity's lead, by its own nickname: the same cross-entity refusal the seat form
    // gets.
    refused(await send({ team: 'api', seat: 'api-lead' }, 'hermes@beta'));
  });

  test('the lead address resolves to the team\'s lead, and another entity\'s lead is out of reach', async () => {
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'lead@api'));
    admitted(await send({ team: 'acme', seat: 'coord' }, 'lead@api'));
    refused(await send({ team: 'api', seat: 'api-lead' }, 'lead@data'));
  });
});

describe('a team upgraded from 0.3.5/0.4: its lead is the file\'s seat, never the role word', () => {
  test("an orchestrator reaches a legacy coordinator's lead@team", async () => {
    // `legacy`'s file names its lead with the legacy `coordinator:` key, its roster carries no
    // `leads` mark, and its lead's role is the legacy word. The lead address and the bare seat
    // both reach the seat the file declares — the send works without the role rename.
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'lead@legacy'));
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'steward@legacy'));
    // And the legacy lead reaches another team's lead by the same rule.
    admitted(await send({ team: 'legacy', seat: 'steward' }, 'web-lead@web'));
  });

  test("a seat that leads nothing reaches the legacy team of its entity like any other", async () => {
    // The upgraded team is a team of the entity, so its seats are reached by the entity's seat
    // rule — the `leads` mark the pre-0.5 roster never wrote is no part of the caller's reach.
    admitted(await send({ team: 'web', seat: 'web-helper' }, 'lead@legacy'));
    admitted(await send({ team: 'web', seat: 'web-helper' }, 'steward@legacy'));
    admitted(await send({ team: 'web', seat: 'web-lead' }, 'legacy-helper@legacy'));
  });

  test('another entity is refused the legacy lead', async () => {
    refused(await send({ team: 'data', seat: 'data-lead' }, 'lead@legacy'));
  });
});

describe('cross-team --list', () => {
  test("the caller's entity's other teams' seats follow the file's own, each as seat@team", async () => {
    const reading = await list({ team: 'api', seat: 'api-lead' });

    expect(reading.code).toBe(0);
    expect(reading.err).toBe('');
    // The file's own rows first, then the entity's other teams by their own name: acme, then
    // legacy, then web. `legacy` is the team upgraded from 0.4 — its rows show although no roster
    // line holds `leads` — and beta and data belong to another entity and are not addressable
    // from here, so they never show; every name in the name column is a spec the resolver takes
    // as it stands.
    expect(reading.out).toBe(
      [
        'team api, session "api"',
        '  SEAT                  NICKNAME        ROLE         PROJECT  REACH',
        '  api-lead              @zeus           guide        api      socket',
        '  api-helper            -               coordinator  api      socket',
        '  coord@acme            -               facilitator  acme     socket',
        '  acme-helper@acme      -               builder      acme     socket',
        '  steward@legacy        -               coordinator  legacy   socket',
        '  legacy-helper@legacy  -               builder      legacy   socket',
        '  web-lead@web          -               guide        web      socket',
        '  web-helper@web        hephaestus@web  lead         web      socket',
        '8 seats',
      ].join('\n') + '\n',
    );
    expect(reading.out).not.toContain('@beta');
    expect(reading.out).not.toContain('@data');
  });

  test("a signed nickname stands where the roster's projection did, in the row and at the address", async () => {
    // `api-lead` signs a new word: the row prints it and a send addresses it, while the file word
    // the record replaced names nobody any more.
    const roster = readTeams(world.home)[teamIdOf(world.roots.api as string)]?.roster ?? [];
    const lead = roster.find((line) => line.seat === 'api-lead');
    if (lead === undefined) throw new Error('the test world has no api-lead roster line');
    installKey(world.home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
    const plan = planConfigSet(world.home, { level: 'seat', target: lead.agent, settings: [{ key: 'nickname', value: 'athena' }] });
    if (!plan.ok) throw new Error(plan.why);
    const written = writeConfigSet(world.home, plan, { now: NOW });
    if (!written.ok) throw new Error(written.why);

    const reading = await list({ team: 'api', seat: 'api-lead' });
    expect(reading.code).toBe(0);
    const row = reading.out.split('\n').find((line) => line.startsWith('  api-lead '));
    expect(row).toContain('@athena');
    expect(reading.out).not.toContain('@zeus');

    admitted(await send({ team: 'web', seat: 'web-lead' }, 'athena@api'));
    const gone = await send({ team: 'web', seat: 'web-lead' }, 'zeus@api');
    expect(gone.code).toBe(1);
    expect(gone.err).toContain('no registered agent holds the seat or nickname "zeus"');
  });

  test('the launch projects a seat\'s nickname into its team\'s registry roster', () => {
    const teams = readTeams(world.home);
    const api = teams[teamIdOf(world.roots.api as string)];
    expect(api?.roster.find((line) => line.seat === 'api-lead')?.nickname).toBe('zeus');
    const web = teams[teamIdOf(world.roots.web as string)];
    expect(web?.roster.find((line) => line.seat === 'web-helper')?.nickname).toBe('hephaestus');
    expect(web?.roster.find((line) => line.seat === 'web-lead')?.nickname).toBeUndefined();
  });

  test('--json carries the same rows, and a stopped or retired seat is marked as it is', async () => {
    const acmeId = teamIdOf(world.roots.acme as string);
    const roster = readTeams(world.home)[acmeId]?.roster ?? [];
    const helper = roster.find((entry) => entry.seat === 'acme-helper');
    if (!helper) throw new Error('the test world has no acme-helper roster line');
    updateAgent(world.home, helper.agent, { lifecycle: 'stopped' });

    const reading = await list({ team: 'api', seat: 'api-helper' }, ['--json']);

    expect(reading.code).toBe(0);
    const doc = JSON.parse(reading.out) as { project: string; session: string; summary: string; seats: { name: string; nickname: string | null; cli: string; role: string; stopped: boolean; project: string; reach: string }[] };
    expect(doc.session).toBe('api');
    expect(doc.summary).toBe('8 seats');
    const byName = new Map(doc.seats.map((row) => [row.name, row]));
    expect(doc.seats.length).toBe(8);
    expect(byName.get('acme-helper@acme')).toEqual({ name: 'acme-helper@acme', nickname: null, cli: 'claude-code', role: 'builder', project: 'acme', reach: 'socket', stopped: true });
    // The upgraded team's seats are addressable rows like any other: reachability keys on the
    // entity, never on the `leads` mark a pre-0.5 roster never wrote.
    expect(byName.get('steward@legacy')).toEqual({ name: 'steward@legacy', nickname: null, cli: 'claude-code', role: 'coordinator', project: 'legacy', reach: 'socket', stopped: false });
    expect(byName.get('legacy-helper@legacy')).toEqual({ name: 'legacy-helper@legacy', nickname: null, cli: 'claude-code', role: 'builder', project: 'legacy', reach: 'socket', stopped: false });
    expect(byName.get('web-lead@web')).toEqual({ name: 'web-lead@web', nickname: null, cli: 'claude-code', role: 'guide', project: 'web', reach: 'socket', stopped: false });
    expect(byName.get('api-lead')).toEqual({ name: 'api-lead', nickname: '@zeus', cli: 'claude-code', role: 'guide', project: 'api', reach: 'socket', stopped: false });
    expect(byName.has('data-lead@data')).toBe(false);
  });
});

describe('cross-team --record', () => {
  test('a delivery by address is recorded in the receiving team\'s own history', async () => {
    const reading = await record({ team: 'web', seat: 'web-lead' }, 'api-lead@api');

    expect(reading.code).toBe(0);
    expect(reading.out).toBe('team api, session "api"\napi-lead: recorded (native, 812 ms)\n');
    const written = readFileSync(historyPath('api', world.roots.api as string, world.home), 'utf8');
    expect(written).toContain('"from":"web-lead"');
    expect(written).toContain('"to":"api-lead"');
    expect(written).toContain('"via":"native"');
    // The sender's own team rides the line, so a reader in the receiving team resolves it by its
    // address rather than by a local seat name it might share.
    expect(written).toContain(`"from_team":"${teamIdOf(world.roots.web as string)}"`);
  });

  test('the history line keeps the address as written and the id it resolved to', async () => {
    const reading = await record({ team: 'web', seat: 'web-lead' }, 'zeus@api');

    expect(reading.code).toBe(0);
    expect(reading.out).toBe('team api, session "api"\napi-lead: recorded (native, 812 ms)\n');
    const teams = readTeams(world.home);
    const zeus = teams[teamIdOf(world.roots.api as string)]?.roster.find((line) => line.seat === 'api-lead');
    if (!zeus) throw new Error('the test world has no api-lead roster line');
    const written = readFileSync(historyPath('api', world.roots.api as string, world.home), 'utf8');
    expect(written).toContain('"to":"api-lead"');
    // The nickname as the caller wrote it, and the registry id it resolved to: the line keeps
    // both, so a reader sees the address beside the seat.
    expect(written).toContain('"spec":"zeus@api"');
    expect(written).toContain(`"resolved":"${zeus.agent}"`);
    // A plain seat of the caller's own team names itself: no `spec` is written, and the line is
    // the one it always was.
    await record({ team: 'web', seat: 'web-lead' }, 'web-helper');
    const plain = readFileSync(historyPath('web', world.roots.web as string, world.home), 'utf8');
    expect(plain).toContain('"to":"web-helper"');
    expect(plain).not.toContain('"spec"');
  });

  test('a dry run resolves the same address and writes nothing; another entity is refused', async () => {
    const dry = await record({ team: 'web', seat: 'web-lead' }, 'api-lead@api', ['--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toBe('team api, session "api"\napi-lead: would record (native, 812 ms); nothing was written\n');
    expect(dry.out).not.toContain('recorded (native');

    refused(await record({ team: 'web', seat: 'web-lead' }, 'data-lead@data'));
  });
});
