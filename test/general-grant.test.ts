import { afterAll, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admitGeneral, GENERAL_OPS, type GeneralOp, generalGrantPath, issueHeldGeneralGrant, issueOwnerGeneralGrant, parseOps, readGeneralGrant, SCOPED_GRANT_REFUSAL, type GrantOp } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { installKey } from '../src/store/keys.ts';
import { fixtureBase } from './helpers.ts';

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
function world() {
  const home = fixtureBase('.gg-test-');
  homes.push(home);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const key = (name: string) => {
    const pair = newClientKeyPair();
    const w = writeClientKeyFiles(join(home, '.config', 'team-client', name), pair);
    if (!w.ok) throw new Error(w.why);
    return { pub: pair.publicKey, path: w.keyPath };
  };
  return { home, a: key('a'), b: key('b'), c: key('c') };
}
const later = (days: number) => new Date(Date.now() + days * 86_400_000);

test('owner issuance refuses unavailable operation names before publishing', () => {
  const w = world();
  for (const op of ['start', 'outside-vocabulary']) {
    const made = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: [op as GeneralOp], mayIssue: false, expires: later(1) });
    expect(made.ok, op).toBe(false);
    if (!made.ok) expect(made.why).toContain(op);
  }
  for (const ops of [['send'], ['*']] as GrantOp[][]) {
    expect(issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops, mayIssue: false, expires: later(1) }).ok).toBe(true);
  }
});

test('an owner-signed general grant admits its ops on any entity, and nothing else', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['config', 'restart'], mayIssue: true, expires: later(30) });
  if (!g.ok) throw new Error(g.why);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', 'material').ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', null).ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'up', 'material').ok).toBe(false);
  expect(admitGeneral(w.home, g.path, w.b.path, 'config', 'material').ok).toBe(false);
});

test('forget requires an explicit op and cannot be widened through a wildcard holder', () => {
  const w = world();
  const all = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(5) });
  const named = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['forget'], mayIssue: true, expires: later(5) });
  if (!all.ok || !named.ok) throw new Error('issue');
  const refused = admitGeneral(w.home, all.path, w.a.path, 'forget', 'floor');
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.why).toContain('explicit');
    expect(refused.why).toContain('--request');
    expect(refused.why).toContain('--approval');
  }
  expect(admitGeneral(w.home, named.path, w.a.path, 'forget', 'floor').ok).toBe(true);
  for (const ops of [['forget'], ['*', 'forget']] as GrantOp[][]) {
    const child = { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops, mayIssue: false, expires: later(1) };
    expect(issueHeldGeneralGrant(w.home, all.path, w.a.path, child).ok).toBe(false);
  }
  const child = issueHeldGeneralGrant(w.home, named.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['forget'], mayIssue: false, expires: later(1) });
  expect(child.ok).toBe(true);
  if (child.ok) expect(admitGeneral(w.home, child.path, w.b.path, 'forget', 'floor').ok).toBe(true);
});

test('a child grant never names an unavailable or out-of-scope op', () => {
  const w = world();
  const all = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(5) });
  const send = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['send'], mayIssue: true, expires: later(5) });
  if (!all.ok || !send.ok) throw new Error('issue');
  for (const [parent, op] of [[all.path, 'start'], [all.path, 'forget'], [send.path, 'config']] as const) {
    const child = issueHeldGeneralGrant(w.home, parent, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: [op as GeneralOp], mayIssue: false, expires: later(1) });
    expect(child.ok, op).toBe(false);
    if (!child.ok) expect(child.why).toContain(op === 'start' ? 'not an issuable general-grant op' : 'outside the parent grant');
  }
});

test('a listed-entity grant is refused until 0.5.11, with the one sentence, whatever entity the run names', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['material'], ops: ['config'], mayIssue: false, expires: later(1) });
  if (!g.ok) throw new Error(g.why);
  for (const entity of ['material', 'floor', null]) {
    const held = admitGeneral(w.home, g.path, w.a.path, 'config', entity);
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.why).toBe(SCOPED_GRANT_REFUSAL);
  }
});

test('a tampered grant does not verify', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['material'], ops: ['config'], mayIssue: false, expires: later(1) });
  if (!g.ok) throw new Error(g.why);
  const disk = JSON.parse(readFileSync(g.path, 'utf8'));
  disk.general_grant.entities = ['*'];
  writeFileSync(g.path, JSON.stringify(disk));
  expect(readGeneralGrant(w.home, g.path).ok).toBe(false);
});

test('a holder issues only to another principal, never wider, and the chain verifies', () => {
  const w = world();
  const root = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['material', 'floor'], ops: ['config', 'send'], mayIssue: true, expires: later(10) });
  if (!root.ok) throw new Error(root.why);
  const self = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'a', publicKey: w.a.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(1) });
  expect(self.ok).toBe(false);
  const wide = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['send'], mayIssue: false, expires: later(1) });
  expect(wide.ok).toBe(false);
  const op = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['material'], ops: ['restart'], mayIssue: false, expires: later(1) });
  expect(op.ok).toBe(false);
  const long = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(20) });
  expect(long.ok).toBe(false);
  const wrongKey = issueHeldGeneralGrant(w.home, root.path, w.b.path, { clientId: 'c', publicKey: w.c.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(1) });
  expect(wrongKey.ok).toBe(false);
  const child = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(1) });
  if (!child.ok) throw new Error(child.why);
  // The chain verifies; the child lists entities, so 0.5.10's door refuses it.
  const held = admitGeneral(w.home, child.path, w.b.path, 'send', 'material');
  expect(held.ok).toBe(false);
  if (!held.ok) expect(held.why).toBe(SCOPED_GRANT_REFUSAL);
  // b's grant may not issue at all
  expect(issueHeldGeneralGrant(w.home, child.path, w.b.path, { clientId: 'c', publicKey: w.c.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(1) }).ok).toBe(false);
  expect(generalGrantPath(w.home, child.grant.grant_id)).toBe(child.path);
});

test('init is a general-grant op; the wildcard covers it and every op, and never widens through a holder', () => {
  const w = world();
  const listed = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['config', 'up'], mayIssue: true, expires: later(5) });
  if (!listed.ok) throw new Error(listed.why);
  expect(admitGeneral(w.home, listed.path, w.a.path, 'init', 'floor').ok).toBe(false);
  const all = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(5) });
  if (!all.ok) throw new Error(all.why);
  expect(admitGeneral(w.home, all.path, w.a.path, 'init', 'floor').ok).toBe(true);
  expect(admitGeneral(w.home, all.path, w.a.path, 'reply', 'floor').ok).toBe(true);
  expect(admitGeneral(w.home, all.path, w.a.path, 'init', 'material').ok).toBe(true);
  expect(admitGeneral(w.home, all.path, w.a.path, 'init', null).ok).toBe(true);
  // a listed holder never issues the wildcard; a wildcard holder still never issues to itself
  expect(issueHeldGeneralGrant(w.home, listed.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: later(1) }).ok).toBe(false);
  expect(issueHeldGeneralGrant(w.home, listed.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['init'], mayIssue: false, expires: later(1) }).ok).toBe(false);
  expect(issueHeldGeneralGrant(w.home, all.path, w.a.path, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['init'], mayIssue: false, expires: later(1) }).ok).toBe(false);
  const child = issueHeldGeneralGrant(w.home, all.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['init'], mayIssue: false, expires: later(1) });
  if (!child.ok) throw new Error(child.why);
  expect(admitGeneral(w.home, child.path, w.b.path, 'init', 'floor').ok).toBe(true);
  expect(admitGeneral(w.home, child.path, w.b.path, 'up', 'floor').ok).toBe(false);
  // the op list is signed: rewriting it to the wildcard breaks verification
  const disk = JSON.parse(readFileSync(listed.path, 'utf8'));
  disk.general_grant.ops = ['*'];
  writeFileSync(listed.path, JSON.stringify(disk));
  expect(admitGeneral(w.home, listed.path, w.a.path, 'init', 'floor').ok).toBe(false);
});

test('parseOps defaults to the wildcard and still refuses unknown ops', () => {
  expect(parseOps(undefined)).toEqual(['*']);
  expect(parseOps('all')).toEqual(['*']);
  expect(parseOps('init,up')).toEqual(['init', 'up']);
  expect(typeof parseOps('create')).toBe('string');
});

test('the wildcard admits ordinary ops on every entity and leaves forget explicit', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(30) });
  if (!g.ok) throw new Error(g.why);
  expect(GENERAL_OPS).toContain('init');
  for (const op of GENERAL_OPS) {
    expect(admitGeneral(w.home, g.path, w.a.path, op, 'floor').ok).toBe(op !== 'forget');
    expect(admitGeneral(w.home, g.path, w.a.path, op, 'material').ok).toBe(op !== 'forget');
    expect(admitGeneral(w.home, g.path, w.a.path, op, null).ok).toBe(op !== 'forget');
  }
});

test('the wildcard admits an op added after it was signed; a listed grant does not', () => {
  const w = world();
  const all = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: later(3) });
  const listed = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: [...GENERAL_OPS], mayIssue: false, expires: later(3) });
  if (!all.ok || !listed.ok) throw new Error('issue');
  const future = 'archive-later' as GeneralOp;
  expect(admitGeneral(w.home, all.path, w.a.path, future, 'floor').ok).toBe(true);
  expect(admitGeneral(w.home, listed.path, w.a.path, future, 'floor').ok).toBe(false);
});

test('a named-entity grant is refused until 0.5.11, whatever op or entity the run names', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['floor'], ops: ['*'], mayIssue: false, expires: later(3) });
  if (!g.ok) throw new Error(g.why);
  for (const op of GENERAL_OPS) {
    for (const entity of ['floor', 'material', null]) {
      const held = admitGeneral(w.home, g.path, w.a.path, op, entity);
      expect(held.ok).toBe(false);
      if (!held.ok) expect(held.why).toBe(SCOPED_GRANT_REFUSAL);
    }
  }
});

test('self-grant is refused by client id alone and by key alone', () => {
  const w = world();
  const root = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(5) });
  if (!root.ok) throw new Error(root.why);
  const sameId = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'a', publicKey: w.b.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: later(1) });
  const sameKey = issueHeldGeneralGrant(w.home, root.path, w.a.path, { clientId: 'b', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: later(1) });
  expect(sameId.ok).toBe(false);
  expect(sameKey.ok).toBe(false);
  if (!sameKey.ok) expect(sameKey.why).toContain('itself');
});

test('a wildcard child needs a wildcard parent: ops and entities alike', () => {
  const w = world();
  const all = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: later(5) });
  const someOps = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['up', 'send'], mayIssue: true, expires: later(5) });
  const someEnt = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['floor'], ops: ['*'], mayIssue: true, expires: later(5) });
  if (!all.ok || !someOps.ok || !someEnt.ok) throw new Error('issue');
  const kid = (p: string, entities: string[], ops: ('*' | GeneralOp)[]) => issueHeldGeneralGrant(w.home, p, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities, ops, mayIssue: false, expires: later(1) });
  expect(kid(someOps.path, ['*'], ['*']).ok).toBe(false);
  expect(kid(someEnt.path, ['*'], ['*']).ok).toBe(false);
  expect(kid(someEnt.path, ['floor'], ['*']).ok).toBe(true);
  const ok = kid(all.path, ['*'], ['*']);
  if (!ok.ok) throw new Error(ok.why);
  expect(admitGeneral(w.home, ok.path, w.b.path, 'init', 'material').ok).toBe(true);
});

test('expiry: admitted just before expires, refused at and after it (fake clock), chain included', () => {
  const w = world();
  const t0 = new Date('2030-01-01T00:00:00Z');
  const exp = new Date(t0.getTime() + 3_600_000);
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: exp }, t0);
  if (!g.ok) throw new Error(g.why);
  expect(admitGeneral(w.home, g.path, w.a.path, 'init', 'floor', new Date(exp.getTime() - 1)).ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'init', 'floor', exp).ok).toBe(false);
  const after = admitGeneral(w.home, g.path, w.a.path, 'init', 'floor', new Date(exp.getTime() + 1));
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.why).toContain('expired');
  const child = issueHeldGeneralGrant(w.home, g.path, w.a.path, { clientId: 'b', publicKey: w.b.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: exp }, t0);
  if (!child.ok) throw new Error(child.why);
  expect(admitGeneral(w.home, child.path, w.b.path, 'up', 'floor', new Date(exp.getTime() - 1)).ok).toBe(true);
  expect(admitGeneral(w.home, child.path, w.b.path, 'up', 'floor', new Date(exp.getTime() + 1)).ok).toBe(false);
});

test('tampering any signed field of a wildcard grant breaks it: ops, entities, expiry, key', () => {
  const w = world();
  const fields: [string, unknown][] = [['ops', ['up']], ['entities', ['floor']], ['expires', later(300).toISOString()], ['public_key', w.b.pub], ['may_issue', false]];
  for (const [field, value] of fields) {
    const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['floor'], ops: ['init'], mayIssue: true, expires: later(3) });
    if (!g.ok) throw new Error(g.why);
    const disk = JSON.parse(readFileSync(g.path, 'utf8'));
    disk.general_grant[field] = value;
    if (field === 'ops') disk.general_grant.ops = ['*'];
    if (field === 'entities') disk.general_grant.entities = ['*'];
    writeFileSync(g.path, JSON.stringify(disk));
    expect(readGeneralGrant(w.home, g.path).ok).toBe(false);
  }
});
