// Independent scenes for the agent-prompt wake. The pane is a scripted capture: an idle frame
// is woken by one herdr agent prompt, a busy frame is never typed into, and a prompt the pane
// refuses leaves the drop queued. No herdr runs and nothing is typed into a live pane.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { recordBody } from './helpers.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.70', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');

const homes: string[] = [];
afterAll(() => discardFixtures(homes));

function seat() {
  const made = world(['mcp-inbox', 'typed'], [{ name: 'grok', role: 'implementer', cli: 'grok', launch: 'grok' }]);
  homes.push(dirname(made.root));
  return made;
}

function capture(screen: (reads: number, prompts: number) => string, promptOk = true) {
  const typed: string[] = [];
  const prompts: string[] = [];
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => screen(typed.length + prompts.length + enters, prompts.length),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    prompt: (_pane, line) => {
      prompts.push(line);
      return promptOk;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    prompts,
    enters: () => enters,
  };
}

function send(made: ReturnType<typeof seat>, pane: ReturnType<typeof capture>, body: string) {
  const host = fake(made, {
    agents: () => [{ name: 'grok', pane: 'pane-1' }],
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  return { host, io, done: runSend(['grok', body], io, host) };
}

function dropNames(dir: string): string[] {
  const drops = join(dir, 'send-drops', 'acme', 'grok');
  return readdirSync(drops).filter((name) => !name.includes('.'));
}

test('a busy pane is never typed into', async () => {
  const made = seat();
  const pane = capture(() => WORKING);
  const { io, done } = send(made, pane, 'leave the busy pane');
  // 1345 never-drop: a busy pane is terminal — nothing is typed, the record is kept in the
  // inbox, and the sender is told `not delivered: wake not taken` on stderr, exit 1.
  expect(await done).toBe(1);
  expect(pane.prompts).toEqual([]);
  expect(pane.typed).toEqual([]);
  expect(pane.enters()).toBe(0);
  expect(io.err).toContain('not delivered: wake not taken');
  expect(io.err).toContain('kept in grok\'s inbox');
  expect(io.out).not.toContain('delivered (typed wake)');
  expect(dropNames(made.dir)).toHaveLength(1);
});
