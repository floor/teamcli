// `team trace` and `team raise` read the retained log through the sealed segments' signed
// indexes: only the record-id or kind candidates' own lines are read, and a sealed segment whose
// index names no candidate is never opened. A tampered line the index did not name is not read at
// all; a tampered line it did name sends the read through the ordinary verified full read, so a
// forged payload is never returned. `team raise` counts its day's raises from the signed index
// while the sealed bytes behind the count stay sealed. A segment with no trusted seal sends both
// reads through the ordinary verified path, and their answers are unchanged.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { EventKind } from '../src/bus/kinds.ts';
import { appendEvent, eventLogPath } from '../src/bus/log.ts';
import { RAISES_PER_DAY, runRaise, type RaiseSources } from '../src/commands/raise.ts';
import { runTrace } from '../src/commands/trace.ts';
import { sealPathOf } from '../src/bus/seal.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
// The fixture rotates at 50 KB with four slots; the readers read the team's own bound (a hundred
// slots at the one-megabyte segment word), which is only a bound, so the two agree on the files.
const MAX_BYTES = 50_000;
const KEPT = 4;

const TEAM_YAML = `format: 1
project: acme
session: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane1', session: 'acme' };

type World = { root: string; home: string };

const dirs: string[] = [];

afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `trace-raise-sealed-${name}-`)));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.seats['lead'] = { stage: 'ready', pane: 'pane1' };
  });
  return { root, home };
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function append(world: World, kind: EventKind, id: string, reason?: string): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind,
    session: 'acme',
    record_id: id,
    from: 'lead',
    to: 'builder',
    ...(reason === undefined ? {} : { reason }),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

/** Padded filler until the fixture rotation creates `slot`, so the records written before it sit
 *  in a sealed segment and the newest records sit in one or two newer ones. */
function fillUntil(world: World, slot: number, prefix: string): void {
  for (let n = 1; n <= 900; n += 1) {
    append(world, 'message.arrived', `${prefix}-${String(n)}`, 'x'.repeat(200));
    if (existsSync(`${livePath(world)}.${String(slot)}`)) return;
  }
  throw new Error(`the fixture never sealed slot ${String(slot)}`);
}

/** One record's own line in a sealed segment, rewritten at the same length with a signature the
 *  key does not hold: the segment's size and index still match the seal, so only a reader that
 *  checks the line's own signature can tell. */
function tamper(path: string, recordId: string): void {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(`"record_id":"${recordId}"`));
  if (at < 0) throw new Error(`no line for ${recordId}`);
  const line = lines[at] as string;
  const signature = (JSON.parse(line) as { signature: string }).signature;
  // A hex signature is case-insensitive, so the forge must change a digit's value, not its case.
  const flipped = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
  lines[at] = line.replace(`"signature":"${signature}"`, `"signature":"${flipped}"`);
  writeFileSync(path, lines.join('\n'));
}

type Traced = { code: number; ids: string[]; unverified: number; err: string };

async function trace(world: World, id: string): Promise<Traced> {
  const io = testIo(world.root, { kind: 'owner' });
  const code = await runTrace([id, '--json'], io, { home: world.home });
  let ids: string[] = [];
  let unverified = -1;
  try {
    const doc = JSON.parse(io.out) as { steps?: { record_id: string }[]; unverified?: number };
    ids = (doc.steps ?? []).map((step) => step.record_id);
    unverified = doc.unverified ?? -1;
  } catch {
    // An error document, or none: the caller reads the code and stderr.
  }
  return { code, ids, unverified, err: io.err };
}

async function raise(world: World, text: string): Promise<{ code: number; err: string }> {
  const io = testIo(world.root, LEAD);
  const sources: RaiseSources = { home: world.home, now: () => NOW, notify: () => {} };
  const code = await runRaise(['release.ready', text], io, sources);
  return { code, err: io.err };
}

function steps(world: World): void {
  append(world, 'message.staged', 'msg-a:staged', 'staged');
  append(world, 'leg.tried', 'msg-a:leg.tried:bus', 'bus');
  append(world, 'message.arrived', 'msg-a', 'arrived');
}

const STEPS = ['msg-a:staged', 'msg-a:leg.tried:bus', 'msg-a'];

describe('trace and raise read the sealed history through its indexes', () => {
  test('a sealed segment whose index names no step is never opened', async () => {
    const world = makeWorld('unread');
    steps(world);
    // The steps are sealed into `.1`; one more rotation leaves only filler in `.1`, so the steps
    // sit in `.2` and the segment a full read would trip over holds none of them.
    fillUntil(world, 1, 'fill-a');
    fillUntil(world, 2, 'fill-b');
    chmodSync(`${livePath(world)}.1`, 0o000);

    const ran = await trace(world, 'msg-a');
    expect(ran.code).toBe(0);
    expect(ran.ids).toEqual(STEPS);
    expect(ran.unverified).toBe(0);
  });

  test('a tampered line the index did not name is not read at all', async () => {
    const world = makeWorld('other-line');
    steps(world);
    fillUntil(world, 1, 'fill-a');
    tamper(`${livePath(world)}.1`, 'fill-a-1');

    const ran = await trace(world, 'msg-a');
    expect(ran.code).toBe(0);
    expect(ran.ids).toEqual(STEPS);
    // The steps' lines all verify; the forged filler line is not a candidate, so it is not read.
    expect(ran.unverified).toBe(0);
  });

  test('a tampered line the index named sends the read through the verified full read', async () => {
    const world = makeWorld('step-line');
    steps(world);
    fillUntil(world, 1, 'fill-a');
    tamper(`${livePath(world)}.1`, 'msg-a:staged');

    const ran = await trace(world, 'msg-a');
    expect(ran.code).toBe(0);
    // The forged payload is never returned, and the read says it skipped an unverified record.
    expect(ran.ids).toEqual(['msg-a:leg.tried:bus', 'msg-a']);
    expect(ran.unverified).toBe(1);
  });

  test('a segment with no trusted seal reads through the ordinary path, answer unchanged', async () => {
    const world = makeWorld('unsealed');
    steps(world);
    fillUntil(world, 1, 'fill-a');
    rmSync(sealPathOf(`${livePath(world)}.1`), { force: true });

    const ran = await trace(world, 'msg-a');
    expect(ran.code).toBe(0);
    expect(ran.ids).toEqual(STEPS);
    expect(ran.unverified).toBe(0);
  });

  test("raise counts the day's raises from the index, sealed bytes behind the count unread", async () => {
    const world = makeWorld('raise-cap');
    for (let n = 1; n <= RAISES_PER_DAY; n += 1) {
      append(world, 'release.ready', `raise-${String(n)}`, `line ${String(n)}`);
    }
    // One rotation seals the raises into `.1`; a second leaves only filler in `.1`, so the raises
    // are in `.2` and the count's candidate lines stay readable while `.1` is not.
    fillUntil(world, 1, 'fill-a');
    fillUntil(world, 2, 'fill-b');
    chmodSync(`${livePath(world)}.1`, 0o000);

    const ran = await raise(world, 'the line past the cap');
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('ten raises have reached the owner today');
    expect(ran.err).not.toContain("can't be read");
  });
});
