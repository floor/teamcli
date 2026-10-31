// General grants: one owner-signed record that lets a named client principal act across every
// entity, or a listed set, without a per-action request. A holder may issue a narrower grant to
// another principal (never to itself, never wider than its own); that child is signed by the
// holder's client key and chains back to an owner-signed root.
import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { CLIENT_PUBLIC_KEY_PATTERN, publicKeyObject, readClientPrivateKey } from './records.ts';

export const GENERAL_GRANT_DOMAIN = 'team-general-grant-v1';
export const GENERAL_OPS = ['config', 'restart', 'up', 'down', 'abandon', 'send', 'messages', 'reply', 'init'] as const;
export type GeneralOp = (typeof GENERAL_OPS)[number];
/** Every op, now and later: signed as the literal `*`, so one owner signature covers ops added after it. */
export const ALL_OPS = '*' as const;
export type GrantOp = GeneralOp | typeof ALL_OPS;
/** Whether a signed op list covers `op`. */
export function opsCover(ops: readonly string[], op: GeneralOp): boolean {
  return ops.includes(ALL_OPS) || ops.includes(op);
}
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
  if (!parent.ops.includes(ALL_OPS)) {
    if (child.ops.includes(ALL_OPS)) return 'the child names every op; the parent does not cover every op';
    for (const o of child.ops) if (!parent.ops.includes(o)) return `op "${o}" is outside the parent grant`;
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

/** Whether this grant file and key admit `op` on a team of `entity`. Proof of the key is reading it. */
export function admitGeneral(home: string, grantPath: string, keyPath: string, op: GeneralOp, entity: string | null, now: Date = new Date()): R<{ grant: GeneralGrant }> {
  const read = readGeneralGrant(home, grantPath, now);
  if (!read.ok) return read;
  const held = readClientPrivateKey(home, keyPath);
  if (!held.ok) return held;
  if (held.publicKey !== read.grant.public_key) return { ok: false, why: `the key does not match general grant ${read.grant.grant_id}` };
  if (!opsCover(read.grant.ops, op)) return { ok: false, why: `general grant ${read.grant.grant_id} does not cover ${op}` };
  if (!read.grant.entities.includes('*')) {
    if (entity === null) return { ok: false, why: 'this team belongs to no entity; the grant covers listed entities only' };
    if (!read.grant.entities.includes(entity)) return { ok: false, why: `general grant ${read.grant.grant_id} does not cover entity "${entity}"` };
  }
  return { ok: true, grant: read.grant };
}
