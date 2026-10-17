// Cross-team send acceptance for a team's leads, from the requested behaviour and not from the
// implementation: a lead reaches another team's lead inside one entity; the entity's coordinator
// — the lead of the team whose own project is the entity — is reached as any other team lead, both
// ways; a lead pair across entities is refused; and a seat that leads nothing is refused across
// teams, same entity or not. A lead is the file's `leads` mark, a place in the chain, never a role
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
import { readTeams, teamIdOf } from '../src/registry/teams.ts';
import { historyPath } from '../src/send/history.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

type SeatSpec = { name: string; role: string; leads?: boolean };
type TeamSpec = { project: string; entity: string; session: string; seats: SeatSpec[] };

/** Two entities. `acme` is three teams: the entity's own team (its project is the entity's name)
 *  and two teams under it; `beta` holds two more. The lead seats carry everyday roles, and the
 *  seats spelled `lead` and `coordinator` hold no mark: the shape a rule reading role words would
 *  get wrong. */
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
      { name: 'web-helper', role: 'lead' },
    ],
  },
  api: {
    project: 'api',
    entity: 'acme',
    session: 'api',
    seats: [
      { name: 'api-lead', role: 'guide', leads: true },
      { name: 'api-helper', role: 'coordinator' },
    ],
  },
  beta: {
    project: 'beta',
    entity: 'beta',
    session: 'beta',
    seats: [{ name: 'beta-lead', role: 'guide', leads: true }],
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
  const lead = spec.seats.find((seat) => seat.leads === true);
  if (!lead) throw new Error('a test team needs a seat that leads');
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
${seat.leads === true ? '    leads: true\n' : ''}`,
    )
    .join('');
  return `format: 1
project: ${spec.project}
entity: ${spec.entity}
session: ${spec.session}
coordinator: ${lead.name}
operator: ${lead.name}
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

  test('a seat that leads nothing is refused across teams, same entity or not', async () => {
    // Same entity: to a team's lead, and to a plain seat.
    refused(await send({ team: 'web', seat: 'web-helper' }, 'api-lead@api'));
    refused(await send({ team: 'web', seat: 'web-helper' }, 'api-helper@api'));
    // Another entity: to a team's lead, and to a plain seat.
    refused(await send({ team: 'web', seat: 'web-helper' }, 'data-lead@data'));
    refused(await send({ team: 'web', seat: 'web-helper' }, 'data-helper@data'));
  });
});

describe('cross-team --list', () => {
  test("the caller's entity's other teams' seats follow the file's own, each as seat@team", async () => {
    const reading = await list({ team: 'api', seat: 'api-lead' });

    expect(reading.code).toBe(0);
    expect(reading.err).toBe('');
    // The file's own rows first, then the entity's other teams by their own name: acme, then
    // web. beta and data belong to another entity and are not addressable from here, so they
    // never show; every name in the name column is a spec the resolver takes as it stands.
    expect(reading.out).toBe(
      [
        'api-lead  claude-code  guide  api',
        'api-helper  claude-code  coordinator  api',
        'coord@acme  claude-code  facilitator  acme',
        'acme-helper@acme  claude-code  builder  acme',
        'web-lead@web  claude-code  guide  web',
        'web-helper@web  claude-code  lead  web',
      ].join('\n') + '\n',
    );
    expect(reading.out).not.toContain('@beta');
    expect(reading.out).not.toContain('@data');
  });

  test('--json carries the same rows, and a stopped or retired seat is marked as it is', async () => {
    const acmeId = teamIdOf(world.roots.acme as string);
    const roster = readTeams(world.home)[acmeId]?.roster ?? [];
    const helper = roster.find((entry) => entry.seat === 'acme-helper');
    if (!helper) throw new Error('the test world has no acme-helper roster line');
    updateAgent(world.home, helper.agent, { lifecycle: 'stopped' });

    const reading = await list({ team: 'api', seat: 'api-helper' }, ['--json']);

    expect(reading.code).toBe(0);
    const doc = JSON.parse(reading.out) as { status: string; seats: { name: string; cli: string; role: string; stopped: boolean; project: string }[] };
    expect(doc.status).toBe('listed');
    const byName = new Map(doc.seats.map((row) => [row.name, row]));
    expect(doc.seats.length).toBe(6);
    expect(byName.get('acme-helper@acme')).toEqual({ name: 'acme-helper@acme', cli: 'claude-code', role: 'builder', stopped: true, project: 'acme' });
    expect(byName.get('web-lead@web')).toEqual({ name: 'web-lead@web', cli: 'claude-code', role: 'guide', stopped: false, project: 'web' });
    expect(byName.get('api-lead')).toEqual({ name: 'api-lead', cli: 'claude-code', role: 'guide', stopped: false, project: 'api' });
    expect(byName.has('data-lead@data')).toBe(false);
  });
});

describe('cross-team --record', () => {
  test('a delivery by address is recorded in the receiving team\'s own history', async () => {
    const reading = await record({ team: 'web', seat: 'web-lead' }, 'api-lead@api');

    expect(reading.code).toBe(0);
    expect(reading.out).toBe('api-lead: recorded (native, 812 ms)\n');
    const written = readFileSync(historyPath('api', world.roots.api as string, world.home), 'utf8');
    expect(written).toContain('"from":"web-lead"');
    expect(written).toContain('"to":"api-lead"');
    expect(written).toContain('"via":"native"');
  });

  test('a dry run resolves the same address and writes nothing; another entity is refused', async () => {
    const dry = await record({ team: 'web', seat: 'web-lead' }, 'api-lead@api', ['--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toBe('api-lead: would record (native, 812 ms); nothing was written\n');
    expect(dry.out).not.toContain('recorded (native');

    refused(await record({ team: 'web', seat: 'web-lead' }, 'data-lead@data'));
  });
});
