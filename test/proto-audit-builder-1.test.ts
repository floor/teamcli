// The private 0.5.10 audit of inherited names in the payloads this build reads: owner-action
// requests, grant requests, messages and signed envelopes, and the workflow store. An object
// parsed from outside the process can carry its own key named `__proto__` (JSON.parse makes it an
// own data property). Nothing here may let that name reach a plain-object assignment — where it
// would replace a map's prototype and drop the entry — or leave a later lookup walking a shared
// object. Each scene builds its payload synthetically and reads no real record, key or home.

import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerActionHash, readOwnerActionRecord } from '../src/client/owner-action.ts';
import type { OwnerActionParams } from '../src/client/owner-action.ts';
import { GRANT_REQUEST_DOMAIN, pendingGrantHash } from '../src/client/emission.ts';
import type { PendingGrantParams } from '../src/client/emission.ts';
import { MESSAGE_DOMAIN, signDomain, verifyDomain } from '../src/store/keys.ts';
import type { Json } from '../src/store/keys.ts';
import { canonicalJson } from '../src/workflow/canonical.ts';
import { readScript } from '../src/workflow/dry/script.ts';
import { validateItemKey } from '../src/workflow/live/records.ts';
import { parseWorkflow } from '../src/workflow/schema.ts';

const HOMES: string[] = [];

// A name a scene planted must not answer from the prototype every object shares.
function inherited(name: string): unknown {
  return ({} as Record<string, unknown>)[name];
}

function syntheticHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'proto-audit-'));
  HOMES.push(home);
  return home;
}

afterEach(() => {
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
});

function ownerParams(args: Record<string, unknown>): OwnerActionParams {
  return {
    kind: 'owner-action',
    actions: ['team-send'],
    root: '/synthetic/root',
    team: 'acme',
    head: null,
    args: args as OwnerActionParams['args'],
    requested_by: 'requester',
  };
}

describe('owner-action request payloads', () => {
  test('the parameters hash binds an args entry named __proto__', () => {
    // Two records that differ only in an extra entry: the hash the owner's answer binds must
    // tell them apart, or the approval covers bytes it never saw.
    const clean = ownerActionHash(ownerParams(JSON.parse('{"team-send":"aaa"}')));
    const extra = ownerActionHash(ownerParams(JSON.parse('{"team-send":"aaa","__proto__":{"team-send":"bbb"}}')));
    expect(extra).not.toBe(clean);
    expect(inherited('team-send')).toBeUndefined();
  });

  test('a request naming an action this build does not know is refused at the read door', () => {
    const home = syntheticHome();
    const folder = join(home, '.config', 'team', 'action-requests');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const id = `oa_${'a'.repeat(24)}`;
    const params = ownerParams(JSON.parse('{"team-send":"aaa"}'));
    (params.actions as string[]).push('__proto__');
    const record = { request_id: id, params, params_sha256: ownerActionHash(params), created: '2026-10-31T12:00:00.000Z', expires_at: null };
    writeFileSync(join(folder, `${id}.json`), `${JSON.stringify(record)}\n`);
    const read = readOwnerActionRecord(home, id);
    expect(read).toBe(`request ${id} names an action this build does not know`);
  });

  test('a request naming only known actions still reads back', () => {
    const home = syntheticHome();
    const folder = join(home, '.config', 'team', 'action-requests');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const id = `oa_${'b'.repeat(24)}`;
    const params = ownerParams(JSON.parse('{"team-send":"aaa"}'));
    const record = { request_id: id, params, params_sha256: ownerActionHash(params), created: '2026-10-31T12:00:00.000Z', expires_at: null };
    writeFileSync(join(folder, `${id}.json`), `${JSON.stringify(record)}\n`);
    const read = readOwnerActionRecord(home, id);
    expect(typeof read).toBe('object');
    if (typeof read === 'string') return;
    expect(read.request_id).toBe(id);
  });
});

describe('workflow store payloads', () => {
  test('two payloads that differ only by an own __proto__ entry canonicalize apart', () => {
    // The canonical encoding is an identity: a request and another that carries one extra field
    // must not digest to the same bytes.
    const clean = canonicalJson({ a: 1, nested: { b: 2 } });
    const extra = canonicalJson(JSON.parse('{"a":1,"nested":{"b":2,"__proto__":{"c":3}}}'));
    expect(extra).not.toBe(clean);
    expect(extra).toContain('"__proto__"');
    expect(inherited('c')).toBeUndefined();
  });

  test('an item key is four segments, so an item named __proto__ is an ordinary key', () => {
    const keyed = validateItemKey({ source: '__proto__', project: 'constructor', team: 'prototype', id: '__proto__' });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.key.split('.').length).toBe(4);
    expect(keyed.key).not.toBe('__proto__');
    const items: Record<string, number> = {};
    items[keyed.key] = 1;
    expect(Object.keys(items)).toEqual([keyed.key]);
    expect(Object.getPrototypeOf(items)).toBe(Object.prototype);
  });

  test('a definition naming a state __proto__ is refused at the reader', () => {
    const parsed = parseWorkflow(`workflow: proto-audit
version: 1
initial: idle
states:
  idle: {}
  __proto__: {}
transitions: []
`);
    expect('invalid' in parsed).toBe(true);
    if (!('invalid' in parsed)) return;
    expect(parsed.invalid.name).toBe('YamlError');
    expect(parsed.invalid.line).toBe(6);
    expect(parsed.invalid.message).toBe('a map key may not be "__proto__"');
  });
});

describe('evidence a dry script reads', () => {
  test('an evidence ref named __proto__ is refused at the reader', () => {
    const script = `format: 1
target: floor/teamcli
artifact: { kind: none }
settings: {}
inputs: {}
evidence:
  __proto__:
    type: timer
signals:
  - { signal: time-reached, at: '2026-10-21T18:00:00Z', request-id: req-1, expected-revision: 0, evidence: [__proto__] }
`;
    const read = readScript(script);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('workflow.script');
    expect(read.why).toBe('line 7: a map key may not be "__proto__"');
  });
});

describe('grant request payloads', () => {
  const params: PendingGrantParams = {
    client_id: 'client',
    entity: 'acme',
    public_key: 'pk',
    key_id: 'kid',
    key_dir: '/synthetic/key',
    team: 'acme',
    seat: 'seat',
    expires: null,
    inbox: false,
    allow_grant: false,
    grant_scope: { entities: [], projects: [], teams: [] },
  };

  test('the parameters hash reads its fixed fields, so an added entry changes nothing', () => {
    const clean = pendingGrantHash(params);
    const extended = { ...params, ...JSON.parse('{"__proto__":{"entity":"other"}}') } as PendingGrantParams;
    expect(pendingGrantHash(extended)).toBe(clean);
    expect(pendingGrantHash({ ...params, entity: 'other' })).not.toBe(clean);
    expect(inherited('entity')).toBeUndefined();
  });

  test('the signed request binds an own __proto__ entry in its body', () => {
    const keys = generateKeyPairSync('ed25519');
    const body = JSON.parse('{"name":"oa_example","grant_request":{"client_id":"client","__proto__":{"entity":"other"}}}') as Json;
    const signature = signDomain(GRANT_REQUEST_DOMAIN, body, keys.privateKey);
    expect(verifyDomain(GRANT_REQUEST_DOMAIN, body, signature, keys.publicKey)).toBe(true);
    const without = JSON.parse('{"name":"oa_example","grant_request":{"client_id":"client"}}') as Json;
    expect(verifyDomain(GRANT_REQUEST_DOMAIN, without, signature, keys.publicKey)).toBe(false);
    expect(inherited('entity')).toBeUndefined();
  });
});

describe('message and signed-envelope payloads', () => {
  test('the message signature binds an own __proto__ entry in its payload', () => {
    const keys = generateKeyPairSync('ed25519');
    const event = JSON.parse('{"v":1,"kind":"note","session":"acme","record_id":"r1","payload":{"escalatedTo":null,"__proto__":{"escalatedTo":"elsewhere"}}}') as Json;
    const signature = signDomain(MESSAGE_DOMAIN, event, keys.privateKey);
    expect(verifyDomain(MESSAGE_DOMAIN, event, signature, keys.publicKey)).toBe(true);
    const without = JSON.parse('{"v":1,"kind":"note","session":"acme","record_id":"r1","payload":{"escalatedTo":null}}') as Json;
    expect(verifyDomain(MESSAGE_DOMAIN, without, signature, keys.publicKey)).toBe(false);
    expect(inherited('escalatedTo')).toBeUndefined();
  });
});
