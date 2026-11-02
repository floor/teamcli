// The team inbox at launch. A refused registration is retried once — a CLI's own add can fail
// transiently — and a refusal that stands leaves the seat out instead of launching it with no
// inbox. A registry-team launch names no file, so the registration resolves the registry; a file
// team's launch names the file it read. Synthetic folders and a fake host; no CLI, no herdr.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';

type Registration = { ok: true } | { ok: false; reason: string } | null;

function inboxHost(input: {
  register?: (cli: string, seat: string, cwd: string, session: string, teamFile?: string) => Registration;
  calls: string[];
  said: string[];
  logged: { who: string; what: string }[];
}): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: () => { input.calls.push('paneRun'); return true; },
    ...(input.register ? { registerInbox: input.register } : {}),
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
  test('a file team registers the launch file, for the launch session, before the launch command runs', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({
      calls, said, logged,
      register: (cli, seat, cwd, session, teamFile) => {
        calls.push(`register:${cli}:${seat}:${cwd}:${session}:${teamFile ?? 'none'}`);
        return { ok: true };
      },
    });
    await executePlan(steps('/project/.agents/team.yaml'), 'acme', host);
    expect(calls).toEqual(['register:cursor:coder:/seat/folder:acme:/project/.agents/team.yaml', 'paneRun']);
    expect(said.join('')).not.toContain('team inbox');
  });

  test('a registry launch passes no file: the registration resolves the registry for the session', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    const host = inboxHost({
      calls, said, logged,
      register: (cli, seat, cwd, session, teamFile) => {
        calls.push(`register:${cli}:${seat}:${cwd}:${session}:${teamFile ?? 'none'}`);
        return { ok: true };
      },
    });
    await executePlan(steps(), 'acme', host);
    expect(calls).toEqual(['register:cursor:coder:/seat/folder:acme:none', 'paneRun']);
  });

  test('a refusal is retried once, and a success on the retry launches the seat', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    let tries = 0;
    const host = inboxHost({
      calls, said, logged,
      register: () => (++tries === 1 ? { ok: false, reason: 'its project does not ignore .cursor/mcp.json' } : { ok: true }),
    });
    const report = await executePlan(steps(), 'acme', host);
    expect(tries).toBe(2);
    expect(calls).toEqual(['paneRun']);
    expect(report.dropped).toEqual([]);
    expect(said.join('')).not.toContain('team inbox');
    expect(logged).toEqual([{ who: 'coder', what: 'ready' }]);
  });

  test('a refusal that stands leaves the seat out, and its command never runs', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    let tries = 0;
    const host = inboxHost({
      calls, said, logged,
      register: () => {
        tries += 1;
        return { ok: false, reason: 'its project does not ignore .cursor/mcp.json' };
      },
    });
    const report = await executePlan(steps(), 'acme', host);
    expect(tries).toBe(2);
    expect(calls).toEqual([]);
    expect(report.dropped).toEqual(['coder']);
    expect(logged).toEqual([{ who: 'coder', what: 'left out: the team inbox was not registered: its project does not ignore .cursor/mcp.json' }]);
  });

  test('a profile with no file route registers nothing and launches', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const logged: { who: string; what: string }[] = [];
    let tries = 0;
    const host = inboxHost({ calls, said, logged, register: () => { tries += 1; return null; } });
    const report = await executePlan(steps(), 'acme', host);
    expect(tries).toBe(1);
    expect(calls).toEqual(['paneRun']);
    expect(report.dropped).toEqual([]);
    expect(said.join('')).not.toContain('team inbox');
  });
});
