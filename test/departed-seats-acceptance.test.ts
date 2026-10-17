// The departed-seats rule: a team's `.agents/team.state.json` can outlive the team file it was
// written for. It may still hold seats the file no longer declares — one of them claiming the
// very pane a declared seat stands on — and session entries the file no longer names. The file
// is the truth, in four places:
//
//   1. `team register`, `team up` and `team route` resolve who holds a pane from the file's
//      seats, not from the state's, so registering the declared seat on that pane succeeds;
//   2. `team check` names every state seat the file does not declare, with the pane it claims,
//      and every stale session;
//   3. a repair drops exactly those records, logs what it dropped, and leaves a declared seat's
//      record untouched — two records claiming one pane are told apart by the file, never by a
//      guess;
//   4. none of it depends on what herdr happens to be running: the state's own claims are the
//      subject, and a pane herdr no longer lists is still a pane the state claims.
//
// Every scene is a temporary home and root, with herdr's reads injected or stubbed and the
// caller pinned. The shape is the live failure's: a departed seat on the declared lead's own
// pane, a second departed seat on a pane of its own, and two sessions the file does not name.
// The names are synthetic and the panes neutral; nothing here reads a real session or home.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { check } from '../src/commands/check.ts';
import { loadConfig } from '../src/check/load.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runRoute } from '../src/commands/route.ts';
import type { SendHost } from '../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { NativePane } from '../src/send/native.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, liveAgentsOf, testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-10-17T13:00:00Z');
const SESSION = 'alpha';
const PANE = 'w1:p1';
const SECOND = 'w1:p2';
const OWNER: Caller = { kind: 'owner' };
/** The seats the file does not declare: one on the lead's own pane, one on a pane of its own. */
const DEPARTED = ['clerk', 'porter'] as const;
/** The session entries the file does not name. */
const STALE = ['bravo', 'charlie'] as const;

const made: string[] = [];
beforeEach(() => {
  // No pane of this machine's is behind a read a scene forgot to inject: an unreadable herdr
  // leaves it alone rather than reaching a real session.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string; sockets: string };

/** One machine: a checkout with its file, a temporary home with the machine lobby, and a socket
 *  folder nothing listens in. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ds-accept-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'team.yaml'), teamText(home, root));
  return { base, root, home, dir, sockets: join(base, 'sockets') };
}

/** The file: one declared lead seat, in the one session it names. */
function teamText(home: string, root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobbyDir(home)}
  - ${root}
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
    leads: true
`;
}

function fileOf(w: World): TeamFile {
  const loaded = validateTeamFile(readFileSync(join(w.dir, 'team.yaml'), 'utf8'));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

/** The state the live failure left behind. `ready` records the declared lead on its pane, as a
 *  launch leaves it; `absent` leaves it unrecorded, as a team whose lead is being registered for
 *  the first time. Either way the state still holds two seats the file does not declare — the
 *  first on the lead's own pane — and two session entries the file does not name. */
function seed(w: World, lead: 'ready' | 'absent'): void {
  updateState(w.dir, (state) => {
    const alpha = (state.sessions[SESSION] ??= emptySession());
    alpha.watch = { pid: 1, heartbeat: NOW.toISOString() };
    if (lead === 'ready') alpha.seats.lead = { stage: 'ready', pane: PANE, workspace: 'w1' };
    alpha.seats.clerk = { stage: 'ready', pane: PANE, workspace: 'w1' };
    alpha.seats.porter = { stage: 'ready', pane: SECOND, workspace: 'w2' };
    const bravo = (state.sessions.bravo ??= emptySession());
    bravo.seats['former-a'] = { stage: 'ready', pane: 'w9:p1', workspace: 'w9' };
    const charlie = (state.sessions.charlie ??= emptySession());
    charlie.seats['former-b'] = { stage: 'ready', pane: 'w9:p2', workspace: 'w9' };
  });
}

/** Herdr's reading of the file's session: the declared lead, idle on its pane, and nothing on
 *  the panes only the state's departed records claim — their panes are the state's subject. */
function liveOn(w: World): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: workspaceLabel(fileOf(w).seats[0]!) }],
    screens: { [PANE]: CLAUDE_IDLE },
  };
}

function checkSources(w: World, live: Live = liveOn(w)): CheckSources {
  return {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, w.home),
    now: () => NOW,
    home: w.home,
  };
}

function runCheck(w: World): { code: number; out: string; err: string } {
  const io = testIo(w.root, OWNER);
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, checkSources(w));
  return { code, out: io.out, err: io.err };
}

/** The check's report as findings: each `difference:` line with the `repair:` line under it. */
function findings(out: string): string[] {
  const lines = out.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.startsWith('difference:')) continue;
    blocks.push([lines[index]!, lines[index + 1] ?? ''].join('\n'));
  }
  return blocks;
}

describe('team check names the records the file no longer declares', () => {
  test('each departed state seat, with the pane it claims', () => {
    const w = world();
    seed(w, 'ready');

    const { code, out } = runCheck(w);

    const blocks = findings(out);
    const named = (name: string, pane: string): boolean =>
      blocks.some((block) => block.includes(name) && block.includes(pane) && block.includes('state seat not in the file'));
    expect(named('clerk', PANE), out).toBe(true);
    expect(named('porter', SECOND), out).toBe(true);
    // The declared lead stands on the same pane as the departed record, and is the file's: it is
    // never named as a state seat the file does not declare.
    expect(blocks.some((block) => block.includes('state seat not in the file') && block.includes('lead'))).toBe(false);
    expect(code).toBe(1);
  });

  test('each stale session, by name', () => {
    const w = world();
    seed(w, 'ready');

    const { code, out } = runCheck(w);

    const blocks = findings(out);
    for (const session of STALE) {
      expect(
        blocks.some((block) => block.includes(session) && /session/i.test(block)),
        out,
      ).toBe(true);
    }
    // The session the file names is the team's, not a stale one.
    expect(blocks.some((block) => block.includes(SESSION) && /stale/i.test(block))).toBe(false);
    expect(code).toBe(1);
  });

  test('a state with nothing the file left behind is not a difference', () => {
    const w = world();
    // The same world, with only the records the file declares: the finding is the departure, not
    // the state having records at all.
    updateState(w.dir, (state) => {
      const alpha = (state.sessions[SESSION] ??= emptySession());
      alpha.watch = { pid: 1, heartbeat: NOW.toISOString() };
      alpha.seats.lead = { stage: 'ready', pane: PANE, workspace: 'w1' };
    });

    const { code, out } = runCheck(w);

    expect(findings(out)).toEqual([]);
    expect(code).toBe(0);
  });
});

describe('the repair drops them, logs it, and leaves the declared seat alone', () => {
  test('two records claiming one pane are told apart by the file, never by a guess', async () => {
    const w = world();
    seed(w, 'ready');
    const before = readState(w.dir).sessions[SESSION]!.seats.lead;
    expect(before).toBeDefined();

    const io = testIo(w.root, OWNER);
    const code = await check(['--repair'], io, loadConfig, checkSources(w));

    // The repair ran: a usage or dispatch refusal is not one, whatever it printed.
    expect(code, `${io.out}${io.err}`).not.toBe(2);
    const state = readState(w.dir);
    // The stale sessions are gone, and the file's own session is not.
    expect(Object.keys(state.sessions)).toEqual([SESSION]);
    // The departed seats are gone; the declared lead, on the same pane as one of them, is not —
    // its record untouched, byte for byte.
    expect(Object.keys(state.sessions[SESSION]!.seats)).toEqual(['lead']);
    expect(state.sessions[SESSION]!.seats.lead).toEqual(before);
    // What was dropped was logged, by name.
    const log = readFileSync(join(w.dir, LOG_FILE), 'utf8');
    for (const name of [...DEPARTED, ...STALE]) expect(log).toContain(name);
  });
});

describe("team register resolves the pane from the file, not the state's departed seats", () => {
  test("registering the file's lead on the pane a departed record claims succeeds", async () => {
    const w = world();
    seed(w, 'absent');

    const io = testIo(w.root, OWNER);
    const code = await runRegister(['lead', '--pane', PANE], io, registerSources(w));

    // Nothing refused it: the pane is the file's lead's, whatever the state still records.
    expect(io.err, `${io.out}${io.err}`).toBe('');
    expect(code).toBe(0);
    expect(io.out).toContain(`lead: registered — pane ${PANE}`);
    // The record the run writes is the lead's, on that pane.
    expect(readState(w.dir).sessions[SESSION]?.seats.lead?.pane).toBe(PANE);
  });
});

describe('team up plans from the file, whatever the state still records', () => {
  test('a dry run with departed records present plans the declared seat and refuses nothing', async () => {
    const w = world();
    seed(w, 'ready');
    const team = fileOf(w);
    const before = JSON.stringify(readState(w.dir));
    const { sources: reads, trace } = upSources(w, team);
    const io = testIo(w.root, OWNER);

    const code = await runUp(['--dry-run'], io, reads);

    expect(code, `${io.out}${io.err}`).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('dry run: nothing was run');
    expect(io.out).not.toContain('! up would refuse:');
    // The departed seats are not the run's seats: neither is planned, resumed or named.
    expect(io.out).not.toContain('clerk');
    expect(io.out).not.toContain('porter');
    // A dry run makes nothing and writes nothing: the departed records are still there, untouched.
    expect(trace).toEqual({ workspaces: 0, closed: 0, starts: 0, typed: 0, renamed: 0 });
    expect(JSON.stringify(readState(w.dir))).toBe(before);
  });
});

describe('team route resolves the declared seat live, whatever the state still records', () => {
  test('a route to the declared lead is answered on the pane herdr names', async () => {
    const w = world();
    seed(w, 'ready');
    record(w);
    mkdirSync(w.sockets, { recursive: true });

    const io = testIo(w.root, OWNER);
    const code = await runRoute(['lead'], io, sendHost(w));

    expect(code, `${io.out}${io.err}`).toBe(0);
    expect(io.out).toContain(`pane ${PANE}`);
    expect(io.out).not.toContain('clerk');
    expect(io.out).not.toContain('porter');
  });
});

/** The register reads a scene replaces: herdr's session running, the declared lead's name on its
 *  pane, a CLI in front of the pane's shell, and its idle prompt. */
function registerSources(w: World): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [leadAgent()],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    refreshAddress: () => ({ address: null }),
    renameAgent: () => true,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
  };
}

function leadAgent(): HerdrAgent {
  return { name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null, session: 'claude-session-1' };
}

type Trace = { workspaces: number; closed: number; starts: number; typed: number; renamed: number };

/** The up run's reads: the file's one seat ready on its pane, a doctor that finds nothing, and a
 *  launch that records every effect it would make. A dry run may call none of them. */
function upSources(w: World, team: TeamFile): { sources: UpSources; trace: Trace } {
  const trace: Trace = { workspaces: 0, closed: 0, starts: 0, typed: 0, renamed: 0 };
  const agents: HerdrAgent[] = [leadAgent()];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer() {
      trace.starts += 1;
      return true;
    },
    sessionUp: () => true,
    createWorkspace() {
      trace.workspaces += 1;
      return null;
    },
    paneRun() {
      trace.starts += 1;
      return true;
    },
    renameAgent() {
      trace.renamed += 1;
      return true;
    },
    closeWorkspace() {
      trace.closed += 1;
      return true;
    },
    agentPanes: () => [PANE],
    agents: () => agents,
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    typeText() {
      trace.typed += 1;
      return true;
    },
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    trace,
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents,
      workspaces: () => [{ id: 'w1', label: workspaceLabel(team.seats[0]!) }],
      home: w.home,
      doctor: doctor(w),
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
  };
}

function doctor(w: World): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: w.home,
  };
}

/** The registry's record of the file's one seat, running on its pane. */
function record(w: World): Agent {
  const id = teamIdOf(w.root);
  const lead = registerAgent(w.home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: id, seat: 'lead', session: SESSION, pane: PANE, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(w.home, id, {
    project: 'acme',
    entity: 'acme',
    session: SESSION,
    root: w.root,
    lobby: lobbyDir(w.home),
    roster: [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  return lead;
}

/** The send host a route reads: herdr's live list from the registry, a pane process list, and a
 *  socket folder nothing listens in. Nothing is dialed. */
function sendHost(w: World): SendHost {
  return {
    agents: () => liveAgentsOf(w.home, SESSION),
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} } satisfies NativePane,
    now: () => NOW,
    home: w.home,
  };
}
