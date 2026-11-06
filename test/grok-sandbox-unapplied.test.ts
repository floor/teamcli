// Synthetic frames only. No CLI is started.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { GROK_SANDBOX_UNAPPLIED, grokSandboxUnapplied, sandboxUnappliedNotes } from '../src/launch/grok-sandbox.ts';

const FRAME = [
  'warning: sandbox could not be applied: Custom sandbox profile was not found.',
  '',
  'user@pane %',
].join('\n');

test('a synthetic frame that carries the sandbox refusal is recognised', () => {
  expect(grokSandboxUnapplied(FRAME)).toBe(true);
  expect(grokSandboxUnapplied(`stderr: ${GROK_SANDBOX_UNAPPLIED}\n`)).toBe(true);
  expect(grokSandboxUnapplied('idle prompt\n› ')).toBe(false);
});

test('team status names the stopped seat from the record, not from a stored sentence', () => {
  const notes = sandboxUnappliedNotes(
    [{ name: 'worker' }, { name: 'other' }],
    { seats: { worker: { sandbox_unapplied: { why: 'ignore this stored sentence' } } } },
  );
  expect(notes).toEqual([`worker: stopped: ${GROK_SANDBOX_UNAPPLIED}`]);
});

test('a sandbox warning leaves the team file bytes unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-stop-'));
  const file = join(dir, 'team.toml');
  const bytes = ['format: 1', 'seats:', '  - name: worker', '    cli: grok', ''].join('\n');
  writeFileSync(file, bytes);
  const recorded: unknown[] = [];
  const closed: string[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'owned-pane', workspace: 'owned-space' }),
    paneRun: () => true,
    typeLine: () => { throw new Error('unexpected terminal typing'); },
    renameAgent: () => true,
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    markStopped: () => {
      writeFileSync(file, `${bytes}stopped: true\n`);
      return true;
    },
    stopSession: () => true,
    kill: () => { throw new Error('unexpected process signal'); },
    agentPanes: () => [],
    classify: () => 'idle',
    paneText: () => FRAME,
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (_seat, patch) => { recorded.push(patch); },
    running: () => {},
    drop: () => {},
    say: (text) => { said.push(text); },
    log: () => {},
  };
  const steps: Step[] = [{
    kind: 'wait',
    text: 'until worker shows its idle prompt',
    do: {
      do: 'idle',
      seat: 'worker',
      label: 'worker',
      cli: 'grok',
      seconds: 5,
      command: 'grok',
      pane: 'owned-pane',
      workspace: 'owned-space',
      repairLine: 'synthetic repair',
    },
  }];
  await executePlan(steps, 'orbit-scene', host);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(closed).toEqual(['owned-space']);
  expect(recorded).toContainEqual({ stage: 'launched', sandbox_unapplied: { why: GROK_SANDBOX_UNAPPLIED } });
  expect(said.join('')).toContain(GROK_SANDBOX_UNAPPLIED);
  expect(said.join('')).not.toContain('stopped mark');
});
