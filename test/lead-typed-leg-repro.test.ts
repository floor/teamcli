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

test('a Claude lead whose profile refuses typed keeps the unread drop, and the retired name stays out of the walk', async () => {
  expect(liveOrderWords(['mcp-inbox', 'typed'])).toEqual(['typed']);
  const made = open();
  const pane = wakeFake((read, enters, typed) => {
    if (enters > 0) return CLAUDE_WORKING;
    const line = typed[typed.length - 1];
    return line === undefined ? claudeBox('') : claudeBox(line);
  });
  const host = fake(made, {
    agents: () => [{ name: 'lead', pane: 'pane-lead' }],
    processInfo: () => ({ shell: 11, foreground: [22] }),
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  expect(await runSend(['lead', 'hello'], io, host), io.err + io.out).toBe(0);
  const text = io.err + io.out;
  expect(withoutSendId(io.out)).toContain('lead: queued, not woken (drop,');
  expect(text).not.toContain('delivered (typed wake)');
  expect(text).not.toContain('mcp-inbox');
  // A fully capable host does not override the receiver profile's refusal.
  expect(pane.reads).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(host.frames).toEqual([]);

  const drops = dropDir(made.dir, 'lead');
  const ids = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(ids).toHaveLength(1);
  const id = ids[0] as string;
  expect(recordBody(join(drops, id))).toBe(filed('hello'));
  expect(existsSync(join(drops, `${id}.read.json`))).toBe(false);
  expect(existsSync(join(drops, `${id}.replied.json`))).toBe(false);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) throw new Error(history.reason);
  expect(history.entries).toHaveLength(1);
  expect(history.entries[0]).toMatchObject({ id, from: 'owner', to: 'lead', body: filed('hello'), outcome: 'queued, not woken', via: 'drop' });
});

test('a launcher pane that holds a program beside the shell still takes the typed wake', async () => {
  const made = open();
  const pane = wakeFake((read, enters, typed) => {
    if (enters > 0) return WORKING;
    if (read < 2) return IDLE;
    return holding(typed[typed.length - 1] ?? '');
  });
  const host = fake(made, {
    agents: () => [{ name: 'scribe', pane: 'pane-scribe' }],
    processInfo: () => ({ shell: 11, foreground: [11, 33] }),
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  expect(await runSend(['scribe', 'hello'], io, host), io.err + io.out).toBe(0);
  const text = io.err + io.out;
  expect(text).toContain('scribe: delivered (typed wake)');
  expect(text).not.toContain('pull-only');
  expect(text).not.toContain('back at its shell');
  expect(pane.typed.length).toBe(1);
});

test('a working screen is waited out and the wake runs once the box is idle', async () => {
  const made = open();
  const pane = wakeFake((read, enters, typed) => {
    if (enters > 0) return WORKING;
    if (read === 0) return WORKING;
    if (typed.length === 0) return IDLE;
    return holding(typed[typed.length - 1] ?? '');
  });
  const host = fake(made, {
    agents: () => [{ name: 'scribe', pane: 'pane-scribe-working' }],
    processInfo: () => ({ shell: 11, foreground: [22] }),
    typedWake: () => pane.host,
    wakeVerifyMs: 50,
    wakePollMs: 1,
  });
  const io = owner(made.root);
  expect(await runSend(['scribe', 'hello'], io, host), io.err + io.out).toBe(0);
  expect(io.err + io.out).toContain('scribe: delivered (typed wake)');
  expect(io.err + io.out).not.toContain('pull-only');
  expect(pane.reads).toBeGreaterThan(1);
  expect(pane.enters).toBe(1);
});

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
