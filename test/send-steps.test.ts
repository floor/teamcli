// One send, one story in the receiving team's signed event log.
//
// The record is staged, the receiving seat's webhook adapter is posted when its file declares one,
// and every leg the walk attempts is an event of its own with its outcome and its cost. The
// events are filed under the message id the send prints on its last line, so the line a sender
// quotes is the key to the trace; a step appended twice is one event, the second append reported
// as a duplicate.
//
// The team is a synthetic world under a temp folder: the socket is an empty file the fake
// receiver's declaration points at, and the webhook is a loopback listener. No live seat and no
// real adapter are touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents, type EventPayload } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { stagedStep } from '../src/send/steps.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let made: World | null = null;
const extras: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  made?.cleanup();
  made = null;
  for (const dir of extras.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. The frame's reader line names the record's own id, so the socket leg needs nothing
 *  about the entity's owner-reply target. */
function declareEntity(at: World, entity = 'floor'): void {
  const path = join(at.dir, 'team.yaml');
  const lobby = resolveLobby(at.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(at.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** The receiving seat's own `crossSessionInbound` declaration, and the empty file its pane
 *  exposes. The declaration predates the socket, so the session is one that read the policy. */
function declareSocket(at: World): void {
  const path = cliHookSettingsPath(at.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(at.sockets, '222.sock'), '');
  const past = Date.now() - 60_000;
  utimesSync(path, new Date(past), new Date(past));
}

/** The two files a seat row names for its webhook adapter: the routine's URL, and a 0600 secret
 *  only the POST carries. */
function hookFiles(url: string): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-steps-')));
  extras.push(base);
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, 'synthetic-secret-value\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

/** Every event filed under one message id, in the log's own (sequence) order. `message.arrived`
 *  names the id itself; every step is `<id>:<step>`. */
function stepsOf(at: World, id: string): EventPayload[] {
  const read = readEvents('acme', at.root, at.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events
    .map((one) => one.payload)
    .filter((payload) => payload.record_id === id || payload.record_id.startsWith(`${id}:`));
}

/** The id a closing line carries: the last line's ` (id <uuid>)` tail. */
function idOf(text: string): string {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const match = / \(id ([0-9a-f-]{36})\)$/.exec(last);
  if (match === null) throw new Error(`the closing line names no id: ${last}`);
  return match[1]!;
}

describe('the send files its steps under the id it prints', () => {
  test('a socket send prints its id on the last line and files staging and the leg under it', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    const io = owner(made.root);

    const code = await runSend(['lead', 'hello'], io, fake(made));

    expect(code, io.err).toBe(0);
    const id = idOf(io.out);
    expect(id).toMatch(UUID);
    expect(io.out.trimEnd().split('\n').at(-1)!.startsWith('lead: delivered (socket)')).toBe(true);

    const steps = stepsOf(made, id);
    expect(steps.map((step) => [step.kind, step.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:socket`],
    ]);
    // The step carries the record's own pair, session and thread, and the record's signed instant.
    expect(steps[0]).toMatchObject({ session: 'acme', from: 'owner', to: 'lead', thread: id, ts: expect.any(String) });
    expect(steps[1]).toMatchObject({ via: 'socket', outcome: 'delivered' });
    expect(typeof steps[1]!.ms).toBe('number');
    expect(steps[1]!.ms!).toBeGreaterThanOrEqual(0);
  });

  test('the --json face names the same id in its action summary and its ids', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    const io = owner(made.root);

    const code = await runSend(['lead', 'hello', '--json'], io, fake(made));

    expect(code, io.err).toBe(0);
    const doc = JSON.parse(io.out) as { ids: { sent: string }; action_summary: string };
    expect(doc.ids.sent).toMatch(UUID);
    expect(doc.action_summary).toBe(`lead: delivered (socket) (id ${doc.ids.sent})`);
    expect(stepsOf(made, doc.ids.sent).map((step) => step.kind)).toContain('message.staged');
  });

  test("the sender's own webhook post is one step with its status and cost", async () => {
    const hits: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        hits.push(new URL(request.url).pathname);
        return new Response('ok', { status: 201 });
      },
    });
    stops.push(() => server.stop(true));
    made = world(['drop'], [{ name: 'iris', role: 'remote', webhook: hookFiles(`http://127.0.0.1:${String(server.port)}/routine`) }]);
    const io = owner(made.root);

    const code = await runSend(['iris', 'the gate is green'], io, fake(made));

    expect(code, io.err).toBe(0);
    expect(hits).toEqual(['/routine']);
    const id = idOf(io.out);
    const steps = stepsOf(made, id);
    expect(steps.map((step) => step.kind)).toContain('message.staged');
    const post = steps.find((step) => step.kind === 'webhook.posted');
    expect(post).toBeDefined();
    expect(post!.record_id).toBe(`${id}:webhook.posted`);
    expect(post).toMatchObject({ session: 'acme', from: 'owner', to: 'iris', via: 'webhook', outcome: 'posted' });
    expect(typeof post!.ms).toBe('number');
    expect(post!.ms!).toBeGreaterThanOrEqual(0);
  });

  test('a step appended twice is one event, and the second append is reported as a duplicate', () => {
    made = world(null);
    const fields = {
      store: { project: 'acme', root: made.root, home: made.home },
      id: 'dedupe-1',
      session: 'acme',
      from: 'lead',
      to: 'native',
      ts: '2026-11-03T00:00:00.000Z',
    };

    const first = stagedStep(fields);
    const second = stagedStep(fields);

    expect(first).toEqual({ ok: true, duplicate: false });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(stepsOf(made, 'dedupe-1').map((step) => step.record_id)).toEqual(['dedupe-1:staged']);
  });
});
