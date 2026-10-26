// Owner-seat approval of import, add and up (src/client/owner-action.ts): request, a signed
// owner-seat answer, execute — bound to action, repository, team, HEAD, arguments and a fifteen
// minute TTL, single-use, and fail-closed on every other shape. Hermetic: a temp HOME, an
// in-memory credential store, no herdr, never the machine's ~/.config/team.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitOwnerAction, admitOwnerActionByRule, approveOwnerAction, boundWords, createOwnerActionRequest, listOwnerActionRules,
  OWNER_ACTION_TTL_MS, type OwnerAction,
} from '../../src/client/owner-action.ts';
import { actionApprovalsFolder, actionAuditFolder, actionRequestsFolder, createTeamCreateRequest, approveTeamCreate } from '../../src/client/team-create.ts';
import { fakeOwnerStore, seatOwner } from '../helpers/owner-seat.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });

const NOW = new Date('2026-10-26T11:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-action-')));
  made.push(base);
  const home = join(base, 'home');
  const parent = join(base, 'code');
  const root = join(parent, 'acme');
  mkdirSync(root, { recursive: true });
  const store = seatOwner(home);
  return { base, home, parent, root, store };
}

type Place = ReturnType<typeof place>;
const HEAD = 'a'.repeat(40);

function request(p: Place, over: { actions?: OwnerAction[]; words?: Partial<Record<OwnerAction, string[]>>; by?: string } = {}) {
  const actions = over.actions ?? ['team-up'];
  const made = createOwnerActionRequest(p.home, { actions, root: p.root, team: 'acme', head: HEAD, args: over.words ?? {}, requestedBy: over.by ?? 'seat:iris' }, NOW);
  if (!made.ok) throw new Error(made.why);
  return made.record.request_id;
}
const ask = (p: Place, action: OwnerAction = 'team-up', over: Partial<{ root: string; team: string; head: string | null; words: string[]; claim: boolean }> = {}) =>
  ({ action, root: over.root ?? p.root, team: over.team ?? 'acme', head: over.head === undefined ? HEAD : over.head, words: over.words ?? [], claim: over.claim ?? true });

describe('request, owner-seat answer, execute', () => {
  test('a request lands in the owner seat inbox with what will run; nothing is admitted before the answer', () => {
    const p = place();
    const id = request(p);
    const inbox = readdirSync(join(p.home, '.config', 'team')).join(' ');
    expect(inbox).toContain('owner-seat');
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(p.home), `${id}.json`), 'utf8'));
    expect(record.params).toMatchObject({ kind: 'owner-action', actions: ['team-up'], root: p.root, team: 'acme', head: HEAD, requested_by: 'seat:iris' });
    expect(Date.parse(record.expires_at) - Date.parse(record.created)).toBe(OWNER_ACTION_TTL_MS);
    const before = admitOwnerAction(p.home, id, ask(p), p.store, NOW);
    expect(before).toEqual({ ok: false, why: `request ${id} has no owner-seat answer yet; the owner answers it on the owner page` });
  });

  test('oui admits the run once; a dry run verifies without spending it; a replay is refused', () => {
    const p = place();
    const id = request(p);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, later(1000))).toEqual({ ok: true, choice: 'once' });
    expect(p.store.prompts.at(-1)).toContain('seat:iris asks to start the team');
    const dry = admitOwnerAction(p.home, id, ask(p, 'team-up', { claim: false }), p.store, later(2000));
    expect(dry).toMatchObject({ ok: true, via: 'owner-seat', signer: 'mac' });
    const real = admitOwnerAction(p.home, id, ask(p), p.store, later(3000));
    expect(real).toMatchObject({ ok: true, via: 'owner-seat', signer: 'mac', requestId: id });
    const audit = JSON.parse(readFileSync(join(actionAuditFolder(p.home), `${id}.team-up.json`), 'utf8'));
    expect(audit).toMatchObject({ request_id: id, action: 'team-up', via: 'owner-seat', signer: 'mac' });
    const replay = admitOwnerAction(p.home, id, ask(p), p.store, later(4000));
    expect(replay).toEqual({ ok: false, why: `request ${id} was already used for team-up: an approval is single-use` });
  });

  test('one answer covers a bundled init and up, each once', () => {
    const p = place();
    const id = request(p, { actions: ['team-create', 'team-up'] });
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW).ok).toBe(true);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-create'), p.store, NOW).ok).toBe(true);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-create'), p.store, NOW).ok).toBe(false);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up'), p.store, NOW).ok).toBe(true);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-add'), p.store, NOW)).toEqual({ ok: false, why: `request ${id} does not approve team-add (it names team-create, team-up)` });
  });
});

describe('fail closed', () => {
  test('a missing, malformed or unknown request id admits nothing', () => {
    const p = place();
    expect(admitOwnerAction(p.home, 'oa_nope', ask(p), p.store, NOW)).toEqual({ ok: false, why: '"oa_nope" is not an owner-seat request id' });
    expect(admitOwnerAction(p.home, `oa_${'0'.repeat(24)}`, ask(p), p.store, NOW)).toEqual({ ok: false, why: `no owner-seat request oa_${'0'.repeat(24)} can be read` });
  });

  test('expired: the request, and an answer given after it expired', () => {
    const p = place();
    const id = request(p);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, later(OWNER_ACTION_TTL_MS + 1))).toEqual({ ok: false, why: expect.stringContaining('expired') });
    const id2 = request(p);
    expect(approveOwnerAction(p.home, id2, 'oui', p.store, later(60_000)).ok).toBe(true);
    expect(admitOwnerAction(p.home, id2, ask(p), p.store, later(OWNER_ACTION_TTL_MS + 1))).toEqual({ ok: false, why: expect.stringContaining('expired') });
  });

  test('mismatched repository, team, HEAD, arguments or action', () => {
    const p = place();
    const other = join(p.parent, 'other');
    mkdirSync(other);
    const id = request(p, { words: { 'team-up': ['--serial'] } });
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW).ok).toBe(true);
    const words = ['--serial'];
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up', { root: other, words }), p.store, NOW).ok).toBe(false);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up', { team: 'beta', words }), p.store, NOW).ok).toBe(false);
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up', { head: 'b'.repeat(40), words }), p.store, NOW)).toEqual({ ok: false, why: expect.stringContaining('HEAD is now bbbbbbbbbbbb') });
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up', { words: [] }), p.store, NOW)).toEqual({ ok: false, why: `request ${id} was approved for other team-up arguments` });
    expect(admitOwnerAction(p.home, id, ask(p, 'team-add', { words }), p.store, NOW).ok).toBe(false);
    // The right shape still runs: nothing above spent it.
    expect(admitOwnerAction(p.home, id, ask(p, 'team-up', { words }), p.store, NOW).ok).toBe(true);
  });

  test('a request whose parameters were edited after the fact no longer reads', () => {
    const p = place();
    const id = request(p);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW).ok).toBe(true);
    const path = join(actionRequestsFolder(p.home), `${id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.params.actions = ['team-up', 'team-add'];
    writeFileSync(path, JSON.stringify(record));
    expect(admitOwnerAction(p.home, id, ask(p, 'team-add'), p.store, NOW)).toEqual({ ok: false, why: `request ${id}'s parameters do not match its hash` });
  });

  test('unsigned or forged answers, and an answer signed for another kind, admit nothing', () => {
    const p = place();
    const id = request(p);
    const answer = join(actionRequestsFolder(p.home), `${id}.seat-answer.json`);
    writeFileSync(answer, JSON.stringify({ owner_seat_answer: { kind: 'owner-action', request_id: id, params_sha256: 'x', choice: 'once', team: 'floor', seat: 'owner', at: NOW.toISOString() } }));
    expect(admitOwnerAction(p.home, id, ask(p), p.store, NOW)).toEqual({ ok: false, why: 'the owner-seat answer is not signed' });
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(p.home), `${id}.json`), 'utf8'));
    writeFileSync(answer, JSON.stringify({ owner_seat_answer: { kind: 'owner-action', request_id: id, params_sha256: record.params_sha256, choice: 'once', team: 'floor', seat: 'owner', at: NOW.toISOString() }, signer: 'mac', signature: '3045' + '00'.repeat(68) }));
    expect(admitOwnerAction(p.home, id, ask(p), p.store, NOW)).toEqual({ ok: false, why: expect.stringContaining('does not verify') });
    // A real team-create answer, copied over: signed, but for another kind and request.
    const tc = createTeamCreateRequest(p.home, p.root, HEAD, NOW);
    if (!tc.ok) throw new Error(tc.why);
    expect(approveTeamCreate(p.home, tc.record.request_id, 'oui', p.store, NOW).ok).toBe(true);
    writeFileSync(answer, readFileSync(join(actionRequestsFolder(p.home), `${tc.record.request_id}.seat-answer.json`)));
    expect(admitOwnerAction(p.home, id, ask(p), p.store, NOW)).toEqual({ ok: false, why: `the owner-seat answer is not bound to request ${id} and its parameters` });
  });

  test('a signer from another store (a key the credential store does not hold) is refused', () => {
    const p = place();
    const id = request(p);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW).ok).toBe(true);
    expect(admitOwnerAction(p.home, id, ask(p), fakeOwnerStore(), NOW).ok).toBe(false);
  });

  test('no principal approves its own request', () => {
    const p = place();
    const id = request(p, { by: 'mac' });
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toEqual({ ok: false, why: `signer "mac" asked for request ${id}; no principal approves its own request` });
    expect(admitOwnerAction(p.home, id, ask(p), p.store, NOW).ok).toBe(false);
  });

  test('non is a refusal at execute', () => {
    const p = place();
    const id = request(p);
    expect(approveOwnerAction(p.home, id, 'non', p.store, NOW)).toEqual({ ok: true, choice: 'deny' });
    expect(admitOwnerAction(p.home, id, ask(p), p.store, NOW)).toEqual({ ok: false, why: `the owner seat denied request ${id}` });
  });

  test('no owner seat, no request', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-action-none-')));
    made.push(base);
    const made2 = createOwnerActionRequest(join(base, 'home'), { actions: ['team-up'], root: base, team: 'x', head: null, args: {}, requestedBy: 'seat:iris' }, NOW);
    expect(made2.ok).toBe(false);
  });
});

describe('always rules', () => {
  test('always signs a rule for the same actions under the parent folder; it covers a sibling repository, not another action', () => {
    const p = place();
    const id = request(p, { actions: ['team-up'] });
    expect(approveOwnerAction(p.home, id, 'always', p.store, NOW)).toEqual({ ok: true, choice: 'always', ruleId: id });
    const rules = listOwnerActionRules(p.home, p.store, NOW).rules;
    expect(rules).toEqual([{ rule_id: id, actions: ['team-up'], scope: p.parent, team: 'acme', signer: 'mac', created: NOW.toISOString() }]);
    const sibling = join(p.parent, 'beta');
    mkdirSync(sibling);
    expect(admitOwnerActionByRule(p.home, { action: 'team-up', root: sibling, team: 'beta', claim: false }, p.store, NOW)).toMatchObject({ ok: true, via: 'rule', ruleId: id });
    expect(admitOwnerActionByRule(p.home, { action: 'team-add', root: sibling, team: 'beta', claim: false }, p.store, NOW).ok).toBe(false);
    const elsewhere = join(p.base, 'elsewhere', 'gamma');
    mkdirSync(elsewhere, { recursive: true });
    expect(admitOwnerActionByRule(p.home, { action: 'team-up', root: elsewhere, team: 'gamma', claim: false }, p.store, NOW).ok).toBe(false);
  });

  test('a rule whose actions were widened by hand is ignored', () => {
    const p = place();
    const id = request(p, { actions: ['team-up'] });
    expect(approveOwnerAction(p.home, id, 'always', p.store, NOW).ok).toBe(true);
    const path = join(actionApprovalsFolder(p.home), `${id}.json`);
    const rule = JSON.parse(readFileSync(path, 'utf8'));
    rule.params.actions = ['team-up', 'team-add'];
    writeFileSync(path, JSON.stringify(rule));
    expect(listOwnerActionRules(p.home, p.store, NOW)).toEqual({ rules: [], ignored: [id] });
    expect(admitOwnerActionByRule(p.home, { action: 'team-add', root: p.root, team: 'acme', claim: false }, p.store, NOW).ok).toBe(false);
  });
});

test('the bound words leave out only how the run is asked and shown', () => {
  expect(boundWords(['worker', '--like', 'lead', '--dry-run', '--json', '--approval', 'oa_x', '--request'])).toEqual(['worker', '--like', 'lead']);
});
