// rfc-event-comms step E5: a confined seat's `team ack <id>` and `team drops --read --seat <self>`
// go through its outbox, like its send and reply. The watch runs them as that seat after proving
// the folder, seat, session and pane (the existing relay) and the binding E5 adds: the read names
// that seat (and that session), the acknowledgement names exactly one record in that seat's own
// drop folder. Nothing is granted to the sandbox; every refusal writes only the seat's own result.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  outboxFolder, relayBindingRefusal, relayOutboxes, relayRefusal, relayThroughOutbox,
  type OutboxCommand, type RelayCaller, type RelaySources,
} from '../src/send/confined-outbox.ts';
import { ACK_FLAG_OPTIONS, DROPS_FLAG_OPTIONS, DROPS_VALUED_OPTIONS } from '../src/send/command-grammar.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

let scratchParent: string | undefined;
const made: string[] = [];
afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

const MINE = 'b5000000-0000-4000-8000-000000000001';
const THEIRS = 'b5000000-0000-4000-8000-000000000002';

function team(): { root: string; dir: string } {
  const root = fixtureBase('outbox-ack-');
  scratchParent ??= dirname(root);
  made.push(root);
  const dir = join(root, '.agents');
  mkdirSync(join(dir, 'seat-state', 's', 'keeper'), { recursive: true });
  mkdirSync(join(dir, 'send-drops', 's', 'keeper'), { recursive: true });
  mkdirSync(join(dir, 'send-drops', 's', 'other'), { recursive: true });
  writeFileSync(join(dir, 'send-drops', 's', 'keeper', MINE), '{}\n');
  writeFileSync(join(dir, 'send-drops', 's', 'keeper', `${MINE}.read.json`), '{}\n');
  writeFileSync(join(dir, 'send-drops', 's', 'other', THEIRS), '{}\n');
  return { root, dir };
}

type Ran = { command: OutboxCommand; argv: string[]; caller: RelayCaller };

function relay(): { sources: RelaySources; ran: Ran[] } {
  const ran: Ran[] = [];
  return {
    ran,
    sources: {
      recordedPane: (seat) => (seat === 'keeper' ? 'pane-k' : undefined),
      agents: () => [{ name: 'keeper', pane: 'pane-k' }],
      seal: () => true,
      run: async (command, argv, _cwd, caller) => {
        ran.push({ command, argv, caller });
        return { code: 0, out: `${command} ${argv.join(' ')}\n`, err: '' };
      },
      now: () => new Date(),
      log: () => {},
    },
  };
}

async function through(root: string, dir: string, sources: RelaySources, command: OutboxCommand, argv: string[]) {
  let out = '';
  let err = '';
  const code = await relayThroughOutbox({
    command, argv, cwd: root, dir, seat: 'keeper', session: 's', pane: 'pane-k',
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    waitMs: 5_000,
    sleep: async () => { await relayOutboxes(dir, 's', ['keeper'], sources); },
  });
  return { code, out, err };
}

function plant(dir: string, request: Record<string, unknown>): string {
  const folder = outboxFolder(dir, 's', 'keeper')!;
  mkdirSync(folder, { recursive: true });
  const id = String(request.id);
  writeFileSync(join(folder, `${id}.request.json`), JSON.stringify(request));
  return join(folder, `${id}.result.json`);
}

describe('E5: confined ack and read through the outbox', () => {
  test('an ack of one of its own messages is run by the watch as the seat', async () => {
    const { root, dir } = team();
    const { sources, ran } = relay();
    const { code, out } = await through(root, dir, sources, 'ack', [MINE]);
    expect(code).toBe(0);
    expect(out).toBe(`ack ${MINE}\n`);
    expect(ran).toEqual([{ command: 'ack', argv: [MINE], caller: { kind: 'seat', name: 'keeper', pane: 'pane-k', session: 's' } }]);
  });

  test('a read of its own mail is run by the watch as the seat', async () => {
    const { root, dir } = team();
    const { sources, ran } = relay();
    const { code } = await through(root, dir, sources, 'drops', ['--read', '--seat', 'keeper', '--session', 's']);
    expect(code).toBe(0);
    expect(ran.map((one) => one.command)).toEqual(['drops']);
  });

  test('an ack of another seat\'s message, an unknown id or an ambiguous prefix is refused before anything runs', async () => {
    const { root, dir } = team();
    writeFileSync(join(dir, 'send-drops', 's', 'keeper', 'b5000000-0000-4000-8000-000000000009'), '{}\n');
    const { sources, ran } = relay();
    for (const id of [THEIRS, 'c0000000-0000-4000-8000-000000000000', 'b5000000']) {
      const { code, err } = await through(root, dir, sources, 'ack', [id]);
      expect(code).toBe(1);
      expect(err).toContain('the relay refused this request');
    }
    expect(ran).toEqual([]);
    // Nothing was written in the other seat's folder.
    expect(readdirSync(join(dir, 'send-drops', 's', 'other'))).toEqual([THEIRS]);
  });

  test('a read that names another seat or session is refused', async () => {
    const { dir } = team();
    const request = { command: 'drops' as const, seat: 'keeper', session: 's' };
    expect(relayBindingRefusal(dir, { ...request, argv: ['--read', '--seat', 'other'] })).toContain('another seat');
    expect(relayBindingRefusal(dir, { ...request, argv: ['--read', '--seat', 'keeper', '--session', 't'] })).toContain('another session');
    expect(relayBindingRefusal(dir, { ...request, argv: ['--read', '--seat', 'keeper'] })).toBeNull();
  });

  test('only the plain forms are taken: one id; --read with --seat; no scoped clearing', () => {
    expect(relayRefusal('ack', [MINE])).toBeNull();
    expect(relayRefusal('ack', [MINE, '--json'])).toBeNull();
    expect(relayRefusal('ack', [MINE, THEIRS])).toContain('one message');
    expect(relayRefusal('ack', ['--seat', 'keeper', '--older-than', '1h'])).toContain('--');
    expect(relayRefusal('drops', ['--seat', 'keeper'])).toContain('drops --read');
    expect(relayRefusal('drops', ['--read'])).toContain('drops --read');
    expect(relayRefusal('drops', ['--read', '--seat', 'keeper', '--follow'])).toContain('--follow');
    expect(relayRefusal('drops', ['--read', '--seat', 'keeper', '--epoch', 'e1', '--id', MINE])).toBeNull();
  });

  test('a forged request in the outbox (another seat named, a stale pane) is refused and only the seat\'s own result is written', async () => {
    const { root, dir } = team();
    const { sources, ran } = relay();
    const at = new Date().toISOString();
    const forged = plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000a1', command: 'ack', argv: [MINE], cwd: root, seat: 'other', session: 's', pane: 'pane-k', at });
    const stale = plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000a2', command: 'drops', argv: ['--read', '--seat', 'keeper'], cwd: root, seat: 'keeper', session: 's', pane: 'pane-x', at });
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(ran).toEqual([]);
    expect(JSON.parse(readFileSync(forged, 'utf8')).code).toBe(1);
    expect(JSON.parse(readFileSync(stale, 'utf8')).code).toBe(1);
    expect(existsSync(join(dir, 'send-drops', 's', 'keeper', `${MINE}.read.json`))).toBe(true);
  });

  test('the relay reads the ack and drops grammar the commands publish in the contract', () => {
    const contract = JSON.parse(readFileSync(new URL('../contract/cli.json', import.meta.url), 'utf8')) as {
      commands: { name: string; flags: { name: string; takesValue: boolean }[] }[];
    };
    const has = (name: string, flag: string, takesValue: boolean) =>
      contract.commands.find((one) => one.name === name)!.flags.some((one) => one.name === `--${flag}` && one.takesValue === takesValue);
    // Every word a relayed line may carry is one the command publishes (`--dry-run` and `--unread`
    // are parsed by `team drops` only to refuse them, and are never relayed).
    for (const flag of ACK_FLAG_OPTIONS) expect(has('ack', flag, false)).toBe(true);
    for (const flag of DROPS_VALUED_OPTIONS) expect(has('drops', flag, true)).toBe(true);
    for (const flag of DROPS_FLAG_OPTIONS.filter((one) => one !== 'dry-run' && one !== 'unread')) expect(has('drops', flag, false)).toBe(true);
    expect(relayRefusal('drops', ['--read', '--seat', 'keeper', '--dry-run'])).not.toBeNull();
  });
});

// Review round 1: the run is bound to what was proven, and a read's hand-over survives the relay.

type RunFn = RelaySources['run'];

function relayWith(run: RunFn): RelaySources {
  return {
    recordedPane: (seat) => (seat === 'keeper' ? 'pane-k' : undefined),
    agents: () => [{ name: 'keeper', pane: 'pane-k' }],
    run,
    now: () => new Date(),
    log: () => {},
    seal: () => true,
  };
}

describe('E5 round 1: binding and hand-over', () => {
  test('a request naming another checkout\'s folder runs in the outbox\'s own team root, on the full id the check resolved', async () => {
    const { root, dir } = team();
    const elsewhere = fixtureBase('outbox-elsewhere-');
    made.push(elsewhere);
    const seen: { argv: string[]; cwd: string }[] = [];
    const sources = relayWith(async (_command, argv, cwd) => {
      seen.push({ argv, cwd });
      return { code: 0, out: '', err: '' };
    });
    const at = new Date().toISOString();
    const ack = plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000b1', command: 'ack', argv: ['b5000000-0000-4000-8000-00000000000'], cwd: elsewhere, seat: 'keeper', session: 's', pane: 'pane-k', at });
    const read = plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000b2', command: 'drops', argv: ['--read', '--seat', 'keeper'], cwd: elsewhere, seat: 'keeper', session: 's', pane: 'pane-k', at });
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(seen).toEqual([
      { argv: [MINE], cwd: root },
      { argv: ['--read', '--seat', 'keeper'], cwd: root },
    ]);
    expect(existsSync(ack)).toBe(true);
    expect(existsSync(read)).toBe(true);
  });

  test('a read cut off after it handed its bodies over answers with them, not with an empty result', async () => {
    const { root, dir } = team();
    const sources = relayWith(async (_command, _argv, _cwd, _caller, persist) => {
      persist('BODY OF MINE\n');
      throw new Error('stopped after the hand-over');
    });
    const result = plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000c1', command: 'drops', argv: ['--read', '--seat', 'keeper'], cwd: root, seat: 'keeper', session: 's', pane: 'pane-k', at: new Date().toISOString() });
    await relayOutboxes(dir, 's', ['keeper'], sources);
    const published = JSON.parse(readFileSync(result, 'utf8'));
    expect(published.out).toBe('BODY OF MINE\n');
  });

  test('a result that cannot be published keeps the hand-over durable; the recovery answers with it', async () => {
    const { root, dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    const id = '00000000-0000-4000-8000-0000000000d1';
    const sources = relayWith(async (_command, _argv, _cwd, _caller, persist) => {
      persist('BODY OF MINE\n');
      return { code: 0, out: 'BODY OF MINE\n', err: '' };
    });
    const result = plant(dir, { v: 1, id, command: 'drops', argv: ['--read', '--seat', 'keeper'], cwd: root, seat: 'keeper', session: 's', pane: 'pane-k', at: new Date().toISOString() });
    mkdirSync(result);
    await relayOutboxes(dir, 's', ['keeper'], sources);
    // The hand-over is saved as a whole chunk: a header line naming its ids, sha256 and length,
    // then the text.
    const chunk = readFileSync(join(folder, `${id}.partial.000000`), 'utf8');
    expect(chunk.slice(chunk.indexOf('\n') + 1)).toBe('BODY OF MINE\n');
    rmdirSync(result);
    const old = new Date(Date.now() - 6 * 60_000);
    utimesSync(join(folder, `${id}.taking`), old, old);
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(JSON.parse(readFileSync(result, 'utf8')).out).toBe('BODY OF MINE\n');
    expect(existsSync(join(folder, `${id}.partial.000000`))).toBe(false);
  });
});

describe('E5 round 2: the hand-over is durable in order, and unreadable saved output is kept', () => {
  test('partial flushed (file, folder) before the command goes on; result flushed (file, folder) before the partial is removed', async () => {
    const { root, dir } = team();
    const points: string[] = [];
    const sources: RelaySources = {
      ...relayWith(async (_command, _argv, _cwd, _caller, persist) => {
        persist('BODY\n');
        points.push('command-continues');
        return { code: 0, out: 'BODY\n', err: '' };
      }),
      trace: (point) => points.push(point),
    };
    plant(dir, { v: 1, id: '00000000-0000-4000-8000-0000000000e1', command: 'drops', argv: ['--read', '--seat', 'keeper'], cwd: root, seat: 'keeper', session: 's', pane: 'pane-k', at: new Date().toISOString() });
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(points).toEqual(['partial-fsync', 'partial-folder-fsync', 'command-continues', 'result-fsync', 'result-folder-fsync', 'partial-removed']);
  });

  test('saved output that cannot be read at recovery is kept with its take, and answered once it reads again', async () => {
    const { dir } = team();
    const folder = outboxFolder(dir, 's', 'keeper')!;
    mkdirSync(folder, { recursive: true });
    const id = '00000000-0000-4000-8000-0000000000f1';
    const taking = join(folder, `${id}.taking`);
    writeFileSync(taking, '{}');
    const old = new Date(Date.now() - 6 * 60_000);
    utimesSync(taking, old, old);
    mkdirSync(join(folder, `${id}.partial`));
    const sources = relayWith(async () => ({ code: 0, out: '', err: '' }));
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(existsSync(taking)).toBe(true);
    expect(existsSync(join(folder, `${id}.result.json`))).toBe(false);
    rmdirSync(join(folder, `${id}.partial`));
    writeFileSync(join(folder, `${id}.partial`), 'SAVED BODY\n');
    await relayOutboxes(dir, 's', ['keeper'], sources);
    expect(JSON.parse(readFileSync(join(folder, `${id}.result.json`), 'utf8')).out).toBe('SAVED BODY\n');
  });
});

test('E5 round 3: saved output whose stat fails with EIO is kept with its take, and answered once it reads', async () => {
  const { dir } = team();
  const folder = outboxFolder(dir, 's', 'keeper')!;
  mkdirSync(folder, { recursive: true });
  const id = '00000000-0000-4000-8000-0000000000f2';
  const taking = join(folder, `${id}.taking`);
  writeFileSync(taking, '{}');
  const old = new Date(Date.now() - 6 * 60_000);
  utimesSync(taking, old, old);
  const partial = join(folder, `${id}.partial`);
  writeFileSync(partial, 'SAVED BODY\n');
  const failing = (path: string) => {
    if (path === partial) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return lstatSync(path);
  };
  await relayOutboxes(dir, 's', ['keeper'], { ...relayWith(async () => ({ code: 0, out: '', err: '' })), stat: failing });
  expect(existsSync(taking)).toBe(true);
  expect(readFileSync(partial, 'utf8')).toBe('SAVED BODY\n');
  await relayOutboxes(dir, 's', ['keeper'], relayWith(async () => ({ code: 0, out: '', err: '' })));
  expect(JSON.parse(readFileSync(join(folder, `${id}.result.json`), 'utf8')).out).toBe('SAVED BODY\n');
});
