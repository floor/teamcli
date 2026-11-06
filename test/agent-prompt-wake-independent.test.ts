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

test('an idle agent prompt is woken and nothing is typed', async () => {
  const made = seat();
  const pane = capture((_reads, prompts) => (prompts > 0 ? WORKING : IDLE));
  const { host, io, done } = send(made, pane, 'wake the idle seat');
  expect(await done).toBe(0);
  expect(io.out).toContain('delivered (typed wake)');
  expect(pane.prompts).toHaveLength(1);
  expect(pane.prompts[0]).toContain('team drops --read');
  expect(pane.typed).toEqual([]);
  expect(pane.enters()).toBe(0);
  const history = readHistory('acme', made.root, host.home);
  expect(history.ok).toBe(true);
  if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'grok', outcome: 'delivered (typed wake)', via: 'typed' });
});

test('a busy pane is never typed into', async () => {
  const made = seat();
  const pane = capture(() => WORKING);
  const { io, done } = send(made, pane, 'leave the busy pane');
  expect(await done).toBe(0);
  expect(pane.prompts).toEqual([]);
  expect(pane.typed).toEqual([]);
  expect(pane.enters()).toBe(0);
  expect(io.out).toContain('nothing was typed');
  expect(io.out).not.toContain('delivered (typed wake)');
  expect(dropNames(made.dir)).toHaveLength(1);
});

test('a failed wake leaves the drop queued, not lost', async () => {
  const made = seat();
  const pane = capture(() => IDLE, false);
  const { host, io, done } = send(made, pane, 'keep the failed wake');
  expect(await done).toBe(0);
  expect(pane.prompts).toHaveLength(1);
  expect(pane.typed).toEqual([]);
  expect(pane.enters()).toBe(0);
  expect(io.out).toContain('queued, not woken');
  expect(io.out).toContain('the pane did not take the agent prompt');
  expect(io.out).not.toContain('sent (unconfirmed)');
  const names = dropNames(made.dir);
  expect(names).toHaveLength(1);
  const id = names[0] as string;
  const drops = join(made.dir, 'send-drops', 'acme', 'grok');
  expect(recordBody(join(drops, id))).toBe(filed('keep the failed wake'));
  expect(existsSync(join(drops, `${id}.read.json`))).toBe(false);
  expect(listUnread(drops, { to: 'grok', root: made.root, session: 'acme' }, host.home).map((message) => message.id)).toEqual([id]);
  const history = readHistory('acme', made.root, host.home);
  expect(history.ok).toBe(true);
  if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'grok', outcome: 'queued, not woken', via: 'drop' });
});
