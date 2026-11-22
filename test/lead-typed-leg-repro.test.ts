// A receiver profile decides whether an order may use typed wake; a Claude lead
// keeps its durable drop when no event adapter is live.
// A wrapper beside the shell is not a bare shell. A working screen is waited
// out, and that wait does not end pull-only. Screens and pane names are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { liveOrderWords } from '../src/settings/inherit.ts';
import { claudeBox, recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';
import { dropDir, fake, filed, owner, world, type World } from './send-native-fixtures.ts';

const CURSOR = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const IDLE = readFileSync(join(CURSOR, 'idle.txt'), 'utf8');
const UNSENT = readFileSync(join(CURSOR, 'unsent.txt'), 'utf8');
const WORKING = readFileSync(join(CURSOR, 'working.txt'), 'utf8');
const CLAUDE_WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.302', 'working.txt'), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function open(): World {
  const made = world(['mcp-inbox', 'typed'], [{ name: 'scribe', role: 'implementer', cli: 'cursor', launch: 'cursor-agent' }]);
  cleanups.push(made.cleanup);
  return made;
}

function holding(text: string): string {
  return UNSENT.replace('Fix the failing test', () => text);
}

function wakeFake(screen: (read: number, enters: number, typed: readonly string[]) => string): {
  host: TypedWakeHost;
  typed: string[];
  reads: number;
  enters: number;
} {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    prompt: () => true,
    wait: async () => {},
  };
  return {
    host,
    typed,
    get reads() {
      return state.reads;
    },
    get enters() {
      return state.enters;
    },
  };
}

test('a screen that stays working is not reported pull-only', async () => {
  const made = open();
  const pane = wakeFake(() => WORKING);
  const host = fake(made, {
    agents: () => [{ name: 'scribe', pane: 'pane-scribe-busy' }],
    processInfo: () => ({ shell: 11, foreground: [22] }),
    typedWake: () => pane.host,
    wakeVerifyMs: 5,
    wakePollMs: 1,
  });
  const io = owner(made.root);
  expect(await runSend(['scribe', 'hello'], io, host), io.err + io.out).toBe(1);
  const text = io.err + io.out;
  expect(text).toContain('not delivered: wake not taken');
  expect(text).toContain('kept in scribe\'s inbox');
  expect(text).not.toContain('pull-only');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
});
