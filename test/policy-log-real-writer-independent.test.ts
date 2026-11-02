// Independent scenes: real in-process admission and signed policy writes, with an
// isolated home and fresh fixture keys. No operational command, pane or credential store runs.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { generalDoor } from '../src/client/general-door.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runPolicy } from '../src/commands/policy.ts';
import type { Io } from '../src/io.ts';
import { readTeamPolicySource, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T18:00:00.000Z');
const NAME = 'codex-daemon';
const SESSION = 'lantern';
const LEAD = 'writer-seat';
const CLIENT = 'fixture-client';
const SEAT: Caller = { kind: 'seat', name: LEAD, pane: 'fixture-lead', session: SESSION };
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene() {
  const base = fixtureBase('policy-writer-independent-');
  made.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, `format: 1
project: lantern
session: lantern
entity: fixture
operator: writer-seat
workspace:
  mode: shared
seats:
  - role: coordinator
    name: writer-seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
  - role: worker
    name: observer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`);
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ??= emptySession();
    session.seats[LEAD] = { stage: 'ready', pane: 'fixture-lead', workspace: 'fixture-workspace' };
  });
  return { base, root, home, dir, file };
}

type Scene = ReturnType<typeof scene>;
type Writer = 'owner' | 'client' | 'dev-seat';
type Action = 'set' | 'unset';

function entries(at: Scene): string[] {
  const path = join(at.dir, LOG_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

function changes(at: Scene): string[] {
  // Dev mode has its own admission warning. Select only the actual policy change records.
  return entries(at).filter((line) => line.includes(' policy [') && line.includes('level team ('));
}

function seed(at: Scene): void {
  const written = writePolicySet(at.home, {
    level: 'team', target: teamIdOf(at.root), teamRoot: at.root, name: NAME, value: 'off',
  }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
}

function signedPolicy(at: Scene) {
  const read = readTeamPolicySource(at.home, at.root);
  if (!read.ok) throw new Error(read.why);
  return read.policies.find((policy) => policy.name === NAME);
}

function clientGrant(at: Scene, ops: ('policy' | 'status')[] = ['policy']) {
  const pair = newClientKeyPair();
  const key = writeClientKeyFiles(join(at.home, '.config', 'team-client', 'fixture-client'), pair);
  if (!key.ok) throw new Error(key.why);
  const issued = issueOwnerGeneralGrant(at.home, {
    clientId: CLIENT, publicKey: pair.publicKey, entities: ['*'], ops,
    mayIssue: false, expires: new Date(NOW.getTime() + 3_600_000),
  }, NOW);
  if (!issued.ok) throw new Error(issued.why);
  return { path: issued.path, id: issued.grant.grant_id, key: key.keyPath };
}

function ioFor(at: Scene, writer: Writer) {
  const io = testIo(at.root, writer === 'owner' ? { kind: 'owner' } : SEAT);
  io.env = { HOME: at.home, ...(writer === 'dev-seat' ? { TEAMCLI_DEV_MODE: '1' } : {}) };
  return io;
}

function args(action: Action): string[] {
  return action === 'set' ? ['set', 'team', NAME, 'off'] : ['unset', 'team', NAME];
}

async function writeAs(at: Scene, writer: Writer, argv: string[]) {
  const raw = ioFor(at, writer);
  let io: Io = raw;
  let words = argv;
  let grantId: string | undefined;
  if (writer === 'client') {
    const grant = clientGrant(at);
    grantId = grant.id;
    // These are arguments to an in-process verifier, never an executable command line.
    const door = generalDoor('policy', [...argv, '--general', grant.path, '--key', grant.key], raw, NOW);
    if (door.kind !== 'admitted') throw new Error(`fixture grant was not admitted: ${door.kind}${'why' in door ? `: ${door.why}` : ''}`);
    io = door.io;
    words = door.argv;
  }
  const code = await runPolicy(words, io, { home: at.home, now: NOW });
  return { code, raw, grantId };
}

for (const writer of ['owner', 'client', 'dev-seat'] as const) {
  for (const action of ['set', 'unset'] as const) {
    test(`${writer} ${action}: the change log credits the writer while the signed setter stays owner`, async () => {
      const at = scene();
      if (action === 'unset') {
        seed(at);
        expect(signedPolicy(at)?.setter).toBe('owner');
      }
      const result = await writeAs(at, writer, args(action));
      expect(result.code, result.raw.err).toBe(0);
      const rows = changes(at);
      expect(rows).toHaveLength(1);
      const tag = writer === 'client' ? `client:${CLIENT}` : writer === 'dev-seat' ? LEAD : 'owner';
      const said = writer === 'client' ? `client ${CLIENT}, grant ${result.grantId}` : writer === 'dev-seat' ? `${LEAD}, dev mode` : 'owner';
      expect(rows[0]).toContain(`policy [${tag}] level team (${teamIdOf(at.root)}) ${NAME}: `);
      expect(rows[0]).toContain(action === 'set' ? 'unset -> off' : 'off -> unset');
      expect(rows[0]).toEndWith(`(setter: ${said})`);
      if (action === 'set') {
        const policy = signedPolicy(at);
        expect(policy?.setter).toBe('owner');
        expect(policy?.value).toBe('off');
        expect(typeof policy?.signature).toBe('string');
      } else {
        expect(signedPolicy(at)).toBeUndefined();
      }
      expect(entries(at).join('\n')).not.toMatch(/PRIVATE KEY|privatePem|private_key/);
    });

    test(`${writer} ${action} dry run writes neither a policy nor a change log`, async () => {
      const at = scene();
      if (action === 'unset') seed(at);
      const before = readFileSync(at.file, 'utf8');
      const result = await writeAs(at, writer, [...args(action), '--dry-run']);
      expect(result.code, result.raw.err).toBe(0);
      expect(readFileSync(at.file, 'utf8')).toBe(before);
      expect(changes(at)).toEqual([]);
    });
  }
}

test('the door replaces claimed metadata with the client and grant IDs it actually verified', async () => {
  const at = scene();
  const grant = clientGrant(at);
  const raw = ioFor(at, 'client');
  raw.general = { grant: 'claimed-grant', key: 'claimed-key', clientId: 'claimed-client', grantId: 'claimed-id' };
  raw.env.TEAMCLI_CLIENT_ID = 'environment-client';
  raw.env.TEAMCLI_GRANT_ID = 'environment-id';
  const door = generalDoor('policy', [...args('set'), '--general', grant.path, '--key', grant.key], raw, NOW);
  expect(door.kind).toBe('admitted');
  if (door.kind !== 'admitted') return;
  expect(door.io.general?.clientId).toBe(CLIENT);
  expect(door.io.general?.grantId).toBe(grant.id);
  expect(await runPolicy(door.argv, door.io, { home: at.home, now: NOW })).toBe(0);
  expect(changes(at)[0]).toContain(`(setter: client ${CLIENT}, grant ${grant.id})`);
  expect(changes(at).join('\n')).not.toMatch(/claimed-|environment-/);
});

for (const refusal of ['tampered', 'expired', 'wrong-key', 'wrong-op'] as const) {
  test(`a ${refusal} grant never reaches a policy write or a client change log`, async () => {
    const at = scene();
    const grant = clientGrant(at, refusal === 'wrong-op' ? ['status'] : ['policy']);
    let key = grant.key;
    if (refusal === 'tampered') {
      const disk = JSON.parse(readFileSync(grant.path, 'utf8')) as { general_grant: { client_id: string } };
      disk.general_grant.client_id = 'unsigned-client';
      writeFileSync(grant.path, JSON.stringify(disk));
    }
    if (refusal === 'wrong-key') {
      const written = writeClientKeyFiles(join(at.home, '.config', 'team-client', 'another-client'), newClientKeyPair());
      if (!written.ok) throw new Error(written.why);
      key = written.keyPath;
    }
    const before = readFileSync(at.file, 'utf8');
    const now = refusal === 'expired' ? new Date(NOW.getTime() + 7_200_000) : NOW;
    const door = generalDoor('policy', [...args('set'), '--general', grant.path, '--key', key], ioFor(at, 'client'), now);
    expect(door.kind).toBe('refused');
    if (door.kind === 'refused') {
      const reason = { tampered: 'does not verify', expired: 'expired', 'wrong-key': 'does not match', 'wrong-op': 'does not cover policy' }[refusal];
      expect(door.why).toContain(reason);
    }
    // This is the dispatcher's boundary: a refusal is never handed to the command.
    expect(readFileSync(at.file, 'utf8')).toBe(before);
    expect(changes(at)).toEqual([]);
  });
}

test('a seat without dev-mode admission cannot write or be credited as owner', async () => {
  const at = scene();
  const raw = ioFor(at, 'client');
  const before = readFileSync(at.file, 'utf8');
  expect(await runPolicy(args('set'), raw, { home: at.home, now: NOW })).toBe(1);
  expect(readFileSync(at.file, 'utf8')).toBe(before);
  expect(changes(at)).toEqual([]);
});
