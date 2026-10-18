import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHerdrRun } from '../src/herdr.ts';
import { getAgent, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import {
  defaultSocketsDir,
  defaultSocketsDirAlt,
  defaultSocketsDirs,
  liveSocketOf,
  paneSocket,
  refreshAgentAddress,
  socketOfProcesses,
  socketPid,
} from '../src/send/address.ts';

let home: string;
let socks: string;
let altSocks: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-address-'));
  socks = mkdtempSync(join(tmpdir(), 'team-socks-'));
  altSocks = mkdtempSync(join(tmpdir(), 'team-socks-alt-'));
});
afterEach(() => {
  setHerdrRun(null);
  rmSync(home, { recursive: true, force: true });
  rmSync(socks, { recursive: true, force: true });
  rmSync(altSocks, { recursive: true, force: true });
});

// A socket the way a live session leaves one: the pid names the file.
function sock(pid: number, dir = socks): string {
  const path = join(dir, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

// A `pane process-info` result as herdr 0.7.1 reports it.
function processInfo(shell: number, foreground: number[]): unknown {
  return { process_info: { shell_pid: shell, foreground_processes: foreground.map((pid) => ({ pid })) } };
}

function init(overrides: Partial<AgentInit> = {}): AgentInit {
  return {
    name: 'Builder One',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
    ...overrides,
  };
}

describe('socketPid', () => {
  test('the pid a socket path is named by', () => {
    expect(socketPid(join(socks, '4321.sock'))).toBe(4321);
  });

  test('a path that is not <something>/<pid>.sock reads null', () => {
    expect(socketPid(join(socks, 'session.sock'))).toBeNull();
    expect(socketPid(join(socks, '4321.socket'))).toBeNull();
    expect(socketPid('/tmp/cc-socks/')).toBeNull();
  });

  test('nothing recorded reads null', () => {
    expect(socketPid(null)).toBeNull();
    expect(socketPid(undefined)).toBeNull();
    expect(socketPid('')).toBeNull();
  });
});

describe('socketOfProcesses', () => {
  test('the foreground pid with a socket wins over the shell', () => {
    const shell = sock(100);
    const foreground = sock(200);
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, socks)).toBe(foreground);
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, socks)).not.toBe(shell);
  });

  test('a foreground pid without a socket falls through to the next, then the shell', () => {
    const first = sock(101);
    const shell = sock(301);
    expect(socketOfProcesses({ shell: 301, foreground: [201, 101] }, socks)).toBe(first);
    expect(socketOfProcesses({ shell: 301, foreground: [201, 202] }, socks)).toBe(shell);
  });

  test('an unreadable pane and a pane with no socket both read null', () => {
    expect(socketOfProcesses(null, socks)).toBeNull();
    expect(socketOfProcesses(undefined, socks)).toBeNull();
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, socks)).toBeNull();
  });
});

describe('the two folders discovery walks', () => {
  test('a socket found only in the fallback folder is the pane\'s socket', () => {
    const live = sock(200, altSocks);
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, [socks, altSocks])).toBe(live);
  });

  test('pids are walked before folders: an earlier pid in the fallback beats a later one in the temp folder', () => {
    sock(100, socks);
    const earlier = sock(200, altSocks);
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, [socks, altSocks])).toBe(earlier);
  });

  test('the temp folder is tried before the fallback for one pid', () => {
    const first = sock(200, socks);
    sock(200, altSocks);
    expect(socketOfProcesses({ shell: 100, foreground: [200] }, [socks, altSocks])).toBe(first);
  });

  test('a stale record falls through to a socket only the fallback folder carries', () => {
    const recorded = sock(999);
    const fresh = sock(201, altSocks);
    expect(liveSocketOf(recorded, { shell: 100, foreground: [201] }, [socks, altSocks])).toBe(fresh);
  });

  test('a launch records a socket that sits only in the fallback folder', () => {
    const agent = registerAgent(home, init());
    const live = sock(200, altSocks);
    setHerdrRun(() => processInfo(100, [200]));
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, [socks, altSocks])).toEqual({ address: live });
    expect(getAgent(home, agent.id)?.reach.address).toBe(live);
  });

  test('a relaunch whose new socket sits only in the fallback folder replaces the old address', () => {
    const old = sock(400);
    const agent = registerAgent(home, init({ reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: old } }));
    const fresh = sock(200, altSocks);
    setHerdrRun(() => processInfo(100, [200]));
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, [socks, altSocks])).toEqual({ address: fresh });
    expect(getAgent(home, agent.id)?.reach.address).toBe(fresh);
  });
});

describe('liveSocketOf', () => {
  test('a recorded address still in the pane wins over rediscovery', () => {
    const recorded = sock(200);
    sock(100);
    expect(liveSocketOf(recorded, { shell: 300, foreground: [100, 200] }, socks)).toBe(recorded);
  });

  test('a recorded pid no longer in the pane is stale, and the pane answers', () => {
    const recorded = sock(999);
    const fresh = sock(201);
    expect(liveSocketOf(recorded, { shell: 100, foreground: [201] }, socks)).toBe(fresh);
  });

  test('a recorded pid still in the pane but with its socket gone is stale too', () => {
    const recorded = join(socks, '100.sock');
    const fresh = sock(201);
    expect(liveSocketOf(recorded, { shell: 100, foreground: [100, 201] }, socks)).toBe(fresh);
  });

  test('no recorded address, or no reading, leaves discovery', () => {
    sock(201);
    expect(liveSocketOf(null, { shell: 100, foreground: [201] }, socks)).toBe(join(socks, '201.sock'));
    expect(liveSocketOf(join(socks, '201.sock'), null, socks)).toBeNull();
  });
});

describe('paneSocket', () => {
  test('a pane reads through herdr to its live socket', () => {
    const live = sock(200);
    const asked: string[][] = [];
    setHerdrRun((args) => {
      asked.push(args);
      return processInfo(100, [200]);
    });
    expect(paneSocket('w1:p1', undefined, socks)).toBe(live);
    expect(asked).toEqual([['pane', 'process-info', '--pane', 'w1:p1']]);
  });

  test('a pane herdr cannot read has no socket', () => {
    setHerdrRun(() => {
      throw new Error('no such pane');
    });
    expect(paneSocket('w1:p9', undefined, socks)).toBeNull();
  });
});

describe('refreshAgentAddress', () => {
  test('a launch records the live socket on the agent', () => {
    const agent = registerAgent(home, init());
    const live = sock(200);
    setHerdrRun(() => processInfo(100, [200]));
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, socks)).toEqual({ address: live });
    expect(getAgent(home, agent.id)?.reach.address).toBe(live);
  });

  test('a relaunch with a new pid replaces the address the old one left', () => {
    const old = sock(400);
    const agent = registerAgent(home, init({ reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: old } }));
    const fresh = sock(200);
    setHerdrRun(() => processInfo(100, [200]));
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, socks)).toEqual({ address: fresh });
    expect(getAgent(home, agent.id)?.reach.address).toBe(fresh);
  });

  test('a relaunch whose pane carries no socket clears the stale address', () => {
    const old = sock(400);
    const agent = registerAgent(home, init({ reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: old } }));
    setHerdrRun(() => processInfo(100, [200]));
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, socks)).toEqual({ address: null });
    expect(getAgent(home, agent.id)?.reach.address).toBeNull();
  });

  test('a pane that cannot be read never clears what was recorded', () => {
    const recorded = sock(400);
    const agent = registerAgent(home, init({ reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: recorded } }));
    setHerdrRun(() => {
      throw new Error('herdr is down');
    });
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, socks)).toEqual({ address: recorded });
    expect(getAgent(home, agent.id)?.reach.address).toBe(recorded);
  });

  test('a seat that is not claude-code keeps its record, and herdr is not asked', () => {
    const recorded = sock(400);
    const agent = registerAgent(home, init({ cli: 'gemini', reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: recorded } }));
    const asked: string[][] = [];
    setHerdrRun((args) => {
      asked.push(args);
      return processInfo(100, [200]);
    });
    expect(refreshAgentAddress(home, agent.id, 'w36:p1', undefined, socks)).toEqual({ address: recorded });
    expect(asked).toEqual([]);
    expect(getAgent(home, agent.id)?.reach.address).toBe(recorded);
  });

  test('a launch with no pane yet keeps the record, and herdr is not asked', () => {
    const agent = registerAgent(home, init());
    const asked: string[][] = [];
    setHerdrRun((args) => {
      asked.push(args);
      return processInfo(100, [200]);
    });
    expect(refreshAgentAddress(home, agent.id, null, undefined, socks)).toEqual({ address: null });
    expect(asked).toEqual([]);
  });

  test('an unknown id reads a null address and never throws', () => {
    expect(refreshAgentAddress(home, 'agt_000000000000', 'w36:p1', undefined, socks)).toEqual({ address: null });
    expect(refreshAgentAddress(home, 'not-an-id', 'w36:p1', undefined, socks)).toEqual({ address: null });
  });
});

describe('defaultSocketsDir', () => {
  test('the real folder is the runtime temp folder\'s cc-socks', () => {
    expect(defaultSocketsDir()).toBe(join(tmpdir(), 'cc-socks'));
  });
});

describe('defaultSocketsDirs', () => {
  test('the temp folder\'s own and the fallback the sessions were seen in, each once', () => {
    const dirs = defaultSocketsDirs();
    expect(dirs[0]).toBe(defaultSocketsDir());
    expect(dirs).toContain('/tmp/cc-socks');
    expect(dirs).toContain(defaultSocketsDirAlt());
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
