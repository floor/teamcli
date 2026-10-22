// The `clients:` section: the seats an external client grant may address, read from the
// coordinator team's file and honoured only while the owner's approval of it is in force. Absent,
// a client reaches the orchestrator alone, exactly as before. Synthetic homes only.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { newClientKeyPair, clientKeyDir, resolveEntityCoordinator, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { resolveClientTarget } from '../src/client/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { keyOf } from '../src/store/keys.ts';

const TEAM_ID = 'aaaaaaaaaaaa';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

const seat = (name: string, extra = '') => `  - role: ${name === 'orchestrator' ? 'orchestrator' : 'builder'}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
${extra}`;

function teamText(clients: string, project = 'floor'): string {
  return `format: 1
project: ${project}
operator: steward
workspace:
  mode: shared
seats:
${seat('orchestrator', '    leads: true\n')}${seat('zeus')}${seat('steward')}${seat('pat', '    human: true\n')}${clients}`;
}

function world(label: string, clients: string, options: { approve?: boolean; approved?: string; entity?: string; client?: string; entities?: string } = {}) {
  const entity = options.entity ?? 'floor';
  const clientId = options.client ?? 'grok-bot';
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.client-seats-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, entity);
  mkdirSync(join(root, '.agents'), { recursive: true });
  // Its own checkout, so the file read is this one and never a parent repository's.
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const text = teamText(clients, entity);
  if (options.entities !== undefined) writeFileSync(join(home, '.config', 'team', 'entities.yaml'), options.entities);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const ownerKey = keyOf(home);
  const agent = (name: string) => registerAgent(home, {
    name,
    signing: { model: 'M', version: '1', role: name },
    lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: TEAM_ID, seat: name, session: entity, pane: 'w1:p1', address: join(base, 'x.sock') },
    mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const orch = agent('orchestrator');
  const zeus = agent('zeus');
  const steward = agent('steward');
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), `teams:
  "${TEAM_ID}":
    project: ${entity}
    project_id: null
    entity: ${entity}
    session: ${entity}
    root: ${root}
    lobby: ${join(base, 'lobby')}
    roster:
      - { agent: ${orch.id}, seat: orchestrator, role: orchestrator, leads: true }
      - { agent: ${zeus.id}, seat: zeus, role: builder }
      - { agent: ${steward.id}, seat: steward, role: builder }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" }
`);
  if (options.approve !== false) {
    const approvedText = options.approved ?? text;
    const checked = validateTeamFile(approvedText);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, NOW), file: approvedText }, [], home);
  }
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, clientId);
  const files = writeClientKeyFiles(keyDir, pair);
  if (!files.ok) throw new Error(files.why);
  const issue = (seatName?: string) => writeClientGrant(
    home,
    { clientId, entity, publicKey: pair.publicKey, keyId: pair.keyId, keyDir, ...(seatName ? { seat: seatName } : {}) },
    { now: NOW, key: ownerKey },
  );
  return { home, root, issue };
}

const ZEUS = 'clients:\n  grok-bot:\n    seats: [orchestrator, zeus]\n';

describe('the clients section in the team file', () => {
  test('reads seats by client id and refuses undeclared, operator, human, counted and empty lists', () => {
    const ok = validateTeamFile(teamText(ZEUS));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.team.clients).toEqual({ 'grok-bot': { seats: ['orchestrator', 'zeus'] } });
    const absent = validateTeamFile(teamText(''));
    expect(absent.ok && absent.team.clients).toBeNull();
    for (const [list, word] of [
      ['[nobody]', 'names no declared seat'],
      ['[steward]', 'is the operator'],
      ['[pat]', 'is a human seat'],
      ['[]', 'at least one seat'],
      ['[zeus, zeus]', 'twice'],
    ] as const) {
      const bad = validateTeamFile(teamText(`clients:\n  grok-bot:\n    seats: ${list}\n`));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.some((error) => error.message.includes(word))).toBe(true);
    }
    const unknownKey = validateTeamFile(teamText('clients:\n  grok-bot:\n    seats: [zeus]\n    role: owner\n'));
    expect(unknownKey.ok).toBe(false);
  });
});

describe('client grants address the configured seats only', () => {
  test('with no clients section, the orchestrator alone is reachable, as before', () => {
    const w = world('default', '');
    const grant = w.issue();
    expect(grant.ok).toBe(true);
    if (grant.ok) expect(grant.grant.recipientSeat).toBe('orchestrator');
    const zeus = w.issue('zeus');
    expect(zeus.ok).toBe(false);
    if (!zeus.ok) expect(zeus.why).toContain('does not list "zeus"');
  });

  test('an approved list admits a listed seat, and send addresses exactly that seat', () => {
    const w = world('zeus', ZEUS);
    const grant = w.issue('zeus');
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.grant.recipientSeat).toBe('zeus');
    expect(grant.grant.allowedRoles).toEqual(['orchestrator']);
    const target = resolveClientTarget(w.home, 'zeus@floor', grant.grant);
    expect(target.ok).toBe(true);
    if (target.ok) expect(target.target.recipientSeat).toBe('zeus');
    const other = resolveClientTarget(w.home, 'orchestrator@floor', grant.grant);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.why).toContain('addresses only zeus@floor');
    expect(w.issue('orchestrator').ok).toBe(true);
  });

  test('a seat outside the list, the operator, an unknown seat and an unrostered seat are refused', () => {
    const w = world('refuse', 'clients:\n  grok-bot:\n    seats: [zeus]\n');
    for (const name of ['orchestrator', 'steward', 'pat', 'nobody']) {
      const refused = w.issue(name);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.why).toContain(`does not list "${name}"`);
    }
  });

  test('an unapproved or edited clients section is refused, never read as the default', () => {
    const unapproved = world('unapproved', ZEUS, { approve: false });
    const a = unapproved.issue();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.why).toContain('not the one the owner approved');
    const edited = world('edited', ZEUS, { approved: teamText('') });
    expect(edited.issue('zeus').ok).toBe(false);
  });

  test('a send re-checks the list: a grant issued before the seat was removed stops resolving', () => {
    const w = world('removed', ZEUS);
    const grant = w.issue('zeus');
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    const narrowed = teamText('clients:\n  grok-bot:\n    seats: [orchestrator]\n');
    writeFileSync(join(w.root, '.agents', 'team.yaml'), narrowed);
    const checked = validateTeamFile(narrowed);
    if (!checked.ok) throw new Error('narrowed file is invalid');
    writeApproval(storePath('floor', w.root, w.home), { approval: approvalOf(checked.team, w.root, NOW), file: narrowed }, [], w.home);
    expect(resolveEntityCoordinator(w.home, 'floor', { seat: 'zeus', clientId: 'grok-bot' }).ok).toBe(false);
    expect(resolveClientTarget(w.home, 'zeus@floor', grant.grant).ok).toBe(false);
  });
});

describe('clients and entities come from the entities file', () => {
  test('a declared client on a declared entity is admitted, to the seats the entity lists', () => {
    const entities = 'labs:\n  clients:\n    acme-bot:\n      seats: [zeus]\n';
    const w = world('labs', '', { entity: 'labs', client: 'acme-bot', entities });
    const zeus = w.issue('zeus');
    expect(zeus.ok).toBe(true);
    if (!zeus.ok) return;
    expect(zeus.grant.clientId).toBe('acme-bot');
    expect(zeus.grant.entity).toBe('labs');
    expect(resolveClientTarget(w.home, 'zeus@labs', zeus.grant).ok).toBe(true);
    const orch = w.issue();
    expect(orch.ok).toBe(false);
    if (!orch.ok) expect(orch.why).toContain('does not list "orchestrator"');
  });

  test('an entity that declares clients admits only those: grok-bot is refused when not listed', () => {
    const w = world('floor-other', '', { entities: 'floor:\n  clients:\n    acme-bot:\n      seats: [orchestrator]\n' });
    const refused = w.issue();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('declares no client "grok-bot"');
  });

  test('with no clients word, any client but grok-bot and any entity but floor is refused', () => {
    const w = world('labs-none', '', { entity: 'labs', client: 'acme-bot' });
    const refused = w.issue();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('only grok-bot on floor is admitted');
  });

  test('a malformed clients map refuses whole, never read in part', () => {
    for (const bad of [
      'floor:\n  clients:\n    grok-bot:\n      seats: []\n',
      'floor:\n  clients:\n    grok-bot:\n      seats: [orchestrator]\n      role: owner\n',
      'floor:\n  clients:\n    Grok_Bot:\n      seats: [orchestrator]\n',
      'floor:\n  clients: []\n',
    ]) {
      const w = world('malformed', '', { entities: bad });
      const refused = w.issue();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.why).toContain('entities.yaml clients:');
    }
  });

  test('the approved team file overrides the entity list for its client, and still refuses the operator', () => {
    const entities = 'floor:\n  clients:\n    grok-bot:\n      seats: [orchestrator, steward]\n';
    const w = world('override', 'clients:\n  grok-bot:\n    seats: [zeus]\n', { entities });
    expect(w.issue('zeus').ok).toBe(true);
    expect(w.issue().ok).toBe(false);
    const base = world('entity-op', '', { entities });
    const op = base.issue('steward');
    expect(op.ok).toBe(false);
  });

  test('a grant whose client the entities file stops admitting no longer reads', () => {
    const w = world('dropped', '');
    const grant = w.issue();
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    writeFileSync(join(w.home, '.config', 'team', 'entities.yaml'), 'floor:\n  clients:\n    acme-bot:\n      seats: [orchestrator]\n');
    expect(resolveClientTarget(w.home, 'orchestrator@floor', grant.grant).ok).toBe(false);
  });
});
