// The native channel's acceptance pass: the promises its two halves ship with, exercised through
// the commands a Claude Code seat actually runs — `team route <seat>` before it delivers with its
// own tool, `team send --record …` after — over a temporary home, a temporary root and a fake
// herdr interface. No live session, no real CLI home and no socket is ever opened: the fake that
// stands in for delivery counts every frame it is handed and every keystroke it would type, so
// "nothing else moved" is asserted on counters, not on faith.
//
//   1. route answers the address the registry records, and does so only for an admitted pair;
//   2. a refused route hands out no address and records nothing at all;
//   3. --record writes one history line — delivered, via native, the sender's own span — with no
//      drop file, no frame, no keystroke and no socket touched;
//   4. --record is judged by admission exactly as a send is: a pair no rule admits cannot record
//      a delivery, and nothing is written.
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
import { routesPath } from '../src/send/routes.ts';
import { updateState } from '../src/state.ts';
import { testIo, type TestIo } from './helpers.ts';

const BODY = 'the words the sender carried in its own tool call';
const NOW = new Date('2026-10-17T07:00:00.000Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

function seatBlock(role: string, name: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude-code --model test
`;
}

type World = { base: string; home: string; root: string; sockets: string };

/**
 * One team of three seats — its coordinator `lead`, and the two implementers `helper` and
 * `spare` — with the team file, the registry records, the team record, the state and a socket
 * folder of its own. `helper`'s registry record carries a recorded address whose pid (222) is
 * the one the fake pane runs, so the reading says `live`; the file is named here and dialed
 * nowhere.
 */
function acme(): { w: World; id: string; lead: Agent; helper: Agent; address: string; leadIo: TestIo; helperIo: TestIo } {
  const base = temp('b4-nat-');
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
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
${seatBlock('coordinator', 'lead')}${seatBlock('implementer', 'helper')}${seatBlock('implementer', 'spare')}`);

  const address = join(sockets, '222.sock');
  writeFileSync(address, '');
  const id = teamIdOf(root);
  const lead = registered(home, id, { seat: 'lead', role: 'coordinator', pane: 'w1:p1' });
  const helper = registered(home, id, { seat: 'helper', role: 'implementer', pane: 'w1:p2', address });
  const spare = registered(home, id, { seat: 'spare', role: 'implementer', pane: 'w1:p3' });
  upsertTeam(home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root,
    lobby: lobbyDir(home),
    lifecycle: 'running',
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
      { agent: spare.id, seat: 'spare', role: 'implementer', leads: false },
    ],
  });
  place(root, 'acme', [
    ['lead', 'w1:p1'],
    ['helper', 'w1:p2'],
    ['spare', 'w1:p3'],
  ]);
  return {
    w: { base, home, root, sockets },
    id,
    lead,
    helper,
    address,
    leadIo: testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } satisfies Caller),
    helperIo: testIo(root, { kind: 'seat', name: 'helper', pane: 'w1:p2', session: 'acme' } satisfies Caller),
  };
}

/** One registry record, as `up`/`add` would have written it. */
function registered(
  home: string,
  team: string,
  seat: { seat: string; role: string; pane: string; address?: string },
): Agent {
  return registerAgent(home, {
    name: seat.seat,
    signing: { model: 'Test', version: '1', role: seat.role },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude-code --model test',
    reach: { team, seat: seat.seat, session: 'acme', pane: seat.pane, address: seat.address ?? null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

/** The state record `up` leaves for launched seats: each one's pane in the session. */
function place(root: string, session: string, seats: [string, string][]): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions[session] = {
      seats: Object.fromEntries(seats.map(([seat, pane]) => [seat, { stage: 'launched', pane, workspace: 'w1' }])),
      worktrees: {},
    };
  });
}

/** The fake delivery side: every frame, keystroke and keypress it would make is counted, so a
 *  scene can assert the record half made none. */
type Rig = SendHost & { frames: string[]; typed: string[]; entered: string[] };

function rig(w: World, patch: Partial<SendHost> = {}): Rig {
  const frames: string[] = [];
  const typed: string[] = [];
  const entered: string[] = [];
  return {
    frames,
    typed,
    entered,
    agents: () => [],
    // The pane runs pid 222 — the pid helper's recorded address names — so the reading is live.
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (_socket: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: (_session: string, _pane: string, text: string) => {
        typed.push(text);
        return false;
      },
      pressEnter: (_session: string, pane: string) => {
        entered.push(pane);
        return false;
      },
      status: () => null,
      wait: async () => {},
    } satisfies NativePane,
    now: () => NOW,
    home: w.home,
    ...patch,
  };
}

function routeLines(at: string): Record<string, unknown>[] {
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('native acceptance: the route half', () => {
  test('an admitted pair is answered the address the registry records, and the route is written down', async () => {
    const { w, id, lead, helper, address, leadIo } = acme();

    const code = await runRoute(['helper'], leadIo, rig(w));

    expect(code).toBe(0);
    expect(leadIo.err).toBe('');
    expect(leadIo.out).toBe(
      `helper  ${helper.id}  (helper)\n` +
        `session acme\n` +
        `cli claude-code\n` +
        `pane w1:p2\n` +
        `socket ${address} (live)\n` +
        `native yes\n` +
        `admitted by: an orchestrator or operator to a seat of its own team\n`,
    );
    const lines = routeLines(routesPath('acme', w.root, w.home));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ts: NOW.toISOString(),
      from: 'orchestrator',
      from_id: lead.id,
      to: 'helper',
      to_id: helper.id,
      team: id,
      session: 'acme',
      pane: 'w1:p2',
      socket: address,
      socket_state: 'live',
      native: true,
      rule: 'an orchestrator or operator to a seat of its own team',
    });
  });

  test('a refused route answers no address, and writes no line anywhere', async () => {
    const { w, id, helperIo } = acme();

    const code = await runRoute(['spare'], helperIo, rig(w));

    expect(code).toBe(1);
    expect(helperIo.out).toBe('');
    expect(helperIo.err).toBe(
      `team route: refused: helper@${id} may not send to spare@${id}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
    );
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });
});

describe('native acceptance: the record half', () => {
  test('--record writes one history line — native, the sender\'s span — and nothing else moves', async () => {
    const { w, leadIo } = acme();
    const run = rig(w);

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '1234', BODY], leadIo, run);

    expect(code).toBe(0);
    expect(leadIo.out).toBe('helper: recorded (native, 1234 ms)\n');
    expect(leadIo.err).toBe('');
    const entry = parseHistoryLine(readFileSync(historyPath('acme', w.root, w.home), 'utf8'));
    expect(entry).toMatchObject({
      ts: NOW.toISOString(),
      from: 'lead',
      to: 'helper',
      body: BODY,
      outcome: 'delivered',
      ms: 1234,
      via: 'native',
    });
    expect(entry?.id).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing moved: no frame was dialed, no keystroke and no keypress was sent, no drop file
    // was written, and this half keeps no route stream of its own.
    expect(run.frames).toEqual([]);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('--record is judged by admission like any send: a pair no rule admits is refused, nothing written', async () => {
    const { w, id, helperIo } = acme();

    const code = await runSend(['--record', 'spare', '--channel', 'native', '--ms', '9'], helperIo, rig(w));

    expect(code).toBe(1);
    expect(helperIo.err).toBe(
      `team send: refused: helper@${id} may not send to spare@${id}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
    );
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });
});
