// Start verification: the seals a rotation wrote are read, checked and chained without reading
// one byte of a sealed segment. A seal that is missing, altered or signed for another segment, a
// segment whose size no longer matches its seal, and an index that disagrees with the signed
// triple each mark their segment unsealed — and an unsealed segment breaks the chain of every
// newer seal, so nothing after it is trusted from a seal either. A segment with no seal at all
// (an older store) is unsealed too: a cost, never trust.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, EVENT_LOG_FILE, eventLogPath, verifyEventLogSeals } from '../src/bus/log.ts';
import {
  indexPathOf,
  keyPrintOfKey,
  sealDigestOf,
  sealPayloadOf,
  sealPathOf,
  SEAL_DOMAIN,
} from '../src/bus/seal.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { messageKeyOf, messageKeyState, signDomain } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const MAX_BYTES = 50_000;
const KEPT = 4;

const dirs: string[] = [];

afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

const TEAM_YAML = `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
`;

type World = { root: string; home: string; teamId: string };

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(`/private/tmp/bus-seal-verify-${name}-`));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const teamId = teamIdOf(root);
  const written = writePolicySet(
    home,
    { level: 'team', target: teamId, teamRoot: root, name: 'event-segment-mb', value: 1 },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
  return { root, home, teamId };
}

function appendPadded(world: World, id: string): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    reason: 'x'.repeat(200),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 900; index += 1) {
    appendPadded(world, `${prefix}-${String(index)}`);
    if (existsSync(`${livePath(world)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function verify(world: World) {
  return verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
}

describe('start verification trusts seals, never sealed bytes', () => {
  test('a healthy chain verifies by seal and index while the segment files stay unreadable', () => {
    const world = makeWorld('healthy');
    appendUntilSealed(world, 2, 'r');
    // The verifier may stat a sealed segment and read its sidecars, never its bytes: a file this
    // process cannot open still verifies.
    chmodSync(`${livePath(world)}.1`, 0o000);
    chmodSync(`${livePath(world)}.2`, 0o000);

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments.map((segment) => segment.name)).toEqual(['events.jsonl.2', 'events.jsonl.1']);
    expect(checked.segments.map((segment) => segment.state)).toEqual(['sealed', 'sealed']);
    expect(checked.problems).toEqual([]);
    const newer = checked.segments[1]!;
    const older = checked.segments[0]!;
    expect(newer.seal?.previous).toBe(older.seal?.sealDigest);
    const entries = newer.entries ?? [];
    expect(entries.length).toBe(newer.seal?.lines ?? -1);
    expect(entries[0]?.offset).toBe(0);
    expect(checked.open?.path).toBe(livePath(world));
  });

  test('an index that disagrees with the signed triple leaves its segment and every newer one unsealed', () => {
    const world = makeWorld('bad-index');
    appendUntilSealed(world, 2, 'r');
    const index = readFileSync(indexPathOf(`${livePath(world)}.2`), 'utf8');
    // Same length, same line count, one digit changed: only the signed digest can catch it.
    writeFileSync(indexPathOf(`${livePath(world)}.2`), index.replace('"seq":', '"seq":9'.slice(0, 8)));

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    const older = checked.segments[0]!;
    const newer = checked.segments[1]!;
    expect(older.name).toBe('events.jsonl.2');
    expect(older.state).toBe('unsealed');
    expect(older.why).toBe('index');
    expect(older.entries).toBeUndefined();
    expect(newer.state).toBe('unsealed');
    expect(newer.why).toBe('chain');
    expect(checked.problems.length).toBe(2);
  });

  test('a sealed segment whose size changed is unsealed, its successor with it', () => {
    const world = makeWorld('size');
    appendUntilSealed(world, 2, 'r');
    // The size check catches the edit without reading one byte of the sealed segment.
    writeFileSync(`${livePath(world)}.2`, readFileSync(`${livePath(world)}.2`));
    writeFileSync(`${livePath(world)}.1`, `${readFileSync(`${livePath(world)}.1`, 'utf8')} `);

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    const newer = checked.segments[1]!;
    expect(newer.name).toBe('events.jsonl.1');
    expect(newer.state).toBe('unsealed');
    expect(newer.why).toBe('size');
    // The older seal is untouched by its successor's size mismatch.
    expect(checked.segments[0]!.state).toBe('sealed');
  });

  test('a seal signed for another segment is never accepted, even under the real key', () => {
    const world = makeWorld('foreign');
    appendUntilSealed(world, 1, 'r');
    const key = messageKeyOf(world.home);
    const state = messageKeyState(world.home);
    if (state.kind !== 'key') throw new Error('the fixture has no message key');
    const text = readFileSync(sealPathOf(`${livePath(world)}.1`), 'utf8');
    const stored = JSON.parse(text) as Record<string, unknown>;
    const fields = { ...stored, segment: 'events.jsonl.9' } as Parameters<typeof sealDigestOf>[0];
    const sealDigest = sealDigestOf(fields);
    const signature = signDomain(SEAL_DOMAIN, sealPayloadOf(fields), key);
    writeFileSync(
      sealPathOf(`${livePath(world)}.1`),
      `${JSON.stringify({ ...sealPayloadOf(fields), sealDigest, signature })}\n`,
    );
    expect(keyPrintOfKey(key)).toBe(stored['keyPrint'] as string);

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    const segment = checked.segments[0]!;
    expect(segment.name).toBe('events.jsonl.1');
    expect(segment.state).toBe('unsealed');
    expect(segment.why).toBe('bad-seal');
  });

  test('a missing middle segment is a hole that breaks every newer seal', () => {
    const world = makeWorld('hole');
    appendUntilSealed(world, 3, 'r');
    rmSync(`${livePath(world)}.2`, { force: true });
    rmSync(sealPathOf(`${livePath(world)}.2`), { force: true });
    rmSync(indexPathOf(`${livePath(world)}.2`), { force: true });

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments.map((segment) => [segment.name, segment.state, segment.why])).toEqual([
      ['events.jsonl.3', 'sealed', undefined],
      ['events.jsonl.2', 'missing', undefined],
      ['events.jsonl.1', 'unsealed', 'chain'],
    ]);
    expect(checked.problems.some((problem) => problem.includes('events.jsonl.2'))).toBe(true);
  });

  test('a store written before seals existed reports every segment unsealed, never an error', () => {
    const world = makeWorld('old-store');
    appendUntilSealed(world, 1, 'r');
    for (const suffix of ['.seal.json', '.index.jsonl']) {
      rmSync(`${livePath(world)}.1${suffix}`, { force: true });
    }

    const checked = verify(world);
    if (!checked.ok) throw new Error(checked.reason);
    const segment = checked.segments[0]!;
    expect(segment.state).toBe('unsealed');
    expect(segment.why).toBe('no-seal');
    expect(checked.problems).toEqual([`${EVENT_LOG_FILE}.1: seal file is missing`]);
    // The open segment is still named, so the caller can read it through the ordinary path.
    expect(checked.open?.path).toBe(livePath(world));
  });
});
