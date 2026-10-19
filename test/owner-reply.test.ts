// The `owner-reply-to` policy: the entity-level address an owner-origin message names for the
// seat that answers it. Entity `floor` ships `orchestrator@floor`; every other entity must
// declare its own, and the reader answers an explicit missing or invalid reason rather than
// inventing a seat or naming a pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import {
  getPolicySpec,
  normalizePolicyName,
  planPolicySet,
  POLICY_DOMAIN,
  policySignaturePayload,
  resolveOwnerReplyTo,
  writePolicySet,
} from '../src/policy/index.ts';
import {
  OWNER_REPLY_DEFAULT,
  ownerReplyToValueProblem,
  parseOwnerReplyToValue,
} from '../src/settings/owner-reply.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';

const NOW = new Date('2026-10-19T12:00:00Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function teamText(root: string, lobby: string, entity: string | null): string {
  return `format: 1
project: acme
${entity === null ? '' : `entity: ${entity}\n`}coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

/** A team and a home under one scratch folder. A team that names an entity starts in that
 *  entity's lobby, and the file trusts that lobby and its root. */
function world(entity: string | null = 'floor'): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-reply-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const lobby = entity === null ? lobbyDir(home) : resolveLobby(home, { entity });
  mkdirSync(lobby, { recursive: true });
  writeFileSync(join(root, '.agents/team.yaml'), teamText(root, lobby, entity));
  return { home, root };
}

/** The owner's signed entity declaration, written the way `team policy set` writes one. */
function declare(home: string, entity: string, value: unknown, expiry?: string): void {
  const wrote = writePolicySet(
    home,
    { level: 'entity', target: entity, name: 'owner-reply-to', value, ...(expiry === undefined ? {} : { expiry }) },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
}

/** Rewrites the signed entry's value and signs it again: a hand-edited value under a valid
 *  signature, which the reader must judge by the value, not the signature. */
function retargetValue(home: string, entity: string, from: string, to: string): void {
  const path = entitiesPath(home);
  const text = readFileSync(path, 'utf8');
  const date = /^\s+date: "([^"]+)"$/m.exec(text)?.[1];
  const generation = Number(/^\s+generation: (\d+)$/m.exec(text)?.[1]);
  const valueLine = `      value: ${JSON.stringify(from)}`;
  const signatureLine = /^(\s+signature: )".*"$/m;
  if (date === undefined || !Number.isInteger(generation) || !text.includes(valueLine) || !signatureLine.test(text)) {
    throw new Error('the signed entity entry is not written the way this fixture edits it');
  }
  const signature = signDomain(
    POLICY_DOMAIN,
    policySignaturePayload({
      name: 'owner-reply-to',
      value: to,
      level: 'entity',
      target: entity,
      setter: 'owner',
      date,
      expiry: null,
      kind: 'enforced',
      generation,
    }),
    keyOf(home),
  );
  writeFileSync(path, text.replace(valueLine, `      value: ${JSON.stringify(to)}`).replace(signatureLine, `$1${JSON.stringify(signature)}`));
}

describe('the owner-reply-to catalogue entry', () => {
  test('is enforced at the entity level alone, with no target as its release default', () => {
    const spec = getPolicySpec('owner-reply-to');
    expect(spec).not.toBeNull();
    expect(spec?.kind).toBe('enforced');
    expect(spec?.levels).toEqual(['entity']);
    expect(spec?.defaultValue).toBe('');
    expect(spec?.gateLifting).toBe(false);
    expect(normalizePolicyName('owner_reply_to')).toBe('owner-reply-to');
  });

  test('project, team and seat cannot set it', () => {
    const { home } = world('floor');
    for (const level of ['project', 'team', 'seat'] as const) {
      const planned = planPolicySet(
        home,
        { level, target: 'acme', name: 'owner-reply-to', value: 'inbox@floor' },
        { now: NOW },
      );
      expect(planned.ok).toBe(false);
      if (!planned.ok) expect(planned.why).toContain('allowed: entity');
    }
  });
});

describe('the owner-reply-to vocabulary', () => {
  test('parses a qualified seat@team target and trims it', () => {
    expect(parseOwnerReplyToValue('orchestrator@floor')).toBe('orchestrator@floor');
    expect(parseOwnerReplyToValue('  inbox.1@lab-2  ')).toBe('inbox.1@lab-2');
  });

  test('refuses a pane address, a bare seat, two teams and a missing side', () => {
    expect(parseOwnerReplyToValue('w1:p1')).toBeNull();
    expect(ownerReplyToValueProblem('w1:p1')).toContain('pane address');
    expect(parseOwnerReplyToValue('lead')).toBeNull();
    expect(ownerReplyToValueProblem('lead')).toContain('seat@team');
    expect(parseOwnerReplyToValue('a@b@c')).toBeNull();
    expect(ownerReplyToValueProblem('a@b@c')).toContain('exactly one team');
    expect(parseOwnerReplyToValue('a b@floor')).toBeNull();
    expect(parseOwnerReplyToValue('@floor')).toBeNull();
    expect(parseOwnerReplyToValue('inbox@')).toBeNull();
    expect(parseOwnerReplyToValue('')).toBeNull();
    expect(parseOwnerReplyToValue(42)).toBeNull();
  });
});

describe('the owner-reply reader', () => {
  test('entity floor with no declaration answers its shipped orchestrator', () => {
    const { home, root } = world('floor');
    expect(resolveOwnerReplyTo(root, home, 'floor', NOW)).toEqual({
      ok: true,
      entity: 'floor',
      target: OWNER_REPLY_DEFAULT,
      source: 'default',
    });
  });

  test('a signed floor declaration replaces the default', () => {
    const { home, root } = world('floor');
    declare(home, 'floor', 'inbox@floor');
    expect(resolveOwnerReplyTo(root, home, 'floor', NOW)).toEqual({
      ok: true,
      entity: 'floor',
      target: 'inbox@floor',
      source: 'policy',
    });
  });

  test('another entity without a declaration is missing, and the reason names it', () => {
    const { home, root } = world('lab');
    const found = resolveOwnerReplyTo(root, home, 'lab', NOW);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toBe('missing');
      expect(found.entity).toBe('lab');
      expect(found.why).toContain('no owner-reply-to');
    }
  });

  test('another entity with a signed declaration answers it', () => {
    const { home, root } = world('lab');
    declare(home, 'lab', 'inbox@lab');
    expect(resolveOwnerReplyTo(root, home, 'lab', NOW)).toEqual({
      ok: true,
      entity: 'lab',
      target: 'inbox@lab',
      source: 'policy',
    });
  });

  test('the team file names the entity when the caller passes none', () => {
    const { home, root } = world('floor');
    expect(resolveOwnerReplyTo(root, home, null, NOW)).toEqual({
      ok: true,
      entity: 'floor',
      target: OWNER_REPLY_DEFAULT,
      source: 'default',
    });
  });

  test('a team that names no entity has no target', () => {
    const { home, root } = world(null);
    const found = resolveOwnerReplyTo(root, home, null, NOW);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toBe('missing');
      expect(found.why).toContain('names no entity');
    }
  });

  test('an expired declaration is unset, so a non-floor entity is missing', () => {
    const { home, root } = world('lab');
    declare(home, 'lab', 'inbox@lab', new Date(NOW.getTime() + 1_000).toISOString());
    const found = resolveOwnerReplyTo(root, home, 'lab', new Date(NOW.getTime() + 60_000));
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toBe('missing');
      expect(found.why).toContain('expired');
    }
  });

  test('an expired floor declaration falls back to the shipped default', () => {
    const { home, root } = world('floor');
    declare(home, 'floor', 'inbox@floor', new Date(NOW.getTime() + 1_000).toISOString());
    expect(resolveOwnerReplyTo(root, home, 'floor', new Date(NOW.getTime() + 60_000))).toEqual({
      ok: true,
      entity: 'floor',
      target: OWNER_REPLY_DEFAULT,
      source: 'default',
    });
  });

  test('a signed declaration with an unreadable value is invalid', () => {
    const { home, root } = world('lab');
    declare(home, 'lab', 'inbox@lab');
    retargetValue(home, 'lab', 'inbox@lab', 'w1:p1');
    const found = resolveOwnerReplyTo(root, home, 'lab', NOW);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toBe('invalid');
      expect(found.why).toContain('pane address');
    }
  });

  test('an unreadable entity source is invalid with its reason', () => {
    const { home, root } = world('lab');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(entitiesPath(home), '- not a map of entities\n');
    const found = resolveOwnerReplyTo(root, home, 'lab', NOW);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toBe('invalid');
      expect(found.why).toContain('expected a map of entities');
    }
  });
});
