// `team trace <id>` reads one message's signed steps back from the receiving team's event log:
// the send's staging, every leg the walk tried, the bus's arrival and the seat's receipts, in
// the log's own order, each with the quiet time from the step above it.
//
// The team is a synthetic world under a temp folder, as the send-step scenes build it: the
// socket is an empty file the fake receiver's declaration points at. No live seat is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { runTrace } from '../src/commands/trace.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { storePath } from '../src/store/store.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

/** The team file with an entity and that entity's lobby in its trust list, so the frame carries
 *  an owner-reply target: without one the socket leg is skipped and the story is a typed leg. */
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

/** The id a closing line carries: the last line's ` (id <uuid>)` tail. */
function idOf(text: string): string {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const match = / \(id ([0-9a-f-]{36})\)$/.exec(last);
  if (match === null) throw new Error(`the closing line names no id: ${last}`);
  return match[1]!;
}

/** One socket send into a fresh accepting team, and the id it filed its steps under: staging and
 *  the one leg the walk took. */
async function socketSend(): Promise<{ at: World; id: string }> {
  made = world(null);
  declareEntity(made);
  declareSocket(made);
  const io = owner(made.root);
  const code = await runSend(['lead', 'hello'], io, fake(made));
  expect(code, io.err).toBe(0);
  return { at: made, id: idOf(io.out) };
}

describe('team trace reads one message story out of the receiving team log', () => {
  test('the table names every step in order, with the quiet time between them', async () => {
    const { at, id } = await socketSend();

    const io = owner(at.root);
    const code = await runTrace([id], io, { home: at.home });

    expect(code, io.err).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines[0]).toBe('team acme, session "acme"');
    expect(lines[1]?.trim()).toMatch(/^TIME\s+STEP\s+VIA\s+OUTCOME\s+MS\s+DELTA\s+NOTE$/);
    expect(lines.at(-1)).toBe('2 steps');
    const rows = lines.slice(2, -1).map((row) => row.trim().split(/ {2,}/));
    expect(rows).toHaveLength(2);
    // The staged step carries no route, no outcome, no cost, no note, and no step above it.
    expect(rows[0]).toEqual(['04:00:00.000', 'message.staged', '-', '-', '-', '-', '-']);
    // Both stamps are the fixture's pinned instant, so the second step follows the first in 0 ms.
    const leg = rows[1]!;
    expect(leg.slice(0, 4)).toEqual(['04:00:00.000', 'leg.tried', 'socket', 'delivered']);
    expect(leg[4]).toMatch(/^\d+$/);
    expect(leg.slice(5)).toEqual(['0 ms', '-']);
    expect(io.err).toBe('');
  });

  test('--json is one document: the steps, their record ids and their deltas', async () => {
    const { at, id } = await socketSend();
    // The bus's own arrival for the same record: the bare id, a step of the same story.
    const arrived = appendEvent('acme', at.root, at.home, {
      ts: '2026-10-05T04:00:00.500Z',
      kind: 'message.arrived',
      session: 'acme',
      record_id: id,
      from: 'owner',
      to: 'lead',
    });
    expect(arrived.ok).toBe(true);

    const io = owner(at.root);
    const code = await runTrace([id, '--json'], io, { home: at.home });

    expect(code, io.err).toBe(0);
    const doc = JSON.parse(io.out) as {
      schema: { name: string; version: number };
      id: string;
      summary: string;
      unverified: number;
      steps: { kind: string; record_id: string; seq: number; delta_ms: number | null; via?: string; outcome?: string; ms?: number }[];
    };
    expect(doc.schema).toEqual({ name: 'team.trace', version: 1 });
    expect(doc.id).toBe(id);
    expect(doc.summary).toBe('3 steps');
    expect(doc.unverified).toBe(0);
    expect(doc.steps.map((step) => step.kind)).toEqual(['message.staged', 'leg.tried', 'message.arrived']);
    expect(doc.steps.map((step) => step.record_id)).toEqual([`${id}:staged`, `${id}:leg.tried:socket`, id]);
    expect(doc.steps[0]?.delta_ms).toBeNull();
    expect(doc.steps[1]?.delta_ms).toBe(0);
    expect(doc.steps[2]?.delta_ms).toBe(500);
    expect(doc.steps[1]).toMatchObject({ via: 'socket', outcome: 'delivered' });
    expect(typeof doc.steps[1]?.ms).toBe('number');
    // The sequence is the log's own, in the order it was written.
    const seqs = doc.steps.map((step) => step.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test('a full step id prints that one step; the bare id prints the story', async () => {
    const { at, id } = await socketSend();

    const io = owner(at.root);
    expect(await runTrace([`${id}:staged`], io, { home: at.home }), io.err).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('1 step');
    expect(lines).toHaveLength(4); // the context line, the header, the one row, the count
    expect(lines[2]).toContain('message.staged');
  });

  test('an id the log holds no step for is an empty answer, and exit 1', async () => {
    made = world(null);
    const io = owner(made.root);
    const missing = '11111111-1111-4111-8111-111111111111';

    const code = await runTrace([missing], io, { home: made.home });

    expect(code).toBe(1);
    expect(io.out).toBe('team acme, session "acme"\n0 steps\n');
    expect(io.err).toBe(`team trace: no step is filed under ${missing} in this team's event log\n`);

    const json = owner(made.root);
    expect(await runTrace([missing, '--json'], json, { home: made.home })).toBe(1);
    const doc = JSON.parse(json.out) as { steps: unknown[]; summary: string };
    expect(doc).toMatchObject({ steps: [], summary: '0 steps' });
    expect(json.err).toBe('');
  });

  test('the invocation is refused with the usage, and a --json run answers with the error document', async () => {
    made = world(null);
    const io = owner(made.root);

    expect(await runTrace([], io, { home: made.home })).toBe(2);
    expect(io.err).toContain('team trace: a message id is required\nUsage: team trace <id> [--json]');

    const bad = owner(made.root);
    expect(await runTrace(['not/a/message:id'], bad, { home: made.home })).toBe(2);
    expect(bad.err).toContain('is not a message id');

    const json = owner(made.root);
    expect(await runTrace(['--json'], json, { home: made.home })).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ schema: { name: 'team.error' }, error: { id: 'trace.usage' } });
  });

  test('a log the read cannot verify is refused, never repaired into a trace', async () => {
    made = world(null);
    mkdirSync(join(storePath('acme', made.root, made.home), 'events.jsonl'), { recursive: true });

    const io = owner(made.root);
    const code = await runTrace(['11111111-1111-4111-8111-111111111111'], io, { home: made.home });

    expect(code).toBe(1);
    expect(io.err).toBe('team trace: the event log cannot be read: the event log path is a directory\n');
    expect(io.out).toBe('');
  });
});
