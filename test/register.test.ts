// `team register`'s acceptance scenes (its own design note): a seat herdr already runs is
// adopted where it stands, never relaunched.
//
// (a) a running seat is registered: the state, the registry record and the pane pointer are
//     written, the pane both now name is herdr's own reading of the live pane, and the process
//     identity, agent session and live session socket are exactly that reading;
// (b) the run only reads beyond the two sidebar writes: every source this file injects is a
//     read, and the interface's write channels — the seat's herdr title and display
//     (`test/register-label.test.ts` holds their scenes) — are injected here as noops that
//     record nothing, so "nothing was launched" is what the scene is built on, and every call
//     taken is on the pane herdr named;
// (c) registers herdr does not place as that seat are refused, and nothing at all is written:
//     no agent of the name in the session, two agents of the name, a pane holding a shell, a
//     pane whose foreground process is not the one the file's `cli` names, a screen the
//     file-cli's reader does not know, and a pane another seat's record already holds, whether
//     `--pane` named it or herdr did;
// (d) the run is repeatable: the second run says `already registered` and writes the registry
//     record again from the file, re-reading the pane's live CLI — a pane whose CLI exited or
//     was replaced is refused, never re-recorded as running — while its screen is not read
//     again; `--dry-run` writes nothing.
// Fake herdr throughout, a temporary home and a pinned caller: no live session is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { AGENT_ID_PATTERN, findAgent, readAgents } from '../src/registry/agents.ts';
import { readTeams, teamIdOf } from '../src/registry/teams.ts';
import { defaultSocketsDir } from '../src/send/address.ts';
import { emptySession, LOG_FILE, mintSeatId, readState, SEAT_ID_PATTERN, STATE_FILE, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T21:00:00Z');
const OWNER = { kind: 'owner' as const };
// The pane the fake herdr places the seat in, and the pointer the run writes for it.
const PANE = 'w1:p1';
const WORKSPACE = 'ws-1';

const made: string[] = [];
// The address refresh reads herdr on its own; no pane of this machine's is behind it here, and
// an unreadable pane is the reading that leaves a record alone.
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; dir: string };

/** A temporary home and one root with `.agents/team.yaml` — the shape `team register` reads. */
function world(cli = 'claude-code'): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-acc-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
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
  - role: coordinator
    name: lead
    label: lead
    cli: ${cli}
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  return { base, home, root, dir: join(root, '.agents') };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null, session: 'claude-session-1' };
}

/** Herdr's `pane process-info`, faked: the pane's shell and the programs in front of it, with
 *  the calls recorded so a scene can show what the address refresh read, and when. */
function herdrPane(pids: { shell: number; foreground: number[] }, calls: string[] = []): string[] {
  setHerdrRun((args, session) => {
    calls.push(`${session ?? '-'} ${args.join(' ')}`);
    return { process_info: { shell_pid: pids.shell, foreground_processes: pids.foreground.map((pid) => ({ pid })) } };
  });
  return calls;
}

type Ledger = string[];

/** Every herdr read `register` makes, recorded: the scene can show what was read and on which
 *  pane, and the interface offers nothing else that could reach a pane. */
function sources(w: World, led: Ledger = [], over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: (session) => {
      led.push(`session ${session}`);
      return 'running';
    },
    agents: (session) => {
      led.push(`agents ${session}`);
      return [agent('lead')];
    },
    processInfo: (session, pane) => {
      led.push(`processes ${session} ${pane}`);
      return { shell: 400, foreground: [401] };
    },
    foreground: (session, pane) => {
      led.push(`foreground ${session} ${pane}`);
      return ['claude'];
    },
    paneText: (session, pane) => {
      led.push(`text ${session} ${pane}`);
      return CLAUDE_IDLE;
    },
    // The two sidebar writes (`test/register-label.test.ts` holds their scenes): noops that
    // record nothing, so a scene's ledger stays reads alone.
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
    ...over,
  };
}

async function register(
  w: World,
  argv: string[],
  over: Partial<RegisterSources> = {},
): Promise<{ code: number; out: string; err: string; led: Ledger }> {
  const io = testIo(w.root, OWNER);
  const led: Ledger = [];
  const code = await runRegister(argv, io, sources(w, led, over));
  return { code, out: io.out, err: io.err, led };
}

/** What the run left on disk: the state file, agent records, the log and the pane pointers. */
function written(w: World): { state: boolean; agents: number; log: boolean; panes: boolean } {
  return {
    state: existsSync(join(w.dir, STATE_FILE)),
    agents: readAgents(w.home).length,
    log: existsSync(join(w.dir, LOG_FILE)),
    panes: existsSync(join(w.home, '.config', 'team', 'panes')),
  };
}

const NOTHING = { state: false, agents: 0, log: false, panes: false };

function panesDir(w: World): string {
  return join(w.home, '.config', 'team', 'panes');
}

describe('a running seat', () => {
  test('is registered where it stands, on the pane herdr names, and only that pane is read', async () => {
    const w = world();
    const r = await register(w, ['lead']);

    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w1:p1; nothing was launched');
    // The whole verification, and nothing else: reads of the session, its agents and the one
    // pane herdr named the seat on — no second pane, and no call anything like a write.
    expect(r.led).toEqual(['session acme', 'agents acme', 'processes acme w1:p1', 'foreground acme w1:p1', 'text acme w1:p1']);

    const held = readState(w.dir).sessions.acme?.seats.lead;
    expect(held?.stage).toBe('ready');
    expect(held?.pane).toBe(PANE);
    expect(held?.workspace).toBe(WORKSPACE);
    expect(held?.cli).toBe('claude-code');
    expect(held?.id).toMatch(SEAT_ID_PATTERN);
    expect(held?.last_active).toBe(NOW.toISOString());
    // The pane's own reading, recorded as it was: the shell in front of which the cli runs, and
    // the cli's pid. Unchanged is the point — an adoption reads, it does not restart.
    expect(held?.launched).toEqual({ shell: 400, cli: [401] });
    expect(held?.agent_session).toBe('claude-session-1');
    // Only a launch can know these: an adoption must not invent them.
    expect(held?.model).toBeUndefined();
    expect(held?.version).toBeUndefined();
    expect(held?.effort).toBeUndefined();
    expect(held?.launch_line).toBeUndefined();

    const record = findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' });
    expect(record?.id).toMatch(AGENT_ID_PATTERN);
    expect(record?.seat_handle).toBe(held?.id);
    expect(record?.reach.pane).toBe(PANE);
    expect(record?.reach.session).toBe('acme');
    expect(record?.lifecycle).toBe('running');
    expect(record?.cli).toBe('claude-code');
    expect(record?.launch).toContain('claude --model claude-opus-5-5');

    const roster = readTeams(w.home)[teamIdOf(w.root)]?.roster ?? [];
    expect(roster).toHaveLength(1);
    expect(roster[0]?.agent).toBe(record?.id);
    expect(roster[0]?.seat).toBe('lead');
    expect(roster[0]?.role).toBe('coordinator');

    expect(written(w)).toEqual({ state: true, agents: 1, log: true, panes: true });
    const log = readFileSync(join(w.dir, LOG_FILE), 'utf8');
    expect(log).toContain('lead: registered seat_');
    expect(log).toContain(PANE);

    // The pointer `team send` resolves the team file from: written for this session and pane,
    // naming the file that registered it.
    const panes = readdirSync(panesDir(w));
    expect(panes).toHaveLength(1);
    expect(readFileSync(join(panesDir(w), panes[0]!), 'utf8').trim()).toBe(join(w.root, '.agents', 'team.yaml'));
  });

  test('a seat registering under the caller override records itself as `by`, not the unplaceable walk', async () => {
    // The acceptance shape: the session's state already records the seat on its pane, the registry
    // holds no agent record of it yet, and the run is the seat's own — started inside herdr, where
    // `walkCaller` stops at the server and places nobody. The admission is judged on the session
    // placement; the registry's provenance must say the seat, not the walk's reading.
    const w = world();
    const id = mintSeatId();
    updateState(w.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { id, stage: 'ready', pane: PANE, workspace: WORKSPACE, cli: 'claude-code' };
    });
    const io = testIo(w.root);
    // Dev mode on, so the record carries the override's own mark too: both provenance fields are
    // written from the same `by`, and the scene shows both name the seat.
    io.env.TEAMCLI_DEV_MODE = '1';
    io.callerSources = (asked?: string) => {
      const placed = asked === undefined || asked === 'acme';
      return {
        ancestors: () => [{ pid: 700, name: 'node' }, { pid: 600, name: 'herdr' }],
        agents: () => (placed ? [agent('lead')] : []),
        paneRootPid: (pane: string) => (placed && pane === PANE ? 700 : null),
        env: io.env,
        stdinIsTTY: false,
      };
    };

    const code = await runRegister(['lead'], io, sources(w));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain('lead: already registered — pane w1:p1');
    const record = findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' });
    expect(record).toBeDefined();
    expect(record?.provenance.registered_by).toBe('lead');
    expect(record?.provenance.dev_mode_by).toBe('lead');
  });

  test('records the pane\'s live session socket, read again after the write', async () => {
    const w = world();
    // A pid no pane of this machine runs, and one file standing in for its socket. The folder is
    // the runtime temp one the address rule names — never a live session's own, and the file is
    // gone again either way.
    const pid = 99991;
    const dir = defaultSocketsDir();
    const socket = join(dir, `${String(pid)}.sock`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(socket, '');
    const calls = herdrPane({ shell: 400, foreground: [pid] });

    try {
      const r = await register(w, ['lead']);

      expect(r.code).toBe(0);
      // The record a launch would have written carries the socket the seat answers at.
      const record = findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' });
      expect(record?.reach.address).toBe(socket);
      // The pane read the way a launch reads it, after the record itself was written.
      expect(calls).toEqual(['acme pane process-info --pane w1:p1']);
    } finally {
      rmSync(socket, { force: true });
    }
  });

  test('registered twice: the second run refreshes the record, re-reads the CLI and not the screen', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const before = readState(w.dir).sessions.acme?.seats.lead;

    const second = await register(w, ['lead'], {
      paneText: () => {
        throw new Error('the screen must not be read again');
      },
    });

    expect(second.code).toBe(0);
    expect(second.out).toContain('lead: already registered — pane w1:p1; the record was refreshed from the file, nothing relaunched');
    // The pane is re-read for the process in front of its shell and the CLI it runs — a pane
    // whose CLI left is not the seat — and not for its screen: the dialog wait is not repeated.
    expect(second.led).toEqual(['session acme', 'agents acme', 'processes acme w1:p1', 'foreground acme w1:p1']);
    expect(readState(w.dir).sessions.acme?.seats.lead).toEqual(before);
    expect(readAgents(w.home)).toHaveLength(1);
  });

  test('a pane whose CLI exited is refused, not re-recorded as running', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const state = readFileSync(join(w.dir, STATE_FILE), 'utf8');

    const second = await register(w, ['lead'], { processInfo: () => ({ shell: 400, foreground: [] }) });

    expect(second.code).toBe(1);
    expect(second.err).toContain('lead: pane w1:p1 holds no process in front of its shell; nothing was registered');
    // The ready record stands exactly as the launch wrote it: nothing was refreshed.
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(state);
  });

  test('a pane whose CLI was replaced is refused, not re-recorded as the seat', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);

    const second = await register(w, ['lead'], { foreground: () => ['codex'] });

    expect(second.code).toBe(1);
    expect(second.err).toContain('lead: pane w1:p1 holds no `claude-code` process; nothing was registered');
    expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
  });

  test('--dry-run verifies the pane the same way and writes nothing', async () => {
    const w = world();
    const r = await register(w, ['lead', '--dry-run']);

    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: would register — pane w1:p1; nothing would be launched');
    expect(r.led).toEqual(['session acme', 'agents acme', 'processes acme w1:p1', 'foreground acme w1:p1', 'text acme w1:p1']);
    expect(written(w)).toEqual(NOTHING);
  });
});

describe('a pane herdr does not place as that seat', () => {
  test('is refused when herdr names no agent of the seat in the session', async () => {
    const w = world();
    const r = await register(w, ['lead'], { agents: () => [] });

    expect(r.code).toBe(1);
    expect(r.err).toContain('no agent named lead is running in session "acme"; nothing was registered');
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when herdr names two agents of the seat: registering one would guess', async () => {
    const w = world();
    const r = await register(w, ['lead'], { agents: () => [agent('lead'), agent('lead')] });

    expect(r.code).toBe(1);
    expect(r.err).toContain('2 agents named lead; registering one would guess');
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when the pane holds a shell and no cli in front of it', async () => {
    const w = world();
    const r = await register(w, ['lead'], { processInfo: () => ({ shell: 400, foreground: [] }) });

    expect(r.code).toBe(1);
    expect(r.err).toContain('holds no process in front of its shell; nothing was registered');
    expect(written(w)).toEqual(NOTHING);
  });
});

describe('a pane another seat of the session holds', () => {
  test('is refused on a run without --pane: one pane is one seat\'s', async () => {
    const w = world();
    // The file declares the seat whose record holds the pane: herdr answers to `lead` on it — a
    // pane renamed in herdr while the other seat's record stayed. Recording it here would hold
    // one pane for two seats. (A record for a seat the file does NOT declare holds nothing: the
    // file is the truth, and `test/state-departed-seats.test.ts` reads that side.)
    const file = join(w.dir, 'team.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
    updateState(w.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: PANE };
    });

    const r = await register(w, ['lead']);

    expect(r.code).toBe(1);
    expect(r.err).toContain("pane w1:p1 is worker's in session \"acme\"; nothing was registered");
    expect(readState(w.dir).sessions.acme?.seats.lead).toBeUndefined();
    expect(readAgents(w.home)).toHaveLength(0);
  });
});

describe('a cli mismatch', () => {
  test('is refused when the pane runs a program the file-cli does not name', async () => {
    const w = world();
    const seen: string[] = [];
    const r = await register(w, ['lead'], {
      foreground: (session, pane) => {
        seen.push(`foreground ${session} ${pane}`);
        return ['codex'];
      },
      paneText: () => {
        throw new Error('the screen must not be read');
      },
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain('holds no `claude-code` process; nothing was registered');
    // The refusal lands on the pane herdr named, before the screen is read: a pane running
    // another cli is not read as this seat at all.
    expect(seen).toEqual(['foreground acme w1:p1']);
    expect(written(w)).toEqual(NOTHING);

    // An unreadable foreground list is the same refusal, not a pass.
    const blind = await register(w, ['lead'], {
      foreground: () => null,
      paneText: () => {
        throw new Error('the screen must not be read');
      },
    });
    expect(blind.code).toBe(1);
    expect(blind.err).toContain('holds no `claude-code` process; nothing was registered');
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when the screen is one the file-cli\'s own reader does not know', async () => {
    const w = world();
    const r = await register(w, ['lead'], { paneText: () => '$ ls -la\ntotal 0\n$ ' });

    expect(r.code).toBe(1);
    expect(r.err).toContain('not the seat at its prompt (unknown); nothing was registered');
    expect(written(w)).toEqual(NOTHING);
  });
});
