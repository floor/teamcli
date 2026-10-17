// The native channel's two bookkeeping halves, run for real: `team route <seat>` answers an
// admitted pair the recipient's own address — the seat resolved live by herdr, read from the
// registry, the live pane's process list and the socket folder's file names, never dialed — and
// `team send --record …` writes the one
// history line for a delivery the sender made with its own tool. A route lands in its own
// stream, `routes.jsonl`, beside `messages.jsonl`: a route is not a message and moves no text.
// Fake herdr reads, a temporary home and a temporary root: no live session, no real CLI home and
// no socket is ever opened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runRoute } from '../src/commands/route.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { PROJECT_RULE_SUMMARY, RULE_SUMMARY } from '../src/send/admit.ts';
import { historyPath, parseHistoryLine } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { NATIVE_BODY_MARKER, routesPath } from '../src/send/routes.ts';
import { ROUTE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { updateState } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { liveAgentsOf, testIo, type TestIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const OWNER = { kind: 'owner' as const };
const BODY = 'the native delivery, written down after the fact';
const NOW = new Date('2026-10-17T06:00:00.000Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

function seatBlock(role: string, name: string, cli: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${cli} --model test
`;
}

type World = { base: string; home: string; root: string; sockets: string };

/** One root with `.agents/team.yaml`, in a home, with its own socket folder. A second team joins
 *  the same base and home (`into`): one home is one lobby. */
function world(project: string, session: string, coordinator: string, seats: string[], into?: World): World {
  const base = into?.base ?? tempBase('r4a-route-');
  const home = into?.home ?? join(base, 'h');
  if (!into) mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, project);
  const sockets = into?.sockets ?? join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  if (!existsSync(sockets)) mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${project}
coordinator: ${coordinator}
operator: ${coordinator}
session: ${session}
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seats.join('')}`);
  return { base, home, root, sockets };
}

/** One agent record, as `up`/`add` would have registered it. */
function agent(
  home: string,
  init: { name: string; role: string; cli: string; team: string; seat: string; session: string; pane: string | null; address?: string | null },
): Agent {
  return registerAgent(home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: 'test-lab',
    cli: init.cli,
    launcher: null,
    launch: `${init.cli} --model test`,
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: init.address ?? null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

function team(
  home: string,
  id: string,
  project: string,
  session: string,
  root: string,
  roster: { agent: string; seat: string; role: string; leads: boolean }[],
): void {
  upsertTeam(home, id, { project, entity: project, session, root, lobby: lobbyDir(home), roster, lifecycle: 'running' });
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. Seats add to
 *  their session's record — one launch never erases the seat already standing beside it. */
function place(root: string, session: string, seat: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    const seats = state.sessions[session]?.seats ?? {};
    state.sessions[session] = {
      seats: { ...seats, [seat]: { stage: 'launched', pane, workspace: 'w1' } },
      worktrees: state.sessions[session]?.worktrees ?? {},
    };
  });
}

/** The socket a pane's listener has: an empty file named `<pid>.sock` in the folder. Its
 *  content is never read — nothing here dials, and nothing in the command does either. */
function socketAt(dir: string, pid: number): string {
  const path = join(dir, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

type Fake = SendHost & { frames: string[] };

function host(made: World, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  return {
    frames,
    agents: (session) => liveAgentsOf(made.home, session),
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: made.sockets,
    deliver: async (_socketPath: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} } satisfies NativePane,
    now: () => NOW,
    home: made.home,
    ...patch,
  };
}

function routeLines(at: string): Record<string, unknown>[] {
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The acme world the scenes share: the file's own lead and helper, both registered and placed,
 *  one team record, and the two seat callers' io. */
function acme(address?: string | null): { w: World; lead: Agent; helper: Agent; leadIo: TestIo; ownerIo: TestIo; id: string } {
  const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'codex')]);
  const id = teamIdOf(w.root);
  const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: address ?? null });
  const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'codex', team: id, seat: 'helper', session: 'acme', pane: 'w1:p2' });
  team(w.home, id, 'acme', 'acme', w.root, [
    { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
    { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
  ]);
  place(w.root, 'acme', 'lead', 'w1:p1');
  place(w.root, 'acme', 'helper', 'w1:p2');
  const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
  return { w, lead, helper, leadIo: testIo(w.root, caller), ownerIo: testIo(w.root, OWNER), id };
}

describe('route: the address the native channel answers', () => {
  test('the owner is answered the recorded address, and one record is written', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'codex')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const run = host(w, { processInfo: () => ({ shell: 111, foreground: [4242] }) });

    const code = await runRoute(['lead'], testIo(w.root, OWNER), run);

    expect(code).toBe(0);
    expect(run.frames).toEqual([]);
    const at = routesPath('acme', w.root, w.home);
    const lines = routeLines(at);
    expect(lines).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        from_id: null,
        to: 'lead',
        to_id: lead.id,
        team: id,
        session: 'acme',
        pane: 'w1:p1',
        socket: address,
        socket_state: 'live',
        native: true,
        rule: 'the owner',
      },
    ]);
    // No drop file: a route moves no text.
    expect(existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);
  });

  test('the answer names the recipient, its session, CLI, pane, socket and the rule', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead'], io, host(w, { processInfo: () => ({ shell: 111, foreground: [4242] }) }));

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
        `lead  ${lead.id}  (lead)\n` +
        'session acme\n' +
        'cli claude-code\n' +
        'pane w1:p1\n' +
        `socket ${address} (live)\n` +
        'native yes\n' +
        'admitted by: the owner\n' +
        `lead: routed at ${address} (live)\n`,
    );
    expect(io.err).toBe('');
  });

  test('--json prints the route answer as the team.route envelope', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead', '--json'], io, host(w, { processInfo: () => ({ shell: 111, foreground: [4242] }) }));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, ROUTE_OUTPUT_SCHEMA);
    expect(doc).toEqual({
      schema: { name: 'team.route', version: 1 },
      format: 1,
      dry_run: false,
      status: 'routed',
      action_summary: `lead: routed at ${address} (live)`,
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      agent: lead.id,
      recipient_session: 'acme',
      cli: 'claude-code',
      pane: 'w1:p1',
      address,
      socket_state: 'live',
      native: true,
      rule: 'the owner',
    });
  });

  test('a stale recorded address is named, and warned against dialing', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4243);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);
    const run = host(w); // the pane process 4243 belonged to is gone

    const code = await runRoute(['lead'], io, run);

    expect(code).toBe(0);
    expect(io.out).toContain(`socket ${address} (stale; do not dial it)`);
    expect(routeLines(routesPath('acme', w.root, w.home))[0]?.socket_state).toBe('stale');
    expect(run.frames).toEqual([]);
  });

  test('with nothing recorded, the socket the pane carries now is found', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const found = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead'], io, host(w, { processInfo: () => ({ shell: 111, foreground: [4242] }) }));

    expect(code).toBe(0);
    expect(io.out).toContain(`socket ${found} (found on the pane)`);
    expect(routeLines(routesPath('acme', w.root, w.home))[0]?.socket_state).toBe('pane');
  });

  test('a pane the seat no longer stands on never yields its socket', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'claude-code')]);
    const id = teamIdOf(w.root);
    const ours = socketAt(w.sockets, 4242);
    socketAt(w.sockets, 9001); // the socket the reused pane carries: another seat's session
    // The record still says w1:p1, and that pane now holds another seat's Claude session; herdr
    // names this seat on w1:p2. A recorded-pane read would answer 9001.sock — the other seat's.
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'claude-code', team: id, seat: 'helper', session: 'acme', pane: 'w1:p1' });
    team(w.home, id, 'acme', 'acme', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
    ]);
    const io = testIo(w.root, OWNER);
    const run = host(w, {
      agents: () => [
        { name: 'lead', pane: 'w1:p2', cli: 'claude' },
        { name: 'helper', pane: 'w1:p1', cli: 'claude' },
      ],
      processInfo: (_session, pane) => ({ shell: 111, foreground: pane === 'w1:p2' ? [4242] : [9001] }),
    });

    const code = await runRoute(['lead'], io, run);

    expect(code).toBe(0);
    expect(io.out).toContain('pane w1:p2\n');
    expect(io.out).toContain(`socket ${ours} (found on the pane)`);
    expect(io.out).not.toContain('9001.sock');
    expect(routeLines(routesPath('acme', w.root, w.home))[0]).toMatchObject({ pane: 'w1:p2', socket: ours, socket_state: 'pane' });
  });

  test('a seat herdr does not name there is refused, and no address is answered', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    socketAt(w.sockets, 9001);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);
    // The recorded pane now holds another seat's Claude session; herdr names no lead anywhere.
    const run = host(w, {
      agents: () => [{ name: 'helper', pane: 'w1:p1', cli: 'claude' }],
      processInfo: () => ({ shell: 111, foreground: [9001] }),
    });

    const code = await runRoute(['lead'], io, run);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team route: refused: ${lead.id}: herdr names no seat "lead" in the session "acme", so no address was answered\n`);
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
    expect(run.frames).toEqual([]);
  });

  test('a seat the file marks stopped is refused, dry run and all, and no address is answered', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'codex')]);
    const id = teamIdOf(w.root);
    socketAt(w.sockets, 9002);
    const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'codex', team: id, seat: 'helper', session: 'acme', pane: 'w1:p2' });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: helper.id, seat: 'helper', role: 'implementer', leads: false }]);
    place(w.root, 'acme', 'helper', 'w1:p2');
    const file = join(w.root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: implementer', '  - role: implementer\n    stopped: true'));
    // herdr would name the seat on the pane its record carries: the refusal is the file's own.
    const run = host(w, { agents: () => [{ name: 'helper', pane: 'w1:p2', cli: 'codex' }] });

    for (const argv of [['helper'], ['helper', '--dry-run']]) {
      const io = testIo(w.root, OWNER);
      expect(await runRoute(argv, io, run)).toBe(1);
      expect(io.out).toBe('');
      expect(io.err).toBe('team route: refused: helper is stopped\n');
    }
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
    expect(run.frames).toEqual([]);
  });

  test('a seat herdr names on another CLI is refused, and no address is answered', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    socketAt(w.sockets, 9001);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);
    const run = host(w, {
      agents: () => [{ name: 'lead', pane: 'w1:p1', cli: 'codex' }],
      processInfo: () => ({ shell: 111, foreground: [9001] }),
    });

    const code = await runRoute(['lead'], io, run);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team route: refused: ${lead.id}: herdr names "lead" running "codex", not the recorded CLI "claude-code"; no address was answered\n`);
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('a session herdr cannot be read is refused, and no address is answered', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead'], io, host(w, { agents: () => null }));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team route: refused: ${lead.id}: the session "acme" could not be read, so no address was answered\n`);
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('no socket anywhere is none, and a seat that is not Claude Code is not native', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'codex')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null });
    const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'codex', team: id, seat: 'helper', session: 'acme', pane: 'w1:p2' });
    team(w.home, id, 'acme', 'acme', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
    ]);
    const io = testIo(w.root, OWNER);
    const run = host(w, { processInfo: () => ({ shell: 111, foreground: [222] }) });

    const code = await runRoute(['helper', '--json'], io, run);

    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ seat: 'helper', address: null, socket_state: 'none', native: false });
    expect(routeLines(routesPath('acme', w.root, w.home))[0]?.socket).toBeNull();
  });

  test('a pane that cannot be read leaves a recorded address named, unclaimed', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead'], io, host(w, { processInfo: () => null }));

    expect(code).toBe(0);
    expect(io.out).toContain(`socket ${address} (recorded; the pane could not be read)`);
    expect(routeLines(routesPath('acme', w.root, w.home))[0]?.socket_state).toBe('unread');
  });

  test('--dry-run answers the same and writes nothing', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const address = socketAt(w.sockets, 4242);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', address });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const run = host(w, { processInfo: () => ({ shell: 111, foreground: [4242] }) });

    const code = await runRoute(['lead', '--dry-run'], io, run);

    expect(code).toBe(0);
    const target = join(storePath('acme', w.root, w.home), 'routes.jsonl');
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
        `lead  ${lead.id}  (lead)\n` +
        'session acme\n' +
        'cli claude-code\n' +
        'pane w1:p1\n' +
        `socket ${address} (live)\n` +
        'native yes\n' +
        'admitted by: the owner\n' +
        `+ record: lead: append the route to ${target}\n` +
        'dry run: nothing was run\n',
    );
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);

    const jsonIo = testIo(w.root, OWNER);
    expect(await runRoute(['lead', '--dry-run', '--json'], jsonIo, run)).toBe(0);
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(jsonIo.out, ROUTE_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({ dry_run: true, status: 'dry-run', action_summary: 'dry run: nothing was run' });
    expect(doc.plan).toEqual([{ step: 'record', seat: 'lead', detail: `append the route to ${target}`, prefix: '+' }]);
  });

  test('a pair no rule admits answers nothing and writes nothing', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code'), seatBlock('implementer', 'helper', 'codex')]);
    const bound = world('beta', 'beta', 'chief', [seatBlock('coordinator', 'chief', 'claude-code'), seatBlock('builder', 'builder', 'claude-code')], w);
    const acmeId = teamIdOf(w.root);
    const betaId = teamIdOf(bound.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: acmeId, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    const chief = agent(w.home, { name: 'chief', role: 'coordinator', cli: 'claude-code', team: betaId, seat: 'chief', session: 'beta', pane: 'w2:p1' });
    const builder = agent(w.home, { name: 'builder', role: 'builder', cli: 'claude-code', team: betaId, seat: 'builder', session: 'beta', pane: 'w2:p2' });
    team(w.home, acmeId, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    team(w.home, betaId, 'beta', 'beta', bound.root, [
      { agent: chief.id, seat: 'chief', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder', role: 'builder', leads: false },
    ]);
    place(w.root, 'acme', 'lead', 'w1:p1');
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
    const run = host(w);

    const code = await runRoute([`builder@${betaId}`], io, run);

    expect(code).toBe(1);
    expect(io.err).toBe(
      `team route: refused: lead@${acmeId} may not send to builder@${betaId}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
    );
    expect(existsSync(routesPath('beta', bound.root, w.home))).toBe(false);
    expect(run.frames).toEqual([]);
  });

  test('a seat the registry holds no record for is refused with the reading’s words', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['ghost'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toBe(
      'team route: refused: ghost: no registered agent holds the seat "ghost" in that team; `team up` records a seat it launches, or `team register ghost` records one already running\n',
    );
    expect(io.out).toBe('');
  });

  test('a store that refuses the write refuses the route', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    // A file where the project's state folder would be: the ladder refuses it, so the record
    // can not be written — and an address this CLI can not account for is not handed out.
    const at = storePath('acme', w.root, w.home);
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    writeFileSync(at, '');
    const io = testIo(w.root, OWNER);

    const code = await runRoute(['lead'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toBe('team route: refused: the route record could not be written: the state folder path is not a directory\n');
    expect(io.out).toBe('');
  });

  test('--json refusals are the structured error envelope, with stderr empty', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    team(w.home, id, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);

    const usageIo = testIo(w.root, OWNER);
    expect(await runRoute(['--json'], usageIo, host(w))).toBe(2);
    expect(usageIo.err).toBe('');
    assertJsonErrorShape(usageIo.out, { id: 'route.usage', messageContains: 'a seat, a seat@team or an agent id is required' });

    const detachedIo = testIo(w.root, { kind: 'owner-no-tty' });
    expect(await runRoute(['lead', '--json'], detachedIo, host(w))).toBe(1);
    expect(detachedIo.err).toBe('');
    assertJsonErrorShape(detachedIo.out, { id: 'route.detached', repair: 'run team route from a terminal outside herdr' });

    const refusedIo = testIo(w.root, OWNER);
    expect(await runRoute(['ghost', '--json'], refusedIo, host(w))).toBe(1);
    expect(refusedIo.err).toBe('');
    assertJsonErrorShape(refusedIo.out, { id: 'route.refused', messageContains: 'no registered agent holds the seat "ghost"' });

    const at = storePath('acme', w.root, w.home);
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    writeFileSync(at, '');
    const unrecordedIo = testIo(w.root, OWNER);
    expect(await runRoute(['lead', '--json'], unrecordedIo, host(w))).toBe(1);
    expect(unrecordedIo.err).toBe('');
    assertJsonErrorShape(unrecordedIo.out, { id: 'route.unrecorded', messageContains: 'the route record could not be written' });
  });
});

describe('send --record: the delivery the sender made itself', () => {
  test('a Claude sender records its own delivery: one history line, via native', async () => {
    const { w, lead, helper, leadIo } = acme();
    const run = host(w);

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '812'], leadIo, run);

    expect(code).toBe(0);
    expect(leadIo.out).toBe('team acme, session "acme"\nhelper: recorded (native, 812 ms)\n');
    expect(leadIo.err).toBe('');
    const text = readFileSync(historyPath('acme', w.root, w.home), 'utf8');
    const entry = parseHistoryLine(text);
    expect(entry).toMatchObject({
      ts: NOW.toISOString(),
      from: 'lead',
      to: 'helper',
      body: NATIVE_BODY_MARKER,
      outcome: 'delivered',
      ms: 812,
      via: 'native',
    });
    expect(entry?.id).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing was delivered, dialed or typed: this half writes down what the sender did.
    expect(run.frames).toEqual([]);
    expect(existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);
    const log = readFileSync(join(w.root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('send [orchestrator] helper: recorded (native, 812 ms)');
    expect(lead.id).not.toBe(helper.id);
  });

  test('a body given is recorded verbatim', async () => {
    const { w, leadIo } = acme();

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '5', BODY], leadIo, host(w));

    expect(code).toBe(0);
    const entry = parseHistoryLine(readFileSync(historyPath('acme', w.root, w.home), 'utf8'));
    expect(entry).toMatchObject({ from: 'lead', to: 'helper', body: BODY, outcome: 'delivered', ms: 5, via: 'native' });
  });

  test('a recorded delivery is judged by admission like any send', async () => {
    const w = world('acme', 'acme', 'lead', [seatBlock('coordinator', 'lead', 'claude-code')]);
    const bound = world('beta', 'beta', 'chief', [seatBlock('coordinator', 'chief', 'claude-code'), seatBlock('builder', 'builder', 'claude-code')], w);
    const acmeId = teamIdOf(w.root);
    const betaId = teamIdOf(bound.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: acmeId, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    const chief = agent(w.home, { name: 'chief', role: 'coordinator', cli: 'claude-code', team: betaId, seat: 'chief', session: 'beta', pane: 'w2:p1' });
    const builder = agent(w.home, { name: 'builder', role: 'builder', cli: 'claude-code', team: betaId, seat: 'builder', session: 'beta', pane: 'w2:p2' });
    team(w.home, acmeId, 'acme', 'acme', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);
    team(w.home, betaId, 'beta', 'beta', bound.root, [
      { agent: chief.id, seat: 'chief', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder', role: 'builder', leads: false },
    ]);
    place(w.root, 'acme', 'lead', 'w1:p1');
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['--record', `builder@${betaId}`, '--channel', 'native', '--ms', '9'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toBe(
      `team send: refused: lead@${acmeId} may not send to builder@${betaId}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
    );
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
    expect(existsSync(historyPath('beta', bound.root, w.home))).toBe(false);
  });

  test('the options are judged on their own, before anything is read', async () => {
    const { w, leadIo } = acme();
    const cases: { argv: string[]; message: string }[] = [
      { argv: ['--record', 'helper', '--ms', '812'], message: '--record needs --channel native' },
      { argv: ['--record', 'helper', '--channel', 'socket', '--ms', '812'], message: '--channel takes native (got "socket"): the other channels send themselves' },
      { argv: ['--record', 'helper', '--channel', 'native'], message: '--record needs --ms <N>: the span the sender measured, in whole milliseconds' },
      { argv: ['--record', 'helper', '--channel', 'native', '--ms', '812ms'], message: '--ms takes a whole number of milliseconds (got "812ms")' },
      { argv: ['--record', 'helper', '--channel', 'native', '--ms', '812', '--wait'], message: '--wait and --timeout are not meaningful with --record: nothing is delivered here' },
    ];
    for (const one of cases) {
      const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
      const code = await runSend(one.argv, io, host(w));
      expect(code).toBe(2);
      expect(io.err).toContain(`team send: ${one.message}\n`);
      expect(io.out).toBe('');
    }
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });

  test('--dry-run records nothing', async () => {
    const { w, leadIo } = acme();

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '812', '--dry-run'], leadIo, host(w));

    expect(code).toBe(0);
    expect(leadIo.out).toBe('team acme, session "acme"\nhelper: would record (native, 812 ms); nothing was written\n');
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });

  test('--json prints the result document, id and all', async () => {
    const { w, leadIo } = acme();

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '812', '--json'], leadIo, host(w));

    expect(code).toBe(0);
    const doc = JSON.parse(leadIo.out) as {
      schema: { name: string; version: number };
      format: number;
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      channel: string;
      ids: { sent: string; reply: null };
    };
    expect(doc.schema).toEqual({ name: 'team.send', version: 1 });
    expect(doc).toMatchObject({ seat: 'helper', status: 'recorded', dry_run: false, channel: 'native' });
    expect(doc.action_summary).toBe('helper: recorded (native, 812 ms)');
    expect(doc.ids.reply).toBeNull();
    const entry = parseHistoryLine(readFileSync(historyPath('acme', w.root, w.home), 'utf8'));
    expect(entry?.id).toBe(doc.ids.sent);
  });
});
