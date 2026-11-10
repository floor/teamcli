// Independent scenes for the send host's two capability doors. A snapshot of the host keeps
// pane readers absent when the host has none: a minimal or partial host never looks readable,
// never crashes the walk, and the drop the send leaves behind survives for the seat's own
// read. The typed leg stays behind the receiver's profile: a host whose hook can type one
// gains no leg for a profile that cannot, and a no-store walk carries no typed leg at all,
// while a profile that declares the typed wake still types and delivers.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');

/** The captured idle frame with `text` drawn in its composer, so a wake can read its own line
 *  back as the box's contents. */
function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

/** A scripted typed-wake pane: it records every line and Enter, and answers each read from
 *  `screen`. The wake owns the pane, so nothing here touches a live session. */
function wakePane(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function museWorld() {
  const made = world(['mcp-inbox', 'typed'], [{ name: 'muse', role: 'implementer', cli: 'muse', launch: 'muse' }]);
  cleanups.push(made.cleanup);
  return made;
}

/** A pane that would take a wake: idle twice, then holding whatever line was typed, then
 *  working once Enter goes in. A skipped typed leg leaves it untouched. */
const welcoming = (read: number, enters: number, typed: readonly string[]) =>
  enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '');

const dropRecordsOf = (made: ReturnType<typeof museWorld>, seat = 'muse'): string[] => {
  const drops = join(made.dir, 'send-drops', 'acme', seat);
  return existsSync(drops) ? readdirSync(drops).filter((name) => !name.includes('.')) : [];
};

test('a host with no pane readers keeps them absent: the walk skips the pane legs and the drop survives', async () => {
  const made = museWorld();
  const pane = wakePane(welcoming);
  const host: SendHost = fake(made, { agents: undefined, processInfo: undefined, typedWake: () => pane.host });
  const io = owner(made.root);
  const code = await runSend(['muse', 'hello'], io, host);
  expect(code).toBe(0);
  expect(io.out + io.err).not.toContain('is not a function');
  // No pane was read or typed into: the capability door, not a crash, ended the leg.
  expect(pane.reads).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  // The message survives as the seat's drop, body whole.
  const records = dropRecordsOf(made);
  expect(records).toHaveLength(1);
  expect(recordBody(join(made.dir, 'send-drops', 'acme', 'muse', records[0] as string))).toBe(filed('hello'));
});

test('either half of the pane readers alone is still no capability: both partial hosts skip the leg safely', async () => {
  for (const partial of [
    { agents: undefined, processInfo: () => ({ shell: 111, foreground: [222] }) },
    { agents: () => [{ name: 'muse', pane: 'pane-1' }], processInfo: undefined },
  ] as Partial<SendHost>[]) {
    const made = museWorld();
    const pane = wakePane(welcoming);
    const host: SendHost = fake(made, { ...partial, typedWake: () => pane.host });
    const io = owner(made.root);
    const code = await runSend(['muse', 'hello'], io, host);
    expect(code, JSON.stringify(partial)).toBe(0);
    expect(io.out + io.err).not.toContain('is not a function');
    expect(pane.reads, JSON.stringify(partial)).toBe(0);
    expect(pane.typed, JSON.stringify(partial)).toEqual([]);
    expect(dropRecordsOf(made)).toHaveLength(1);
  }
});

test('a profile that declares the typed wake still types and delivers through a capable host', async () => {
  const made = museWorld();
  const pane = wakePane(welcoming);
  const host: SendHost = fake(made, {
    agents: () => [{ name: 'muse', pane: 'pane-1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  const code = await runSend(['muse', 'hello'], io, host);
  expect(code).toBe(0);
  expect(io.out).toContain('muse: delivered (typed wake)');
  // One line, one Enter, and the line is the trigger that reads the drop, never the body.
  expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: team drops --read.']);
  expect(pane.enters).toBe(1);
  expect(dropRecordsOf(made)).toHaveLength(1);
  const history = readHistory('acme', made.root, host.home);
  expect(history.ok).toBe(true);
  if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'delivered (typed wake)', via: 'typed' });
});

test('a host hook that can type gains no typed leg for a profile that cannot', async () => {
  const made = museWorld();
  const pane = wakePane(welcoming);
  const host: SendHost = fake(made, {
    agents: () => [
      { name: 'lead', pane: 'pane-2' },
      { name: 'muse', pane: 'pane-1' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  // The receiver is the file's Claude Code lead: its profile names no typed wake.
  const code = await runSend(['lead', 'hello'], io, host);
  expect(code).toBe(0);
  expect(pane.reads).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  const history = readHistory('acme', made.root, host.home);
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.entries[0]?.failed).toEqual([
      "typed: typing into a seat's pane is never a delivery: messages go through the bus and an event adapter",
    ]);
  }
  expect(dropRecordsOf(made, 'lead')).toHaveLength(1);
});

test('a no-store walk carries no typed leg even for a profile that declares one', async () => {
  const made = museWorld();
  const pane = wakePane(welcoming);
  const host: SendHost = fake(made, {
    agents: () => [{ name: 'muse', pane: 'pane-1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    typedWake: () => pane.host,
    store: 'none',
  });
  const io = owner(made.root);
  const code = await runSend(['muse', 'hello'], io, host);
  // The walk keeps only the legs that carry a body themselves; none of them is the pane, and
  // with none of them listening, nothing is stored and nothing is sent.
  expect(pane.reads).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(dropRecordsOf(made)).toHaveLength(0);
  expect(code).toBe(1);
  expect(io.out + io.err).toContain('messaging.store is none and no route the order names carries the body itself; nothing was stored and nothing was sent');
});
