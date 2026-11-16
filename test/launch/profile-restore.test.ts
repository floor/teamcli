// Three restart paths seen on 2026-11-16, after the machine restarted. Synthetic frames and
// readings only: no CLI is started, no herdr session is touched.
//   1. Codex's "open in another app" notice on a resume of the seat's own conversation
//      (src/launch/another-app.ts, the idle wait in src/launch/execute.ts).
//   2. A Jules pane herdr does not list as an agent, named after the pane is declared one
//      (the rename step in src/launch/execute.ts).
//   3. A wait recorded at a provider error that the pane has since left (src/status/compare.ts).
import { describe, expect, test } from 'bun:test';
import { anotherAppDecision, codexOpenElsewhere, conversationHolders } from '../../src/launch/another-app.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import type { HerdrAgent } from '../../src/herdr.ts';

// The notice as codex-cli 0.167.0 draws it (the layout test/provider-error-gaps.test.ts keeps).
const LOCKED = [
  '• done-stop — typecheck passed; worktree left as-is.',
  '',
  '■ This conversation is read-only or unavailable; no operation was sent.',
  '',
  '  🔒 This conversation is open in another app                                  r to retry',
  '     Close it there and press R to continue here.',
  '',
  '  r retry   f fork   ←/esc command center   ^c/q exit   ^t transcript',
].join('\n');

const CONVERSATION = '01a1c017-0000-7000-8000-000000000001';
const HERE = { session: 'acme', pane: 'w27:p1' };

function agent(pane: string, session?: string, name: string | null = null): HerdrAgent {
  return { name, agent: 'codex', pane, workspace: pane.split(':')[0]!, status: 'idle', cwd: null, ...(session ? { session } : {}) };
}

describe('the notice is read only when both of its rows are drawn', () => {
  test('the captured frame', () => {
    expect(codexOpenElsewhere(LOCKED)).toBe(true);
  });
  test('one row alone, or a transcript line quoting half of it, is not the notice', () => {
    expect(codexOpenElsewhere('This conversation is open in another app')).toBe(false);
    expect(codexOpenElsewhere('Close it there and press R to continue here')).toBe(false);
    expect(codexOpenElsewhere('› ')).toBe(false);
  });
});

describe('who holds the conversation', () => {
  test('panes of every running session that report the id; stopped sessions are not read', () => {
    const read: string[] = [];
    const holders = conversationHolders({
      sessions: () => [{ name: 'acme', running: true }, { name: 'floor', running: true }, { name: 'old', running: false }],
      agents: (name) => {
        read.push(name);
        if (name === 'acme') return [agent('w27:p1', CONVERSATION), agent('w3:p1', 'other')];
        return [agent('w56:p1', CONVERSATION)];
      },
    }, CONVERSATION);
    expect(holders).toEqual([{ session: 'acme', pane: 'w27:p1' }, { session: 'floor', pane: 'w56:p1' }]);
    expect(read).toEqual(['acme', 'floor']);
  });
  test('an unreadable session list or agent list is unknown, never "no holder"', () => {
    expect(conversationHolders({ sessions: () => null, agents: () => [] }, CONVERSATION)).toBeNull();
    expect(conversationHolders({ sessions: () => [{ name: 'acme', running: true }], agents: () => null }, CONVERSATION)).toBeNull();
  });
});

describe('R is pressed only for the seat\'s own detached task', () => {
  const base = { cli: 'codex', text: LOCKED, resumes: CONVERSATION, here: HERE };
  test('no other pane holds it, or only this launch\'s own pane: press', () => {
    expect(anotherAppDecision({ ...base, holders: [] })).toEqual({ press: true });
    expect(anotherAppDecision({ ...base, holders: [HERE] })).toEqual({ press: true });
  });
  test('another live pane holds it (a duplicate beside a live seat): left to the owner', () => {
    const decision = anotherAppDecision({ ...base, holders: [{ session: 'floor', pane: 'w56:p1' }] });
    expect(decision.press).toBe(false);
    expect(decision).toEqual({ press: false, why: 'another live pane holds the conversation (w56:p1 in session floor)' });
  });
  test('any missing proof is left to the owner', () => {
    expect(anotherAppDecision({ ...base, holders: null }).press).toBe(false);
    expect(anotherAppDecision({ ...base, resumes: null, holders: [] }).press).toBe(false);
    expect(anotherAppDecision({ ...base, resumes: '', holders: [] }).press).toBe(false);
    expect(anotherAppDecision({ ...base, text: null, holders: [] }).press).toBe(false);
    expect(anotherAppDecision({ ...base, text: '› ', holders: [] }).press).toBe(false);
    expect(anotherAppDecision({ ...base, cli: 'claude-code', holders: [] }).press).toBe(false);
  });
});

type IdleScene = {
  holders: { session: string; pane: string }[] | null;
  /** Whether the notice goes away after R (the take-over worked). */
  clears: boolean;
  command?: string;
  takeOver?: boolean;
};

async function idleWait(scene: IdleScene) {
  let pressedR = 0;
  let clock = 0;
  const logs: string[] = [];
  const said: string[] = [];
  const records: unknown[] = [];
  const locked = () => pressedR === 0 || !scene.clears;
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: HERE.pane, workspace: 'w27' }),
    paneRun: () => true,
    typeLine: () => { throw new Error('unexpected typing'); },
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => { throw new Error('unexpected process signal'); },
    agentPanes: () => [HERE.pane],
    classify: () => (locked() ? 'provider error' : 'idle'),
    paneText: () => (locked() ? LOCKED : '› '),
    foreground: () => ['codex'],
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    allow: () => null,
    record: (_seat, patch) => { records.push(patch); },
    running: () => {},
    drop: () => {},
    say: (text) => { said.push(text); },
    log: (_who, what) => { logs.push(what); },
    conversationHolders: () => scene.holders,
    ...(scene.takeOver === false ? {} : { takeOverConversation: () => { pressedR += 1; return true; } }),
  };
  const steps: Step[] = [{
    kind: 'wait',
    text: 'until operator shows its idle prompt',
    do: {
      do: 'idle',
      seat: 'operator',
      label: 'operator',
      cli: 'codex',
      seconds: 5,
      command: scene.command ?? `codex resume ${CONVERSATION}`,
      pane: HERE.pane,
      workspace: 'w27',
      repairLine: 'synthetic repair',
    },
  }];
  const report = await executePlan(steps, HERE.session, host);
  return { pressedR, logs, said: said.join(''), records, report };
}

describe('the idle wait answers the notice once, and only with proof', () => {
  test('the seat\'s own detached task: R once, then the seat reaches its prompt', async () => {
    const run = await idleWait({ holders: [], clears: true });
    expect(run.pressedR).toBe(1);
    expect(run.logs).toContain(`its conversation ${CONVERSATION} was held by its own detached Codex task; pressed R to continue here`);
    expect(run.said).not.toContain('waiting for owner');
    expect(run.report.dropped).toEqual([]);
  });
  test('another live pane holds it: no key, the wait stops at the dialog as before', async () => {
    const run = await idleWait({ holders: [{ session: 'floor', pane: 'w56:p1' }], clears: true });
    expect(run.pressedR).toBe(0);
    expect(run.logs.some((line) => line.includes('left to the owner: another live pane holds the conversation'))).toBe(true);
  });
  test('R that does not clear the notice is not pressed again', async () => {
    const run = await idleWait({ holders: [], clears: false });
    expect(run.pressedR).toBe(1);
  });
  test('a launch line that names no conversation: no key', async () => {
    const run = await idleWait({ holders: [], clears: true, command: 'codex' });
    expect(run.pressedR).toBe(0);
  });
  test('a host that offers no take-over key: no key', async () => {
    const run = await idleWait({ holders: [], clears: true, takeOver: false });
    expect(run.pressedR).toBe(0);
  });
});

describe('a Jules pane herdr does not list is declared an agent, then named', () => {
  async function nameJules(input: { foreground: string[]; reportWorks: boolean; offerReport?: boolean }) {
    let declared = false;
    const reports: { pane: string; agent: string }[] = [];
    const renames: string[] = [];
    const logs: string[] = [];
    const records: unknown[] = [];
    let named = false;
    let clock = 0;
    const listedAgents = (): HerdrAgent[] =>
      declared ? [{ name: named ? 'tester-1' : null, agent: 'jules', pane: 'w4B:p1', workspace: 'w4B', status: 'idle', cwd: null }] : [];
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'w4B:p1', workspace: 'w4B' }),
      paneRun: () => true,
      typeLine: () => { throw new Error('unexpected typing'); },
      renameAgent: (_s, pane, name) => {
        renames.push(`${pane}=${name}`);
        if (declared) named = true;
        return declared;
      },
      ...(input.offerReport === false
        ? {}
        : {
            reportAgent: (_s: string, pane: string, agentName: string) => {
              reports.push({ pane, agent: agentName });
              if (input.reportWorks) declared = true;
              return input.reportWorks;
            },
          }),
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => { throw new Error('unexpected process signal'); },
      agentPanes: () => listedAgents().map((one) => one.pane),
      agentList: () => listedAgents(),
      classify: () => 'idle',
      foreground: () => input.foreground,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      allow: () => null,
      record: (_seat, patch) => { records.push(patch); },
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (_who, what) => { logs.push(what); },
    };
    const steps: Step[] = [{
      kind: 'rename',
      text: 'name tester-1',
      do: { do: 'rename', seat: 'tester-1', label: 'Lynceus · tester 1', cli: 'jules', seconds: 10, rules: 'option', pane: 'w4B:p1' },
    } as Step];
    const report = await executePlan(steps, 'teamcli', host);
    return { reports, renames, logs, records, report };
  }

  test('the jules process in front: declared once, then named and recorded', async () => {
    const run = await nameJules({ foreground: ['bash', 'jules'], reportWorks: true });
    expect(run.reports).toEqual([{ pane: 'w4B:p1', agent: 'jules' }]);
    expect(run.renames[0]).toBe('w4B:p1=tester-1');
    expect(run.records).toContainEqual({ stage: 'named', pane: 'w4B:p1' });
    expect(run.report.dropped).toEqual([]);
  });
  test('a shell in front: nothing is declared and nothing is named', async () => {
    const run = await nameJules({ foreground: ['zsh'], reportWorks: true });
    expect(run.reports).toEqual([]);
    expect(run.renames).toEqual([]);
    expect(run.report.dropped).toEqual(['tester-1']);
  });
  test('a host with no report: the old refusal stands', async () => {
    const run = await nameJules({ foreground: ['jules'], reportWorks: true, offerReport: false });
    expect(run.reports).toEqual([]);
    expect(run.report.dropped).toEqual(['tester-1']);
  });
});
