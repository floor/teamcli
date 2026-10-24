// How long a client grant may last is the owner's `client-grant-max-duration` policy, not a
// constant: seven days for a send grant, ninety for up/down and bundles unless the owner says
// otherwise, and `none` allows a grant with NO end date (`--expires never`) that only `team revoke`
// ends. Synthetic homes only: a fake credential store stands in for Touch ID; no real config,
// key, team or grant is read or written.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArgs } from '../src/args.ts';
import type { Caller } from '../src/caller.ts';
import { DEFAULT_BUNDLE_SPECS } from '../src/client/bundle-ops.ts';
import {
  DAY_MS,
  GRANT_DURATION_DEFAULT_DAYS,
  capWithin,
  defaultDurationCaps,
  durationPolicyWithin,
  expiryPhrase,
  formatDurationPolicy,
  parseDurationPolicy,
} from '../src/client/duration-policy.ts';
import { pendingGrantHash, type PendingGrantParams } from '../src/client/emission.ts';
import { grantDurationInForce } from '../src/client/grant-duration.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import {
  CLIENT_BUNDLE_VOCABULARY_VERSION,
  CLIENT_EXPIRY_MAX_MS,
  CLIENT_GRANT_DOMAIN,
  CLIENT_UP_EXPIRY_MAX_MS,
  activeClientGrant,
  activeClientUpGrant,
  clientGrantExpired,
  clientGrantPath,
  clientKeyDir,
  newClientKeyPair,
  planClientBundleGrant,
  planClientGrant,
  planClientUpGrant,
  readClientGrant,
  readClientGrantFile,
  readClientUpGrant,
  readClientUpGrantFile,
  writeClientBundleGrant,
  writeClientGrant,
  writeClientKeyFiles,
  writeClientUpGrant,
  type ClientGrantRecord,
  type ClientUpGrantRecord,
} from '../src/client/records.ts';
import { resolveClientUpTarget, verifyClientUp } from '../src/client/up-grant.ts';
import { runClientSend } from '../src/client/send.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import type { SendHost } from '../src/commands/send.ts';
import type { Io } from '../src/io.ts';
import { ENFORCED_POLICY_NAMES } from '../src/policy/types.ts';
import { resolvePolicyChain } from '../src/policy/resolve.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';

const POLICY = 'client-grant-max-duration';
const TEAM_ID = 'aaaaaaaaaaaa';
const TEAMCLI_ID = 'bbbbbbbbbbbb';
const CLIENT_ID = 'grok-bot';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const DAY = DAY_MS;
const FAR = new Date(NOW.getTime() + 3650 * DAY);

const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

const ACME = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: steward
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  const point = (pair: ReturnType<typeof generateKeyPairSync>) => {
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  };
  return {
    name: 'fake-credential-store', prompts,
    available: () => true,
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: point(pair) };
    },
    publicKey: (label) => {
      const pair = keys.get(label);
      return pair ? { ok: true, publicKey: point(pair) } : { ok: false, why: 'no key' };
    },
    sign: (label, message, reason) => {
      prompts.push(reason);
      const pair = keys.get(label);
      if (!pair) return { ok: false, why: 'no key' };
      return { ok: true, signature: cryptoSign('sha256', message, { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex') };
    },
  };
}

/** Two coordinator teams of entity `floor` (floor and teamcli), a real team folder `acme` for the up,
 *  down and bundle grants, and one client key. A client key may not sit in the OS temp directory,
 *  so the world is under the working directory like the other client suites. */
function world(label: string, options: { projectId?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.client-duration-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  const teamRoot = join(base, 'floor');
  const teamcliRoot = join(base, 'teamcli');
  const acme = join(base, 'acme');
  for (const dir of [home, teamRoot, teamcliRoot, join(base, 'lobby'), join(base, 'lobby-2')]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(acme, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: acme, stdio: 'ignore' });
  writeFileSync(join(acme, '.agents', 'team.yaml'), ACME);
  const ownerKey = keyOf(home);
  const agentFor = (team: string, name: string) =>
    registerAgent(home, {
      name, signing: { model: 'DeepSeek', version: 'V4.1', role: 'orchestrator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
      reach: { team, seat: 'orchestrator', session: 'floor', pane: 'w1:p1', address: join(base, `${name}.sock`) },
      mcp: [], skills: [], lifecycle: 'running', by: 'test',
    });
  const floorAgent = agentFor(TEAM_ID, 'orchestrator');
  const teamcliAgent = agentFor(TEAMCLI_ID, 'orchestrator-2');
  const provenance = 'provenance: { registered_by: test, registered_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" }';
  const projectId = options.projectId ?? 'null';
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'team', 'teams.yaml'),
    `teams:
  "${TEAM_ID}":
    project: floor
    project_id: ${projectId}
    entity: floor
    session: floor
    root: ${teamRoot}
    lobby: ${join(base, 'lobby')}
    roster:
      - { agent: ${floorAgent.id}, seat: orchestrator, role: orchestrator, leads: true }
    lifecycle: running
    ${provenance}
  "${TEAMCLI_ID}":
    project: teamcli
    project_id: ${projectId}
    entity: floor
    session: teamcli
    root: ${teamcliRoot}
    lobby: ${join(base, 'lobby-2')}
    roster:
      - { agent: ${teamcliAgent.id}, seat: orchestrator, role: orchestrator, leads: true }
    lifecycle: running
    ${provenance}
`,
  );
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, CLIENT_ID);
  const keyFiles = writeClientKeyFiles(keyDir, pair);
  if (!keyFiles.ok) throw new Error(keyFiles.why);
  return { base, home, teamRoot, teamcliRoot, acme, ownerKey, pair, keyDir, keyPath: keyFiles.keyPath, pubPath: keyFiles.pubPath, store: fakeStore() };
}
type World = ReturnType<typeof world>;

function setPolicy(w: World, value: string, options: { level?: 'entity' | 'project'; target?: string; name?: string } = {}) {
  const set = writePolicySet(w.home, { level: options.level ?? 'entity', target: options.target ?? 'floor', name: options.name ?? POLICY, value }, { now: NOW });
  if (!set.ok) throw new Error(set.why);
}

const request = (w: World, extra: Record<string, unknown> = {}) => ({
  clientId: CLIENT_ID, entity: 'floor', publicKey: w.pair.publicKey, keyId: w.pair.keyId, keyDir: w.keyDir, ...extra,
});

const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

/** The binding of the `acme` folder as the owner would sign it. */
function binding(w: World) {
  const target = resolveClientUpTarget(w.home, 'floor', 'acme', w.acme);
  if (!target.ok) throw new Error(target.why);
  return target.binding;
}

const bundleRequest = (w: World, extra: Record<string, unknown> = {}) => ({
  ...request(w), bundle: 'observer' as const, ops: ['status'], up: binding(w), ...extra,
});

const lifespan = (grant: { issued: string; expires: string | null }): number => Date.parse(grant.expires!) - Date.parse(grant.issued);
const recordOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')).client_grant as Record<string, unknown>;

function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(String((result as { why?: string }).why));
  return result as Extract<T, { ok: true }>;
}

describe('the default: nothing changes unless the owner sets the policy', () => {
  test('the release defaults are the three constants the code had', () => {
    expect(GRANT_DURATION_DEFAULT_DAYS).toEqual({ send: 7, up: 90, bundle: 90 });
    expect(CLIENT_EXPIRY_MAX_MS).toBe(7 * DAY);
    expect(CLIENT_UP_EXPIRY_MAX_MS).toBe(90 * DAY);
    expect(DEFAULT_BUNDLE_SPECS.operator.expiryDays).toBe(90);
    expect(defaultDurationCaps()).toEqual({ send: 7, up: 90, bundle: 90 });
    expect(ENFORCED_POLICY_NAMES as readonly string[]).toContain(POLICY);
  });

  test('send: seven days by default, eight refused, with the policy and where to set it named', () => {
    const w = world('default-send');
    const plain = must(planClientGrant(w.home, request(w), { now: NOW }));
    expect(lifespan(plain.grant)).toBe(7 * DAY);
    expect(must(planClientGrant(w.home, request(w, { expires: at(7) }), { now: NOW })).grant.expires).toBe(at(7));
    const eight = planClientGrant(w.home, request(w, { expires: at(8) }), { now: NOW });
    expect(eight.ok).toBe(false);
    const why = eight.ok ? '' : eight.why;
    expect(why).toContain('more than 7 days away');
    expect(why).toContain(POLICY);
    expect(why).toContain('at most 7 days for a send grant');
    expect(why).toContain('team policy set entity client-grant-max-duration send=30d --entity floor');
    expect(why).toContain('send=none');
  });

  test('up and down: ninety days by default, ninety-one refused', () => {
    const w = world('default-up');
    const up = { ...request(w), up: binding(w) };
    expect(lifespan(must(planClientUpGrant(w.home, up, { now: NOW })).grant)).toBe(90 * DAY);
    expect(lifespan(must(planClientUpGrant(w.home, { ...up, ops: ['up', 'down'] }, { now: NOW })).grant)).toBe(90 * DAY);
    expect(planClientUpGrant(w.home, { ...up, expires: at(90) }, { now: NOW }).ok).toBe(true);
    const long = planClientUpGrant(w.home, { ...up, expires: at(91) }, { now: NOW });
    expect(long.ok).toBe(false);
    expect(long.ok ? '' : long.why).toContain('at most 90 days for an up or down grant');
    expect(long.ok ? '' : long.why).toContain('up=none');
  });

  test('bundle: ninety days by default, ninety-one refused', () => {
    const w = world('default-bundle');
    expect(lifespan(must(planClientBundleGrant(w.home, bundleRequest(w), { now: NOW })).grant)).toBe(90 * DAY);
    expect(planClientBundleGrant(w.home, bundleRequest(w, { expires: at(90) }), { now: NOW }).ok).toBe(true);
    const long = planClientBundleGrant(w.home, bundleRequest(w, { expires: at(91) }), { now: NOW });
    expect(long.ok).toBe(false);
    expect(long.ok ? '' : long.why).toContain('at most 90 days for a bundle grant');
  });

  test('the client-bundles policy still shortens a bundle, and its days stay the default length', () => {
    const w = world('default-bundles-policy');
    const specs = { observer: { ops: ['status'] as never, expiryDays: 30, expiryExplicit: true }, operator: DEFAULT_BUNDLE_SPECS.operator };
    expect(lifespan(must(planClientBundleGrant(w.home, bundleRequest(w, { specs }), { now: NOW })).grant)).toBe(30 * DAY);
    const long = planClientBundleGrant(w.home, bundleRequest(w, { specs, expires: at(31) }), { now: NOW });
    expect(long.ok ? '' : long.why).toContain('client-bundles');
    // Even `none` does not lift a bound the client-bundles policy wrote.
    setPolicy(w, 'bundle=none');
    const never = planClientBundleGrant(w.home, bundleRequest(w, { specs, neverExpires: true }), { now: NOW });
    expect(never.ok).toBe(false);
    expect(never.ok ? '' : never.why).toContain('client-bundles');
  });

  test('--expires never is refused by default, in all three kinds, and says what to do', () => {
    const w = world('default-never');
    for (const refused of [
      planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW }),
      planClientUpGrant(w.home, { ...request(w, { neverExpires: true }), up: binding(w) }, { now: NOW }),
      planClientBundleGrant(w.home, bundleRequest(w, { neverExpires: true }), { now: NOW }),
    ]) {
      expect(refused.ok).toBe(false);
      const why = refused.ok ? '' : refused.why;
      expect(why).toContain('--expires never is refused');
      expect(why).toContain(`no ${POLICY} policy is set`);
      expect(why).toContain(`team policy set entity ${POLICY}`);
    }
  });

  test('the policy is a value the catalogue reads: forms, defaults and bad words', () => {
    expect(parseDurationPolicy('30d')).toEqual({ ok: true, caps: { send: 30, up: 30, bundle: 30 } });
    expect(parseDurationPolicy('none')).toEqual({ ok: true, caps: { send: null, up: null, bundle: null } });
    expect(parseDurationPolicy('send=30d;up=none')).toEqual({ ok: true, caps: { send: 30, up: null } });
    expect(parseDurationPolicy(30)).toEqual({ ok: true, caps: { send: 30, up: 30, bundle: 30 } });
    expect(parseDurationPolicy('')).toEqual({ ok: true, caps: {} });
    expect(formatDurationPolicy({ up: null, send: 30 })).toBe('send=30d;up=none');
    for (const bad of ['forever', '0d', '-3d', '3651d', 'send=0d', 'send=30d;send=7d', 'tomorrow=30d', 'send', 'send=30d;7d', 'send=30 days']) {
      expect(parseDurationPolicy(bad).ok, bad).toBe(false);
    }
    const w = world('policy-words');
    for (const bad of ['forever', 'send=0d', 'wat=30d']) {
      expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: POLICY, value: bad }, { now: NOW }).ok, bad).toBe(false);
    }
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client_grant_max_duration', value: 'send=none' }, { now: NOW }).ok).toBe(true);
    // Not a team-level or seat-level word: entity and project only.
    expect(writePolicySet(w.home, { level: 'seat', target: 'x', name: POLICY, value: '7d' }, { now: NOW }).ok).toBe(false);
  });
});

describe('the owner raises (or lowers) the cap', () => {
  test('send=30d: thirty days accepted, thirty-one refused naming the level; the default length stays seven', () => {
    const w = world('raise-send');
    setPolicy(w, 'send=30d');
    expect(planClientGrant(w.home, request(w, { expires: at(30) }), { now: NOW }).ok).toBe(true);
    const over = planClientGrant(w.home, request(w, { expires: at(31) }), { now: NOW });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.why).toContain('the policy client-grant-max-duration at entity floor allows at most 30 days for a send grant');
    // A cap bounds a request; it does not lengthen one that names no date.
    expect(lifespan(must(planClientGrant(w.home, request(w), { now: NOW })).grant)).toBe(7 * DAY);
    // The other kinds keep their own defaults.
    const up = { ...request(w), up: binding(w) };
    expect(planClientUpGrant(w.home, { ...up, expires: at(90) }, { now: NOW }).ok).toBe(true);
    expect(planClientUpGrant(w.home, { ...up, expires: at(91) }, { now: NOW }).ok).toBe(false);
    expect(planClientBundleGrant(w.home, bundleRequest(w, { expires: at(91) }), { now: NOW }).ok).toBe(false);
  });

  test('a written 30d send grant is signed, read back whole, and valid on day 29', () => {
    const w = world('raise-written');
    setPolicy(w, 'send=30d');
    const written = must(writeClientGrant(w.home, request(w, { expires: at(30) }), { now: NOW, key: w.ownerKey }));
    expect(written.grant.expires).toBe(at(30));
    const read = must(readClientGrantFile(w.home, written.path));
    expect(activeClientGrant(w.home, read, new Date(NOW.getTime() + 29 * DAY)).ok).toBe(true);
    expect(activeClientGrant(w.home, read, new Date(NOW.getTime() + 31 * DAY)).ok).toBe(false);
  });

  test('up=30d and bundle=180d: per kind, and a cap below the default lowers it', () => {
    const w = world('per-kind');
    setPolicy(w, 'up=30d;bundle=180d');
    const up = { ...request(w), up: binding(w) };
    expect(lifespan(must(planClientUpGrant(w.home, up, { now: NOW })).grant)).toBe(30 * DAY);
    expect(planClientUpGrant(w.home, { ...up, expires: at(31) }, { now: NOW }).ok).toBe(false);
    expect(planClientBundleGrant(w.home, bundleRequest(w, { expires: at(180) }), { now: NOW }).ok).toBe(true);
    expect(planClientBundleGrant(w.home, bundleRequest(w, { expires: at(181) }), { now: NOW }).ok).toBe(false);
    expect(lifespan(must(planClientBundleGrant(w.home, bundleRequest(w), { now: NOW })).grant)).toBe(90 * DAY);
    // Send was not named: the release default holds.
    expect(planClientGrant(w.home, request(w, { expires: at(8) }), { now: NOW }).ok).toBe(false);
  });

  test('one bare value names every kind, and a short one shortens the default length too', () => {
    const w = world('bare');
    setPolicy(w, '3d');
    expect(lifespan(must(planClientGrant(w.home, request(w), { now: NOW })).grant)).toBe(3 * DAY);
    expect(lifespan(must(planClientUpGrant(w.home, { ...request(w), up: binding(w) }, { now: NOW })).grant)).toBe(3 * DAY);
    expect(planClientGrant(w.home, request(w, { expires: at(4) }), { now: NOW }).ok).toBe(false);
  });

  test('a policy that expires counts as unset: the release default returns', () => {
    const w = world('policy-expiry');
    const set = writePolicySet(w.home, { level: 'entity', target: 'floor', name: POLICY, value: 'send=none', expiry: at(1) }, { now: NOW });
    expect(set.ok).toBe(true);
    expect(planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW }).ok).toBe(true);
    const later = new Date(NOW.getTime() + 2 * DAY);
    const refused = planClientGrant(w.home, request(w, { neverExpires: true }), { now: later });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.why).toContain('release default');
  });
});

describe('none and --expires never sign a record with no end date', () => {
  test('send: the record says expires null, whole and explicit, under the same vocabulary', () => {
    const w = world('none-send');
    setPolicy(w, 'send=none');
    const written = must(writeClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW, key: w.ownerKey }));
    expect(written.grant.expires).toBeNull();
    expect(written.grant.vocabulary).toBe(1);
    const disk = recordOf(written.path);
    expect(Object.hasOwn(disk, 'expires')).toBe(true);
    expect(disk.expires).toBeNull();
    expect(readFileSync(written.path, 'utf8')).toContain('"expires": null');
    const read = must(readClientGrant(w.home, written.grant.grantId));
    expect(read.grant.expires).toBeNull();
    expect(read.grant.issued).toBe(NOW.toISOString());
    // The inbox form is the same record with a second op.
    const inbox = must(writeClientGrant(w.home, request(w, { neverExpires: true, inbox: true }), { now: NOW, key: w.ownerKey }));
    expect(inbox.grant.expires).toBeNull();
    expect(inbox.grant.vocabulary).toBe(2);
  });

  test('up, down and bundle: null too, each under its own kind', () => {
    const w = world('none-team');
    setPolicy(w, 'up=none;bundle=none');
    const up = must(writeClientUpGrant(w.home, { ...request(w, { neverExpires: true }), ops: ['up', 'down'], up: binding(w) }, { now: NOW, key: w.ownerKey }));
    expect(up.grant.expires).toBeNull();
    expect(recordOf(up.path).expires).toBeNull();
    expect(must(readClientUpGrant(w.home, up.grant.grantId)).grant.expires).toBeNull();
    const down = must(writeClientUpGrant(w.home, { ...request(w, { neverExpires: true }), ops: ['down'], up: binding(w) }, { now: NOW, key: w.ownerKey }));
    expect(must(readClientUpGrant(w.home, down.grant.grantId)).grant.expires).toBeNull();
    const bundle = must(writeClientBundleGrant(w.home, bundleRequest(w, { neverExpires: true }), { now: NOW, key: w.ownerKey }));
    expect(bundle.grant.expires).toBeNull();
    expect(bundle.grant.vocabulary).toBe(CLIENT_BUNDLE_VOCABULARY_VERSION);
    expect(must(readClientUpGrant(w.home, bundle.grant.grantId)).grant.expires).toBeNull();
    // `send` was not named, so a send grant still cannot be open-ended.
    expect(planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW }).ok).toBe(false);
  });

  test('a bare `none` names every kind', () => {
    const w = world('none-bare');
    setPolicy(w, 'none');
    expect(planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW }).ok).toBe(true);
    expect(planClientUpGrant(w.home, { ...request(w, { neverExpires: true }), up: binding(w) }, { now: NOW }).ok).toBe(true);
    expect(planClientBundleGrant(w.home, bundleRequest(w, { neverExpires: true }), { now: NOW }).ok).toBe(true);
  });

  test('none lifts the cap, never the default length: no end date is asked for, never given unasked', () => {
    const w = world('none-default');
    setPolicy(w, 'none');
    expect(lifespan(must(planClientGrant(w.home, request(w), { now: NOW })).grant)).toBe(7 * DAY);
    expect(lifespan(must(planClientUpGrant(w.home, { ...request(w), up: binding(w) }, { now: NOW })).grant)).toBe(90 * DAY);
    expect(planClientGrant(w.home, request(w, { expires: at(3000) }), { now: NOW }).ok).toBe(true);
  });

  test('--expires never is refused when the policy is not none, naming the level, the cap and the command', () => {
    const w = world('never-refused');
    setPolicy(w, 'send=30d');
    const refused = planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW });
    expect(refused.ok).toBe(false);
    const why = refused.ok ? '' : refused.why;
    expect(why).toContain('--expires never is refused');
    expect(why).toContain('the policy client-grant-max-duration at entity floor allows at most 30 days for a send grant');
    expect(why).toContain('team policy set entity client-grant-max-duration send=none --entity floor');
  });

  test('never and a date together are not a request', () => {
    const w = world('never-and-date');
    setPolicy(w, 'none');
    const both = planClientGrant(w.home, request(w, { neverExpires: true, expires: at(3) }), { now: NOW });
    expect(both.ok).toBe(false);
    expect(both.ok ? '' : both.why).toContain('not both');
  });

  test('a master grant and a sub-grant always end, even under none', () => {
    const w = world('never-master');
    setPolicy(w, 'none');
    const scope = { entities: ['floor'], projects: [], teams: [] };
    const master = planClientGrant(w.home, request(w, { neverExpires: true, grantScope: scope }), { now: NOW });
    expect(master.ok).toBe(false);
    expect(master.ok ? '' : master.why).toContain('always has an end date');
    const sub = planClientGrant(w.home, request(w, { neverExpires: true, issuedBy: `cg_${'a'.repeat(24)}` }), { now: NOW });
    expect(sub.ok).toBe(false);
    // The decoder holds the same line: an owner-signed master record with null is nothing.
    const written = must(writeClientGrant(w.home, request(w, { expires: at(3), grantScope: scope }), { now: NOW, key: w.ownerKey }));
    const doc = JSON.parse(readFileSync(written.path, 'utf8'));
    doc.client_grant.expires = null;
    doc.signature = signDomain(CLIENT_GRANT_DOMAIN, { name: doc.client_grant.grant_id, client_grant: doc.client_grant }, w.ownerKey);
    writeFileSync(written.path, JSON.stringify(doc));
    expect(readClientGrantFile(w.home, written.path).ok).toBe(false);
  });

  test('the command line: `--expires never` signs a no-expiry record only under none, and says so', async () => {
    const w = world('cli-direct');
    const flags = ['--client', CLIENT_ID, '--entity', 'floor', '--public-key', w.pubPath, '--team', 'teamcli', '--seat', 'orchestrator'];
    const run = async (extra: string[]) => {
      const c = capture(w, { kind: 'owner' });
      const code = await runGrant([...flags, ...extra], c.io, { home: w.home });
      return { code, out: c.out(), err: c.err() };
    };
    const refused = await run(['--expires', 'never']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--expires never is refused');
    expect(refused.err).toContain(POLICY);
    setPolicy(w, 'send=none');
    const signed = await run(['--expires', 'NEVER']);
    expect(signed.code, signed.err).toBe(0);
    expect(signed.out).toContain('expires: never (until revoked; no end date)');
    const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(signed.out)![1]!;
    expect(recordOf(clientGrantPath(w.home, grantId)).expires).toBeNull();
    // Omitting --expires still means the default length, unchanged by the policy.
    const dated = await run([]);
    expect(dated.code).toBe(0);
    expect(dated.out).toMatch(/expires: 20\d\d-\d\d-\d\dT/);
    // A sub-grant never takes it.
    const sub = await run(['--client-request', '--via', 'x', '--key', 'y', '--expires', 'never']);
    expect(sub.code).toBe(2);
    expect(sub.err).toContain('a sub-grant always has an end date');
  });
});

describe('narrowing: a lower level may only lower the cap', () => {
  test('the order: fewer days is tighter, none is the loosest, kind by kind', () => {
    expect(capWithin(7, 30)).toBe(true);
    expect(capWithin(30, 30)).toBe(true);
    expect(capWithin(30, 7)).toBe(false);
    expect(capWithin(null, 30)).toBe(false);
    expect(capWithin(30, null)).toBe(true);
    expect(capWithin(null, null)).toBe(true);
    expect(durationPolicyWithin('send=7d', 'send=30d')).toBe(true);
    expect(durationPolicyWithin('send=30d', 'send=7d')).toBe(false);
    expect(durationPolicyWithin('send=none', 'send=30d')).toBe(false);
    expect(durationPolicyWithin('up=30d', 'up=none')).toBe(true);
    // Each kind is read over the release defaults: raising `up` above the default is a loosening.
    expect(durationPolicyWithin('up=none', '')).toBe(false);
    expect(durationPolicyWithin('send=30d;up=30d', 'send=30d')).toBe(true);
    expect(durationPolicyWithin('send=30d', 'send=30d;up=30d')).toBe(false);
  });

  const declaration = (level: 'entity' | 'project', value: string) => ({
    name: POLICY, value, level, setter: 'owner', date: NOW.toISOString(), expiry: null, kind: 'enforced' as const, target: level === 'entity' ? 'floor' : 'p1', generation: 0,
  });
  const chain = (entity: string, project: string) =>
    resolvePolicyChain({
      entity: { ok: true, level: 'entity', target: 'floor', policies: [declaration('entity', entity)] },
      project: { ok: true, level: 'project', target: 'p1', policies: [declaration('project', project)] },
    } as never);

  test('the chain: a project may lower the entity, never loosen it, and keeps the kinds it does not name', () => {
    const lowered = chain('send=30d;up=none', 'send=7d');
    expect(lowered.ok).toBe(true);
    if (lowered.ok) expect(lowered.policies[POLICY]?.value).toBe('send=7d;up=none;bundle=90d');
    const loosened = chain('send=7d', 'send=30d');
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) expect(loosened.refusals[0]?.message).toContain('loosens level entity');
    expect(chain('send=30d', 'send=none').ok).toBe(false);
  });

  test('through real files: a project that loosens refuses the whole chain, so a new grant is refused', () => {
    const w = world('narrow-files', { projectId: 'p1' });
    setPolicy(w, 'send=7d');
    expect(grantDurationInForce(w.home, 'floor', 'p1', NOW).ok).toBe(true);
    // The writer takes the project word at its own level; the chain refuses it as a loosening.
    writePolicySet(w.home, { level: 'project', target: 'p1', name: POLICY, value: 'send=30d' }, { now: NOW });
    const refused = planClientGrant(w.home, request(w, { expires: at(20) }), { now: NOW });
    expect(refused.ok).toBe(false);
    const why = refused.ok ? '' : refused.why;
    expect(why).toContain('the policy chain cannot be verified');
    expect(why).toContain('loosens');
    expect(why).toContain('nothing was signed');
    // Not even the default length is granted on a chain nobody can verify.
    expect(planClientGrant(w.home, request(w), { now: NOW }).ok).toBe(false);
  });

  test('through real files: a project that lowers wins, and names itself', () => {
    const w = world('narrow-lower', { projectId: 'p1' });
    setPolicy(w, 'send=30d');
    const set = writePolicySet(w.home, { level: 'project', target: 'p1', name: POLICY, value: 'send=3d' }, { now: NOW });
    expect(set.ok, set.ok ? '' : set.why).toBe(true);
    expect(planClientGrant(w.home, request(w, { expires: at(3) }), { now: NOW }).ok).toBe(true);
    const over = planClientGrant(w.home, request(w, { expires: at(4) }), { now: NOW });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.why).toContain('the policy client-grant-max-duration at project p1 allows at most 3 days for a send grant');
    expect(over.ok ? '' : over.why).toContain('--project p1');
  });
});

describe('a chain that cannot be read or verified refuses a new grant', () => {
  test('a policy file edited after it was signed refuses every kind, and nothing is written', () => {
    const w = world('tampered');
    setPolicy(w, 'send=7d');
    const file = join(w.home, '.config', 'team', 'entities.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('send=7d', 'send=none'));
    for (const refused of [
      planClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW }),
      planClientGrant(w.home, request(w), { now: NOW }),
      planClientUpGrant(w.home, { ...request(w), up: binding(w) }, { now: NOW }),
      planClientBundleGrant(w.home, bundleRequest(w), { now: NOW }),
    ]) {
      expect(refused.ok).toBe(false);
      const why = refused.ok ? '' : refused.why;
      expect(why).toContain('the policy chain cannot be verified');
      expect(why).toContain('nothing was signed');
    }
    const written = writeClientGrant(w.home, request(w), { now: NOW, key: w.ownerKey });
    expect(written.ok).toBe(false);
    expect(existsSync(join(w.home, '.config', 'team', 'grants')) ? readdirSync(join(w.home, '.config', 'team', 'grants')) : []).toEqual([]);
  });

  test('an entity file that is not YAML refuses too, rather than reading as the default', () => {
    const w = world('unreadable');
    writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), 'floor: [unclosed\n');
    const refused = planClientGrant(w.home, request(w), { now: NOW });
    expect(refused.ok).toBe(false);
  });
});

/** A world with one grant per kind, every one of them signed under `none`. */
function noEndWorld(label: string) {
  const w = world(label);
  setPolicy(w, 'none');
  const send = must(writeClientGrant(w.home, request(w, { neverExpires: true }), { now: NOW, key: w.ownerKey }));
  const up = must(writeClientUpGrant(w.home, { ...request(w, { neverExpires: true }), ops: ['up', 'down'], up: binding(w) }, { now: NOW, key: w.ownerKey }));
  const down = must(writeClientUpGrant(w.home, { ...request(w, { neverExpires: true }), ops: ['down'], up: binding(w) }, { now: NOW, key: w.ownerKey }));
  const observer = must(writeClientBundleGrant(w.home, bundleRequest(w, { neverExpires: true }), { now: NOW, key: w.ownerKey }));
  return { w, send, up, down, observer };
}

function capture(w: World, caller?: Caller): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd: w.teamRoot, env: {}, stdinIsTTY: false, ...(caller ? { caller } : {}) };
  return { io, out: () => out, err: () => err };
}

async function sendAt(w: World, grantPath: string, now: Date, sendId = 'drop-1'): Promise<{ code: number; err: string }> {
  const argv = ['--client', grantPath, '--key', w.keyPath, 'orchestrator@floor', 'hello orchestrator'];
  const c = capture(w);
  const host = { home: w.home, now: () => now, sendId: () => sendId } as unknown as SendHost;
  const code = await runClientSend(readArgs(argv, ['file', 'client', 'key', 'request-id'], ['json']), c.io, host, false);
  return { code, err: c.err() };
}

describe('a grant with no end date verifies everywhere, and is not expired in the far future', () => {
  test('the record level: never expired, still revocable', () => {
    expect(clientGrantExpired(null, new Date(8_640_000_000_000_000))).toBe(false);
    expect(clientGrantExpired(at(1), new Date(NOW.getTime() + 2 * DAY))).toBe(true);
    expect(clientGrantExpired('not a date', NOW)).toBe(true);
    expect(expiryPhrase(null)).toBe('until revoked (no end date)');
    expect(expiryPhrase('2027-01-01T00:00:00.000Z')).toBe('until 2027-01-01T00:00:00.000Z');
    const { w, send, up, observer } = noEndWorld('verify-record');
    const sendRead = must(readClientGrantFile(w.home, send.path));
    expect(activeClientGrant(w.home, sendRead, FAR).ok).toBe(true);
    for (const issued of [up, observer]) {
      const read = must(readClientUpGrantFile(w.home, issued.path, issued === up ? 'up' : 'status'));
      expect(activeClientUpGrant(w.home, read, FAR).ok).toBe(true);
    }
  });

  test('send: a client send ten years on is admitted and drops the message', async () => {
    const { w, send } = noEndWorld('verify-send');
    const run = await sendAt(w, send.path, FAR);
    expect(run.code, run.err).toBe(0);
    const drops = join(w.teamRoot, '.agents', 'send-drops', 'floor', 'orchestrator');
    expect(readdirSync(drops).length).toBe(1);
  });

  test('up, down and status: verified ten years on, each op from its own record', () => {
    const { w, up, down, observer } = noEndWorld('verify-up');
    const run = (grantPath: string, op: 'up' | 'down' | 'status') =>
      verifyClientUp({ home: w.home, grantFile: grantPath, keyFile: w.keyPath, cwd: w.acme, team: 'acme', now: FAR, op, io: null });
    for (const [issued, op] of [[up, 'up'], [up, 'down'], [down, 'down'], [observer, 'status']] as const) {
      const verified = run(issued.path, op);
      expect(verified.ok, verified.ok ? '' : verified.why).toBe(true);
      if (verified.ok) expect(verified.grant.expires).toBeNull();
    }
    // A record still says no more than it was signed for.
    expect(run(down.path, 'up').ok).toBe(false);
    expect(run(observer.path, 'down').ok).toBe(false);
  });

  test('a dated grant is still refused after its date, and says so', async () => {
    const w = world('dated-still-expires');
    const dated = must(writeClientGrant(w.home, request(w), { now: NOW, key: w.ownerKey }));
    const run = await sendAt(w, dated.path, new Date(NOW.getTime() + 8 * DAY));
    expect(run.code).toBe(1);
    expect(run.err).toContain('expired at');
  });

  test('revoke ends it: send, up, down, status and the record gate all refuse after `team revoke`', async () => {
    const { w, send, up, observer } = noEndWorld('revoke');
    const revoke = capture(w, { kind: 'owner' });
    expect(await runRevoke([send.grant.grantId], revoke.io, { home: w.home } as never)).toBe(0);
    expect(await runRevoke([up.grant.grantId], capture(w, { kind: 'owner' }).io, { home: w.home } as never)).toBe(0);
    expect(await runRevoke([observer.grant.grantId], capture(w, { kind: 'owner' }).io, { home: w.home } as never)).toBe(0);
    const afterSend = await sendAt(w, send.path, FAR, 'drop-2');
    expect(afterSend.code).toBe(1);
    expect(afterSend.err).toContain('was revoked');
    const verify = (grantPath: string, op: 'up' | 'down' | 'status') =>
      verifyClientUp({ home: w.home, grantFile: grantPath, keyFile: w.keyPath, cwd: w.acme, team: 'acme', now: FAR, op, io: null });
    for (const [issued, op] of [[up, 'up'], [up, 'down'], [observer, 'status']] as const) {
      const verified = verify(issued.path, op);
      expect(verified.ok).toBe(false);
      expect(verified.ok ? '' : verified.why).toContain('was revoked');
    }
    expect(activeClientGrant(w.home, must(readClientGrantFile(w.home, send.path)), NOW).ok).toBe(false);
  });

  test('an edit to the record, or a null written by hand without the owner key, verifies as nothing', () => {
    const w = world('edited');
    const dated = must(writeClientGrant(w.home, request(w), { now: NOW, key: w.ownerKey }));
    const doc = JSON.parse(readFileSync(dated.path, 'utf8'));
    doc.client_grant.expires = null;
    writeFileSync(dated.path, JSON.stringify(doc));
    expect(readClientGrantFile(w.home, dated.path).ok).toBe(false);
  });
});

describe('an older build refuses a record with no end date whole', () => {
  test('the record keeps its vocabulary and carries an explicit null: the shipped decoders read a string there', async () => {
    const { send, up, observer } = noEndWorld('older');
    // No vocabulary was bumped: 1 to 5 mean what they meant. What an older build cannot read is
    // the field: every shipped decoder requires `typeof expires === 'string'` (and a date no
    // further than its own constant from `issued`), so a null, or a thirty-day send grant, is
    // refused as a whole record, never read as valid forever and never a crash.
    expect([recordOf(send.path).vocabulary, recordOf(up.path).vocabulary, recordOf(observer.path).vocabulary]).toEqual([1, 4, 5]);
    for (const path of [send.path, up.path, observer.path]) {
      const disk = recordOf(path);
      expect(disk.expires).toBeNull();
      // The shipped rule, as written in the previous build's decoders.
      const olderReads = typeof disk.expires === 'string' && Number.isFinite(Date.parse(disk.expires));
      expect(olderReads).toBe(false);
    }
    // The vocabulary-1 reader of THIS build still reads an old record unchanged: a dated one.
    const w = world('older-dated');
    const dated = must(writeClientGrant(w.home, request(w), { now: NOW, key: w.ownerKey }));
    expect(typeof recordOf(dated.path).expires).toBe('string');
    expect(recordOf(dated.path).vocabulary).toBe(1);
  });
});

describe('the owner card: request, owner-seat answer, execute', () => {
  const flags = (w: World, extra: string[] = []) => ['--client', CLIENT_ID, '--entity', 'floor', '--public-key', w.pubPath, '--team', 'teamcli', '--seat', 'orchestrator', ...extra];

  async function seatAndEmission(w: World): Promise<void> {
    const conversational = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'grant-emission', value: 'conversational' }, { now: new Date() });
    if (!conversational.ok) throw new Error(conversational.why);
    const code = await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], capture(w, { kind: 'owner' }).io, { home: w.home, ownerSeatStore: w.store });
    expect(code).toBe(0);
  }

  async function ask(w: World, extra: string[]) {
    const c = capture(w);
    const code = await runGrant([...flags(w, ['--request', ...extra]), '--json'], c.io, { home: w.home, notify: () => false });
    const text = c.out().trim();
    return { code, out: c.out(), err: c.err(), json: text.startsWith('{') ? JSON.parse(text) : null };
  }

  const setNow = (w: World, value: string) => writePolicySet(w.home, { level: 'entity', target: 'floor', name: POLICY, value }, { now: new Date() });

  test('--expires never under none: the card says until revoked (no end date), always is refused, once signs null', async () => {
    const w = world('card-never');
    await seatAndEmission(w);
    expect(setNow(w, 'send=none').ok).toBe(true);
    const asked = await ask(w, ['--expires', 'never']);
    expect(asked.code, asked.out + asked.err).toBe(0);
    const id = asked.json.target as string;
    expect(asked.json.summary.expires).toBeNull();
    expect(asked.json.summary.text).toBe(`Grant for ${CLIENT_ID}: send to orchestrator@teamcli (entity floor) until revoked (no end date). NO END DATE: it stays valid until you end it with team revoke.`);
    expect(asked.json.prompt).toContain('until revoked (no end date)');
    expect(asked.json.prompt).toContain('NO END DATE');
    // Never "always": a standing rule would renew the largest grant unasked.
    const always = capture(w);
    expect(await runGrant(['--approve-as-owner-seat', id, 'always'], always.io, { home: w.home, ownerSeatStore: w.store })).toBe(1);
    expect(always.err()).toContain('no end date is never approved always');
    // The owner seat's signature prompt carries the same words.
    const yes = capture(w);
    expect(await runGrant(['--approve-as-owner-seat', id, 'oui'], yes.io, { home: w.home, ownerSeatStore: w.store }), yes.err()).toBe(0);
    expect(w.store.prompts.at(-1)).toContain('until revoked (no end date)');
    const done = capture(w);
    expect(await runGrant(['--execute', id], done.io, { home: w.home, ownerSeatStore: w.store }), done.err()).toBe(0);
    expect(done.out()).toContain('expires: never (until revoked; no end date)');
    const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out())![1]!;
    expect(recordOf(clientGrantPath(w.home, grantId)).expires).toBeNull();
    expect(recordOf(clientGrantPath(w.home, grantId)).recipient_seat).toBe('orchestrator');
    expect(recordOf(clientGrantPath(w.home, grantId)).team).toBe('teamcli');
    // One approval, one grant: the request is spent.
    expect(await runGrant(['--execute', id], capture(w).io, { home: w.home, ownerSeatStore: w.store })).toBe(1);
  });

  test('a dated request shows its date, and a request without --expires shows the default length', async () => {
    const w = world('card-dated');
    await seatAndEmission(w);
    const plain = await ask(w, []);
    expect(plain.code, plain.err).toBe(0);
    expect(plain.json.summary.text).toMatch(/\(entity floor\) until 20\d\d-\d\d-\d\dT[\d:.]+Z\.$/);
    expect(plain.json.summary.text).not.toContain('NO END DATE');
    expect(Date.parse(plain.json.summary.expires) - Date.now()).toBeLessThanOrEqual(7 * DAY);
    // A cap below the default shortens what the card promises.
    expect(setNow(w, 'send=2d').ok).toBe(true);
    const short = await ask(w, []);
    expect(Date.parse(short.json.summary.expires) - Date.now()).toBeLessThanOrEqual(2 * DAY);
  });

  test('send=365d: a one-year --request is refused by default, accepted once the owner sets it, signed, executed and read back', async () => {
    const w = world('card-year');
    await seatAndEmission(w);
    const year = new Date(Date.now() + 364 * DAY).toISOString();
    const refused = await ask(w, ['--expires', year]);
    expect(refused.code).toBe(1);
    expect(refused.json.error.message).toContain('more than 7 days away');
    expect(refused.json.error.message).toContain('team policy set entity client-grant-max-duration');
    expect(setNow(w, 'send=365d').ok).toBe(true);
    const asked = await ask(w, ['--expires', year]);
    expect(asked.code, asked.out + asked.err).toBe(0);
    expect(asked.json.summary.expires).toBe(year);
    const id = asked.json.target as string;
    const yes = capture(w);
    expect(await runGrant(['--approve-as-owner-seat', id, 'oui'], yes.io, { home: w.home, ownerSeatStore: w.store }), yes.err()).toBe(0);
    const done = capture(w);
    expect(await runGrant(['--execute', id], done.io, { home: w.home, ownerSeatStore: w.store }), done.err()).toBe(0);
    expect(done.out()).toContain(`expires: ${year}`);
    const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out())![1]!;
    expect(recordOf(clientGrantPath(w.home, grantId)).expires).toBe(year);
    // The cap is a bound: a day past it is refused, and so is no end date.
    const past = await ask(w, ['--expires', new Date(Date.now() + 366 * DAY).toISOString()]);
    expect(past.code).toBe(1);
    expect(past.json.error.message).toContain('more than 365 days away');
    expect((await ask(w, ['--expires', 'never'])).code).toBe(1);
  });

  test('--expires never is refused at the request when the policy is not none, naming the policy and the command', async () => {
    const w = world('card-refused');
    await seatAndEmission(w);
    const unset = await ask(w, ['--expires', 'never']);
    expect(unset.code).toBe(1);
    expect(unset.json.error.message).toContain(`no ${POLICY} policy is set`);
    expect(unset.json.error.message).toContain('team policy set entity client-grant-max-duration send=none --entity floor');
    expect(setNow(w, 'send=30d').ok).toBe(true);
    const capped = await ask(w, ['--expires', 'never']);
    expect(capped.code).toBe(1);
    expect(capped.json.error.message).toContain('the policy client-grant-max-duration at entity floor allows at most 30 days for a send grant');
    const tooLong = await ask(w, ['--expires', new Date(Date.now() + 40 * DAY).toISOString()]);
    expect(tooLong.code).toBe(1);
    expect(tooLong.json.error.message).toContain('at most 30 days');
  });

  test('a policy lowered after the owner answered refuses the request at execute, which is then not spent', async () => {
    const w = world('card-lowered');
    await seatAndEmission(w);
    expect(setNow(w, 'send=none').ok).toBe(true);
    const asked = await ask(w, ['--expires', 'never']);
    const id = asked.json.target as string;
    expect((await (async () => runGrant(['--approve-as-owner-seat', id, 'oui'], capture(w).io, { home: w.home, ownerSeatStore: w.store }))())).toBe(0);
    expect(setNow(w, 'send=30d').ok).toBe(true);
    const run = capture(w);
    expect(await runGrant(['--execute', id], run.io, { home: w.home, ownerSeatStore: w.store })).toBe(1);
    expect(run.err()).toContain('--expires never is refused');
    expect(run.err()).toContain('is not spent');
    // Raised again, the same answer still stands: nothing was burnt.
    expect(setNow(w, 'send=none').ok).toBe(true);
    const again = capture(w);
    expect(await runGrant(['--execute', id], again.io, { home: w.home, ownerSeatStore: w.store }), again.err()).toBe(0);
  });

  test('the request is the request: no end date hashes apart from a dated one', () => {
    const params = (extra: Partial<PendingGrantParams>): PendingGrantParams => ({
      client_id: CLIENT_ID, entity: 'floor', public_key: 'a'.repeat(64), key_id: 'b'.repeat(12), key_dir: '/k', team: 'teamcli', seat: 'orchestrator',
      expires: null, inbox: false, allow_grant: false, grant_scope: null, ...extra,
    });
    expect(pendingGrantHash(params({ expires_never: true }))).not.toBe(pendingGrantHash(params({})));
    expect(pendingGrantHash(params({ expires_never: true }))).not.toBe(pendingGrantHash(params({ expires: at(3) })));
    // A request that never mentions it hashes exactly as before the field existed.
    expect(pendingGrantHash(params({ expires_never: false }))).toBe(pendingGrantHash(params({})));
  });
});
