// One terminal-host snapshot per hosted request (src/host/run.ts): the admission's placement and
// the line's own reads ask the caller's server once, whether a read names its session or reaches
// it through the pane's socket hint. A read of another session is its own, and the next request
// reads afresh. Fake herdr answers only: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeHerdrSnapshotId, agentList, beginHerdrSnapshot, endHerdrSnapshot, paneProcessInfo, paneRootPid, setHerdrRun } from '../../src/herdr.ts';
import { runHostedLine, type HostRequest } from '../../src/host/run.ts';
import type { Io } from '../../src/io.ts';

const vars = process.env;
const home = vars.HOME !== undefined && vars.HOME !== '' ? vars.HOME : homedir();
const SOCKET = join(home, '.config', 'herdr', 'sessions', 'acme', 'herdr.sock');

let calls: string[] = [];
function fakeHerdr(): void {
  calls = [];
  setHerdrRun((args, session) => {
    calls.push(`${session ?? ''}:${args.slice(0, 2).join(' ')}`);
    if (args[0] === 'agent') return { agents: [{ name: 'builder', pane_id: 'w1:p1', agent: 'claude', workspace_id: 'w1', agent_status: 'idle' }] };
    if (args[0] === 'pane') return { process_info: { shell_pid: 101, foreground_processes: [{ pid: 102, argv0: 'claude' }] } };
    return null;
  });
}

afterEach(() => {
  setHerdrRun(null);
});

/** The environment the pane hands its processes: the socket of its own session, no other config folder. */
function hintedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) if (value !== undefined && key !== 'XDG_CONFIG_HOME') env[key] = value;
  env.HERDR_SOCKET_PATH = SOCKET;
  env.HERDR_PANE_ID = 'w1:p1';
  return env;
}

// The admission reads through the terminal host, as the process's own sources do.
const sources: Io['callerSources'] = (session) => ({
  ancestors: () => [{ pid: 102, name: 'claude' }, { pid: 101, name: 'zsh' }, { pid: 100, name: 'herdr' }],
  agents: () => agentList(session),
  paneRootPid: (pane) => paneRootPid(pane, session),
  env: { HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: SOCKET },
  stdinIsTTY: false,
});

const peer = { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid };

function request(env: Record<string, string>): HostRequest {
  return { v: 1, build: 'test', argv: ['send', 'lead', 'hi'], cwd: process.cwd(), env, tty: { stdin: false, stdout: false, stderr: false } };
}

describe('one snapshot per hosted request', () => {
  test('the admission and the line read the caller\'s own server once; another session is its own read', async () => {
    fakeHerdr();
    const env = hintedEnv();
    let inside: number | null = null;
    const run = () => runHostedLine(request(env), peer, {
      cliEntry: 'cli.js',
      ownEnv: env,
      callerSources: sources,
      main: async () => {
        // The command's own snapshot joins the request's, as runSend's does.
        inside = beginHerdrSnapshot();
        try {
          agentList('acme');
          paneProcessInfo('w1:p1', 'acme');
          agentList('other');
        } finally {
          endHerdrSnapshot(inside);
        }
        return 0;
      },
    });
    const result = await run();
    expect(result.answer).toMatchObject({ kind: 'ran', code: 0 });
    expect(result.recycle).toBeNull();
    expect(inside).toBeNull();
    expect(calls).toEqual([':agent list', ':pane process-info', 'other:agent list']);
    expect(activeHerdrSnapshotId()).toBeNull();
    // The next request reads afresh.
    await run();
    expect(calls).toHaveLength(6);
  });

  test('outside a hint the unnamed read and the named one stay apart', () => {
    fakeHerdr();
    const saved = vars.HERDR_SOCKET_PATH;
    delete vars.HERDR_SOCKET_PATH;
    const id = beginHerdrSnapshot();
    try {
      agentList();
      agentList('acme');
      agentList('acme');
    } finally {
      endHerdrSnapshot(id);
      if (saved === undefined) delete vars.HERDR_SOCKET_PATH;
      else vars.HERDR_SOCKET_PATH = saved;
    }
    expect(calls).toEqual([':agent list', 'acme:agent list']);
  });
});
