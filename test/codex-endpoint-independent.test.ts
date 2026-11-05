// Independent coverage for the managed Codex endpoint's launch and delivery contract.
//
// Three doors, each read without the lane's own fixtures: the launch executor never launches a
// marked seat after a start that did not come up (and never appends --no-daemon to it), a blocked
// send tells the lead in the same call with one signed drop and keeps the seat's own drop, and
// team check names exactly the ready Codex seats whose policy would manage an endpoint and whose
// record is absent or unusable.
//
// Every world is synthetic: a scratch team, a scratch state, a scratch home. The send scenes dial
// a socket path that does not exist, so no real Codex binary is spawned and no Codex config
// folder is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { approvalStanding } from '../src/store/store.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { entitiesPath } from '../src/entities.ts';
import { inspectRecordedCodexEndpoint, readRecordedCodexEndpoint } from '../src/daemon/presence/endpoint-record.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { managedCodexLaunch, type Step } from '../src/launch/plan.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { signedRecordOf, verifyRecord } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T04:00:00.000Z');
const SESSION = 'acme';
const SEAT = 'pilot';
const LEAD = 'chief';
const BINDING = 'prs_0123456789ab';
const THREAD_ID = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const MESSAGE_ID = '11111111-2222-4333-8444-555555555555';
const ASK_ID = '22222222-3333-4444-8555-666666666666';
const REPLY_ID = '33333333-4444-4555-8666-777777777777';
const SEGMENT_PIN = 'prs_0123456789ab';

const liveDirs: string[] = [];
afterEach(() => {
  for (const base of liveDirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- launch executor

const STATE_DIR = '/tmp/acme/.agents';
const URL = 'unix:///tmp/acme/.agents/presence/scratch/coder/ab12cd34ef56.sock';

function launchSteps(endpoint?: { dir: string }, command = 'codex'): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch',
        seat: 'coder',
        label: 'coder',
        command,
        pane: 'p1',
        cli: 'codex',
        cwd: '/seat/folder',
        ...(endpoint === undefined ? {} : { codexEndpoint: endpoint }),
      },
    },
    { kind: 'skip', text: 'ready', do: { do: 'record', seat: 'coder', record: { kind: 'ready' } } },
  ];
}

type Seen = { dir: string; session: string; seat: string; cwd?: string; config?: string[]; pane?: string };

function launchHost(input: {
  calls: string[];
  said: string[];
  managed?: (seen: Seen) => import('../src/launch/codex-endpoint.ts').ManagedEndpointRead;
  stop?: () => import('../src/launch/codex-endpoint.ts').EndpointStopRead;
  paneRan?: boolean;
  records?: string[];
}): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: (_session, _pane, command) => {
      input.calls.push(`paneRun:${command}`);
      return input.paneRan ?? true;
    },
    ...(input.managed === undefined
      ? {}
      : {
          managedCodexEndpoint: async (seen: Seen) => {
            input.calls.push('managed');
            return input.managed!(seen);
          },
        }),
    ...(input.stop === undefined
      ? {}
      : {
          stopManagedCodexEndpoint: () => {
            input.calls.push('stop');
            return input.stop!();
          },
        }),
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [],
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (seat: string) => { input.records?.push(seat); },
    running: () => {},
    drop: () => {},
    say: (line) => { input.said.push(line); },
    log: () => {},
  };
}

describe('a marked managed launch never runs without its endpoint', () => {
  test('a start that does not come up leaves the seat out, types nothing, and does not record it ready', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const records: string[] = [];
    const host = launchHost({
      calls, said, records,
      managed: () => ({ kind: 'unmanaged', why: 'the seat records no valid presence binding' }),
    });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed']);
    expect(said.join('')).toContain('coder: left out: the managed Codex endpoint was not started: the seat records no valid presence binding');
    expect(said.join('')).not.toContain('--no-daemon');
    expect(records).toEqual([]);
  });

  test('a host with no endpoint start leaves the seat out before anything is typed', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = launchHost({ calls, said });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual([]);
    expect(said.join('')).toContain('coder: left out: the managed Codex endpoint was not started: this launch starts no managed Codex endpoint');
  });

  test('a line the plan did not mark keeps its own unmanaged fallback', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = launchHost({ calls, said });
    await executePlan(launchSteps(), 'acme', host);
    expect(calls).toEqual(['paneRun:codex --no-daemon']);
    expect(said.join('')).not.toContain('managed Codex endpoint');
  });

  test('an endpoint that came up is attached by exactly its URL, with no daemon flag', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    let seen: Seen | undefined;
    const host = launchHost({
      calls, said,
      managed: (input) => { seen = input; return { kind: 'up', url: URL, started: true }; },
    });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(seen).toEqual({ dir: STATE_DIR, session: 'acme', seat: 'coder', cwd: '/seat/folder', config: [], pane: 'p1' });
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`]);
    expect(calls[1]).not.toContain('--no-daemon');
    expect(said.join('')).not.toContain('left out');
  });

  test('a URL that needs quoting stays one shell word', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const url = "unix:///tmp/a b;touch pwned.sock";
    const host = launchHost({
      calls, said,
      managed: () => ({ kind: 'up', url, started: true }),
    });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', "paneRun:codex --remote 'unix:///tmp/a b;touch pwned.sock'"]);
  });

  test('a pane that never ran stops only the endpoint this launch started', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = launchHost({
      calls, said,
      managed: () => ({ kind: 'up', url: URL, started: true }),
      stop: () => ({ stopped: true }),
      paneRan: false,
    });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`, 'stop']);
    expect(said.join('')).toContain('its launch command did not run; left at launched');
  });

  test('a pane that never ran leaves a reused endpoint alone', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = launchHost({
      calls, said,
      managed: () => ({ kind: 'up', url: URL, started: false }),
      stop: () => ({ stopped: true }),
      paneRan: false,
    });
    await executePlan(launchSteps({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`]);
    expect(said.join('')).not.toContain('not signalled');
  });
});

describe('the endpoint record door refuses anything a launch did not write', () => {
  const record = {
    url: URL,
    binding: BINDING,
    pid: 4242,
    started_at: '2026-10-20T03:59:00.000Z',
  };

  test('a record for the seat’s own binding is the only usable one', () => {
    expect(readRecordedCodexEndpoint(record, BINDING)?.url).toBe(URL);
    expect(inspectRecordedCodexEndpoint(record, 'prs_000000000001')).toEqual({
      kind: 'invalid',
      why: 'the endpoint record names another presence binding',
    });
    expect(inspectRecordedCodexEndpoint(record, undefined).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint(undefined, BINDING)).toEqual({ kind: 'absent' });
  });

  test('a URL, pid or start instant this build could not have written is not a record', () => {
    expect(inspectRecordedCodexEndpoint({ ...record, url: 'http://socket' }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint({ ...record, url: 'unix://relative.sock' }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint({ ...record, url: `unix:///tmp/a\u0001b.sock` }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint({ ...record, pid: 0 }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint({ ...record, pid: 4.5 }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint({ ...record, started_at: 'yesterday' }, BINDING).kind).toBe('invalid');
    expect(inspectRecordedCodexEndpoint([], BINDING).kind).toBe('invalid');
  });

  test('only a line that would start a managed endpoint now can trigger a relaunch', () => {
    const base = {
      cli: 'codex',
      binary: 'codex',
      codexDaemon: 'on' as const,
      stateDir: STATE_DIR,
      launch: 'codex -m gpt-6',
      command: 'codex -m gpt-6',
    };
    expect(managedCodexLaunch(base)).toBe(true);
    expect(managedCodexLaunch({ ...base, command: 'codex -m gpt-6 --no-daemon' })).toBe(false);
    expect(managedCodexLaunch({ ...base, command: 'codex -m gpt-6 --remote=unix:///tmp/x.sock' })).toBe(false);
    expect(managedCodexLaunch({ ...base, command: 'codex -m gpt-6 --remote unix:///tmp/x.sock' })).toBe(false);
    expect(managedCodexLaunch({ ...base, cli: 'claude-code' })).toBe(false);
    expect(managedCodexLaunch({ ...base, codexDaemon: 'off' })).toBe(false);
    expect(managedCodexLaunch({ ...base, stateDir: undefined })).toBe(false);
    expect(managedCodexLaunch({ ...base, launch: '/usr/local/bin/codex -m gpt-6', command: 'codex -m gpt-6' })).toBe(false);
  });
});

// ---------------------------------------------------------------- send

type World = {
  base: string;
  root: string;
  dir: string;
  home: string;
  typed: string[];
};

function world(name: string, options: { record?: 'missing' | 'other-binding' | 'absent' | 'live' } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `codex-endpoint-${name}-`)));
  liveDirs.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const lobby = resolveLobby(home, { entity: 'floor' });
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(join(dirnameOf(entitiesPath(home))), { recursive: true });
  writeFileSync(entitiesPath(home), `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
entity: floor
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${LEAD}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
delivery_order: [native, drop]
`,
  );
  updateState(dir, (state) => {
    const record = {
      url: 'unix://' + join(dir, 'state', 'missing-app-server.sock'),
      binding: options.record === 'other-binding' ? 'prs_000000000001' : BINDING,
      pid: 4242,
      started_at: '2026-10-20T03:59:00.000Z',
    };
    state.sessions[SESSION] = {
      seats: {
        [SEAT]: {
          id: 'seat_123456789abc',
          stage: 'ready',
          pane: 'pane-2',
          agent_session: THREAD_ID,
          presence_binding: BINDING,
          ...(options.record === 'absent' ? {} : { codex_endpoint: record }),
        },
      },
      worktrees: {},
    };
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      agent_session: THREAD_ID,
      pane: 'pane-2',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  return { base, root, dir, home, typed: [] };
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function sendHost(at: World): SendHost {
  return {
    agents: () => [{ name: SEAT, pane: 'pane-2', cli: 'codex' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: at.base,
    deliver: async () => ({ ok: false, reason: 'unused' }),
    native: {
      typeText: (_session, _pane, text) => {
        at.typed.push(text);
        return true;
      },
      pressEnter: () => false,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
    },
    now: () => NOW,
    home: at.home,
    sendId: () => MESSAGE_ID,
    inboxGraceMs: 0,
  };
}

function lastHistory(at: World): Record<string, unknown> {
  const history = readHistory('acme', at.root, at.home);
  if (!history.ok) throw new Error('the history could not be read');
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) throw new Error('no history entry');
  return entry as unknown as Record<string, unknown>;
}

describe('a blocked send says so once and tells the lead with one signed drop', () => {
  test('the notice is signed, carries no message body, and lands in the lead’s own drop folder', async () => {
    const at = world('blocked');
    const io = testIo(at.root, { kind: 'owner' });
    const code = await runSend([SEAT, 'hello there'], io, sendHost(at));
    expect(code).toBe(0);

    const dropDir = join(at.dir, 'send-drops', SESSION, SEAT);
    expect(existsSync(join(dropDir, MESSAGE_ID))).toBe(true);
    expect(at.typed).toEqual([]);
    expect(lastHistory(at).outcome).toBe('queued, not woken');
    expect(lastHistory(at).via).toBe('drop');

    const blocked = `${SEAT}: blocked, its Codex endpoint is not listening;`;
    expect(io.out).toContain(blocked);
    expect(io.out).toContain('not listening (ENOENT)');
    expect(io.out).not.toContain('woken');

    const leadDir = join(at.dir, 'send-drops', SESSION, LEAD);
    const names = readdirSync(leadDir);
    expect(names.length).toBe(1);
    expect(statSync(leadDir).mode & 0o777).toBe(0o700);
    const leadPath = join(leadDir, names[0]!);
    expect(statSync(leadPath).mode & 0o777).toBe(0o600);
    expect(basename(leadPath)).toBe(names[0]!);

    const lead = recordAt(leadPath);
    expect(verifyRecord(lead, messageKeyOf(at.home))).toBe(true);
    expect(lead.payload.kind).toBe('message');
    expect(lead.payload.to).toBe(LEAD);
    expect(lead.payload.to_id).toBeNull();
    expect(lead.payload.from).toBe('runtime');
    expect(lead.payload.from_id).toBeNull();
    expect(lead.payload.root).toBe(realpathSync(at.root));
    expect(lead.payload.session).toBe(SESSION);
    expect(lead.payload.rule).toBe("the team's unread-message report");
    expect(lead.payload.thread).toBe(lead.payload.id);
    expect(lead.payload.body).toContain(blocked);
    expect(lead.payload.body).toContain('team up restores the endpoint (');
    expect(lead.payload.body).not.toContain('hello there');
    expect(lead.payload.body).not.toContain(MESSAGE_ID);
  });

  test('a record that is unusable for another reason is a plain fallback, not a blocked notice', async () => {
    const at = world('other-binding', { record: 'other-binding' });
    const io = testIo(at.root, { kind: 'owner' });
    const code = await runSend([SEAT, 'hello there'], io, sendHost(at));
    expect(code).toBe(0);
    expect(io.out).not.toContain('blocked');
    expect(lastHistory(at).outcome).toBe('queued, not woken');
    expect(existsSync(join(at.dir, 'send-drops', SESSION, LEAD))).toBe(false);
    expect(at.typed).toEqual([]);
  });

  test('a managed seat with no record at all is a plain fallback, not a blocked notice', async () => {
    const at = world('absent', { record: 'absent' });
    const io = testIo(at.root, { kind: 'owner' });
    const code = await runSend([SEAT, 'hello there'], io, sendHost(at));
    expect(code).toBe(0);
    expect(io.out).not.toContain('blocked');
    expect(lastHistory(at).outcome).toBe('queued, not woken');
    expect(existsSync(join(at.dir, 'send-drops', SESSION, LEAD))).toBe(false);
    expect(at.typed).toEqual([]);
  });
});

// ---------------------------------------------------------------- a blocked reply

/** One question from the Codex seat into the owner's own folder: the record a reply answers. */
function ask(at: World): void {
  plantRecord(at.home, at.root, SESSION, 'owner', ASK_ID, 'a question from the seat', {
    from: SEAT,
    at: NOW.toISOString(),
  });
}

async function reply(at: World): Promise<{ code: number; out: string }> {
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runReply([ASK_ID, 'the answer'], io, {
    home: at.home,
    now: () => NOW,
    newId: () => REPLY_ID,
    send: sendHost(at),
  });
  return { code, out: io.out };
}

describe('a reply to a blocked Codex seat says so and tells the lead, exactly as a send does', () => {
  test('the socket is missing: blocked line, signed lead notice, the drop kept, nothing typed', async () => {
    const at = world('reply-blocked');
    ask(at);
    const { code, out } = await reply(at);

    expect(code).toBe(0);
    const blocked = `${SEAT}: blocked, its Codex endpoint is not listening;`;
    expect(out).toContain(blocked);
    expect(out).toContain('codex app-server control socket is not listening (ENOENT)');
    // The blocked line is the reply's own summary: the plain drop ending is not printed too.
    expect(out).not.toContain('delivered (drop)');

    // The answer's own record stays the mailbox copy, and no wake was typed into any pane.
    expect(existsSync(join(at.dir, 'send-drops', SESSION, SEAT, REPLY_ID))).toBe(true);
    expect(at.typed).toEqual([]);
    expect(lastHistory(at).outcome).toBe('queued, not woken');
    expect(lastHistory(at).via).toBe('drop');

    // The lead gets one signed runtime record holding the blocked line, not the answer.
    const leadDir = join(at.dir, 'send-drops', SESSION, LEAD);
    const names = readdirSync(leadDir);
    expect(names.length).toBe(1);
    expect(statSync(leadDir).mode & 0o777).toBe(0o700);
    const leadPath = join(leadDir, names[0]!);
    expect(statSync(leadPath).mode & 0o777).toBe(0o600);
    const lead = recordAt(leadPath);
    expect(verifyRecord(lead, messageKeyOf(at.home))).toBe(true);
    expect(lead.payload.from).toBe('runtime');
    expect(lead.payload.from_id).toBeNull();
    expect(lead.payload.to).toBe(LEAD);
    expect(lead.payload.to_id).toBeNull();
    expect(lead.payload.thread).toBe(lead.payload.id);
    expect(lead.payload.body).toContain(blocked);
    expect(lead.payload.body).not.toContain('the answer');
    expect(lead.payload.body).not.toContain(REPLY_ID);
  });

  test('another binding or no record at all is a plain fallback, never a blocked notice', async () => {
    for (const [name, record] of [['reply-other-binding', 'other-binding'], ['reply-absent', 'absent']] as const) {
      const at = world(name, { record });
      ask(at);
      const { code, out } = await reply(at);
      expect(code).toBe(0);
      expect(out).not.toContain('blocked');
      expect(existsSync(join(at.dir, 'send-drops', SESSION, LEAD))).toBe(false);
      expect(at.typed).toEqual([]);
      expect(lastHistory(at).outcome).toBe('delivered');
      expect(lastHistory(at).via).toBe('drop');
    }
  });
});

// ---------------------------------------------------------------- team check

describe('team check names only the ready Codex seats a managed endpoint should cover', () => {
  const READY = { stage: 'ready' as const, pane: 'pane-x', workspace: 'ws-1' };

  function checkWorld(): { root: string; home: string; seats: string[] } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-endpoint-check-')));
    liveDirs.push(base);
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(
      join(root, '.agents/team.yaml'),
      `format: 1
project: acme
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: pilot
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
  - role: implementer
    name: scout
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
  - role: implementer
    name: herald
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol --no-daemon
  - role: implementer
    name: courier
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol --remote unix:///tmp/x.sock
  - role: implementer
    name: idle
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
    stopped: true
  - role: implementer
    name: guest
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
    human: true
  - role: implementer
    name: arriving
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
`,
    );
    updateState(join(root, '.agents'), (state) => {
      state.sessions[SESSION] = {
        seats: {
          [LEAD]: { stage: 'ready', pane: 'pane-0', workspace: 'ws-1' },
          pilot: { ...READY, pane: 'pane-1' },
          scout: {
            ...READY,
            pane: 'pane-2',
            presence_binding: BINDING,
            codex_endpoint: { url: 'unix:///tmp/scout.sock', binding: 'prs_000000000001', pid: 4242, started_at: NOW.toISOString() },
          },
          herald: { ...READY, pane: 'pane-3', launch_line: 'codex -m gpt-6-sol --no-daemon' },
          courier: { ...READY, pane: 'pane-4' },
          idle: { ...READY, pane: 'pane-5' },
          guest: { ...READY, pane: 'pane-6' },
          arriving: {
            stage: 'launched',
            pane: 'pane-7',
            workspace: 'ws-1',
            presence_binding: BINDING,
            codex_endpoint: { url: 'unix:///tmp/arriving.sock', binding: BINDING, pid: 4243, started_at: NOW.toISOString() },
          },
        },
        worktrees: {},
      };
    });
    return { root, home, seats: [LEAD, 'pilot', 'scout', 'herald', 'courier', 'idle', 'guest', 'arriving'] };
  }

  function liveRead(seats: readonly string[]): Live {
    return {
      running: true,
      agents: seats.map((name, at) => ({ name, agent: name === LEAD ? 'claude' : 'codex', pane: `pane-${String(at)}`, workspace: 'ws-1', status: 'idle', cwd: null })),
      workspaces: [{ id: 'ws-1', label: 'acme' }],
      screens: {},
    };
  }

  test('absent and unusable seats are named once; an unmanaged, stopped, human or not-ready seat is not', () => {
    const { root, home, seats } = checkWorld();
    const io = testIo(root, { kind: 'owner' });
    runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => liveRead(seats),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      sockets: join(root, 'sockets'),
    });
    const text = `${io.out}\n${io.err}`;
    expect(text).toContain('no usable Codex endpoint record: pilot (absent), scout (unusable); team up restores the endpoint');
    expect(text).not.toContain('herald (');
    expect(text).not.toContain('courier (');
    expect(text).not.toContain('idle (');
    expect(text).not.toContain('guest (');
    expect(text).not.toContain('arriving (');
  });
});
