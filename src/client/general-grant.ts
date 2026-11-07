// General grants: one owner-signed record that lets a named client principal act across every
// entity, or a listed set, without a per-action request. A holder may issue a narrower grant to
// another principal (never to itself, never wider than its own); that child is signed by the
// holder's client key and chains back to an owner-signed root.
import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { CLIENT_PUBLIC_KEY_PATTERN, publicKeyObject, readClientPrivateKey } from './records.ts';

export const GENERAL_GRANT_DOMAIN = 'team-general-grant-v1';
// Every command's op: the first nine since 0.5.6, then (0.5.8) every other command the dispatcher's
// general door admits, so a listed grant may name any of them. `abandon` is `down --abandon`'s.
// A command added later is covered by the wildcard at once, and by name once it is listed here
// (test/general-door.test.ts holds this list to the command table). `fallback`, `waits`, `order`
// and `trace` joined with the 0.5.12 routes and have no release row yet:
// test/general-grant-widened.test.ts declares them unshipped until a release measures them.
export const GENERAL_OPS = [
  'config', 'restart', 'up', 'down', 'abandon', 'send', 'messages', 'reply', 'init',
  'ack', 'add', 'agents', 'analyse', 'answer', 'approvals', 'archive', 'ask-show', 'batch', 'brief', 'broker', 'bus', 'check', 'checkpoint', 'client',
  'commits', 'daemon', 'delegate', 'development-mode', 'doctor', 'drops', 'fallback', 'feed', 'forget', 'grant', 'hold', 'import',
  'issues', 'list', 'lock', 'mcp', 'migrate', 'next', 'order', 'owner-seat', 'pause', 'peek', 'plan', 'policy', 'pr', 'proc', 'projects',
  'queue', 'raise', 'register', 'release', 'reload', 'remove', 'rename', 'resume', 'revoke', 'route', 'seat', 'seats',
  'sessions', 'settings', 'setup', 'show', 'status', 'swap', 'tempo', 'trace', 'unlock', 'usage', 'waits', 'watch', 'workflow', 'worktree',
] as const;
export type GeneralOp = (typeof GENERAL_OPS)[number];
/** Delegable ops, now and later, except those requiring an explicit name. Signed as literal `*`. */
export const ALL_OPS = '*' as const;
export type GrantOp = GeneralOp | typeof ALL_OPS;
/** A wildcard never includes these ops, including when its holder issues a child grant. */
export const EXPLICIT_GENERAL_OPS: ReadonlySet<GeneralOp> = new Set(['forget']);
/** Whether a signed op list covers `op`. */
export function opsCover(ops: readonly string[], op: GeneralOp): boolean {
  return ops.includes(op) || (ops.includes(ALL_OPS) && !EXPLICIT_GENERAL_OPS.has(op));
}

/**
 * The op a flag reaches beyond the command's own name: `team down --abandon` is `abandon`, not
 * `down`. The one mapping both the door and the grant's own words read, so a flag that reaches
 * another op is never admitted under the bare command's name. A command with no entry reaches
 * its own op whatever flags it carries (`restart --abandon` is still `restart`).
 */
export const FLAG_OPS: Readonly<Record<string, Readonly<Record<string, GeneralOp>>>> = {
  down: { abandon: 'abandon' },
};

/**
 * The op a grouped verb reaches: `team seat add` re-dispatches to `team add`, so the line is the
 * `add` op, not `seat`. The same single mapping the door reads, so the grant of a re-dispatched
 * line is checked against the command that runs.
 */
export const VERB_OPS: Readonly<Record<string, Readonly<Record<string, GeneralOp>>>> = {
  seat: { add: 'add', remove: 'remove', restart: 'restart', rename: 'rename' },
};
export const GENERAL_GRANT_ID = /^gg_[0-9a-f]{24}$/;
const MAX_CHAIN = 4;

export type GeneralGrant = {
  grant_id: string;
  client_id: string;
  public_key: string;
  /** `['*']` for every entity, or the listed entity slugs. */
  entities: string[];
  /** The listed ops, or `['*']` for every op, including ops added in later releases. */
  ops: GrantOp[];
  /** Whether the holder may issue a narrower grant to another principal. */
  may_issue: boolean;
  /** The grant this one was issued under, or null when the owner signed it. */
  parent: string | null;
  issued: string;
  expires: string;
};
type Disk = { general_grant: GeneralGrant; signature: string };
type R<T> = ({ ok: true } & T) | { ok: false; why: string };

export function generalGrantsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'general-grants');
}
export function generalGrantPath(home: string, id: string): string {
  return join(generalGrantsFolder(home), `${id}.json`);
}
function payload(g: GeneralGrant): Json {
  return { general_grant: { ...g, entities: [...g.entities].sort(), ops: [...g.ops].sort() } } as unknown as Json;
}

export function parseEntities(raw: string | undefined): string[] | string {
  if (raw === undefined || raw.trim() === '*' || raw.trim() === 'all') return ['*'];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '--entities names no entity';
  for (const e of list) if (!/^[a-z0-9][a-z0-9._-]*$/.test(e)) return `"${e}" is not an entity slug`;
  return [...new Set(list)];
}
/** Absent, `all` or `*` is every op (the wildcard); a list names ops of GENERAL_OPS only. */
export function parseOps(raw: string | undefined): GrantOp[] | string {
  if (raw === undefined || raw.trim() === 'all' || raw.trim() === ALL_OPS) return [ALL_OPS];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '--ops names no op';
  for (const o of list) if (!(GENERAL_OPS as readonly string[]).includes(o)) return `"${o}" is not a general-grant op (${GENERAL_OPS.join(', ')})`;
  return [...new Set(list)] as GrantOp[];
}

/** Whether `child` stays within `parent`: entities, ops, expiry, issuing. */
export function withinScope(child: Pick<GeneralGrant, 'entities' | 'ops' | 'expires' | 'may_issue'>, parent: GeneralGrant): string | null {
  if (!parent.entities.includes('*')) {
    if (child.entities.includes('*')) return 'the child names every entity; the parent does not cover every entity';
    for (const e of child.entities) if (!parent.entities.includes(e)) return `entity "${e}" is outside the parent grant`;
  }
  if (child.ops.includes(ALL_OPS) && !parent.ops.includes(ALL_OPS)) return 'the child names every op; the parent does not cover every op';
  for (const op of child.ops) {
    if (op !== ALL_OPS && (!(GENERAL_OPS as readonly string[]).includes(op) || !opsCover(parent.ops, op))) return `op "${op}" is outside the parent grant`;
  }
  if (Date.parse(child.expires) > Date.parse(parent.expires)) return 'the child would outlive the parent grant';
  if (child.may_issue && !parent.may_issue) return 'the parent grant may not issue grants that issue';
  return null;
}

function publish(home: string, g: GeneralGrant, signature: string): R<{ path: string }> {
  const folder = generalGrantsFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = generalGrantPath(home, g.grant_id);
    writeFileSync(path, `${JSON.stringify({ general_grant: g, signature } satisfies Disk, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: true, path };
  } catch (error) {
    return { ok: false, why: `the general grant could not be written in "${folder}": ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type IssueInput = { clientId: string; publicKey: string; entities: string[]; ops: GrantOp[]; mayIssue: boolean; expires: Date };

function fresh(input: IssueInput, parent: string | null, now: Date): GeneralGrant | string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.clientId)) return `"${input.clientId}" is not a client id`;
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(input.publicKey)) return 'the public key is not a raw Ed25519 key';
  if (!(input.expires.getTime() > now.getTime())) return 'the expiry is not in the future';
  return {
    grant_id: `gg_${randomBytes(12).toString('hex')}`,
    client_id: input.clientId,
    public_key: input.publicKey,
    entities: input.entities,
    ops: input.ops,
    may_issue: input.mayIssue,
    parent,
    issued: now.toISOString(),
    expires: input.expires.toISOString(),
  };
}

/** The owner's issue: signed under the owner key. Called only after an owner-seat admission. */
export function issueOwnerGeneralGrant(home: string, input: IssueInput, now: Date = new Date(), key?: KeyObject): R<{ grant: GeneralGrant; path: string }> {
  const g = fresh(input, null, now);
  if (typeof g === 'string') return { ok: false, why: g };
  const signature = signDomain(GENERAL_GRANT_DOMAIN, payload(g), key ?? keyOf(home));
  const out = publish(home, g, signature);
  return out.ok ? { ok: true, grant: g, path: out.path } : out;
}

/** A holder's issue to another principal, within its own scope, signed by the holder's client key. */
export function issueHeldGeneralGrant(home: string, parentPath: string, holderKeyPath: string, input: IssueInput, now: Date = new Date()): R<{ grant: GeneralGrant; path: string }> {
  const parent = readGeneralGrant(home, parentPath, now);
  if (!parent.ok) return parent;
  const held = readClientPrivateKey(home, holderKeyPath);
  if (!held.ok) return held;
  if (held.publicKey !== parent.grant.public_key) return { ok: false, why: 'the key does not match the parent grant' };
  if (!parent.grant.may_issue) return { ok: false, why: `grant ${parent.grant.grant_id} may not issue grants` };
  if (input.clientId === parent.grant.client_id || input.publicKey === parent.grant.public_key) return { ok: false, why: 'a holder never issues a grant to itself' };
  const g = fresh(input, parent.grant.grant_id, now);
  if (typeof g === 'string') return { ok: false, why: g };
  const wider = withinScope(g, parent.grant);
  if (wider !== null) return { ok: false, why: `refused: ${wider}; a holder never issues wider than its own grant` };
  const signature = signDomain(GENERAL_GRANT_DOMAIN, payload(g), createPrivateKey(held.privatePem));
  const out = publish(home, g, signature);
  return out.ok ? { ok: true, grant: g, path: out.path } : out;
}

function load(path: string): Disk | string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return `"${path}" is not a plain file`;
    if (process.getuid !== undefined && stat.uid !== process.getuid()) return `"${path}" belongs to another user`;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Disk;
    const g = parsed?.general_grant;
    if (typeof parsed?.signature !== 'string' || g === undefined || !GENERAL_GRANT_ID.test(g.grant_id) || !Array.isArray(g.entities) || !Array.isArray(g.ops)) return `"${path}" is not a general grant`;
    return parsed;
  } catch {
    return `"${basename(path)}" cannot be read as a general grant`;
  }
}

/** One verified general grant, its whole chain checked back to the owner's signature. */
export function readGeneralGrant(home: string, path: string, now: Date = new Date(), depth = 0): R<{ grant: GeneralGrant }> {
  if (depth > MAX_CHAIN) return { ok: false, why: 'the grant chain is too long' };
  const disk = load(path);
  if (typeof disk === 'string') return { ok: false, why: disk };
  const g = disk.general_grant;
  if (!(Date.parse(g.expires) > now.getTime())) return { ok: false, why: `general grant ${g.grant_id} has expired` };
  if (g.parent === null) {
    const state = keyState(home);
    if (state.kind !== 'key') return { ok: false, why: 'the owner signing key is absent or unreadable: no general grant can verify' };
    if (!verifyDomain(GENERAL_GRANT_DOMAIN, payload(g), disk.signature, keyOf(home))) return { ok: false, why: `general grant ${g.grant_id} does not verify under the owner key` };
    return { ok: true, grant: g };
  }
  if (!GENERAL_GRANT_ID.test(g.parent)) return { ok: false, why: 'the parent grant id is malformed' };
  const parent = readGeneralGrant(home, generalGrantPath(home, g.parent), now, depth + 1);
  if (!parent.ok) return { ok: false, why: `parent ${g.parent}: ${parent.why}` };
  const pk = publicKeyObject(parent.grant.public_key);
  if (pk === null || !verifyDomain(GENERAL_GRANT_DOMAIN, payload(g), disk.signature, pk)) return { ok: false, why: `general grant ${g.grant_id} does not verify under its parent holder's key` };
  if (g.client_id === parent.grant.client_id || g.public_key === parent.grant.public_key) return { ok: false, why: 'the grant was issued to its own holder' };
  const wider = withinScope(g, parent.grant);
  if (wider !== null) return { ok: false, why: wider };
  return { ok: true, grant: g };
}

/** One check of a read grant, as a plain verdict: the doors compose the checks, in order. */
export type GrantVerdict = { ok: true } | { ok: false; why: string };

/** The key proves the grant: reading it at the path given is the proof. */
export function grantKeyMatches(home: string, grant: GeneralGrant, keyPath: string): GrantVerdict {
  const held = readClientPrivateKey(home, keyPath);
  if (!held.ok) return held;
  if (held.publicKey !== grant.public_key) return { ok: false, why: `the key does not match general grant ${grant.grant_id}` };
  return { ok: true };
}

/** The one sentence a grant that lists entities is refused with this release. Exported so every
 *  door gives the same refusal word for word, and a scene holds the sentence still. */
export const SCOPED_GRANT_REFUSAL = 'scoped general grants arrive in 0.5.11; use a wildcard grant or the owner path';

/** 0.5.10's narrow door: a grant admits only when its entities are exactly `['*']`. A grant that
 *  lists entities is still issued, signed and chained as before; no door reads it this release,
 *  because there is no target to check while the wildcard is the only admitted shape. */
export function grantIsWildcard(grant: GeneralGrant): GrantVerdict {
  if (grant.entities.length === 1 && grant.entities[0] === '*') return { ok: true };
  return { ok: false, why: SCOPED_GRANT_REFUSAL };
}

/** The grant covers the op the line reaches. */
export function grantCoversOp(grant: GeneralGrant, op: GeneralOp): GrantVerdict {
  if (EXPLICIT_GENERAL_OPS.has(op) && !grant.ops.includes(op)) {
    return { ok: false, why: `${op} needs an explicit grant naming ${op}, or a per-use approval from the owner (--request/--approval); a wildcard grant does not cover it` };
  }
  if (!opsCover(grant.ops, op)) return { ok: false, why: `general grant ${grant.grant_id} does not cover ${op}` };
  return { ok: true };
}

/** Whether this grant file and key admit `op`. 0.5.10's narrow door admits a wildcard grant only,
 *  so a grant that lists entities is refused before the op is checked, with the one message
 *  `SCOPED_GRANT_REFUSAL` carries. `entity` — the team the run would act on — is not read this
 *  release: with no listed grant admitted, there is no target to check; 0.5.11 restores the check.
 *  Proof of the key is reading it. */
export function admitGeneral(home: string, grantPath: string, keyPath: string, op: GeneralOp, entity: string | null, now: Date = new Date()): R<{ grant: GeneralGrant }> {
  const read = readGeneralGrant(home, grantPath, now);
  if (!read.ok) return read;
  const held = grantKeyMatches(home, read.grant, keyPath);
  if (!held.ok) return held;
  const wildcard = grantIsWildcard(read.grant);
  if (!wildcard.ok) return wildcard;
  const covered = grantCoversOp(read.grant, op);
  if (!covered.ok) return covered;
  return { ok: true, grant: read.grant };
}

/**
 * The release that first shipped each op, measured from this repository's release tags: the op's
 * route in the dispatcher table (`src/cli.ts`) at each tag, by tag date, with `abandon` read from
 * `down --abandon` at v0.1.0. A release candidate is not a release, so `-rc.` tags are skipped.
 * `tag` is the provenance of `at`. The newest entry may name the release being cut, whose tag is
 * created only after its release commit: that row's `at` is the release commit's own time, recorded
 * from the commit so the op is measured as shipped rather than read as unshipped. An op no release
 * ships yet has no entry.
 */
type OpRelease = { tag: string; at: string };
export const OP_RELEASE_GROUPS: readonly { tag: string; at: string; ops: readonly GeneralOp[] }[] = [
  { tag: 'v0.1.0', at: '2026-10-04T09:15:50+02:00', ops: ['up', 'down', 'abandon', 'init', 'add', 'check', 'doctor', 'remove', 'status', 'watch', 'worktree'] },
  { tag: 'v0.3.0', at: '2026-10-06T12:23:58+02:00', ops: ['answer', 'release'] },
  { tag: 'v0.3.3', at: '2026-10-07T12:27:51+02:00', ops: ['commits', 'pr', 'usage'] },
  {
    tag: 'v0.5.0',
    at: '2026-10-18T10:09:55+02:00',
    ops: ['restart', 'send', 'messages', 'ask-show', 'broker', 'delegate', 'feed', 'grant', 'hold', 'issues', 'list', 'lock', 'mcp', 'next', 'plan', 'policy', 'proc', 'projects', 'register', 'reload', 'rename', 'revoke', 'route', 'seats', 'tempo', 'unlock'],
  },
  { tag: 'v0.5.1', at: '2026-10-19T05:11:06+02:00', ops: ['reply', 'bus', 'drops', 'raise'] },
  { tag: 'v0.5.2', at: '2026-10-19T10:12:37+02:00', ops: ['pause', 'resume', 'sessions'] },
  { tag: 'v0.5.3-hotfix.1', at: '2026-10-19T22:33:47+02:00', ops: ['config', 'brief', 'client', 'seat', 'settings', 'swap'] },
  { tag: 'v0.5.3-hotfix.10', at: '2026-10-20T00:30:15+02:00', ops: ['daemon', 'development-mode', 'queue'] },
  { tag: 'v0.5.3', at: '2026-10-21T16:02:35+02:00', ops: ['ack'] },
  { tag: 'v0.5.5', at: '2026-10-26T10:45:10+01:00', ops: ['archive', 'import', 'migrate', 'owner-seat', 'workflow'] },
  { tag: 'v0.5.6', at: '2026-10-31T00:56:10+01:00', ops: ['approvals', 'batch', 'forget', 'setup'] },
  { tag: 'v0.5.10', at: '2026-11-01T15:22:48+01:00', ops: ['agents'] },
  // Measured against the 0.5.11 release commit (chore(release): 0.5.11, 8dbb7ee13): between
  // v0.5.10 and that commit the dispatcher gained exactly one route, `peek`, and lost none.
  { tag: 'v0.5.11', at: '2026-11-02T12:21:36+01:00', ops: ['peek'] },
  // Measured against the 0.5.12 release commit (the merge of release/0.5.12, 61931295e): between
  // v0.5.11 and that commit the dispatcher gained exactly four routes, `fallback`, `order`, `trace`
  // and `waits`, and lost none.
  { tag: 'v0.5.12', at: '2026-11-05T23:50:33+01:00', ops: ['fallback', 'order', 'trace', 'waits'] },
  // The existing v0.5.16 tag contains these routes, even though that version was not
  // published to npm. The tag remains their first measured dispatcher.
  { tag: 'v0.5.16', at: '2026-11-07T06:08:57+01:00', ops: ['analyse', 'checkpoint', 'show'] },
];
/** The first release that shipped each op, or null while no release ships it. */
export const OP_FIRST_SHIPPED: Readonly<Record<GeneralOp, OpRelease | null>> = (() => {
  const table = {} as Record<GeneralOp, OpRelease | null>;
  for (const op of GENERAL_OPS) table[op] = null;
  for (const row of OP_RELEASE_GROUPS) for (const op of row.ops) table[op] = { tag: row.tag, at: row.at };
  return table;
})();

/** One verified wildcard grant and the ops it reaches that first shipped after it was signed.
 *  `signed` is the grant's signing time, or null when the record carries none this code can read:
 *  an unknown signing time reads as unknown, never as new. */
export type WidenedGrant = { grant: GeneralGrant; signed: string | null; ops: GeneralOp[] };

/**
 * Every wildcard grant in this home that reaches an op first shipped after the grant was signed,
 * one entry per grant, reading only. A grant that does not verify — tampered, expired or
 * unreadable — is not admitted by any door, so it is not reported here either. A listed grant
 * never widens.
 */
export function wildcardGrantsWidened(home: string, now: Date = new Date()): WidenedGrant[] {
  const folder = generalGrantsFolder(home);
  let names: string[];
  try {
    names = readdirSync(folder).sort();
  } catch {
    return [];
  }
  const out: WidenedGrant[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!GENERAL_GRANT_ID.test(id)) continue;
    const read = readGeneralGrant(home, join(folder, name), now);
    if (!read.ok) continue;
    const grant = read.grant;
    if (!grant.ops.includes(ALL_OPS)) continue;
    const at = Date.parse(grant.issued);
    if (Number.isNaN(at)) {
      out.push({ grant, signed: null, ops: [] });
      continue;
    }
    const ops = GENERAL_OPS.filter((op) => {
      const release = OP_FIRST_SHIPPED[op];
      return !EXPLICIT_GENERAL_OPS.has(op) && release !== null && Date.parse(release.at) > at;
    });
    if (ops.length > 0) out.push({ grant, signed: grant.issued, ops });
  }
  return out;
}

/** The one plain line a widened wildcard grant is named with: the day it was signed, the ops it
 *  now reaches, and how to stop the line. */
export function widenedGrantNote(widened: WidenedGrant): string {
  const id = widened.grant.grant_id;
  if (widened.signed === null) {
    return `wildcard general grant ${id} has no readable signing time (unknown), so whether it reaches commands added in later releases cannot be told; re-sign the grant to make this readable`;
  }
  return `wildcard general grant ${id} signed ${widened.signed.slice(0, 10)} now reaches ${widened.ops.join(', ')}, which shipped in later releases; re-sign the grant to stop this note`;
}

/** What `team check` and `team doctor` print: one note per widened grant, in grant-id order. */
export function widenedGrantNotes(home: string, now: Date = new Date()): string[] {
  return wildcardGrantsWidened(home, now).map(widenedGrantNote);
}
