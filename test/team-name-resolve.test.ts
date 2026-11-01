// A team written by name, in a registry that holds more than one record: the name a person
// types must reach the team whose own name or session it is, never a team that only sits in a
// project of that name. A second team in the same project must not break the first, a client
// grant resolves by the team it signs (its id), and a name that two records answer refuses in
// plain words, naming both and saying how to pick one.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { resolveTarget } from '../src/send/resolve.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const OWNER = { kind: 'owner' as const } satisfies Caller;
const THREAD = '99999999-9999-4999-8999-999999999999';
const NO_LIVE = () => null;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The key home sits outside the OS temp folder, as the client key rules require; a team folder
 *  may sit in temp, because the registry names it. */
function base(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(process.cwd(), prefix)));
  made.push(dir);
  return dir;
}

const TEAM = (project: string, session: string): string => `format: 1
project: ${project}
entity: floor
coordinator: orchestrator
operator: orchestrator
session: ${session}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type World = { base: string; home: string; root: (project: string, session: string) => string };

function world(): World {
  const dir = base('.team-name-resolve-');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const root = (project: string, session: string): string => {
    const holder = realpathSync(mkdtempSync(join(tmpdir(), 'tnr-root-')));
    made.push(holder);
    const at = join(holder, project);
    mkdirSync(join(at, '.agents'), { recursive: true });
    writeFileSync(join(at, '.agents', 'team.yaml'), TEAM(project, session));
    return at;
  };
  return { base: dir, home, root };
}

/** A team's registry record and the agent its orchestrator seat runs as. */
function record(w: World, init: { project: string; session: string; root: string; entity?: string }): { id: string; agent: string } {
  const id = teamIdOf(init.root);
  const agent = registerAgent(w.home, {
    name: 'Orchestrator',
    signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: id, seat: 'orchestrator', session: init.session, pane: 'pane1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  upsertTeam(w.home, id, {
    project: init.project,
    entity: init.entity ?? 'floor',
    session: init.session,
    root: init.root,
    lobby: join(w.base, 'lobby', id),
    roster: [{ agent: agent.id, seat: 'orchestrator', role: 'orchestrator', leads: true }],
    lifecycle: 'running',
  });
  return { id, agent: agent.id };
}

/** A client key pair and an issued grant, as the owner issues one for `--team material`. */
async function clientGrant(w: World, root: string): Promise<{ grantPath: string; keyPath: string }> {
  keyOf(w.home);
  const keys = writeClientKeyFiles(clientKeyDir(w.home, 'grok-bot'), newClientKeyPair());
  if (!keys.ok) throw new Error(keys.why);
  const granted = testIo(root, OWNER);
  const code = await runGrant(
    ['--client', 'grok-bot', '--entity', 'floor', '--team', 'material', '--public-key', keys.pubPath],
    granted,
    { home: w.home },
  );
  expect(code, `${granted.err}${granted.out}`).toBe(0);
  const grantPath = /^grant file: (.+)$/m.exec(granted.out)?.[1];
  if (grantPath === undefined) throw new Error(`no grant file in: ${granted.out}`);
  return { grantPath, keyPath: keys.keyPath };
}

// Symptom 2: a second team registered in the project material also carries the session word
// material. The address "material" must still be the team whose own name is material.
test('a team named by its own name resolves past a second team that only shares its session', () => {
  const w = world();
  const materialRoot = w.root('material', 'material');
  const writerRoot = w.root('writer', 'material');
  const material = record(w, { project: 'material', session: 'material', root: materialRoot });
  record(w, { project: 'writer', session: 'material', root: writerRoot });

  const resolved = resolveTarget(w.home, 'orchestrator@material', { cwd: materialRoot }, NO_LIVE);
  expect('error' in resolved ? resolved.error : '').toBe('');
  if ('error' in resolved) return;
  expect(resolved.team.id).toBe(material.id);
  expect(resolved.team.project).toBe('material');
  expect(resolved.agent.id).toBe(material.agent);
});

// The widened scope: a word that is no team's own name still resolves by session, as it always
// has. This scene is green before and after the change: the session spelling is kept.
test('a word that no team owns still resolves by its session', () => {
  const w = world();
  const ledgerRoot = w.root('ledger', 'board');
  const ledger = record(w, { project: 'ledger', session: 'board', root: ledgerRoot });

  const resolved = resolveTarget(w.home, 'orchestrator@board', { cwd: ledgerRoot }, NO_LIVE);
  if ('error' in resolved) throw new Error(resolved.error);
  expect(resolved.team.id).toBe(ledger.id);
});

// The by-id spelling is the disambiguator, and it keeps working: it is asked before any name.
test('a team id still names exactly one team', () => {
  const w = world();
  const materialRoot = w.root('material', 'material');
  const material = record(w, { project: 'material', session: 'material', root: materialRoot });
  record(w, { project: 'material', session: 'material-b', root: w.root('material', 'material-b') });

  const resolved = resolveTarget(w.home, `orchestrator@${material.id}`, { cwd: materialRoot }, NO_LIVE);
  if ('error' in resolved) throw new Error(resolved.error);
  expect(resolved.team.id).toBe(material.id);
  expect(resolved.agent.id).toBe(material.agent);
});

// A name two records answer has no safe pick: the refusal names both and says how to choose.
test('a name two teams own refuses as ambiguous, naming both and how to pick one', () => {
  const w = world();
  const firstRoot = w.root('material', 'material');
  const secondRoot = w.root('material', 'material-b');
  const first = record(w, { project: 'material', session: 'material', root: firstRoot });
  const second = record(w, { project: 'material', session: 'material-b', root: secondRoot });

  const resolved = resolveTarget(w.home, 'orchestrator@material', { cwd: firstRoot }, NO_LIVE);
  if (!('error' in resolved)) throw new Error('two teams answered to one name and one was picked');
  expect(resolved.kind).toBe('ambiguous');
  expect(resolved.error).toContain(first.id);
  expect(resolved.error).toContain(second.id);
  expect(resolved.error).toContain('say which by its id');
});

// Symptom 1: the grant signs the coordinator team's id; a second record of the same entity and
// team name no longer makes the send refuse, because the id the grant signs picks the record.
test('a client-grant send resolves by the team the grant signs, after a second record joins the entity and name', async () => {
  const w = world();
  const materialRoot = w.root('material', 'material');
  record(w, { project: 'material', session: 'material', root: materialRoot });
  const { grantPath, keyPath } = await clientGrant(w, materialRoot);

  // The second team joins project material in entity floor: the same project word, another id.
  record(w, { project: 'material', session: 'material-b', root: w.root('material', 'material-b') });

  const io = testIo(materialRoot, OWNER);
  const host = { home: w.home, now: () => new Date(), sendId: () => THREAD } as unknown as SendHost;
  const sent = await runSend(
    ['--client', grantPath, '--key', keyPath, 'orchestrator@material', 'status please'],
    io,
    host,
  );
  expect(sent, io.err).toBe(0);
  expect(io.out).toContain('sent: orchestrator@material');
  // The drop landed in the folder of the team the grant signs.
  const drop = join(materialRoot, '.agents', 'send-drops', 'material', 'orchestrator', THREAD);
  expect(readFileSync(drop, 'utf8')).toContain('status please');
});

// Issuing a grant in the same ambiguous state cannot pick a team either: it refuses, naming
// both candidates and the id spelling that picks one.
test('issuing a client grant for an ambiguous team name refuses, naming both teams', async () => {
  const w = world();
  const firstRoot = w.root('material', 'material');
  const secondRoot = w.root('material', 'material-b');
  const first = record(w, { project: 'material', session: 'material', root: firstRoot });
  const second = record(w, { project: 'material', session: 'material-b', root: secondRoot });
  keyOf(w.home);
  const keys = writeClientKeyFiles(clientKeyDir(w.home, 'grok-bot'), newClientKeyPair());
  if (!keys.ok) throw new Error(keys.why);

  const io = testIo(firstRoot, OWNER);
  const code = await runGrant(
    ['--client', 'grok-bot', '--entity', 'floor', '--team', 'material', '--public-key', keys.pubPath],
    io,
    { home: w.home },
  );
  expect(code, `${io.err}${io.out}`).toBe(1);
  expect(io.err).toContain(first.id);
  expect(io.err).toContain(second.id);
  expect(io.err).toContain('say which by its id');
});
