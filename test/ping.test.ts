import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import { idOf, legOf, runPing, type PingHost } from '../src/commands/ping.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_R = '33333333-3333-4333-8333-333333333333';

function io(cwd: string): Io & { out: string; err: string } {
  const sink = { out: '', err: '' };
  return Object.assign(sink, {
    stdout: (text: string) => { sink.out += text; },
    stderr: (text: string) => { sink.err += text; },
    cwd,
    env: {},
    stdinIsTTY: false,
  }) as Io & { out: string; err: string };
}

/** A team root with three seats: `worker` reads and replies, `tester` never reads, `stranger` is refused. */
function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ping-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), 'project: acme\n');
  let clock = 1_000;
  const sent: string[][] = [];
  const host: PingHost = {
    home: root,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    team: async (args) => {
      sent.push(args);
      if (args[0] === 'seats') {
        return { code: 0, out: JSON.stringify({ session: 'acme', seats: [{ name: 'worker' }, { name: 'tester' }, { name: 'stranger' }] }) };
      }
      clock += 400;
      const to = args[1];
      if (to === 'worker') {
        const dir = join(root, '.agents', 'send-drops', 'acme', 'worker');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${ID_A}.read.json`), JSON.stringify({ payload: { at: new Date(clock + 2_000).toISOString() } }));
        // The worker's answer: a reply on the message's thread, in the caller's own folder.
        const mine = join(root, '.agents', 'send-drops', 'acme', 'lead');
        mkdirSync(mine, { recursive: true });
        writeFileSync(join(mine, ID_R), JSON.stringify({ payload: { kind: 'message', id: ID_R, thread: ID_A, at: new Date(clock + 5_000).toISOString() } }));
        return { code: 0, out: `worker: delivered (socket) (id ${ID_A})\n` };
      }
      if (to === 'tester') return { code: 0, out: `team send: tester: not delivered: no live route; kept in tester's inbox (id ${ID_B})\n` };
      return { code: 1, out: 'team send: refused: no rule admits this seat to stranger\n' };
    },
  };
  return { root, host, sent };
}

describe('team ping', () => {
  test('outcome lines: the leg and the id', () => {
    expect(legOf(`w: delivered (socket) (id ${ID_A})`)).toBe('socket');
    expect(legOf(`iris: delivered (typed wake, 7407 ms; id ${ID_A})`)).toBe('typed wake');
    expect(legOf(`team send: t: not delivered: no live route; kept in t's inbox (id ${ID_A})`)).toBe('inbox');
    expect(idOf(`x (id ${ID_B})`)).toBe(ID_B);
    expect(idOf('team send: refused: no rule')).toBeNull();
  });

  test('--all: one ordinary send per seat, read rows, unread rows and refusals; exit 1', async () => {
    const { root, host, sent } = scene();
    const out = io(root);
    const code = await runPing(['--all', '--wait', '5', '--json'], out, host);
    expect(code).toBe(1);
    expect(sent.filter((args) => args[0] === 'send').map((args) => args[1]).sort()).toEqual(['stranger', 'tester', 'worker']);
    const doc = JSON.parse(out.out) as { rows: { seat: string; status: string; leg: string | null; read_ms: number | null; reply_sent_ms: number | null }[]; all_replied: boolean };
    const bySeat = Object.fromEntries(doc.rows.map((row) => [row.seat, row]));
    expect(bySeat.worker).toMatchObject({ status: 'replied', leg: 'socket' });
    expect(bySeat.worker!.read_ms).toBeGreaterThan(0);
    expect(bySeat.worker!.reply_sent_ms).toBeGreaterThan(bySeat.worker!.read_ms!);
    expect(bySeat.tester).toMatchObject({ status: 'not read', leg: 'inbox', read_ms: null, reply_sent_ms: null });
    expect(bySeat.stranger).toMatchObject({ status: 'refused', leg: null });
    expect(doc.all_replied).toBe(false);
  });

  test('one seat that replies: exit 0 and its stage line', async () => {
    const { root, host } = scene();
    const out = io(root);
    expect(await runPing(['worker'], out, host)).toBe(0);
    expect(out.out).toMatch(/^worker: send 0\.4 s \(socket\); read 2\.\d s; reply sent 5\.\d s, landed \d+\.\d s\n$/);
  });

  test('usage: neither a seat nor --all, both, or a bad wait', async () => {
    const { root, host } = scene();
    for (const argv of [[], ['--all', 'worker'], ['worker', '--wait', 'soon']]) {
      const out = io(root);
      expect(await runPing(argv, out, host)).toBe(2);
      expect(out.err).toContain('team ping:');
    }
  });
});
