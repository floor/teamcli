// Seat-to-client replies end to end, on temporary homes only: the owner issues an `--inbox` grant,
// the client's signed send opens a thread, the recipient seat answers it with `team reply`, and
// the client reads and acks the answer with `team messages --client`. A thread that ends while
// the reply waits for the publication locks is refused and nothing is written.

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientInboxFolder } from '../src/client/inbox.ts';
import { clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runMessages } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const THREAD = '88888888-8888-4888-8888-888888888888';
const REPLY = '77777777-7777-4777-8777-777777777777';
const SEAT = { kind: 'seat', name: 'orchestrator', pane: 'w1:p1', session: 'acme' } as const;

const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; grantPath: string; keyPath: string };

/** A team checkout and a temp HOME with the orchestrator registered, and an `--inbox` grant the
 *  owner issued through `team grant`. */
async function world(): Promise<World> {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.team-client-reply-')));
  made.push(base);
  // The checkout sits in the OS temp folder; the HOME may not, since a client key refuses to
  // live under it.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'team-client-reply-')));
  made.push(outside);
  const root = join(outside, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  keyOf(home);
  const teamId = teamIdOf(root);
  const agent = registerAgent(home, {
    name: 'Orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: teamId, seat: 'orchestrator', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  upsertTeam(home, teamId, {
    project: 'floor',
    entity: 'floor',
    session: 'acme',
    root,
    lobby: join(base, 'lobby'),
    roster: [{ agent: agent.id, seat: 'orchestrator', role: 'orchestrator', leads: true }],
    lifecycle: 'running',
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { orchestrator: { stage: 'ready' as const, pane: 'w1:p1' } } } as never;
  });
  const keyDir = clientKeyDir(home, 'grok-bot');
  const keys = writeClientKeyFiles(keyDir, newClientKeyPair());
  if (!keys.ok) throw new Error(keys.why);

  const io = testIo(root, { kind: 'owner' });
  const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', keys.pubPath, '--inbox'], io, { home });
  expect(io.err).not.toMatch(/refused|cannot|invalid/);
  expect(code).toBe(0);
  const grantPath = /^grant file: (.+)$/m.exec(io.out)?.[1];
  if (grantPath === undefined) throw new Error(`no grant file in: ${io.out}`);
  return { base, root, home, grantPath, keyPath: keys.keyPath };
}

async function clientSend(w: World, now: () => Date): Promise<void> {
  const io = testIo(w.root, { kind: 'owner' });
  const host = { home: w.home, now, sendId: () => THREAD } as unknown as SendHost;
  const code = await runSend(['--client', w.grantPath, '--key', w.keyPath, 'orchestrator@floor', 'what is the status?'], io, host);
  expect(io.err).not.toMatch(/refused|cannot|invalid/);
  expect(code).toBe(0);
}

test('a seat answers a client thread and the client reads and acks the reply', async () => {
  const w = await world();
  const now = () => new Date();
  await clientSend(w, now);

  const seat = testIo(w.root, SEAT);
  const replied = await runReply([THREAD, 'all green, shipping today'], seat, { home: w.home, now, newId: () => REPLY });
  expect(seat.err).toBe('');
  expect(replied).toBe(0);
  expect(seat.out).toContain('client:grok-bot: replied');
  const inbox = clientInboxFolder(w.root, 'acme', 'grok-bot');
  expect(readdirSync(inbox)).toContain(REPLY);

  const read = testIo(w.root);
  const shown = await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--json'], read, { home: w.home, now });
  expect(read.err).not.toMatch(/refused|cannot|invalid/);
  expect(shown).toBe(0);
  expect(read.out).toContain('all green, shipping today');
  expect(read.out).toContain(REPLY);

  const ack = testIo(w.root);
  const acked = await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--ack', REPLY], ack, { home: w.home, now });
  expect(ack.err).not.toMatch(/refused|cannot|invalid/);
  expect(acked).toBe(0);

  const again = testIo(w.root);
  expect(await runMessages(['--client', w.grantPath, '--key', w.keyPath, '--since', REPLY], again, { home: w.home, now })).toBe(0);
  expect(again.out).not.toContain('all green, shipping today');
});

test('a thread that ends while the reply waits for the locks is refused under them', async () => {
  const w = await world();
  const start = Date.now();
  let clock = start;
  const now = () => new Date(clock);
  await clientSend(w, now);

  // The id is drawn after the pre-lock thread check and before the locks are taken: moving the
  // clock past the thread's 72h life there is a thread that ended during the wait.
  const seat = testIo(w.root, SEAT);
  const code = await runReply([THREAD, 'too late'], seat, {
    home: w.home,
    now,
    newId: () => {
      clock = start + 73 * 3_600_000;
      return REPLY;
    },
  });
  expect(code).toBe(1);
  expect(seat.out).not.toContain('replied');
  expect(seat.err).toContain('nothing was written');
  expect(seat.err).toContain('never reopened');
  const inbox = clientInboxFolder(w.root, 'acme', 'grok-bot');
  expect(existsSync(inbox) ? readdirSync(inbox) : []).not.toContain(REPLY);
});
