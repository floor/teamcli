// What a launch does with the plan's endpoint intent: it starts (or reuses) the endpoint in the
// state folder the plan carried, appends `--remote <url>` only once one exists, and says why in
// one line when none does — the seat then launches on the line it had. A pane that never ran
// must not leave a server this run started behind: only a fresh start is stopped, and a stop
// that cannot prove ownership is said, never forced. Reused endpoints belong to the seat's
// earlier launch and are left alone.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import type { EndpointStopRead, ManagedEndpointRead } from '../../src/launch/codex-endpoint.ts';

const STATE_DIR = '/tmp/acme/.agents';
const URL = 'unix:///tmp/acme/.agents/presence/scratch/coder/ab12cd34ef56.sock';

type Seen = { dir: string; session: string; seat: string; cwd?: string; config?: string[]; pane?: string };

function launchStep(codexEndpoint?: { dir: string }): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch',
        seat: 'coder',
        label: 'coder',
        command: 'codex',
        pane: 'p1',
        cli: 'codex',
        cwd: '/seat/folder',
        ...(codexEndpoint === undefined ? {} : { codexEndpoint }),
      },
    },
    // The seat's record ends it, which is when the lines held for it are said.
    { kind: 'skip', text: 'ready', do: { do: 'record', seat: 'coder', record: { kind: 'ready' } } },
  ];
}

function hostOf(input: {
  calls: string[];
  said: string[];
  logged: { who: string; what: string }[];
  managed?: (seen: Seen) => ManagedEndpointRead;
  stop?: () => EndpointStopRead;
  paneRan?: boolean;
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
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { input.said.push(line); },
    log: (who, what) => { input.logged.push({ who, what }); },
  };
}

describe('the launch and the managed Codex endpoint', () => {
  test('an endpoint that came up is attached to the line, from the folder the plan carried', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    let seen: Seen | undefined;
    const host = hostOf({
      calls, said, logged,
      managed: (input) => { seen = input; return { kind: 'up', url: URL, started: true }; },
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    // A bare line names no config of its own: the endpoint gets the profile's feature pins.
    expect(seen).toEqual({ dir: STATE_DIR, session: 'acme', seat: 'coder', cwd: '/seat/folder', config: [
      '-c', 'features.computer_use=false', '-c', 'features.browser_use=false',
        '-c', 'features.browser_use_external=false', '-c', 'features.in_app_browser=false', '-c', 'features.browser_use_full_cdp_access=false', '-c', 'mcp_servers.cua_repl.command=/usr/bin/false', '-c', 'mcp_servers.cua_repl.enabled=false', '-c', 'mcp_servers.node_repl.command=/usr/bin/false', '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'plugins.computer-use@openai-bundled.enabled=false', '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false', '-c', 'plugins.browser@openai-bundled.enabled=false',
    ], pane: 'p1' });
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`]);
    expect(said.join('')).not.toContain('managed Codex endpoint');
  });

  test('a host that starts no endpoint leaves the seat out and says so once', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({ calls, said, logged: [] });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual([]);
    expect(said.join('')).toContain('coder: left out: the managed Codex endpoint was not started: this launch starts no managed Codex endpoint');
  });

  test('a refusal is one line under the seat, and the seat is left out', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({
      calls, said, logged: [],
      managed: () => ({ kind: 'unmanaged', why: 'the seat records no valid presence binding' }),
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed']);
    expect(said.join('')).toContain('coder: left out: the managed Codex endpoint was not started: the seat records no valid presence binding');
  });

  test('notes from the start are said under the seat', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({
      calls, said, logged: [],
      managed: () => ({ kind: 'up', url: URL, started: true, notes: ['the previous endpoint was left alone: it did not serve this seat'] }),
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(said.join('')).toContain('coder: the previous endpoint was left alone: it did not serve this seat');
  });

  test('a pane that never ran stops the endpoint this launch started', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({
      calls, said, logged: [],
      managed: () => ({ kind: 'up', url: URL, started: true }),
      stop: () => ({ stopped: true }),
      paneRan: false,
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`, 'stop']);
    expect(said.join('')).toContain('its launch command did not run (the terminal host did not take the line in pane p1); left at launched');
  });

  test('a pane that never ran leaves a reused endpoint alone: it is not this launch’s to stop', async () => {
    const calls: string[] = [];
    const host = hostOf({
      calls, said: [], logged: [],
      managed: () => ({ kind: 'up', url: URL, started: false }),
      stop: () => ({ stopped: true }),
      paneRan: false,
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`]);
  });

  test('a cleanup that could not prove ownership is said, not forced', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({
      calls, said, logged: [],
      managed: () => ({ kind: 'up', url: URL, started: true }),
      stop: () => ({ stopped: false, why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled' }),
      paneRan: false,
    });
    await executePlan(launchStep({ dir: STATE_DIR }), 'acme', host);
    expect(calls).toEqual(['managed', `paneRun:codex --remote ${URL}`, 'stop']);
    expect(said.join('')).toContain('coder: the recorded process cannot be proven to serve this endpoint; it was not signalled');
  });

  test('a line the plan did not mark is never started, attached, or cleaned up', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const host = hostOf({
      calls, said, logged: [],
      managed: () => ({ kind: 'up', url: URL, started: true }),
      stop: () => ({ stopped: true }),
      paneRan: false,
    });
    await executePlan(launchStep(), 'acme', host);
    expect(calls).toEqual(['paneRun:codex --no-daemon']);
    expect(said.join('')).not.toContain('managed Codex endpoint');
  });
});
