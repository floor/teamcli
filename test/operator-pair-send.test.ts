// Operators of one team send to each other — the acceptance the issue asks for, from the
// requested behaviour and not from the implementation: two seats whose file lines carry
// `role: operator` in one team write to each other, both ways; the pair never leaves the team;
// the word is a role, never a seat's name; and a send admitted by it is logged like every send
// (the drop header names the rule, the team log carries the line). The file's word is the one
// that decides: a role changed in the live file after registration decides the send as it reads
// today. Every scene runs the real admission over registry records written by the launch path
// (`registerLaunch`), with the caller pinned to the pane the state records for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { readHistory } from '../src/send/history.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');

type SeatSpec = { name: string; role: string; leads?: boolean };
type TeamSpec = { project: string; entity: string; session: string; operator: string; seats: SeatSpec[] };

/** One team whose lines carry the role word this issue is about, spelled in several ways so a
 *  rule reading a seat's name instead of its role shows: `ops` is an operator under another
 *  name, `operatorish` is spelled like one and is a builder. The file's own `operator:` place is
 *  operator-1, so operator-2 and operator-3 are operators and nothing else. */
const ACME: TeamSpec = {
  project: 'acme',
  entity: 'acme',
  session: 'acme',
  operator: 'operator-1',
  seats: [
    { name: 'lead', role: 'coordinator', leads: true },
    { name: 'operator-1', role: 'operator' },
    { name: 'operator-2', role: 'operator' },
    { name: 'operator-3', role: 'operator' },
    { name: 'ops', role: 'operator' },
    { name: 'operatorish', role: 'builder' },
    { name: 'helper', role: 'builder' },
  ],
};

/** A second team of the same entity: its operator is reached by no rule from acme's operators,
 *  because the pair this issue adds is same-team only. */
const OTHER: TeamSpec = {
  project: 'other',
  entity: 'acme',
  session: 'other',
  operator: 'other-op',
  seats: [
    { name: 'other-lead', role: 'coordinator', leads: true },
    { name: 'other-op', role: 'operator' },
    { name: 'other-helper', role: 'builder' },
  ],
};

const TEAMS: Record<string, TeamSpec> = { acme: ACME, other: OTHER };

type World = { base: string; home: string; roots: Record<string, string>; files: Record<string, TeamFile> };

function teamText(spec: TeamSpec): string {
  const lead = spec.seats.find((seat) => seat.leads === true)?.name;
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
${seat.leads === true ? '    leads: true\n' : ''}`,
    )
    .join('');
  return `format: 1
project: ${spec.project}
entity: ${spec.entity}
session: ${spec.session}
coordinator: ${lead}
operator: ${spec.operator}
workspace:
  mode: shared
seats:
${seats}
# The drop leg alone: a scene that proves the log writes one drop file and no pane is touched.
delivery_order: [drop]
`;
}

function parsed(spec: TeamSpec): TeamFile {
  const checked = validateTeamFile(teamText(spec));
  if (!checked.ok) throw new Error(`the test's own file does not validate: ${JSON.stringify(checked.errors)}`);
  return checked.team;
}

let base: string;
let world: World;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-operator-pair-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots: Record<string, string> = {};
  const files: Record<string, TeamFile> = {};
  for (const [key, spec] of Object.entries(TEAMS)) {
    const root = join(base, key);
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(spec));
    files[key] = parsed(spec);
    roots[key] = root;
  }
  world = { base, home, roots, files };
  for (const [key, spec] of Object.entries(TEAMS)) {
    for (const seat of spec.seats) launch(key, seat.name);
  }
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const paneOf = (team: string, seat: string): string => `${team}:${seat}`;

/** One seat launched where a real launch would leave it: an agent record, running, on its pane,
 *  and the state recording the seat there — the proof admission binds a caller by. */
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

/** The live file rewritten with one seat's role word changed, as a team's file is edited today:
 *  the registry record keeps the role it was registered under, so a scene that passes proves the
 *  file's present word decided. */
function reword(team: string, seat: string, role: string): void {
  const file = world.files[team] as TeamFile;
  const changed: TeamSpec = { ...(TEAMS[team] as TeamSpec), seats: (TEAMS[team] as TeamSpec).seats.map((one) => (one.name === seat ? { ...one, role } : one)) };
  if (changed.seats.find((one) => one.name === seat) === undefined) throw new Error(`the test's own team ${team} has no seat ${seat}`);
  if (!file.seats.some((one) => one.name === seat)) throw new Error(`the live file for ${team} has no seat ${seat}`);
  const text = teamText(changed);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(checked.errors)}`);
  writeFileSync(join(world.roots[team] as string, '.agents', 'team.yaml'), text);
  world.files[team] = checked.team;
}

/** The send host the scenes are handed: no live session is read, because every record carries
 *  its pane; a dry run never reaches the delivery walk, and the drop-only order writes no pane. */
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

/** One scene's send through the real admission: the caller is a pinned seat of `team` standing
 *  on its recorded pane, and the spec is the one a person would type. */
async function send(from: { team: string; seat: string }, spec: string, flags: string[] = ['--dry-run']): Promise<Reading> {
  const file = world.files[from.team] as TeamFile;
  const caller: Caller = { kind: 'seat', name: from.seat, pane: paneOf(from.team, from.seat), session: file.session };
  const io = testIo(world.roots[from.team] as string, caller);
  const code = await runSend([spec, 'a status line', ...flags], io, host());
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

describe('operators of one team send to each other', () => {
  test('two operators of one team write to each other, both ways', async () => {
    admitted(await send({ team: 'acme', seat: 'operator-2' }, 'operator-3'));
    admitted(await send({ team: 'acme', seat: 'operator-3' }, 'operator-2'));
  });

  test('the word is the role, not the seat name', async () => {
    const root = world.roots.acme as string;
    // `ops` holds `role: operator` and is reached by the operator-pair rule; `operatorish` is
    // spelled like one and is a builder, so only the declared-seat rule reaches it.
    expect((await send({ team: 'acme', seat: 'operator-2' }, 'ops', [])).code).toBe(0);
    const opsDrops = join(root, '.agents', 'send-drops', 'acme', 'ops');
    const opsRecords = readdirSync(opsDrops).filter((name) => !name.includes('.'));
    expect(recordBody(join(opsDrops, opsRecords[0] as string))).toContain('admitted by: an operator to another operator of its own team');

    expect((await send({ team: 'acme', seat: 'operator-2' }, 'operatorish', [])).code).toBe(0);
    const ishDrops = join(root, '.agents', 'send-drops', 'acme', 'operatorish');
    const ishRecords = readdirSync(ishDrops).filter((name) => !name.includes('.'));
    expect(recordBody(join(ishDrops, ishRecords[0] as string))).toContain('admitted by: a seat to a declared seat of its own team');
  });

  test('one side that is no operator falls through to the declared-seat rule, in either direction', async () => {
    const root = world.roots.acme as string;
    expect((await send({ team: 'acme', seat: 'operator-2' }, 'helper', [])).code).toBe(0);
    const helperDrops = join(root, '.agents', 'send-drops', 'acme', 'helper');
    const helperRecords = readdirSync(helperDrops).filter((name) => !name.includes('.'));
    expect(recordBody(join(helperDrops, helperRecords[0] as string))).toContain('admitted by: a seat to a declared seat of its own team');

    expect((await send({ team: 'acme', seat: 'helper' }, 'operator-2', [])).code).toBe(0);
    const opDrops = join(root, '.agents', 'send-drops', 'acme', 'operator-2');
    const opRecords = readdirSync(opDrops).filter((name) => !name.includes('.'));
    expect(recordBody(join(opDrops, opRecords[0] as string))).toContain('admitted by: a seat to a declared seat of its own team');
  });

  test('the pair never leaves the team, even inside one entity', async () => {
    refused(await send({ team: 'acme', seat: 'operator-2' }, 'other-op@other'));
    refused(await send({ team: 'other', seat: 'other-op' }, 'operator-2@acme'));
    // The other team's own place still reaches its own seats: the rule is a team's, not a project's.
    admitted(await send({ team: 'other', seat: 'other-op' }, 'other-helper'));
  });

  test('the file\'s operator place still reaches its whole team', async () => {
    // operator-1 is `operator:` in the file: its reach is the place's rule, wider than the pair.
    admitted(await send({ team: 'acme', seat: 'operator-1' }, 'helper'));
    admitted(await send({ team: 'acme', seat: 'operator-1' }, 'operator-2'));
  });

  test('a refused pair names the operators\' rule among the rules a send is judged by', async () => {
    const reading = await send({ team: 'acme', seat: 'helper' }, 'other-op@other');
    refused(reading);
    expect(reading.err).toContain('an operator to another operator of its own team');
  });

  test('the role the live file writes today decides, not the role the record was registered under', async () => {
    const root = world.roots.acme as string;
    // The record says operator; the file now says builder: the operator-pair rule does not answer.
    reword('acme', 'operator-3', 'builder');
    expect((await send({ team: 'acme', seat: 'operator-2' }, 'operator-3', [])).code).toBe(0);
    const op3Drops = join(root, '.agents', 'send-drops', 'acme', 'operator-3');
    const op3Records = readdirSync(op3Drops).filter((name) => !name.includes('.'));
    expect(recordBody(join(op3Drops, op3Records[0] as string))).toContain('admitted by: a seat to a declared seat of its own team');

    // The record says builder; the file now says operator: the operator-pair rule answers.
    reword('acme', 'operatorish', 'operator');
    expect((await send({ team: 'acme', seat: 'operator-2' }, 'operatorish', [])).code).toBe(0);
    const ishDrops = join(root, '.agents', 'send-drops', 'acme', 'operatorish');
    const ishRecords = readdirSync(ishDrops).filter((name) => !name.includes('.'));
    expect(recordBody(join(ishDrops, ishRecords[0] as string))).toContain('admitted by: an operator to another operator of its own team');
  });
});

describe('a send admitted by the operators\' rule is logged like every send', () => {
  test('the drop header names the rule and the team log carries the line', async () => {
    const root = world.roots.acme as string;
    const reading = await send({ team: 'acme', seat: 'operator-2' }, 'operator-3', []);
    expect(reading.err).toBe('');
    expect(reading.code).toBe(0);
    expect(reading.out).toContain('operator-3: sent (unconfirmed) (drop, 0 ms)');
    // The drop folder: the one signed record (the `.pending` marker beside it is the watch's),
    // whose payload carries the sender header and the admitting rule, the message one empty line
    // under it. The raw drop body the record replaced is gone.
    const drops = join(root, '.agents', 'send-drops', 'acme', 'operator-3');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(
      "from operator-2 — admitted by: an operator to another operator of its own team\n\na status line",
    );
    // The log: one line naming the sender, the receiver and the outcome.
    const log = readFileSync(join(root, '.agents', LOG_FILE), 'utf8');
    expect(log).toContain('send [operator-2] operator-3: sent to its drop folder');
    // The history the reading seat's inbox keeps: one entry, the receiver and the outcome.
    const read = readHistory('acme', root, world.home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ from: 'operator-2', to: 'operator-3', outcome: 'sent (unconfirmed)', via: 'drop' });
  });

  test('the same pair from the operator place is logged under the place\'s own rule', async () => {
    const root = world.roots.acme as string;
    const reading = await send({ team: 'acme', seat: 'operator-1' }, 'operator-2', []);
    expect(reading.code).toBe(0);
    const drops = join(root, '.agents', 'send-drops', 'acme', 'operator-2');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toContain('admitted by: an orchestrator or operator to a seat of its own team');
  });
});
