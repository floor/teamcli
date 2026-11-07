// Synthetic grants under a synthetic home. No owner home is read.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import {
  CHAIN_LIMIT_REASON,
  MAX_CHAIN,
  generalGrantChainNotes,
  generalGrantsFolder,
  issueHeldGeneralGrant,
  issueOwnerGeneralGrant,
  readGeneralGrant,
  type GrantOp,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { installKey } from '../src/store/keys.ts';
import { approvalStanding } from '../src/store/store.ts';
import { fixtureBase, testIo } from './helpers.ts';

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-11-07T12:00:00.000Z');
const EXPIRES = new Date('2026-12-07T12:00:00.000Z');

function install(home: string): void {
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
}

function client(home: string, name: string) {
  const pair = newClientKeyPair();
  const wrote = writeClientKeyFiles(join(home, '.config', 'team-client', name), pair);
  if (!wrote.ok) throw new Error(wrote.why);
  return { id: name, pub: pair.publicKey, path: wrote.keyPath };
}

function issueInput(id: string, pub: string): { clientId: string; publicKey: string; entities: string[]; ops: GrantOp[]; mayIssue: boolean; expires: Date } {
  return { clientId: id, publicKey: pub, entities: ['*'], ops: ['*'], mayIssue: true, expires: EXPIRES };
}

function grantFiles(home: string): string[] {
  try { return readdirSync(generalGrantsFolder(home)).sort(); } catch { return []; }
}

test('a chain at the ancestor limit issues, and one past it is refused before anything is written', () => {
  const home = fixtureBase('.gg-chain-');
  made.push(home);
  install(home);
  const keys = Array.from({ length: MAX_CHAIN + 2 }, (_, i) => client(home, `c${i}`));
  const rootKey = keys[0]!;
  const root = issueOwnerGeneralGrant(home, issueInput(rootKey.id, rootKey.pub), NOW);
  if (!root.ok) throw new Error(root.why);
  let parentPath = root.path;
  let holder = rootKey;
  for (let n = 1; n <= MAX_CHAIN; n++) {
    const next = keys[n]!;
    const child = issueHeldGeneralGrant(home, parentPath, holder.path, issueInput(next.id, next.pub), NOW);
    if (!child.ok) throw new Error(child.why);
    parentPath = child.path;
    holder = next;
  }
  expect(readGeneralGrant(home, parentPath, NOW).ok).toBe(true);
  const before = grantFiles(home);
  expect(before).toHaveLength(MAX_CHAIN + 1);
  const past = keys[MAX_CHAIN + 1]!;
  const refused = issueHeldGeneralGrant(home, parentPath, holder.path, issueInput(past.id, past.pub), NOW);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.why).toBe(CHAIN_LIMIT_REASON);
  expect(grantFiles(home)).toEqual(before);
});

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

test('team check and team doctor show a two-level chain', async () => {
  const base = fixtureBase('.gg-chain-check-');
  made.push(base);
  const rootDir = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(rootDir, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: rootDir, stdio: 'ignore' });
  writeFileSync(join(rootDir, '.agents/team.yaml'), TEAM);
  install(home);
  const a = client(home, 'a');
  const b = client(home, 'b');
  const owner = issueOwnerGeneralGrant(home, issueInput(a.id, a.pub), NOW);
  if (!owner.ok) throw new Error(owner.why);
  const child = issueHeldGeneralGrant(home, owner.path, a.path, issueInput(b.id, b.pub), NOW);
  if (!child.ok) throw new Error(child.why);
  const line = `${child.grant.grant_id} <- ${owner.grant.grant_id}; wildcard; may issue; expires ${EXPIRES.toISOString()}`;
  expect(generalGrantChainNotes(home, NOW)).toContain(line);
  const io = testIo(rootDir, { kind: 'owner' });
  runTeamCheck({ file: '.agents/team.yaml' }, io, {
    home,
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(rootDir, 'nowhere')),
    now: () => NOW,
  });
  expect(`${io.out}${io.err}`).toContain(line);
  const doctorIo = testIo(rootDir, { kind: 'owner' });
  await runDoctor(['--file', '.agents/team.yaml', '--json'], doctorIo, {
    version: () => null,
    onPath: () => false,
    loggedIn: () => null,
    herdrVersion: () => null,
    sessionRunning: () => false,
    now: () => NOW,
    home,
    standing: (at) => approvalStanding(at, join(rootDir, 'nowhere')),
    command: () => null,
  });
  expect(doctorIo.out).toContain(line);
});
