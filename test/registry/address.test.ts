// A Claude Code seat's address: the socket its session listens on, recorded on the agent record
// so a later send can reach the live session without re-reading herdr.
//
// (a) the address is the socket the `send` rule has always walked: the pane's own pids,
//     foreground first, then the shell; the pid in the path's own name is what tells a recorded
//     address from a stale one, since a relaunch replaces the process;
// (b) a refresh records the pane's live socket when the recorded pid no longer runs in the pane,
//     or its socket is gone — and only then: a pane herdr cannot answer for, a null pane, a seat
//     that is not claude-code, and an unknown agent all leave the registry exactly as it was;
// (c) a refresh moves nothing but the address: the record keeps its id, reach and provenance;
// (d) every reading answers null rather than guessing — nothing here throws.
// Herdr is faked and the sockets live in a temporary folder: no live session is read, and no
// socket of the machine's own is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHerdrRun } from '../../src/herdr.ts';
import { AGENT_ID_PATTERN, getAgent, readAgents, recordAgentAddress, registerAgent } from '../../src/registry/agents.ts';
import {
  defaultSocketsDir,
  liveSocketOf,
  paneSocket,
  refreshAgentAddress,
  socketPid,
  socketOfProcesses,
} from '../../src/send/address.ts';

const HOME = join('/tmp', 'nowhere');
const PANE = 'w1:p1';
const SESSION = 'acme';

const made: string[] = [];
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary home and a sockets folder of its own — never the machine's real one. */
function world(): { home: string; dir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'addr-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const dir = join(base, 'socks');
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

/** A socket on disk, stood in for by an empty file: every check here is `existsSync` on the path. */
function sock(dir: string, pid: number): string {
  const path = join(dir, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

/** Herdr's `pane process-info`, faked: the pane's shell and the programs in front of it. The calls
 *  are recorded so a scene can show which pane was read, and that a scene read none at all. */
function herdrAnswers(pids: { shell: number; foreground: number[] }, calls: string[] = []): string[] {
  setHerdrRun((args, session) => {
    calls.push(`${session ?? '-'} ${args.join(' ')}`);
    return { process_info: { shell_pid: pids.shell, foreground_processes: pids.foreground.map((pid) => ({ pid })) } };
  });
  return calls;
}

/** A record of the shape a launch writes, with the address under test. */
function agent(home: string, over: { cli?: string; address?: string | null } = {}): string {
  const record = registerAgent(home, {
    name: 'lead',
    signing: { model: 'DeepSeek V4.1 Flash', version: '0.4.0', role: 'coordinator' },
    lab: 'anthropic',
    cli: over.cli ?? 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: 'tm_acme', seat: 'lead', session: SESSION, pane: PANE, address: over.address ?? null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'lead',
  });
  expect(record.id).toMatch(AGENT_ID_PATTERN);
  return record.id;
}

describe('the socket rule', () => {
  test('takes the first foreground pid with a socket, then the shell', () => {
    const { dir } = world();
    const shell = sock(dir, 400);
    expect(socketOfProcesses({ shell: 400, foreground: [401, 402] }, dir)).toBe(shell);

    const second = sock(dir, 402);
    expect(socketOfProcesses({ shell: 400, foreground: [401, 402] }, dir)).toBe(second);

    const first = sock(dir, 401);
    expect(socketOfProcesses({ shell: 400, foreground: [401, 402] }, dir)).toBe(first);
    // A pid named twice is one candidate, and an unreadable pane is no candidate at all.
    expect(socketOfProcesses({ shell: 401, foreground: [401] }, dir)).toBe(first);
    expect(socketOfProcesses(null, dir)).toBeNull();
  });

  test('no socket on disk is no address, not a guess', () => {
    const { dir } = world();
    expect(socketOfProcesses({ shell: 400, foreground: [401] }, dir)).toBeNull();
  });

  test('reads the pid the path is named by, and only that', () => {
    expect(socketPid('/tmp/cc-socks/1234.sock')).toBe(1234);
    expect(socketPid(`${HOME}/x.sock`)).toBeNull();
    expect(socketPid('/tmp/cc-socks/1234.sock.bak')).toBeNull();
    expect(socketPid(null)).toBeNull();
    // The folder a session's socket lives in, as this build computes it.
    expect(defaultSocketsDir()).toBe(join(tmpdir(), 'cc-socks'));
  });
});

describe('a recorded address', () => {
  test('is used while its pid still runs in the pane and its socket is still there', () => {
    const { dir } = world();
    const held = sock(dir, 401);
    const newer = sock(dir, 402);
    // The recorded one wins even beside a younger socket: a send addresses it as recorded.
    expect(liveSocketOf(held, { shell: 400, foreground: [401, 402] }, dir)).toBe(held);
    // Stale by pid — the relaunch case, the old socket file still on disk.
    expect(liveSocketOf(newer, { shell: 400, foreground: [401] }, dir)).toBe(held);
    // Stale by its own socket being gone though the pid runs.
    expect(liveSocketOf(join(dir, '400.sock'), { shell: 400, foreground: [401] }, dir)).toBe(held);
    // A reading that never happened resolves nothing: the caller falls back to discovery.
    expect(liveSocketOf(held, null, dir)).toBeNull();
  });

  test('is recorded at launch from the pane herdr names it on', () => {
    const w = world();
    const id = agent(w.home);
    const live = sock(w.dir, 401);
    const calls = herdrAnswers({ shell: 400, foreground: [401] });

    const r = refreshAgentAddress(w.home, id, PANE, SESSION, w.dir);

    expect(r.address).toBe(live);
    expect(r.note).toBeUndefined();
    expect(getAgent(w.home, id)?.reach.address).toBe(live);
    // The pane and the session the seat runs under, and nothing else, were read.
    expect(calls).toEqual([`${SESSION} pane process-info --pane ${PANE}`]);
  });

  test('is refreshed when the pid it names no longer runs in the pane', () => {
    const w = world();
    const before = sock(w.dir, 401);
    const id = agent(w.home, { address: before });
    const after = sock(w.dir, 500);
    herdrAnswers({ shell: 400, foreground: [500] });

    const r = refreshAgentAddress(w.home, id, PANE, SESSION, w.dir);

    expect(r.address).toBe(after);
    // Only the address moved: the id, the reach and the launched line are the record's own.
    const held = getAgent(w.home, id);
    expect(held?.id).toBe(id);
    expect(held?.reach).toEqual({ team: 'tm_acme', seat: 'lead', session: SESSION, pane: PANE, address: after });
    expect(held?.launch).toContain('claude --model claude-opus-5-5');
    expect(held?.name).toBe('lead');
    expect(readdirSync(join(w.home, '.config', 'team', 'agents'))).toHaveLength(1);
  });

  test('is refreshed when its own socket is gone though the pid still runs', () => {
    const w = world();
    const id = agent(w.home, { address: join(w.dir, '401.sock') });
    const shell = sock(w.dir, 400);
    herdrAnswers({ shell: 400, foreground: [401] });

    expect(refreshAgentAddress(w.home, id, PANE, SESSION, w.dir).address).toBe(shell);
  });

  test('is left untouched when the pane cannot be read', () => {
    const w = world();
    const held = sock(w.dir, 401);
    const id = agent(w.home, { address: held });
    // Herdr answers, but with nothing that names a process: not a change, so not a write.
    let asked = 0;
    setHerdrRun(() => {
      asked += 1;
      return {};
    });

    const r = refreshAgentAddress(w.home, id, PANE, SESSION, w.dir);

    expect(r.address).toBe(held);
    expect(asked).toBe(1);
    expect(getAgent(w.home, id)?.reach.address).toBe(held);
  });

  test('is left untouched for a null pane or a seat that is not claude-code, unread', () => {
    const w = world();
    const held = sock(w.dir, 401);
    const claude = agent(w.home, { address: held });
    const codex = agent(w.home, { cli: 'codex', address: null });
    let asked = 0;
    setHerdrRun(() => {
      asked += 1;
      return {};
    });

    expect(refreshAgentAddress(w.home, claude, null, SESSION, w.dir)).toEqual({ address: held });
    expect(refreshAgentAddress(w.home, codex, 'w9:p9', SESSION, w.dir)).toEqual({ address: null });
    // Neither pane was read at all: the rule is decided before herdr is asked.
    expect(asked).toBe(0);
    expect(getAgent(w.home, claude)?.reach.address).toBe(held);
  });

  test('is not written for an agent the registry does not hold', () => {
    const w = world();
    const missing = `agt_${'0'.repeat(12)}`;
    herdrAnswers({ shell: 400, foreground: [401] });

    expect(refreshAgentAddress(w.home, missing, PANE, SESSION, w.dir)).toEqual({ address: null });
    expect(readAgents(w.home)).toHaveLength(0);
  });

  test('is cleared, not kept, when the pid relaunched away and the pane holds no socket', () => {
    const w = world();
    // The old socket file is still on disk, but its pid is no longer the pane's, and the pane
    // itself offers none: a readable pane with no live socket is no address, not a stale one.
    const id = agent(w.home, { address: sock(w.dir, 401) });
    herdrAnswers({ shell: 400, foreground: [500] });

    expect(refreshAgentAddress(w.home, id, PANE, SESSION, w.dir).address).toBeNull();
    expect(getAgent(w.home, id)?.reach.address).toBeNull();
  });
});

describe('the record itself', () => {
  test('is set and cleared by the writer, and nothing else on it moves', () => {
    const w = world();
    const id = agent(w.home);
    const live = join(w.dir, '401.sock');

    const set = recordAgentAddress(w.home, id, live);
    expect(set.reach.address).toBe(live);
    expect(set.id).toBe(id);
    expect(set.lifecycle).toBe('running');
    expect(getAgent(w.home, id)?.reach.pane).toBe(PANE);

    expect(recordAgentAddress(w.home, id, null).reach.address).toBeNull();
  });

  test('reads a pane through herdr, and answers null when it cannot', () => {
    const w = world();
    const live = sock(w.dir, 401);
    herdrAnswers({ shell: 400, foreground: [401] });
    expect(paneSocket(PANE, SESSION, w.dir)).toBe(live);

    setHerdrRun(() => {
      throw new Error('herdr is not there');
    });
    expect(paneSocket(PANE, SESSION, w.dir)).toBeNull();
  });
});
