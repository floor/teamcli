// The operator pair, end to end: two seats of one team whose file lines both write
// `role: operator` write to each other. The file's line is the word admission reads, not the
// role a record was registered under; the record carries the admitting rule, and the send is
// logged like any other. The same word in another team is still no pair.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { readHistory } from '../../src/send/history.ts';
import { updateState } from '../../src/state.ts';
import { recordBody, testIo } from '../helpers.ts';
import { dropDir, fake, world, type World } from '../send-native-fixtures.ts';

const made: World[] = [];

afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

/** The acme world with both operators on the file's own lines, and no record for either: the
 *  bootstrap the pair is judged on. The walk is the drop leg, so the outcome is the record. */
function make(): World {
  const one = world(['drop'], [
    { name: 'operator-a', role: 'operator' },
    { name: 'operator-b', role: 'operator' },
  ]);
  made.push(one);
  return one;
}

/** The signed record in a drop folder, past the marker the drop leg leaves beside it: the
 *  directory holds `<id>` and `<id>.pending`, and readdir order is the filesystem's. */
function dropRecord(drops: string): string {
  const name = readdirSync(drops).find((candidate) => !candidate.endsWith('.pending'));
  if (name === undefined) throw new Error(`no drop record in ${drops}`);
  return join(drops, name);
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. */
function place(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

function registered(
  one: World,
  init: { name: string; role: string; team: string; seat: string; session: string; pane: string },
): Agent {
  return registerAgent(one.home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

function teamRecord(one: World, id: string, init: { project: string; session: string; root: string; roster: { agent: string; seat: string; role: string }[] }): void {
  upsertTeam(one.home, id, {
    project: init.project,
    entity: null,
    session: init.session,
    root: init.root,
    lobby: lobbyDir(one.home),
    roster: init.roster.map((entry) => ({ ...entry, leads: false })),
    lifecycle: 'running',
    by: 'test',
  });
}

describe('team send: two operators of one team', () => {
  test('a declared operator reaches another declared operator, and the record, history and log say so', async () => {
    const one = make();
    place(one.dir, 'operator-a', 'w2:p1');
    const io = testIo(one.root, { kind: 'seat', name: 'operator-a', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['operator-b', 'the handover is ready'], io, fake(one));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('team acme, session "acme"\noperator-b: sent (unconfirmed) (drop, 0 ms)\n');
    const drops = dropDir(one.dir, 'operator-b');
    // The drop leg leaves its retry marker beside the record, and readdir order is the
    // filesystem's: the record is picked by name, never by position.
    expect(readdirSync(drops).some((name) => name.endsWith('.pending'))).toBe(true);
    expect(recordBody(dropRecord(drops))).toBe(
      "from the file's seat operator-a (no registry record yet) — admitted by: an operator to another operator of its own team\n\nthe handover is ready",
    );
    // Logged like every send: one history line and one team-log line.
    const read = readHistory('acme', one.root, one.home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ to: 'operator-b', outcome: 'sent (unconfirmed)', via: 'drop' });
    expect(readFileSync(join(one.dir, 'team.log'), 'utf8')).toContain('send [operator-a] operator-b: sent to its drop folder');
  });

  test('the file line is the word, not the role the record signed under', async () => {
    const one = make();
    const id = teamIdOf(one.root);
    const operatorA = registered(one, { name: 'operator-a', role: 'implementer', team: id, seat: 'operator-a', session: 'acme', pane: 'w2:p1' });
    // The record says implementer; the file's line says operator, and the file is what decides.
    teamRecord(one, id, {
      project: 'acme',
      session: 'acme',
      root: one.root,
      roster: [{ agent: operatorA.id, seat: 'operator-a', role: 'implementer' }],
    });
    place(one.dir, 'operator-a', 'w2:p1');
    const io = testIo(one.root, { kind: 'seat', name: 'operator-a', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['operator-b', 'status?'], io, fake(one));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    const drops = dropDir(one.dir, 'operator-b');
    expect(recordBody(dropRecord(drops))).toBe(
      'from operator-a — admitted by: an operator to another operator of its own team\n\nstatus?',
    );
  });

  test('the same word in another team is no pair, and the send is refused', async () => {
    const one = make();
    const id = teamIdOf(one.root);
    const operatorA = registered(one, { name: 'operator-a', role: 'operator', team: id, seat: 'operator-a', session: 'acme', pane: 'w2:p1' });
    teamRecord(one, id, {
      project: 'acme',
      session: 'acme',
      root: one.root,
      roster: [{ agent: operatorA.id, seat: 'operator-a', role: 'operator' }],
    });
    place(one.dir, 'operator-a', 'w2:p1');

    const otherRoot = join(dirname(one.root), 'other');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: otherRoot, stdio: 'ignore' });
    writeFileSync(
      join(otherRoot, '.agents', 'team.yaml'),
      `format: 1
project: other
coordinator: lead
operator: lead
session: other
trust:
  - ${lobbyDir(one.home)}
  - ${otherRoot}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: operator
    name: operator-c
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
delivery_order: [drop]
`,
    );
    const otherId = teamIdOf(otherRoot);
    const operatorC = registered(one, { name: 'operator-c', role: 'operator', team: otherId, seat: 'operator-c', session: 'other', pane: 'w5:p1' });
    teamRecord(one, otherId, {
      project: 'other',
      session: 'other',
      root: otherRoot,
      roster: [{ agent: operatorC.id, seat: 'operator-c', role: 'operator' }],
    });
    const io = testIo(one.root, { kind: 'seat', name: 'operator-a', pane: 'w2:p1', session: 'acme' });

    const code = await runSend([`operator-c@${otherId}`, 'hello'], io, fake(one));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain(`may not send to operator-c@${otherId}: no rule admits it`);
    expect(existsSync(join(one.dir, 'send-drops'))).toBe(false);
  });
});
