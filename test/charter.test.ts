// The owner charter is one signature at `team setup`. Routine commands inside it run with no
// further prompt. Two owner-seat requests that overlap on the lock share one card. Every scene
// uses a temp home; the real ~/.config/team is never read or written.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { charterPath, charterStatement, defaultCharterBody, type CharterBody } from '../src/charter/body.ts';
import { charterGate } from '../src/charter/check.ts';
import { readCharter } from '../src/charter/store.ts';
import { issueGrantUnderCharter, type PendingGrantParams } from '../src/client/emission.ts';
import { createOwnerActionRequest, type OwnerAction } from '../src/client/owner-action.ts';
import { ownerSeatInbox, readOwnerSeat } from '../src/client/owner-seat.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runConfig } from '../src/commands/config.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runSetup } from '../src/commands/setup.ts';
import { runSwap } from '../src/commands/swap.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { charterFolderPretrust } from '../src/launch/pretrust.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';
import { fakeOwnerStore, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const AGENT: Caller = { kind: 'unplaced', reason: 'the agent that launched setup' };
const registry = { ...process.env, TEAM_CONFIG_SOURCE: 'registry' };
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9, pressure: 'normal' };

const CONFIG_TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const SWAP_TEAM = `format: 1
project: acme
session: acme
entity: lab
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
  - role: reviewer
    name: helper
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    launch: codex --model gpt-sol
`;

const ADD_TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { base: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-charter-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

function projectAt(base: string, name: string, text: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  const lobby = text.includes('entity: lab') ? '~/.config/team/lobbies/lab' : '~/.config/team/lobby';
  const trusted = text.includes('trust:') ? text : text.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${root}\nworkspace:\n`);
  writeFileSync(join(root, '.agents', 'team.yaml'), trusted);
  return root;
}

async function sign(home: string, store: FakeStore, roots: string[], cwd: string): Promise<number> {
  const io = testIo(cwd, AGENT);
  return runSetup(['--signer', 'touch-id', '--team', 'floor', '--roots', roots.join(',')], io, { home, store, now: () => NOW });
}

function cards(home: string): string[] {
  try {
    return readdirSync(actionRequestsFolder(home)).filter((name) => /^oa_[0-9a-f]{24}\.json$/.test(name));
  } catch {
    return [];
  }
}

function rawPoint(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
}

test('team setup signs once with Touch ID, and an omitted signer does not sign', async () => {
  const { home, base } = scratch();
  const root = projectAt(base, 'acme', CONFIG_TEAM);
  const store = fakeOwnerStore();
  const skipped = testIo(root, AGENT);
  expect(await runSetup([], skipped, { home, store, now: () => NOW })).toBe(2);
  expect(store.prompts).toEqual([]);
  expect(existsSync(charterPath(home))).toBe(false);

  const io = testIo(root, AGENT);
  expect(await runSetup(['--signer', 'touch-id', '--team', 'floor', '--roots', root], io, { home, store, now: () => NOW })).toBe(0);
  expect(store.prompts).toHaveLength(1);
  expect(io.out).toContain('signed by mac');
  const read = readCharter(home, store);
  expect(read.kind).toBe('ok');
});

test('a passkey charter is one assertion and creates no Mac key', async () => {
  const { home, base } = scratch();
  const root = projectAt(base, 'acme', CONFIG_TEAM);
  const store = fakeOwnerStore();
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = rawPoint(pair.publicKey);
  const body = defaultCharterBody([root]);
  const signature = cryptoSign('sha256', charterStatement(body), { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex');
  const io = testIo(root, AGENT);
  const code = await runSetup(
    ['--signer', 'passkey', '--team', 'floor', '--roots', root, '--public-key', point, '--signature', signature, '--credential-id', 'cred-1'],
    io,
    { home, store, now: () => NOW },
  );
  expect(code, io.err).toBe(0);
  expect(store.prompts).toEqual([]);
  const seat = readOwnerSeat(home);
  expect(seat?.signers.map((signer) => signer.type)).toEqual(['webauthn']);
  expect(readCharter(home, store).kind).toBe('ok');
});

test('a charter that does not verify fails closed, including one that claims the right to grant', async () => {
  const { home, base } = scratch();
  const root = projectAt(base, 'acme', CONFIG_TEAM);
  const store = fakeOwnerStore();
  expect(await sign(home, store, [root], root)).toBe(0);
  const signed = store.prompts.length;
  const path = charterPath(home);
  const file = JSON.parse(readFileSync(path, 'utf8')) as { body: CharterBody; signature: string; signer: string };
  file.body.roots = [join(base, 'elsewhere')];
  writeFileSync(path, `${JSON.stringify(file)}\n`);
  const tampered = charterGate(home, { operation: 'config', cwd: root }, store);
  expect(tampered.kind).toBe('block');
  if (tampered.kind === 'block') expect(tampered.message).toContain('team setup --edit');

  const seat = readOwnerSeat(home);
  const label = seat?.signers[0]?.label ?? '';
  const granted = { ...file.body, roots: [root], grant_right: true as const };
  const signature = store.sign(label, charterStatement(granted as unknown as CharterBody), 'tamper');
  expect(signature.ok).toBe(true);
  if (!signature.ok) return;
  writeFileSync(path, `${JSON.stringify({ format: 1, body: granted, signer: file.signer, signature: signature.signature })}\n`);
  const blocked = charterGate(home, { operation: 'grant', cwd: root }, store);
  expect(blocked.kind).toBe('block');
  if (blocked.kind === 'block') expect(blocked.message).toContain('right to grant');
  const grant = issueGrantUnderCharter(home, { allow_grant: true } as PendingGrantParams, NOW);
  expect(grant.ok).toBe(false);
  if (!grant.ok) expect(grant.why).toContain('cannot carry the right to grant');
  expect(store.prompts).toHaveLength(signed + 1);
});

test('two owner-gated actions at the same time share one card and open no browser', async () => {
  const { home, base } = scratch();
  const root = projectAt(base, 'acme', CONFIG_TEAM);
  const store = fakeOwnerStore();
  const { seatOwner } = await import('./helpers/owner-seat.ts');
  seatOwner(home, store);
  const opened = join(base, 'opened.txt');
  const { ownerActionLockPath, ownerActionWaitersFolder } = await import('../src/client/owner-action.ts');
  mkdirSync(ownerActionWaitersFolder(home), { recursive: true });
  mkdirSync(ownerActionLockPath(home));
  const worker = (action: OwnerAction, requestedBy: string) => new Promise<{ ok: boolean; request_id?: string; actions?: string[] }>((resolve, reject) => {
    const child = new Worker(new URL('./charter-request-worker.ts', import.meta.url), {
      workerData: { home, root, action, requestedBy, opened },
    });
    child.on('message', (message: { ok: true; record: { request_id: string; params: { actions: string[] } } } | { ok: false; why: string }) => {
      if (!message.ok) resolve({ ok: false });
      else resolve({ ok: true, request_id: message.record.request_id, actions: message.record.params.actions });
    });
    child.on('error', reject);
  });
  const pending = Promise.all([worker('team-up', 'atlas'), worker('team-add', 'iris')]);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiters = readdirSync(ownerActionWaitersFolder(home)).filter((name) => name.endsWith('.json'));
    if (waiters.length >= 2) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  rmSync(ownerActionLockPath(home), { recursive: true, force: true });
  const [left, right] = await pending;
  expect(left.ok && right.ok).toBe(true);
  expect(left.request_id).toBe(right.request_id);
  expect(cards(home)).toHaveLength(1);
  expect(left.actions?.slice().sort()).toEqual(['team-add', 'team-up']);
  expect(right.actions?.slice().sort()).toEqual(['team-add', 'team-up']);
  const inbox = readdirSync(ownerSeatInbox(home)).filter((name) => name.endsWith('.json'));
  expect(inbox).toEqual([`${left.request_id}.json`]);
  expect(existsSync(opened)).toBe(false);
  expect(store.prompts).toEqual([]);

  const first = createOwnerActionRequest(home, { actions: ['team-send'], root, team: 'acme', head: null, args: {}, requestedBy: 'ada' }, NOW, () => writeFileSync(opened, 'opened\n'));
  const second = createOwnerActionRequest(home, { actions: ['team-down'], root, team: 'acme', head: null, args: {}, requestedBy: 'ada' }, NOW, () => writeFileSync(opened, 'opened\n'));
  expect(first.ok && second.ok).toBe(true);
  if (first.ok && second.ok) expect(first.record.request_id).not.toBe(second.record.request_id);
  expect(existsSync(opened)).toBe(false);
});

test('a folder under a charter root is pre-trusted, and a folder outside is refused with no request', async () => {
  const { home, base } = scratch();
  const root = projectAt(base, 'acme', CONFIG_TEAM);
  const outside = projectAt(base, 'other', CONFIG_TEAM);
  const store = fakeOwnerStore();
  expect(await sign(home, store, [root], root)).toBe(0);
  const signed = store.prompts.length;
  expect(charterFolderPretrust({ cli: 'grok', cwd: root }, home, { now: NOW, store })).toBe(true);
  expect(existsSync(join(home, '.grok', 'trusted_folders.toml'))).toBe(true);
  const blocked = charterGate(home, { operation: 'add', cwd: outside }, store);
  expect(blocked.kind).toBe('block');
  if (blocked.kind === 'block') expect(blocked.message).toContain('team setup --edit');
  const io = testIo(outside, AGENT);
  const code = await runAdd(['worker', '--request'], io, addSources(home, store));
  expect(code).toBe(1);
  expect(io.err).toContain('team setup --edit');
  expect(cards(home)).toEqual([]);
  expect(store.prompts).toHaveLength(signed);
});

test('seat add, delete, swap and config set run under the charter with no owner prompt', async () => {
  const { home, base } = scratch();
  const configRoot = projectAt(base, 'config', CONFIG_TEAM);
  const swapRoot = projectAt(base, 'swap', SWAP_TEAM);
  const seatRoot = projectAt(base, 'seats', ADD_TEAM);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seatRoot, stdio: 'ignore' });
  const loaded = loadTeamFile(seatRoot, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root), file: readFileSync(join(seatRoot, '.agents', 'team.yaml'), 'utf8') }, loaded.team.seats, home);
  const store = fakeOwnerStore();
  const previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'registry';
  try {
    const migrated = await runMigrate([], testIo(configRoot, { kind: 'owner' }), { home, now: () => NOW });
    expect(migrated, 'migrate before the charter').toBe(0);
  } finally {
    if (previous === undefined) delete process.env.TEAM_CONFIG_SOURCE;
    else process.env.TEAM_CONFIG_SOURCE = previous;
  }
  const rule = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value: '*=!anthropic' }, { now: NOW });
  if (!rule.ok) throw new Error(rule.why);
  expect(await sign(home, store, [configRoot, swapRoot, seatRoot], seatRoot)).toBe(0);
  const signed = store.prompts.length;
  expect(signed).toBe(1);

  const configIo = testIo(configRoot, AGENT);
  const swapIo = testIo(swapRoot, AGENT);
  const [configured, swapped] = await Promise.all([
    runConfig(['set', 'seats.lead.label', 'boss'], configIo, { home, env: registry, now: () => NOW, ownerSeatStore: store }),
    runSwap(['queue', 'lead', '--to', 'codex:gpt sol'], swapIo, { home, now: () => NOW, ownerSeatStore: store }),
  ]);
  expect(configured, configIo.err).toBe(0);
  expect(swapped, `${swapIo.err}${swapIo.out}`).toBe(0);
  const queued = readState(join(swapRoot, '.agents')).swaps?.lead;
  expect(queued?.to).toMatchObject({ cli: 'codex', vendor: 'openai', model: 'GPT Sol' });
  const readBack = testIo(configRoot, AGENT);
  expect(await runConfig(['get', 'seats.lead.label'], readBack, { home, env: registry, now: () => NOW, ownerSeatStore: store }), readBack.err).toBe(0);
  expect(readBack.out).toBe('boss\n');

  const addIo = testIo(seatRoot, AGENT);
  expect(await runAdd(['worker', '--dry-run'], addIo, addSources(home, store)), `${addIo.err}${addIo.out}`).toBe(0);
  const removeIo = testIo(seatRoot, AGENT);
  expect(await runRemove(['worker'], removeIo, removeSources(home, store)), `${removeIo.err}${removeIo.out}`).toBe(0);
  expect(readFileSync(join(seatRoot, '.agents', 'team.yaml'), 'utf8')).not.toContain('name: worker');
  expect(store.prompts).toHaveLength(signed);
  expect(cards(home)).toEqual([]);
});

function doctor(home: string): DoctorSources {
  return { version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => NOW, home };
}

function addSources(home: string, store: FakeStore): AddSources {
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace: () => ({ pane: 'w1:p1', workspace: 'w1' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => [],
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home,
    ownerSeatStore: store,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch,
    machine: () => fine,
  };
}

function removeSources(home: string, store: FakeStore): RemoveSources {
  return {
    home,
    ownerSeatStore: store,
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
  };
}
