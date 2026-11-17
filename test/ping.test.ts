import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import { idOf, legOf, runPing, type PingHost } from '../src/commands/ping.ts';
import { recordTextOf, signReceiptPayload, signRecord, type RecordPayload } from '../src/send/record.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertTeam } from '../src/registry/teams.ts';

const AT = '2026-11-17T09:00:00.000Z';
const IDS = {
  worker: '11111111-1111-4111-8111-111111111111',
  tester: '22222222-2222-4222-8222-222222222222',
  quiet: '44444444-4444-4444-8444-444444444444',
};
const AGENT = { lead: 'agt_000000000001', worker: 'agt_000000000002', tester: 'agt_000000000003', quiet: 'agt_000000000004' };

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

type Answer = 'reply' | 'unsigned-reply' | 'bad-signature' | 'wrong-sender' | 'wrong-recipient' | 'unsigned-receipt' | 'none';

/**
 * Team `alpha` is registry-only: no `.agents/team.yaml` anywhere. The caller runs from team
 * `beta`'s folder (a team file, another session), while its seat `lead` is `alpha`'s: the reply
 * lands in `alpha`'s folder, found by the sender's signed agent id, never by the folder.
 * Each target answers the way `answers` says.
 *
 * `owner`: the owner sends (no sender agent id), and the entity `floor` declares its
 * `owner-reply-to` endpoint as `inbox@hq`, a seat of another team: a reply lands in `hq`'s
 * folder for `inbox`, with `inbox`'s agent id, the way `team reply` writes it.
 */
function scene(answers: Record<string, Answer>, owner = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ping-')));
  const home = join(base, 'h');
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(alpha, '.agents'), { recursive: true });
  mkdirSync(join(beta, '.agents'), { recursive: true });
  writeFileSync(join(beta, '.agents', 'team.yaml'), 'project: beta\nsession: beta\n');
  upsertTeam(home, 't-alpha', {
    project: 'alpha',
    ...(owner ? { entity: 'floor' } : {}),
    session: 'alpha',
    root: alpha,
    at: AT,
    roster: Object.entries(AGENT).map(([seat, agent]) => ({ agent, seat, role: 'worker' })),
  });
  upsertTeam(home, 't-beta', { project: 'beta', session: 'beta', root: beta, at: AT, roster: [] });
  const hq = join(base, 'hq');
  let inboxId: string | null = null;
  if (owner) {
    mkdirSync(hq, { recursive: true });
    const inbox = registerAgent(home, {
      name: 'inbox of hq',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test-lab',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: 'hq', seat: 'inbox', session: 'hq', pane: 'pane-inbox', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    inboxId = inbox.id;
    upsertTeam(home, 'hq', {
      project: 'hq', entity: 'floor', session: 'hq', root: hq, lobby: lobbyDir(home), at: AT,
      roster: [{ agent: inbox.id, seat: 'inbox', role: 'implementer' }], lifecycle: 'running', by: 'up',
    });
    const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-reply-to', value: 'inbox@hq' }, { now: new Date(AT) });
    if (!wrote.ok) throw new Error(wrote.why);
  }
  const endpointDrop = () => {
    const dir = join(hq, '.agents', 'send-drops', 'hq', 'inbox');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  // The fake clock starts at the real one: a reply counts from the files it finds newer than the run.
  let clock = Date.now();
  const drop = (seat: string) => {
    const dir = join(alpha, '.agents', 'send-drops', 'alpha', seat);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const record = (patch: Partial<RecordPayload>): RecordPayload => ({
    kind: 'message', id: '', to: '', to_id: null, root: alpha, session: 'alpha', at: new Date(clock).toISOString(),
    body: '', from: '', from_id: null, rule: 'test', thread: '', ...patch,
  } as RecordPayload);
  const host: PingHost = {
    home,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    team: async (args) => {
      if (args[0] === 'seats') return { code: 0, out: JSON.stringify({ session: 'alpha', seats: Object.keys(answers).map((name) => ({ name })) }) };
      const seat = args[1]!;
      const token = /ping (P[0-9a-z]+)/.exec(args[2]!)![1]!;
      const id = IDS[seat as keyof typeof IDS];
      clock += 400;
      const sent = signRecord(record({
        id, thread: id, to: seat, to_id: AGENT[seat as keyof typeof AGENT],
        from: owner ? 'owner' : 'lead', from_id: owner ? null : AGENT.lead,
        body: `from ${owner ? 'the owner' : 'lead'} — admitted by: test\n\n${args[2]}`,
      }), home);
      writeFileSync(join(drop(seat), id), recordTextOf(sent));
      const answer = answers[seat]!;
      if (answer !== 'none') {
        const receipt = { kind: 'receipt' as const, status: 'read' as const, id, to: seat, root: alpha, session: 'alpha', at: new Date(clock + 1_000).toISOString() };
        writeFileSync(join(drop(seat), `${id}.read.json`), answer === 'unsigned-receipt'
          ? JSON.stringify({ payload: receipt, signature: 'x' })
          : JSON.stringify(signReceiptPayload(receipt, home)));
      }
      const replyId = `9${id.slice(1)}`;
      const reply = record({
        id: replyId, thread: id, in_reply_to: id, at: new Date(clock + 3_000).toISOString(),
        from: answer === 'wrong-sender' ? 'quiet' : seat,
        from_id: answer === 'wrong-sender' ? AGENT.quiet : AGENT[seat as keyof typeof AGENT],
        ...(owner ? { root: hq, session: 'hq', to: 'inbox', to_id: inboxId } : { to: 'lead', to_id: AGENT.lead }),
        // The right seat name with another agent's id: not the destination's recipient.
        ...(answer === 'wrong-recipient' ? { to_id: AGENT.quiet } : {}),
        body: `from ${seat} — admitted by: test\n\npong ${token}`,
      });
      if (owner && (answer === 'reply' || answer === 'wrong-sender' || answer === 'wrong-recipient')) {
        writeFileSync(join(endpointDrop(), replyId), recordTextOf(signRecord(reply, home)));
      } else if (answer === 'reply' || answer === 'wrong-sender' || answer === 'wrong-recipient' || answer === 'unsigned-receipt') {
        writeFileSync(join(drop('lead'), replyId), recordTextOf(signRecord(reply, home)));
      } else if (answer === 'unsigned-reply') {
        writeFileSync(join(drop('lead'), replyId), JSON.stringify({ payload: reply, signature: 'not a signature' }, null, 2));
      } else if (answer === 'bad-signature') {
        const signed = JSON.parse(recordTextOf(signRecord(reply, home))) as { payload: RecordPayload };
        signed.payload.body = `${signed.payload.body} (changed)`;
        writeFileSync(join(drop('lead'), replyId), JSON.stringify(signed, null, 2));
      }
      return { code: 0, out: `${seat}: delivered (socket) (id ${id})\n` };
    },
  };
  return { home, alpha, beta, host };
}

async function rows(answers: Record<string, Answer>, argv: string[] = ['--all', '--wait', '2', '--json'], owner = false) {
  const { beta, host } = scene(answers, owner);
  const out = io(beta);
  const code = await runPing(argv, out, host);
  const doc = JSON.parse(out.out) as { rows: { seat: string; status: string; read_ms: number | null; reply_sent_ms: number | null }[]; all_replied: boolean };
  return { code, doc, by: Object.fromEntries(doc.rows.map((row) => [row.seat, row])) };
}

describe('team ping', () => {
  test('outcome lines: the leg and the id', () => {
    expect(legOf(`w: delivered (socket) (id ${IDS.worker})`)).toBe('socket');
    expect(legOf(`iris: delivered (typed wake, 7407 ms; id ${IDS.worker})`)).toBe('typed wake');
    expect(legOf(`team send: t: not delivered: no live route; kept in t's inbox (id ${IDS.worker})`)).toBe('inbox');
    expect(idOf(`x (id ${IDS.tester})`)).toBe(IDS.tester);
    expect(idOf('team send: refused: no rule')).toBeNull();
  });

  test('registry-only team, run from another team\'s folder: a verified reply is found in the sender\'s own folder', async () => {
    const { code, by } = await rows({ worker: 'reply' });
    expect(code).toBe(0);
    expect(by.worker).toMatchObject({ status: 'replied' });
    expect(by.worker!.read_ms).toBeGreaterThan(0);
    expect(by.worker!.reply_sent_ms).toBeGreaterThan(by.worker!.read_ms!);
  });

  test('an unsigned reply, a reply whose signature does not cover it, a reply from another seat and one to another agent do not count', async () => {
    for (const answer of ['unsigned-reply', 'bad-signature', 'wrong-sender', 'wrong-recipient'] as const) {
      const { code, by } = await rows({ worker: answer });
      expect(code).toBe(1);
      expect(by.worker).toMatchObject({ status: 'read', reply_sent_ms: null });
    }
  });

  test('an owner ping: the reply at the owner-reply-to endpoint (another team\'s seat) counts; one from another seat or to another agent does not', async () => {
    const answered = await rows({ worker: 'reply' }, undefined, true);
    expect(answered.code).toBe(0);
    expect(answered.by.worker).toMatchObject({ status: 'replied' });
    for (const answer of ['wrong-sender', 'wrong-recipient'] as const) {
      const impostor = await rows({ worker: answer }, undefined, true);
      expect(impostor.code).toBe(1);
      expect(impostor.by.worker).toMatchObject({ status: 'read', reply_sent_ms: null });
    }
  });

  test('an unsigned receipt is no read; no answer at all is not read', async () => {
    const unsigned = await rows({ worker: 'unsigned-receipt' });
    expect(unsigned.by.worker!.read_ms).toBeNull();
    const none = await rows({ tester: 'none' });
    expect(none.code).toBe(1);
    expect(none.by.tester).toMatchObject({ status: 'not read', read_ms: null, reply_sent_ms: null });
  });

  test('a refused send is a refused row', async () => {
    const { beta, host } = scene({ worker: 'reply' });
    const refusing: PingHost = { ...host, team: async () => ({ code: 1, out: 'team send: refused: no rule admits this seat to worker\n' }) };
    const out = io(beta);
    expect(await runPing(['worker'], out, refusing)).toBe(1);
    expect(out.out).toContain('refused: refused: no rule admits');
  });

  test('usage: neither a seat nor --all, both, or a bad wait', async () => {
    const { beta, host } = scene({});
    for (const argv of [[], ['--all', 'worker'], ['worker', '--wait', 'soon']]) {
      const out = io(beta);
      expect(await runPing(argv, out, host)).toBe(2);
      expect(out.err).toContain('team ping:');
    }
  });
});

describe('team ping child boundary', () => {
  test('the send child inherits the caller\'s standard input; nothing replaces it', () => {
    // A runner process whose standard input is a known file calls `runChild`; the child reports
    // the identity of its own standard input. Inherited, it is that same file. The real boundary
    // is the one a terminal crosses: replacing stdin would drop the owner's terminal.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ping-child-')));
    const input = join(dir, 'stdin.txt');
    writeFileSync(input, 'x');
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, "import { fstatSync } from 'node:fs'; const s = fstatSync(0); process.stdout.write(`${s.dev}:${s.ino}`);\n");
    const runner = join(dir, 'runner.ts');
    const ping = join(import.meta.dir, '..', 'src', 'commands', 'ping.ts');
    writeFileSync(runner, `import { runChild } from ${JSON.stringify(ping)};
const r = await runChild([process.execPath, ${JSON.stringify(probe)}], [], { cwd: ${JSON.stringify(dir)}, env: process.env, stdinIsTTY: false, stdout() {}, stderr() {} });
process.stdout.write(r.out);
`);
    const fd = openSync(input, 'r');
    try {
      const out = execFileSync(process.execPath, [runner], { stdio: [fd, 'pipe', 'pipe'] }).toString();
      const want = fstatSync(fd);
      expect(out).toBe(`${want.dev}:${want.ino}`);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(input, 'utf8')).toBe('x');
  });
});
