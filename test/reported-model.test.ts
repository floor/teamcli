// A Claude Code seat reports its own model (SessionStart `model`, PostModelSwitch `to_model`),
// written beside its state file by the hooks TeamCLI installs. A send reads that report: a model
// the entity rule allows, under the default drift policy, becomes the record's, and the send
// carries no drift notice (2026-11-13: a lead the owner switched with /model kept its old model on
// record). No screen is read for it.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettings, cliHookStatePath, reportedModelPath } from '../src/launch/cli-hook.ts';
import { getAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { fake, owner, scripted, world } from './send-native-fixtures.ts';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

test('a Claude seat\'s settings write its model report at session start and at every /model switch', () => {
  const settings = JSON.parse(cliHookSettings('/x/seat-state/acme/lead/state.json', undefined, undefined, undefined, undefined, null)) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  for (const event of ['SessionStart', 'PostModelSwitch']) {
    expect(settings.hooks[event]?.[0]?.hooks[0]?.command).toContain('/x/seat-state/acme/lead/model.json');
  }
});

test('a send follows the model the seat\'s CLI reports, and says no drift', async () => {
  const made = world(['typed']);
  cleanup = made.cleanup;
  const agent = registerAgent(made.home, {
    name: 'lead',
    signing: { model: 'Claude Fable', version: '5.2', role: 'coordinator' },
    lab: 'anthropic', cli: 'claude-code', launcher: null, launch: 'claude',
    reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'up',
  });
  const statePath = cliHookStatePath(made.dir, 'acme', 'lead')!;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(reportedModelPath(statePath), JSON.stringify({ hook_event_name: 'PostModelSwitch', from_model: 'claude-fable-5-2', to_model: 'claude-opus-5-5' }));
  const pane = scripted(['idle'], `❯ \n${'─'.repeat(40)}\n  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n`);
  const io = owner(made.root);

  await runSend(['lead', 'hello'], io, fake(made, { native: pane }));

  expect(getAgent(made.home, agent.id)?.signing).toMatchObject({ model: 'Claude Opus', version: '5.5' });
  expect(`${io.out}${io.err}`).not.toContain('model drift');
});

test('with no report, the record is left as it is', async () => {
  const made = world(['typed']);
  cleanup = made.cleanup;
  const agent = registerAgent(made.home, {
    name: 'lead',
    signing: { model: 'Claude Fable', version: '5.2', role: 'coordinator' },
    lab: 'anthropic', cli: 'claude-code', launcher: null, launch: 'claude',
    reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'up',
  });
  await runSend(['lead', 'hello'], owner(made.root), fake(made, { native: scripted(['idle']) }));
  expect(getAgent(made.home, agent.id)?.signing).toMatchObject({ model: 'Claude Fable', version: '5.2' });
});
