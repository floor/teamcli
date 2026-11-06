// The release ships no entity-specific owner-reply address. An entity's own signed record sets
// it. With no record the answer is missing, and another entity's record is not that answer.
// Synthetic records only, in a throwaway home. Runs against builder-4's head.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveOwnerReplyTo, writePolicySet } from '../src/policy/index.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const NOW = new Date('2026-11-06T04:50:00.000Z');
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function homeOf(): string {
  const base = fixtureBase('owner-reply-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function declare(home: string, entity: string, value: string): void {
  const wrote = writePolicySet(
    home,
    { level: 'entity', target: entity, name: 'owner-reply-to', value },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
}

test('an entity with no record is missing, and another entity record is not used', () => {
  const home = homeOf();
  declare(home, 'lab', 'clerk@lab');

  const acme = resolveOwnerReplyTo(join(home, 'unused-root'), home, 'acme', NOW);
  expect(acme).toEqual({
    ok: false,
    entity: 'acme',
    reason: 'missing',
    why: expect.any(String),
  });
  expect(JSON.stringify(acme)).not.toContain('clerk@lab');
  expect(JSON.stringify(acme)).not.toContain('orchestrator@floor');

  const floor = resolveOwnerReplyTo(join(home, 'unused-root'), home, 'floor', NOW);
  expect(floor.ok).toBe(false);
  if (!floor.ok) expect(floor.reason).toBe('missing');
  expect(JSON.stringify(floor)).not.toContain('clerk@lab');
  expect(JSON.stringify(floor)).not.toContain('orchestrator@floor');

  const lab = resolveOwnerReplyTo(join(home, 'unused-root'), home, 'lab', NOW);
  expect(lab).toEqual({ ok: true, entity: 'lab', target: 'clerk@lab', source: 'policy' });
});

test('an entity own record sets its owner-reply address', () => {
  const home = homeOf();
  declare(home, 'acme', 'keeper@acme');
  declare(home, 'lab', 'clerk@lab');
  expect(resolveOwnerReplyTo(join(home, 'unused-root'), home, 'acme', NOW)).toEqual({
    ok: true,
    entity: 'acme',
    target: 'keeper@acme',
    source: 'policy',
  });
  expect(resolveOwnerReplyTo(join(home, 'unused-root'), home, 'lab', NOW)).toEqual({
    ok: true,
    entity: 'lab',
    target: 'clerk@lab',
    source: 'policy',
  });
});
