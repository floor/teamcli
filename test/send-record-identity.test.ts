// `team send`, `team send --record` and `team route` name a sender from a registry record only
// where the call stands as that record: the seat's own name, running, in the record's session,
// on the pane the record holds, and on the pane the state records for that seat. A pane renamed
// to a seat's name, a caller of the name in another session, and a caller the state never placed
// are each refused before the message is read, before anything is delivered, and before an
// address is answered. Fake hosts and a temporary home: no pane is read and no socket is opened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import type { Caller } from '../src/caller.ts';
import { runRoute } from '../src/commands/route.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { historyPath } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { routesPath } from '../src/send/routes.ts';
import { updateState } from '../src/state.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-10-17T06:00:00.000Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

/** One root with `.agents/team.yaml`, its own socket folder, and a home to hold the registry. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'r4a-record-')));
  made.push(base);
  const home = join(base, 'h');
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead', 'claude-code')}${seatBlock('implementer', 'helper', 'codex')}`);
  return { base, home, root, sockets };
}

/** One agent record, as `up`/`add` would have registered it. */
function agent(
  home: string,
  init: { name: string; role: string; cli: string; team: string; seat: string; session: string; pane: string; lifecycle?: Agent['lifecycle'] },
): Agent {
  return registerAgent(home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: 'test-lab',
    cli: init.cli,
    launcher: null,
    launch: `${init.cli} --model test`,
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: init.lifecycle ?? 'running',
    by: 'up',
  });
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. A launch adds
 *  to the session's record; it never erases the seat already standing beside it. */
function place(root: string, session: string, seat: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    const seats = state.sessions[session]?.seats ?? {};
    state.sessions[session] = {
      seats: { ...seats, [seat]: { stage: 'launched', pane, workspace: 'w1' } },
      worktrees: state.sessions[session]?.worktrees ?? {},
    };
  });
}

type Fake = SendHost & { frames: string[] };

function host(made: World, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  return {
    frames,
    agents: () => [],
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

/** The acme world: the file's own lead and helper, both registered and (by default) placed.
 *  `place` names the seats the state records — a seat left out is one no launch ever recorded. */
function acme(options: { place?: ('lead' | 'helper')[]; lifecycle?: Agent['lifecycle'] } = {}): {
  w: World;
  lead: Agent;
  helper: Agent;
  id: string;
} {
  const w = world();
  const id = teamIdOf(w.root);
  const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1', lifecycle: options.lifecycle });
  const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'codex', team: id, seat: 'helper', session: 'acme', pane: 'w1:p2' });
  upsertTeam(w.home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: w.root,
    lobby: lobbyDir(w.home),
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  const placed = options.place ?? ['lead', 'helper'];
  if (placed.includes('lead')) place(w.root, 'acme', 'lead', 'w1:p1');
  if (placed.includes('helper')) place(w.root, 'acme', 'helper', 'w1:p2');
  return { w, lead, helper, id };
}

describe('a registry record binds the call only where the call stands as it', () => {
  test("a pane renamed to a registered seat's name is refused on send", async () => {
    const { w } = acme();
    const run = host(w);
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' });

    const code = await runSend(['helper', 'hello'], io, run);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      "team send: refused: the registry records pane w1:p1 for seat lead in session acme, and this call is on pane w9:p9: a pane renamed to a seat's name is not that seat\n",
    );
    expect(run.frames).toEqual([]);
    expect(existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);

    // The owner hears the refusal as its rule and object — the caller's seat, the seat it
    // addressed, the folder the call stood in — and never the message it tried to send.
    const events = readEvents('acme', w.root, w.home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'security.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      session: 'acme',
      rule: 'admission',
      seat: 'lead',
      subject: 'helper',
      reason: join(w.root, '.agents'),
    });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain('hello');

    // The same refusal again is counted in the command's log, not repeated to the owner.
    const again = await runSend(['helper', 'hello'], testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' }), run);
    expect(again).toBe(1);
    const later = readEvents('acme', w.root, w.home);
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.events.filter((event) => event.payload.kind === 'security.refused')).toHaveLength(1);
    const log = readFileSync(join(w.root, '.agents', 'team.log'), 'utf8');
    expect(log.split('\n').filter((line) => line.includes('refusal [lead] security.refused admission')).length).toBe(2);
  });

  test('a caller the state never placed is refused before the target is resolved', async () => {
    const { w } = acme({ place: ['helper'] });
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['someone', 'hello'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toContain('no pane is recorded for seat lead in this session');

    const events = readEvents('acme', w.root, w.home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'security.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      session: 'acme',
      rule: 'placement',
      seat: 'lead',
      subject: 'someone',
      reason: join(w.root, '.agents'),
    });
  });

  test("a pane renamed to a registered seat's name is refused on --record", async () => {
    const { w } = acme();
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' });

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '5'], io, host(w));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('a pane renamed to a seat\'s name is not that seat');
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });

  test("a pane renamed to a registered seat's name is refused on route, and no address is answered", async () => {
    const { w } = acme();
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' });

    const code = await runRoute(['helper'], io, host(w));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('a pane renamed to a seat\'s name is not that seat');
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test("a call on the record's pane but off the state's pane is refused too", async () => {
    // The other half of the same binding: the registry holds w1:p1 for the seat, the state
    // records w9:p9. The call stands as the record but not as the seat the state placed.
    const w = world();
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'acme', pane: 'w1:p1' });
    const helper = agent(w.home, { name: 'helper', role: 'implementer', cli: 'codex', team: id, seat: 'helper', session: 'acme', pane: 'w1:p2' });
    upsertTeam(w.home, id, {
      project: 'acme',
      entity: 'acme',
      session: 'acme',
      root: w.root,
      lobby: lobbyDir(w.home),
      roster: [
        { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
        { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
      ],
      lifecycle: 'running',
    });
    place(w.root, 'acme', 'lead', 'w9:p9');
    place(w.root, 'acme', 'helper', 'w1:p2');
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['helper', 'hello'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toContain('the state records pane w9:p9 for seat lead in this session, not the pane this call is on');
  });

  test('a caller of the same name in another session is refused on send and route', async () => {
    const { w } = acme();
    const elsewhere: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'beta' };

    const sendIo = testIo(w.root, elsewhere);
    const sendCode = await runSend(['helper', 'hello'], sendIo, host(w));
    expect(sendCode).toBe(1);
    expect(sendIo.out).toBe('');
    expect(sendIo.err).toContain('seat lead stands in session acme, and this call is not placed in it: a caller of another session is not that seat');

    const routeIo = testIo(w.root, elsewhere);
    const routeCode = await runRoute(['helper'], routeIo, host(w));
    expect(routeCode).toBe(1);
    expect(routeIo.out).toBe('');
    expect(routeIo.err).toContain('a caller of another session is not that seat');
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('route never answers an address to a caller the state never placed', async () => {
    const { w } = acme({ place: ['helper'] });
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runRoute(['helper'], io, host(w));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('no pane is recorded for seat lead in this session');
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('a registered seat that is not running is refused: its record is not a sender', async () => {
    const { w } = acme({ lifecycle: 'stopped' });
    const io: TestIo = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['helper', 'hello'], io, host(w));

    expect(code).toBe(1);
    expect(io.err).toBe("team send: refused: the registry's record for seat lead is stopped, not running: only a running seat acts as its own record\n");

    // An identity the rules deny is the owner's to hear: the rule and the object, no message.
    const events = readEvents('acme', w.root, w.home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'security.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      session: 'acme',
      rule: 'admission',
      seat: 'lead',
      subject: 'helper',
      reason: join(w.root, '.agents'),
    });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain('hello');
  });
});
