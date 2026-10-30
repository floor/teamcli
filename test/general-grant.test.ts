import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admitGeneral, generalGrantPath, issueHeldGeneralGrant, issueOwnerGeneralGrant, readGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { installKey } from '../src/store/keys.ts';

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
function world() {
  const home = realpathSync(mkdtempSync(join(process.cwd(), '.gg-test-')));
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

test('an owner-signed general grant admits its ops on any entity, and nothing else', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['*'], ops: ['config', 'restart'], mayIssue: true, expires: later(30) });
  if (!g.ok) throw new Error(g.why);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', 'material').ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', null).ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'up', 'material').ok).toBe(false);
  expect(admitGeneral(w.home, g.path, w.b.path, 'config', 'material').ok).toBe(false);
});

test('a listed-entity grant refuses other entities', () => {
  const w = world();
  const g = issueOwnerGeneralGrant(w.home, { clientId: 'a', publicKey: w.a.pub, entities: ['material'], ops: ['config'], mayIssue: false, expires: later(1) });
  if (!g.ok) throw new Error(g.why);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', 'material').ok).toBe(true);
  expect(admitGeneral(w.home, g.path, w.a.path, 'config', 'floor').ok).toBe(false);
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
  expect(admitGeneral(w.home, child.path, w.b.path, 'send', 'material').ok).toBe(true);
  expect(admitGeneral(w.home, child.path, w.b.path, 'send', 'floor').ok).toBe(false);
  // b's grant may not issue at all
  expect(issueHeldGeneralGrant(w.home, child.path, w.b.path, { clientId: 'c', publicKey: w.c.pub, entities: ['material'], ops: ['send'], mayIssue: false, expires: later(1) }).ok).toBe(false);
  expect(generalGrantPath(w.home, child.grant.grant_id)).toBe(child.path);
});
