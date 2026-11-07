// Independent scenes: a general grant past the ancestor limit is refused before it is signed,
// a chain at the limit issues and verifies, and check and doctor each print one chain line.
// The home is a synthetic fixture root, passed to every call. No seat names.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import {
  CHAIN_LIMIT_REASON,
  MAX_CHAIN,
  generalGrantsFolder,
  issueHeldGeneralGrant,
  issueOwnerGeneralGrant,
  readGeneralGrant,
  type GeneralGrant,
  type GrantOp,
} from '../src/client/general-grant.ts';
import { clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { deliverBriefs, fixtureBase, gitEnv, testIo } from './helpers.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const EXPIRES = new Date('2026-12-07T12:00:00.000Z');
const LATER = new Date('2027-01-07T12:00:00.000Z');
const SIGNED_BEFORE = new Date('2026-10-01T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  const owned = roots.splice(0);
  discardFixtures(owned, { roots: owned.map(dirname) });
});

function home(): string {
  const path = fixtureBase('grant-chain-');
  roots.push(path);
  return path;
}

function holder(dir: string, id: string): { id: string; publicKey: string; keyPath: string } {
  const pair = newClientKeyPair();
  const wrote = writeClientKeyFiles(clientKeyDir(dir, id), pair);
  if (!wrote.ok) throw new Error(wrote.why);
  return { id, publicKey: pair.publicKey, keyPath: wrote.keyPath };
}

function issue(id: string, publicKey: string, expires = EXPIRES, ops: GrantOp[] = ['check'], mayIssue = true) {
  return { clientId: id, publicKey, entities: ['*'], ops, mayIssue, expires };
}

function names(dir: string): string[] {
  try {
    return readdirSync(generalGrantsFolder(dir)).sort();
  } catch {
    return [];
  }
}

type Link = { grant: GeneralGrant; keyPath: string };

/** Root plus `children` held grants. The last grant names `children` ancestors. */
function chain(dir: string, children: number, expires = EXPIRES, ops: GrantOp[] = ['check']): Link[] {
  const people = Array.from({ length: children + 1 }, (_, index) => holder(dir, `pebble${index}`));
  const links: Link[] = [];
  for (let index = 0; index <= children; index += 1) {
    const person = people[index]!;
    const made = index === 0
      ? issueOwnerGeneralGrant(dir, issue(person.id, person.publicKey, expires, ops, true), NOW)
      : issueHeldGeneralGrant(dir, grantPath(dir, links[index - 1]!.grant), links[index - 1]!.keyPath, issue(person.id, person.publicKey, expires, ops, true), NOW);
    if (!made.ok) throw new Error(made.why);
    links.push({ grant: made.grant, keyPath: person.keyPath });
  }
  return links;
}

function grantPath(dir: string, grant: GeneralGrant): string {
  return `${generalGrantsFolder(dir)}/${grant.grant_id}.json`;
}

test('a grant that would name more than the ancestor limit is refused before any file is written', () => {
  const dir = home();
  const links = chain(dir, MAX_CHAIN);
  expect(links).toHaveLength(MAX_CHAIN + 1);
  const atLimit = links[MAX_CHAIN]!;
  expect(readGeneralGrant(dir, grantPath(dir, atLimit.grant), NOW).ok).toBe(true);
  const next = holder(dir, 'pebble-past');
  const before = names(dir);
  const refused = issueHeldGeneralGrant(
    dir,
    grantPath(dir, atLimit.grant),
    atLimit.keyPath,
    issue(next.id, next.publicKey),
    NOW,
  );
  expect(refused).toEqual({ ok: false, why: CHAIN_LIMIT_REASON });
  expect(CHAIN_LIMIT_REASON).toContain(String(MAX_CHAIN));
  expect(names(dir)).toEqual(before);
});

test('a child at the limit still cannot outlive its parent, and one inside that scope verifies', () => {
  const dir = home();
  const links = chain(dir, MAX_CHAIN - 1);
  const parent = links[MAX_CHAIN - 1]!;
  const wide = holder(dir, 'pebble-wide');
  const refused = issueHeldGeneralGrant(
    dir,
    grantPath(dir, parent.grant),
    parent.keyPath,
    issue(wide.id, wide.publicKey, LATER),
    NOW,
  );
  expect(refused).toEqual({
    ok: false,
    why: 'refused: the child would outlive the parent grant; a holder never issues wider than its own grant',
  });
  expect(names(dir)).toHaveLength(links.length);
  const narrow = holder(dir, 'pebble-narrow');
  const made = issueHeldGeneralGrant(
    dir,
    grantPath(dir, parent.grant),
    parent.keyPath,
    issue(narrow.id, narrow.publicKey, EXPIRES, ['check'], false),
    NOW,
  );
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const read = readGeneralGrant(dir, made.path, NOW);
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.grant.parent).toBe(parent.grant.grant_id);
});

const TEAM = `format: 1
project: box
session: box
operator: pebble
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: pebble
    cli: muse
    vendor: floor
    model: Pebble
    version: "1.0"
    launch: muse
    leads: true
`;
const OWNER: Caller = { kind: 'owner' };

function project(): { base: string; home: string; root: string } {
  const base = fixtureBase('grant-chain-');
  roots.push(base);
  const dir = join(base, 'home');
  const root = join(base, 'box');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(base, 'sockets'));
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    for (const [index, seat] of parsed.team.seats.entries()) {
      session.seats[seat.name] = { stage: 'ready', pane: `pane${index + 1}`, workspace: `space${index + 1}` };
    }
  });
  return { base, home: dir, root };
}

function live(): Live {
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'muse',
      pane: `pane${index + 1}`,
      workspace: `space${index + 1}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `space${index + 1}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`pane${index + 1}`, 'idle\n'])),
  };
}

test('check and doctor each print one chain line per verified grant, and the widened note remains', async () => {
  const { base, home: dir, root } = project();
  const rootHolder = holder(dir, 'pebble-root');
  const childHolder = holder(dir, 'pebble-child');
  const rootGrant = issueOwnerGeneralGrant(
    dir,
    issue(rootHolder.id, rootHolder.publicKey, EXPIRES, ['*'], true),
    SIGNED_BEFORE,
  );
  expect(rootGrant.ok).toBe(true);
  if (!rootGrant.ok) return;
  const child = issueHeldGeneralGrant(
    dir,
    rootGrant.path,
    rootHolder.keyPath,
    issue(childHolder.id, childHolder.publicKey, EXPIRES, ['*'], false),
    SIGNED_BEFORE,
  );
  expect(child.ok).toBe(true);
  if (!child.ok) return;
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: 'box',
    seats: ['pebble'],
    home: dir,
    at: NOW.toISOString(),
  });
  const chainLine = `${child.grant.grant_id} <- ${rootGrant.grant.grant_id}; wildcard; may not issue; expires ${EXPIRES.toISOString()}`;
  const rootLine = `${rootGrant.grant.grant_id}; wildcard; may issue; expires ${EXPIRES.toISOString()}`;
  const checkIo = testIo(root, OWNER);
  runTeamCheck({ file: '.agents/team.yaml' }, checkIo, {
    home: dir,
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
    alive: () => false,
    sockets: join(base, 'sockets'),
  });
  const checkOut = `${checkIo.out}${checkIo.err}`;
  const doctorIo = testIo(root, OWNER);
  const doctorSources: DoctorSources = {
    version: () => '1.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0',
    sessionRunning: () => false,
    now: () => NOW,
    home: dir,
    command: () => null,
  };
  await runDoctor(['--file', '.agents/team.yaml'], doctorIo, doctorSources);
  const doctorOut = `${doctorIo.out}${doctorIo.err}`;
  for (const line of [chainLine, rootLine]) {
    expect(checkOut).toContain(`note: ${line}`);
    expect(doctorOut).toContain(`note  ${line}`);
  }
  for (const id of [rootGrant.grant.grant_id, child.grant.grant_id]) {
    const widened = `wildcard general grant ${id} signed ${SIGNED_BEFORE.toISOString().slice(0, 10)}`;
    expect(checkOut).toContain(`note: ${widened}`);
    expect(doctorOut).toContain(`note  ${widened}`);
    expect(checkOut).toContain('re-sign the grant to stop this note');
    expect(doctorOut).toContain('re-sign the grant to stop this note');
  }
});
