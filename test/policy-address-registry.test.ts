// `team policy set` refuses an address policy whose team word does not resolve in this home's
// registry: `owner-reply-to`, `router.aliases` and `router.fallback`. The check runs in
// `planPolicySet`, so `--dry-run` prints the same refusal (runPolicy plans before its dry-run
// branch) and neither path writes. A word resolves by registered team id, by the team's own name
// (its `project`), or by its session — exactly the spellings an address's `@team` may use.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import { entitiesPath } from '../src/entities.ts';
import { planPolicySet, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const made: string[] = [];

afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

type World = { home: string; root: string; acmeId: string };

/** A home whose registry holds two teams: `acme` (name and session both `acme`) and `floor`
 *  (name `floor`, session `floor-beacon`, so the session spelling is testable on its own). */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'policy-address-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(root, { recursive: true });
  const acmeId = teamIdOf(root);
  upsertTeam(home, acmeId, { project: 'acme', session: 'acme', root, roster: [], at: NOW.toISOString() });
  const floorRoot = join(base, 'floor');
  mkdirSync(floorRoot, { recursive: true });
  upsertTeam(home, 'floor', { project: 'floor', session: 'floor-beacon', root: floorRoot, roster: [], at: NOW.toISOString() });
  return { home, root, acmeId };
}

/** The sentence `world()`'s refusals end with: every registered team by id, name and session. */
function registryOf(fx: World): string {
  return `the registry has: acme (id ${fx.acmeId}, session acme), floor (id floor, session floor-beacon)`;
}

describe('a policy word that stores an address', () => {
  test('owner-reply-to: a team word no record matches is refused, and nothing is written', () => {
    const fx = world();
    const request = { level: 'entity' as const, target: 'floor', name: 'owner-reply-to', value: 'inbox@nowhere' };
    const planned = planPolicySet(fx.home, request, { now: NOW });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.why).toBe(
        `policy "owner-reply-to": "inbox@nowhere" names team "nowhere", which no team registry record matches ` +
          `(by id, name or session); ${registryOf(fx)}`,
      );
    }
    expect(writePolicySet(fx.home, request, { now: NOW }).ok).toBe(false);
    expect(existsSync(entitiesPath(fx.home))).toBe(false);
  });

  test('owner-reply-to: a word resolves by name, by session and by id', () => {
    const fx = world();
    for (const value of ['inbox@acme', 'inbox@floor-beacon', `inbox@${fx.acmeId}`]) {
      const planned = planPolicySet(fx.home, { level: 'entity', target: 'floor', name: 'owner-reply-to', value }, { now: NOW });
      expect(planned.ok).toBe(true);
    }
  });

  test('router.aliases: the refused word is named by its alias, and nothing is written', () => {
    const fx = world();
    const request = { level: 'entity' as const, target: 'floor', name: 'router.aliases', value: 'lead=lead@acme,pal=helper@nowhere' };
    const planned = planPolicySet(fx.home, request, { now: NOW });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.why).toBe(
        `policy "router.aliases": alias "pal" names team "nowhere", which no team registry record matches ` +
          `(by id, name or session); ${registryOf(fx)}`,
      );
    }
    expect(writePolicySet(fx.home, request, { now: NOW }).ok).toBe(false);
    expect(existsSync(entitiesPath(fx.home))).toBe(false);
  });

  test('router.aliases: every word the registry answers writes normally', () => {
    const fx = world();
    const wrote = writePolicySet(
      fx.home,
      { level: 'entity', target: 'floor', name: 'router.aliases', value: 'lead=lead@acme,worker=worker@floor-beacon' },
      { now: NOW },
    );
    expect(wrote.ok).toBe(true);
  });

  test('router.fallback: a refused word is named as a fallback, and `none` needs no team', () => {
    const fx = world();
    const refused = planPolicySet(
      fx.home,
      { level: 'entity', target: 'floor', name: 'router.fallback', value: 'lead=helper@nowhere' },
      { now: NOW },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.why).toBe(
        `policy "router.fallback": fallback for "lead" names team "nowhere", which no team registry record matches ` +
          `(by id, name or session); ${registryOf(fx)}`,
      );
    }

    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'policy-address-empty-')));
    made.push(empty);
    const cleared = planPolicySet(
      join(empty, 'home'),
      { level: 'entity', target: 'floor', name: 'router.fallback', value: 'lead=none' },
      { now: NOW },
    );
    expect(cleared.ok).toBe(true);
  });

  test('a word two registry records answer is refused, naming both by id', () => {
    const fx = world();
    const oneRoot = join(fx.root, '..', 'one');
    const twoRoot = join(fx.root, '..', 'two');
    mkdirSync(oneRoot, { recursive: true });
    mkdirSync(twoRoot, { recursive: true });
    const oneId = teamIdOf(oneRoot);
    const twoId = teamIdOf(twoRoot);
    upsertTeam(fx.home, oneId, { project: 'one', session: 'shared', root: oneRoot, roster: [], at: NOW.toISOString() });
    upsertTeam(fx.home, twoId, { project: 'two', session: 'shared', root: twoRoot, roster: [], at: NOW.toISOString() });

    const planned = planPolicySet(
      fx.home,
      { level: 'entity', target: 'floor', name: 'owner-reply-to', value: 'inbox@shared' },
      { now: NOW },
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.why).toBe(
        `policy "owner-reply-to": "inbox@shared" names team "shared", which 2 registry records answer ` +
          `(ids: ${[oneId, twoId].sort().join(', ')}); say which by its id`,
      );
    }
  });

  test('an empty registry says so instead of listing words', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'policy-address-empty-')));
    made.push(base);
    const planned = planPolicySet(
      join(base, 'home'),
      { level: 'entity', target: 'floor', name: 'owner-reply-to', value: 'inbox@lab' },
      { now: NOW },
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.why).toBe(
        'policy "owner-reply-to": "inbox@lab" names team "lab", which no team registry record matches ' +
          '(by id, name or session); the registry has no teams',
      );
    }
  });

  test('a team-level router word is checked against the same registry', () => {
    const fx = world();
    const planned = planPolicySet(
      fx.home,
      { level: 'team', target: fx.acmeId, teamRoot: fx.root, name: 'router.aliases', value: 'pal=helper@nowhere' },
      { now: NOW },
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.why).toContain('policy "router.aliases"');
  });
});

describe('a --dry-run write', () => {
  test('prints the same refusal and writes nothing', async () => {
    const fx = world();
    const io = testIo(fx.root, { kind: 'owner' });
    const code = await runPolicy(
      ['set', 'entity', 'owner-reply-to', 'inbox@nowhere', '--entity', 'floor', '--dry-run'],
      io,
      { home: fx.home, now: () => NOW },
    );
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      'team policy: policy "owner-reply-to": "inbox@nowhere" names team "nowhere", which no team registry record matches ' +
        `(by id, name or session); ${registryOf(fx)}\n`,
    );
    expect(existsSync(entitiesPath(fx.home))).toBe(false);
  });
});
