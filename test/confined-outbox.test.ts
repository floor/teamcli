// A confined seat's send and reply go through its outbox: the seat writes the request into its
// own seat-state folder, the team's watch runs that command as the seat and writes the result
// back, and the seat's command prints it.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { outboxFolder, relayOutboxes, relayRefusal, relayThroughOutbox, type OutboxCommand, type RelayCaller, type RelaySources } from '../src/send/confined-outbox.ts';
import { REPLY_FLAG_OPTIONS, SEND_FLAG_OPTIONS, SEND_VALUED_OPTIONS } from '../src/send/command-grammar.ts';
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

  test('the relay reads the same option grammar the commands publish in the contract', () => {
    const contract = JSON.parse(readFileSync(new URL('../contract/cli.json', import.meta.url), 'utf8')) as {
      commands: { name: string; flags: { name: string; takesValue: boolean }[] }[];
    };
    const options = (name: string) => contract.commands.find((one) => one.name === name)!.flags;
    const has = (name: string, flag: string, takesValue: boolean) =>
      options(name).some((one) => one.name === `--${flag}` && one.takesValue === takesValue);
    for (const flag of SEND_VALUED_OPTIONS) expect(has('send', flag, true)).toBe(true);
    for (const flag of SEND_FLAG_OPTIONS) expect(has('send', flag, false)).toBe(true);
    for (const flag of REPLY_FLAG_OPTIONS) expect(has('reply', flag, false)).toBe(true);
  });

  test('options that name another authority or a file are refused on both sides', async () => {
    expect(relayRefusal('send', ['lead', 'hi', '--file', '/etc/hosts'])).toContain('--file');
    expect(relayRefusal('send', ['lead', 'hi', '--key=/x'])).toContain('--key');
    // The line is read with the command's own grammar: a value that looks like an end of options
    // does not hide what follows it.
    expect(relayRefusal('send', ['lead', '--subject', '--', '--file', '/outside'])).toContain('--file');
    expect(relayRefusal('send', ['lead', 'hello', '--subject', '--', '--wait', '--timeout', '86400'])).not.toBeNull();
    expect(relayRefusal('send', ['lead', '--', 'x'])).toContain('does not read');
    expect(relayRefusal('send', ['lead', 'hi', '--subject', 'news', '--json'])).toBeNull();
    expect(relayRefusal('reply', ['abc', 'thanks', '--close'])).toBeNull();
    const { root, dir } = team();
    const { sources, ran } = relay();
    const { code, err } = await sendThroughOutbox(root, dir, sources, ['lead', 'hi', '--approval', 'x']);
    expect(code).toBe(1);
    expect(err).toContain('--approval');
    expect(ran).toEqual([]);
  });

  test('a request that is not an object, too large, or not a plain file ends in a refusal, never a crash', async () => {
    const { root, dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    writeFileSync(join(folder, `${ids[0]}.request.json`), 'null');
    writeFileSync(join(folder, `${ids[1]}.request.json`), 'x'.repeat(300 * 1024));
    symlinkSync(join(root, 'nowhere'), join(folder, `${ids[2]}.request.json`));
    const { sources, ran } = relay();
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(ran).toEqual([]);
    for (const id of ids) expect(existsSync(join(folder, `${id}.result.json`))).toBe(true);
  });

  test('a request a stopped pass took is answered as cut off, with its outcome unknown', async () => {
    const { dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    const id = '00000000-0000-4000-8000-00000000000d';
    writeFileSync(join(folder, `${id}.taking`), '{}');
    const later = new Date(Date.now() + 6 * 60_000);
    const { sources } = relay({ now: () => later });
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(existsSync(join(folder, `${id}.taking`))).toBe(false);
    expect(readFileSync(join(folder, `${id}.result.json`), 'utf8')).toContain('whether it was sent is unknown');
  });

  test('a take older than a day is still answered, and a temporary file a crash left does not block it', async () => {
    const { dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    const id = '00000000-0000-4000-8000-00000000000e';
    writeFileSync(join(folder, `${id}.taking`), '{}');
    writeFileSync(join(folder, `.${id}.result.tmp`), 'partial');
    // The take was made two days ago: the pass that took it never came back.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(join(folder, `${id}.taking`), twoDaysAgo, twoDaysAgo);
    const { sources } = relay();
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(readFileSync(join(folder, `${id}.result.json`), 'utf8')).toContain('whether it was sent is unknown');
    expect(existsSync(join(folder, `${id}.taking`))).toBe(false);
  });

  test('one pass runs at most three requests; the rest wait for the next', async () => {
    const { root, dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    for (let k = 0; k < 5; k++) {
      const id = `00000000-0000-4000-8000-00000000001${String(k)}`;
      writeFileSync(join(folder, `${id}.request.json`), JSON.stringify({
        v: 1, id, command: 'send', argv: ['lead', `m${String(k)}`], cwd: root, seat: 'keeper', session: 's', pane: 'pane-k', at: new Date().toISOString(),
      }));
    }
    const { sources, ran } = relay();
    expect(await relayOutboxes(dir, 's', ['keeper'], sources)).toBe(3);
    expect(await relayOutboxes(dir, 's', ['keeper'], sources)).toBe(2);
    expect(ran.map((one) => one.argv[1])).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
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
