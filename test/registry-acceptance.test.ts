// The registry MVP's acceptance scenes (design-registry-mvp.md, §Acceptance), test-first:
// (a) an agy seat — a CLI with no SendMessage — sends to the main coordinator by `name@team`,
//     and the drop the receiver is pointed at names the sender's agent id and the rule that
//     admitted it;
// (b) an orchestrator reaches another team's orchestrator by `name@team`, no guessing: two
//     teams hold a seat of the same name, and the message lands in the named team's seat;
// (c) a relaunch keeps a seat's agent id and re-points reach.pane to the pane it starts on.
// R4c, verified delivery, in the same fake-CLI frame (src/send/deliver.ts):
// (d) a CLI that swallows the first Enter is pressed again, and the receipt is delivered;
// (e) a CLI that never submits earns not-submitted, with the box text, inside the try bound;
// (f) a box drawn with a dim (SGR 2) suggestion counts as empty, and no Enter goes out on it.
// Fake herdr throughout and a temporary home: no live session and no real CLI home is read.
// The fixed modules are imported, not stubbed, so this file is red until src/registry/agents.ts,
// src/registry/teams.ts, src/send/resolve.ts, src/send/admit.ts and src/send/deliver.ts land.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents, registerAgent, type Agent } from '../src/registry/agents.ts';
import { findTeam, readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { admitSend, senderHeader } from '../src/send/admit.ts';
import { bindPane, deliverTrigger } from '../src/send/deliver.ts';
import { readTriggerLine, type NativePane } from '../src/send/native.ts';
import { resolveTarget } from '../src/send/resolve.ts';
import { readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const AGENT_ID = /^agt_[0-9a-f]{12}$/;
const BODY = 'the coordinator asked for a status line';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

// ---- the send scenes: a temporary root, a temporary home, and the registry records ----

type SendWorld = { base: string; home: string; roots: Record<string, string> };

function seatBlock(role: string, name: string, cli: string, vendor: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: ${vendor}
    model: Test
    version: "1"
    launch: ${cli} --model test
`;
}

/** One root with `.agents/team.yaml`, and a home: the shape `team send` reads. `entity` is the
 *  file's own `entity:` key, which a send judges the caller's team by; a team that gives one also
 *  names its lobby outright, as the live floor team does, and trust lists it. A team that gives
 *  none carries neither. */
function sendWorld(teams: Record<string, { project: string; entity?: string; session: string; coordinator: string; seats: string[] }>): SendWorld {
  const base = tempBase('r5-acc-');
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const roots: Record<string, string> = {};
  for (const [name, team] of Object.entries(teams)) {
    const root = join(base, name);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const trust = [`  - ${lobbyDir(home)}`, `  - ${root}`];
    let entity = '';
    if (team.entity !== undefined) {
      const lobby = join(home, '.config', 'team', 'lobbies', team.entity.toLowerCase());
      mkdirSync(lobby, { recursive: true });
      trust.push(`  - ${lobby}`);
      entity = `entity: ${team.entity}\nlobby: ${lobby}\n`;
    }
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${team.project}
${entity}coordinator: ${team.coordinator}
operator: ${team.coordinator}
session: ${team.session}
trust:
${trust.join('\n')}
workspace:
  mode: shared
seats:
${team.seats.join('')}# These send scenes walk the typed trigger: the inbox is tried and skipped for want of a
# listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`);
    roots[name] = root;
  }
  return { base, home, roots };
}

/** One agent record, as `up`/`add` would have registered it. */
function registered(
  home: string,
  init: { name: string; role: string; cli: string; lab: string; team: string; seat: string; session: string; pane: string },
): Agent {
  return registerAgent(home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: init.lab,
    cli: init.cli,
    launcher: null,
    launch: `${init.cli} --model test`,
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

function teamRecord(
  home: string,
  id: string,
  team: { project: string; entity: string; session: string; root: string; roster: { agent: string; seat: string; role: string; leads: boolean }[] },
): void {
  upsertTeam(home, id, {
    project: team.project,
    entity: team.entity,
    session: team.session,
    root: team.root,
    lobby: lobbyDir(home),
    roster: team.roster,
    lifecycle: 'running',
  });
}

type Typed = { session: string; pane: string; text: string };
type Scripted = NativePane & { typed: Typed[]; enters: number };

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. The identity
 *  check binds a registered caller only where the state records it standing, so every registered
 *  caller in these scenes is placed here. */
function place(root: string, session: string, seat: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions[session] = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

/** Status samples, one per read: the pre-Enter read, then the polls. `wait` costs nothing. */
function scripted(samples: string[]): Scripted {
  const typed: Typed[] = [];
  let enters = 0;
  let read = 0;
  return {
    typed,
    get enters() {
      return enters;
    },
    typeText: (session, pane, text) => {
      typed.push({ session, pane, text });
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

/** The fake herdr of the send scenes: each seat's pane has its own scripted status, and a
 *  trigger typed into any other pane is not taken. The live name is the seat's own unless the
 *  scene keys two seats of one name in different sessions apart by a distinct key. */
function sendHost(world: SendWorld, seats: Record<string, { name?: string; session: string; pane: string; paneStatus: Scripted }>): SendHost & { typedInto: (pane: string) => Typed[] } {
  const byPane = new Map(Object.values(seats).map((seat) => [seat.pane, seat]));
  const bySession = new Map<string, { name: string; pane: string }[]>();
  for (const [key, seat] of Object.entries(seats)) {
    const list = bySession.get(seat.session) ?? [];
    list.push({ name: seat.name ?? key, pane: seat.pane });
    bySession.set(seat.session, list);
  }
  return {
    typedInto: (pane) => byPane.get(pane)?.paneStatus.typed ?? [],
    agents: (session) => bySession.get(session) ?? null,
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(world.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (session, pane, text) => byPane.get(pane)?.paneStatus.typeText(session, pane, text) ?? false,
      pressEnter: (session, pane) => byPane.get(pane)?.paneStatus.pressEnter(session, pane) ?? false,
      status: (session, pane) => byPane.get(pane)?.paneStatus.status(session, pane) ?? null,
      wait: async () => {},
    },
    now: () => NOW,
    home: world.home,
  };
}

/** The one drop in a seat's folder — the message the send wrote. The typed trigger is the
 *  seat's own receipt-writing read and names no path, so the folder is read, not the line. */
function soleDrop(root: string, session: string, seat: string): { path: string; text: string } {
  const dir = join(root, '.agents', 'send-drops', session, seat);
  const name = readdirSync(dir).find((one) => !one.includes('.'));
  if (name === undefined) throw new Error(`no drop was written in ${dir}`);
  const path = join(dir, name);
  return { path, text: readFileSync(path, 'utf8') };
}

// ---- the R4c delivery scenes: one fake CLI's box, drawn from the captured frames ----

const CLAUDE_CAPTURES = join(import.meta.dir, 'fixtures', 'claude-code', '2.1.289');

/** A captured frame, its CRLF folded to LF as the capture's README says. */
function captured(name: string): string {
  return readFileSync(join(CLAUDE_CAPTURES, name), 'utf8').replaceAll('\r\n', '\n');
}

// The prompt the capture draws: U+276F, then a U+00A0 gap.
const PROMPT = '❯ ';

/** One captured frame with its input row replaced. The row carries no styling: the captures'
 *  README records typed text as plain, and only a suggestion as faint. */
function inputRow(frame: string, row: string): string {
  const rows = frame.split('\n');
  const at = rows.findIndex((line) => line.startsWith(PROMPT));
  if (at < 0) throw new Error('the capture draws no input row');
  rows[at] = row;
  return rows.join('\n');
}

/** The trigger the delivery types. Short, so the captured narrow box draws it on one row. */
const DROP_LINE = 'Read /tmp/r5-drop.md and do that.';
const DELIVER_SESSION = 'alpha';
const DELIVER_PANE = 'w1:p1';
const DELIVER_PROFILE = 'claude-code';

const IDLE_SUGGESTION = captured('idle-suggestion-other-ansi.txt'); // faint `Resume briefly.`
const BOX_HOLDS_LINE = inputRow(captured('unsent-typed-ansi.txt'), PROMPT + DROP_LINE);
const BOX_EMPTY = inputRow(captured('unsent-typed-ansi.txt'), PROMPT); // after a turn: empty

type BoxCli = NativePane & { typed: Typed[]; enters: number; entersOnLine: boolean[] };

/** One fake CLI's pane: a box, a herdr status, and every key recorded. `swallow` counts the
 *  Enters the CLI takes without submitting (`Infinity` never submits); `after` is the frame it
 *  draws once it has taken a line — an empty box, or a fresh greyed suggestion. Each Enter is
 *  recorded with whether the box held team's own line when it went out. */
function boxCli(swallow: number, after: 'empty' | 'suggestion' = 'empty'): BoxCli {
  let status = 'idle';
  let held = false; // team's line sits in the box
  let taken = 0; // Enters the CLI swallowed
  const cli: BoxCli = {
    typed: [],
    enters: 0,
    entersOnLine: [],
    typeText: (session, pane, text) => {
      cli.typed.push({ session, pane, text });
      held = true;
      return true;
    },
    pressEnter: (session, pane) => {
      cli.enters += 1;
      cli.entersOnLine.push(held);
      if (held && taken < swallow) {
        taken += 1; // swallowed: the line stays in the box, the seat stays idle
        return true;
      }
      held = false;
      status = 'working';
      return true;
    },
    status: () => status,
    wait: async () => {},
    paneText: () => (held ? BOX_HOLDS_LINE : status === 'working' && after === 'empty' ? BOX_EMPTY : IDLE_SUGGESTION),
  };
  return cli;
}

describe('an agy seat sends to the main coordinator', () => {
  test('the drop record carries its agent id, and its headline the readable name, before the body', async () => {
    const world = sendWorld({
      floor: {
        project: 'floor',
        session: 's',
        coordinator: 'main-coordinator',
        seats: [seatBlock('coordinator', 'main-coordinator', 'claude-code', 'anthropic'), seatBlock('implementer', 'agy-seat', 'antigravity', 'google')],
      },
    });
    const root = world.roots.floor as string;
    const id = teamIdOf(root);
    // The agy seat has no SendMessage: its word reaches the coordinator on the drop channel.
    const agy = registered(world.home, { name: 'agy-seat', role: 'implementer', cli: 'antigravity', lab: 'google', team: id, seat: 'agy-seat', session: 's', pane: 'pane-agy' });
    const coordinator = registered(world.home, { name: 'main-coordinator', role: 'coordinator', cli: 'claude-code', lab: 'anthropic', team: id, seat: 'main-coordinator', session: 's', pane: 'pane-coordinator' });
    teamRecord(world.home, id, {
      project: 'floor',
      entity: 'floor',
      session: 's',
      root,
      roster: [
        { agent: agy.id, seat: 'agy-seat', role: 'implementer', leads: false },
        { agent: coordinator.id, seat: 'main-coordinator', role: 'coordinator', leads: true },
      ],
    });
    const coordPane = scripted(['idle', 'working']);
    place(root, 's', 'agy-seat', 'pane-agy');
    const host = sendHost(world, {
      'agy-seat': { session: 's', pane: 'pane-agy', paneStatus: scripted(['idle']) },
      'main-coordinator': { session: 's', pane: 'pane-coordinator', paneStatus: coordPane },
    });
    const caller: Caller = { kind: 'seat', name: 'agy-seat', pane: 'pane-agy', session: 's' };

    const code = await runSend(['main-coordinator@floor', BODY], testIo(root, caller), host);

    expect(code).toBe(0);
    expect(host.typedInto('pane-coordinator').length).toBe(1);
    const typed = host.typedInto('pane-coordinator')[0] as Typed;
    expect(typed.session).toBe('s');
    expect(typed.pane).toBe('pane-coordinator');
    // The trigger is the seat's own receipt-writing read, built from the receiver's seat and
    // session — the line that wakes it is the one that writes the signed read receipt.
    const line = readTriggerLine('main-coordinator', 's', { seat: 'agy-seat', team: 'floor', body: BODY });
    if (line === null) throw new Error('the trigger line did not fit');
    expect(typed.text).toBe(line);
    const drop = soleDrop(root, 's', 'main-coordinator');
    expect(AGENT_ID.test(agy.id)).toBe(true);
    // The registry id rides the signed payload's `from_id`; the headline a person reads names
    // the seat, and opens the body.
    expect(drop.text).toContain(agy.id);
    expect(drop.text).toContain(BODY);
    expect(drop.text.indexOf('from agy-seat — admitted by:')).toBeGreaterThanOrEqual(0);
    expect(drop.text.indexOf('from agy-seat — admitted by:')).toBeLessThan(drop.text.indexOf(BODY));
    const admitted = admitSend(agy, coordinator, readTeams(world.home));
    if (!admitted.ok) throw new Error(`the agy seat's send is not admitted: ${admitted.why}`);
    expect(drop.text).toContain(admitted.rule);
    const header = senderHeader(agy, admitted.rule);
    expect(header).toContain(agy.reach.seat);
    expect(header).not.toContain(agy.id);
    expect(header).toContain(admitted.rule);
  });
});

describe('an orchestrator reaches another team by name', () => {
  test('lead@beta resolves to beta\'s lead, and the drop lands there, never on alpha\'s own lead', async () => {
    const world = sendWorld({
      a: { project: 'alpha', entity: 'alpha-ent', session: 'alpha', coordinator: 'lead', seats: [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')] },
      b: { project: 'beta', entity: 'alpha-ent', session: 'beta', coordinator: 'lead', seats: [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')] },
    });
    const alphaRoot = world.roots.a as string;
    const betaRoot = world.roots.b as string;
    const alphaId = teamIdOf(alphaRoot);
    const betaId = teamIdOf(betaRoot);
    // Two teams of one entity, one seat name: a resolver that guesses within the caller's own
    // team is caught by the pane the trigger lands on.
    const alpha = registered(world.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', lab: 'anthropic', team: alphaId, seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const beta = registered(world.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', lab: 'anthropic', team: betaId, seat: 'lead', session: 'beta', pane: 'pane-beta-lead' });
    teamRecord(world.home, alphaId, { project: 'alpha', entity: 'alpha-ent', session: 'alpha', root: alphaRoot, roster: [{ agent: alpha.id, seat: 'lead', role: 'coordinator', leads: true }] });
    // The same entity: the lead pair the send rule reaches. Another entity's lead is refused.
    teamRecord(world.home, betaId, { project: 'beta', entity: 'alpha-ent', session: 'beta', root: betaRoot, roster: [{ agent: beta.id, seat: 'lead', role: 'coordinator', leads: true }] });
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-alpha-lead', session: 'alpha' };
    place(alphaRoot, 'alpha', 'lead', 'pane-alpha-lead');
    const io = testIo(alphaRoot, caller);
    const alphaPane = scripted(['idle']);
    const betaPane = scripted(['idle', 'working']);
    const host = sendHost(world, {
      'alpha-lead': { name: 'lead', session: 'alpha', pane: 'pane-alpha-lead', paneStatus: alphaPane },
      'beta-lead': { name: 'lead', session: 'beta', pane: 'pane-beta-lead', paneStatus: betaPane },
    });

    expect(findTeam(world.home, 'beta')?.root).toBe(betaRoot);
    const resolved = resolveTarget(world.home, 'lead@beta', io);
    if ('error' in resolved) throw new Error(`lead@beta did not resolve: ${resolved.error}`);
    expect(resolved.team.root).toBe(betaRoot);
    expect(resolved.team.session).toBe('beta');
    expect(resolved.agent.id).toBe(beta.id);
    expect(resolved.agent.reach.session).toBe('beta');
    expect(resolved.pane).toBe('pane-beta-lead');

    const code = await runSend(['lead@beta', BODY], io, host);

    expect(code).toBe(0);
    expect(alphaPane.typed).toEqual([]);
    expect(betaPane.typed.length).toBe(1);
    const typed = betaPane.typed[0] as Typed;
    expect(typed.session).toBe('beta');
    expect(typed.pane).toBe('pane-beta-lead');
    const line = readTriggerLine('lead', 'beta', { seat: 'lead', team: 'alpha', body: BODY });
    if (line === null) throw new Error('the trigger line did not fit');
    expect(typed.text).toBe(line);
    const drop = soleDrop(betaRoot, 'beta', 'lead');
    expect(drop.text).toContain(alpha.id);
    expect(drop.text).toContain(BODY);
    // Another team: the headline gives the sender's address, because a bare seat name would read
    // as the receiving team's own.
    expect(drop.text.indexOf('from lead@alpha — admitted by:')).toBeGreaterThanOrEqual(0);
    expect(drop.text.indexOf('from lead@alpha — admitted by:')).toBeLessThan(drop.text.indexOf(BODY));
    const admitted = admitSend(alpha, beta, readTeams(world.home));
    if (!admitted.ok) throw new Error(`orchestrator to orchestrator is not admitted: ${admitted.why}`);
    expect(drop.text).toContain(admitted.rule);
  });
});

// ---- the relaunch scene: the real `up`, a fake herdr, a temporary home ----

describe('a seat relaunch', () => {
  let base: string;
  let root: string;
  let dir: string;
  let home: string;
  let lobby: string;
  let file: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
    });
  }

  function worktreeTeamYaml(): string {
    return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
    cwd: .

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 1
`;
  }

  function approve(): void {
    const text = worktreeTeamYaml();
    writeFileSync(file, text);
    const loaded = loadTeamFile(root, { file, home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  }

  function doctor(): DoctorSources {
    return {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    };
  }

  function upSources(people: () => HerdrAgent[], live: boolean, from = 0): { sources: UpSources } {
    const panes = new Map<string, string>();
    let n = from;
    let clock = NOW.getTime();
    let session: 'absent' | 'running' = live ? 'running' : 'absent';
    // A pane this run creates shows the model the file declares for the seat it launches.
    const screen = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
    const launch: Launch = {
      sessionState: () => session,
      startServer() {
        session = 'running';
        return true;
      },
      sessionUp: () => session === 'running',
      createWorkspace(_session, _cwd, _label) {
        n += 1;
        const pane = `made-${n}`;
        panes.set(pane, screen);
        return { pane, workspace: `ws-${n}` };
      },
      paneRun(_session, pane) {
        panes.set(pane, screen);
        return true;
      },
      typeText: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...new Set([...people().map((agent) => agent.pane), ...panes.keys()])],
      agents: people,
      paneText: (_session, pane) => (panes.has(pane) ? screen : screen),
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => new Date(clock),
    };
    const sources: UpSources = {
      sessionRunning: () => session === 'running',
      sessionState: () => session,
      agents: people,
      home,
      doctor: doctor(),
      launch,
      now: () => new Date(clock),
    };
    return { sources };
  }

  function live(seat: { pane?: string; workspace?: string } | undefined, name: string): HerdrAgent {
    return { name, agent: 'claude-code', pane: seat?.pane ?? '', workspace: seat?.workspace ?? '', status: 'idle', cwd: root };
  }

  beforeEach(() => {
    base = tempBase('r5-acc-up-');
    root = join(base, 'acme');
    dir = join(root, '.agents');
    home = join(base, 'h');
    lobby = join(home, '.config', 'team', 'lobby');
    file = join(dir, 'team.yaml');
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(root, 'README.md'), 'acme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'first');
    approve();
  });

  test('keeps its agent id and re-points reach.pane to the pane it starts on', async () => {
    const first = upSources(() => [], false);
    const firstCode = await runUp([], testIo(root, OWNER), first.sources);
    expect(firstCode).toBe(0);
    const launched = readState(dir).sessions.alpha;
    const firstPane = launched?.seats.worker?.pane ?? '';
    expect(firstPane).not.toBe('');

    const id = teamIdOf(root);
    const before = findAgent(home, { team: id, seat: 'worker' });
    if (before === null) throw new Error('the first launch registered no agent for the worker seat');
    expect(AGENT_ID.test(before.id)).toBe(true);
    expect(before.reach.pane).toBe(firstPane);
    expect(before.reach.seat).toBe('worker');
    expect(before.reach.session).toBe('alpha');
    expect(before.lifecycle).toBe('running');
    expect(readTeams(home)[id]?.roster.some((row) => row.seat === 'worker' && row.agent === before.id)).toBe(true);

    // The worker's pane is gone; the next up starts it again, on a new one. The second run's
    // fake numbers its panes above the first run's, so the two are distinct strings.
    const again = upSources(() => [live(launched?.seats.lead, 'lead')], true, 10);
    const secondCode = await runUp([], testIo(root, OWNER), again.sources);
    expect(secondCode).toBe(0);
    const relaunched = readState(dir).sessions.alpha;
    const secondPane = relaunched?.seats.worker?.pane ?? '';
    expect(secondPane).not.toBe('');
    expect(secondPane).not.toBe(firstPane);

    const after = findAgent(home, { team: id, seat: 'worker' });
    expect(after?.id).toBe(before.id);
    expect(after?.reach.pane).toBe(secondPane);
    expect(readAgents(home).filter((agent) => agent.reach.seat === 'worker').length).toBe(1);
  });
});

describe('a CLI that swallows the first Enter', () => {
  test('is pressed again, and the delivery is verified', async () => {
    const cli = boxCli(1);
    const receipt = await deliverTrigger(bindPane(cli, DELIVER_SESSION), DELIVER_PANE, DROP_LINE, DELIVER_PROFILE);
    expect(receipt).toMatchObject({ outcome: 'delivered', tries: 2, status: 'working' });
    expect(cli.typed).toEqual([{ session: DELIVER_SESSION, pane: DELIVER_PANE, text: DROP_LINE }]);
    expect(cli.enters).toBe(2);
    // Both Enters went to the box while it still held team's own line: the second is the retry,
    // never an Enter into a dialog, an empty box, or text someone else left there.
    expect(cli.entersOnLine).toEqual([true, true]);
  });
});

describe('a CLI that never submits', () => {
  test('is not-submitted, with the box text, inside the try bound', async () => {
    const cli = boxCli(Infinity);
    const receipt = await deliverTrigger(bindPane(cli, DELIVER_SESSION), DELIVER_PANE, DROP_LINE, DELIVER_PROFILE);
    // Never a silent success: the receipt carries what the box holds.
    expect(receipt.outcome).toBe('not-submitted');
    expect(receipt.box).toBe(DROP_LINE);
    expect(receipt.tries).toBe(3); // the doc's bound
    expect(cli.enters).toBe(3); // and the loop stops there
    expect(cli.entersOnLine).toEqual([true, true, true]);
  });
});

describe('a box that shows a dim suggestion', () => {
  test('counts as empty, and no Enter goes out on it', async () => {
    // The captured frame greys `Resume briefly.` — a suggestion the profile's placeholder list
    // does not name, so only the faint styling (SGR 2) can make it read as empty (the capture's
    // README records exactly that pair: its plain read stays unsent). The same frame is drawn
    // again once the CLI has taken the line, so the scene has it both before the type and after.
    expect(IDLE_SUGGESTION).toContain('\u001b[2m');
    const cli = boxCli(0, 'suggestion');
    const receipt = await deliverTrigger(bindPane(cli, DELIVER_SESSION), DELIVER_PANE, DROP_LINE, DELIVER_PROFILE);
    expect(receipt).toMatchObject({ outcome: 'delivered', tries: 1 });
    // The suggestion was never text to hold on or submit: team typed its own line, and the one
    // Enter went to that line.
    expect(cli.typed.map((call) => call.text)).toEqual([DROP_LINE]);
    expect(cli.enters).toBe(1);
    expect(cli.entersOnLine).toEqual([true]);
  });
});
