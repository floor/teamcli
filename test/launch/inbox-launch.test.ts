import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';

function inboxHost(input: {
  registerInbox?: (cli: string, seat: string, cwd: string, teamFile?: string) => { ok: true } | { ok: false; reason: string } | null;
  calls: string[];
  said: string[];
  logged: { who: string; what: string }[];
}): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: () => { input.calls.push('paneRun'); return true; },
    ...(input.registerInbox ? { registerInbox: input.registerInbox } : {}),
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

function steps(teamFile?: string): Step[] {
  return [
    { kind: 'run', argv: [], do: { do: 'launch', seat: 'coder', label: 'coder', command: 'cursor-agent', pane: 'p1', cli: 'cursor', cwd: '/seat/folder', ...(teamFile === undefined ? {} : { teamFile }) } },
    { kind: 'skip', text: 'ready', do: { do: 'record', seat: 'coder', record: { kind: 'ready' } } },
  ];
}

describe('the team inbox at launch', () => {
  test('it is registered in the seat folder, with the team file the run read, before the launch command runs', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({
      calls, said, logged,
      registerInbox: (cli, seat, cwd, teamFile) => { calls.push(`register:${cli}:${seat}:${cwd}:${teamFile ?? ''}`); return { ok: true }; },
    });
    await executePlan(steps('/project/.agents/team.yaml'), 'acme', host);
    expect(calls).toEqual(['register:cursor:coder:/seat/folder:/project/.agents/team.yaml', 'paneRun']);
    expect(said.join('')).not.toContain('team inbox');
  });

  test('a launch with no team file passes none: the registration reads the seat folder', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({
      calls, said, logged,
      registerInbox: (cli, seat, cwd, teamFile) => { calls.push(`register:${cli}:${seat}:${cwd}:${teamFile ?? 'none'}`); return { ok: true }; },
    });
    await executePlan(steps(), 'acme', host);
    expect(calls).toEqual(['register:cursor:coder:/seat/folder:none', 'paneRun']);
  });

  test('a refusal is detail under the seat record, and the seat still launches', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({
      calls, said, logged,
      registerInbox: () => ({ ok: false, reason: 'its project does not ignore .cursor/mcp.json' }),
    });
    await executePlan(steps(), 'acme', host);
    expect(calls).toEqual(['paneRun']);
    expect(said.join('')).toContain('coder: the team inbox was not registered: its project does not ignore .cursor/mcp.json');
    // The record is the seat's line; the refusal is stderr detail, not a second log line.
    expect(logged).toEqual([{ who: 'coder', what: 'ready' }]);
  });

  test('a profile with no file route registers nothing', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({ calls, said, logged, registerInbox: () => null });
    await executePlan(steps(), 'acme', host);
    expect(calls).toEqual(['paneRun']);
    expect(said.join('')).not.toContain('team inbox');
  });
});
