// A confined seat's send and reply go through its outbox: the seat writes the request into its
// own seat-state folder, the team's watch runs that command as the seat and writes the result
// back, and the seat's command prints it.
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { outboxFolder, relayOutboxes, relayThroughOutbox, type OutboxCommand, type RelayCaller, type RelaySources } from '../src/send/confined-outbox.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function team(): { root: string; dir: string } {
  const root = fixtureBase('outbox-');
  scratchParent ??= dirname(root);
  made.push(root);
  const dir = join(root, '.agents');
  mkdirSync(join(dir, 'seat-state', 's', 'keeper'), { recursive: true });
  return { root, dir };
}

type Ran = { command: OutboxCommand; argv: string[]; cwd: string; caller: RelayCaller };

function relay(overrides: Partial<RelaySources> = {}): { sources: RelaySources; ran: Ran[]; logged: string[] } {
  const ran: Ran[] = [];
  const logged: string[] = [];
  const sources: RelaySources = {
    recordedPane: (seat) => (seat === 'keeper' ? 'pane-k' : undefined),
    agents: () => [{ name: 'keeper', pane: 'pane-k' }],
    run: async (command, argv, cwd, caller) => {
      ran.push({ command, argv, cwd, caller });
      return { code: 0, out: `sent ${argv.join(' ')}\n`, err: '' };
    },
    now: () => new Date(),
    log: (line) => logged.push(line),
    ...overrides,
  };
  return { sources, ran, logged };
}

/** The seat's command, its waits served by the watch pass running in between. */
async function sendThroughOutbox(root: string, dir: string, sources: RelaySources, argv = ['lead', 'hello']) {
  let out = '';
  let err = '';
  const code = await relayThroughOutbox({
    command: 'send', argv, cwd: root, dir, seat: 'keeper', session: 's', pane: 'pane-k',
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    waitMs: 5_000,
    sleep: async () => { await relayOutboxes(dir, 's', ['keeper'], sources); },
  });
  return { code, out, err };
}

describe('the confined seat outbox', () => {
  test('a send is run by the watch as the seat, and the seat prints what it said', async () => {
    const { root, dir } = team();
    const { sources, ran } = relay();
    const { code, out } = await sendThroughOutbox(root, dir, sources);
    expect(code).toBe(0);
    expect(out).toBe('sent lead hello\n');
    expect(ran).toEqual([{ command: 'send', argv: ['lead', 'hello'], cwd: root, caller: { kind: 'seat', name: 'keeper', pane: 'pane-k', session: 's' } }]);
    // Nothing is left behind: the request was taken and the result collected.
    expect(readdirSync(outboxFolder(dir, 's', 'keeper')!)).toEqual([]);
  });

  test('a request is run once, however many passes see it', async () => {
    const { root, dir } = team();
    const { sources, ran } = relay();
    await sendThroughOutbox(root, dir, sources);
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(ran).toHaveLength(1);
  });

  test('a pane the team does not record for the seat, or the host gives to another seat, is refused', async () => {
    const { root, dir } = team();
    for (const overrides of [
      { recordedPane: () => 'pane-x' },
      { agents: () => [{ name: 'other', pane: 'pane-k' }] },
      { agents: () => [{ name: 'keeper', pane: 'pane-z' }] },
    ] satisfies Partial<RelaySources>[]) {
      const { sources, ran } = relay(overrides);
      const { code, err } = await sendThroughOutbox(root, dir, sources);
      expect(code).toBe(1);
      expect(err).toContain('the relay refused this request');
      expect(ran).toEqual([]);
    }
  });

  test('a request older than ten minutes is refused', async () => {
    const { root, dir } = team();
    const later = new Date(Date.now() + 11 * 60_000);
    const { sources, ran } = relay({ now: () => later });
    const { code, err } = await sendThroughOutbox(root, dir, sources);
    expect(code).toBe(1);
    expect(err).toContain('older than ten minutes');
    expect(ran).toEqual([]);
  });

  test('an outbox reached through a link relays nothing', async () => {
    const { root, dir } = team();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, outboxFolder(dir, 's', 'keeper')!);
    writeFileSync(join(elsewhere, '00000000-0000-4000-8000-000000000001.request.json'), JSON.stringify({
      v: 1, id: '00000000-0000-4000-8000-000000000001', command: 'send', argv: ['lead', 'x'], cwd: root,
      seat: 'keeper', session: 's', pane: 'pane-k', at: new Date().toISOString(),
    }));
    const { sources, ran, logged } = relay();
    expect(await relayOutboxes(dir, 's', ['keeper'], sources)).toBe(0);
    expect(ran).toEqual([]);
    expect(logged.join('\n')).toContain('not a folder of its own');
  });

  test('a request naming another seat than its outbox is refused', async () => {
    const { root, dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    const id = '00000000-0000-4000-8000-000000000002';
    writeFileSync(join(folder, `${id}.request.json`), JSON.stringify({
      v: 1, id, command: 'send', argv: ['lead', 'x'], cwd: root, seat: 'other', session: 's', pane: 'pane-k', at: new Date().toISOString(),
    }));
    const { sources, ran } = relay();
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(ran).toEqual([]);
    expect(existsSync(join(folder, `${id}.result.json`))).toBe(true);
  });

  test('a seat whose result does not come in time is told its request is queued', async () => {
    const { root, dir } = team();
    let err = '';
    const code = await relayThroughOutbox({
      command: 'reply', argv: ['abc', 'thanks'], cwd: root, dir, seat: 'keeper', session: 's', pane: 'pane-k',
      stdout: () => {}, stderr: (text) => { err += text; }, waitMs: 0, sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(err).toContain('queued in keeper\'s outbox');
  });
});
