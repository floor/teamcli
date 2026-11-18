// The Claude adapter §5: `team doctor` on an E7b-active root lists each Claude seat whose channel
// is not proven, with its reason — no listener, unproven since launch, an overdue offer — and the
// stale pieces a restart repairs: a checkout pair naming a retained daemon runtime copy or pinning
// an `--epoch`, a lead with no pair, a launch line pinning `--resume`. A proven seat with a good
// pair, and every seat of a dark root, draw nothing. A label persona another seat carries is
// noted. `team mcp setup`'s checkout pair names no epoch. Fixtures only: synthetic folders, home,
// pair files and listener markers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { listenerKeyOf, proveOffer } from '../src/comms/offer.ts';
import { writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { planChannelPair } from '../src/mcp/launch-config.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date();
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const COPY = 'a'.repeat(64);

let base: string;
let root: string;
let home: string;

function teamText(leadLaunch = 'claude', workerLabel = ''): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${leadLaunch}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    cwd: worker-folder
${workerLabel}`;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-claude-channel-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'worker-folder'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function sources(): DoctorSources {
  return {
    version: () => '2.1.326 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

async function doctor(text = teamText()): Promise<string> {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const io = testIo(root, OWNER);
  await runDoctor(['--file', '.agents/team.yaml'], io, sources());
  return `${io.out}${io.err}`;
}

function activateRoot(): void {
  expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
}

function pair(args: string[]): void {
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'team-inbox': { command: process.execPath, args } } }));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['team-inbox'] }));
}

function listen(seat: string): InboxListener {
  const dropDir = seatMailDirs(root, SESSION, seat).legacy;
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const listener: InboxListener = { v: 1, seat, session: SESSION, root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), channel: true, level: 3 };
  expect(writeListener(dropDir, listener)).toBe(true);
  return listener;
}

/** A proving ack for one stamped message: the seat's channel is proven for this listener. */
function prove(seat: string, listener: InboxListener): void {
  const id = '8d3e4f5a-0000-4000-8000-0000000d0c01';
  const dirs = seatMailDirs(root, SESSION, seat);
  const payload: RecordPayload = { kind: 'message', id, to: seat, to_id: null, root, session: SESSION, at: new Date().toISOString(), body: 'b', from: 'owner', from_id: null, rule: 'the owner', thread: id };
  expect(writeRecord(dirs.legacy, signRecord(stampedPayload(payload, home), home)).ok).toBe(true);
  const token = 'd'.repeat(32);
  takeCopyNumber(dirs.stamped, id, 'channel', Date.now(), { token, listener: listenerKeyOf(listener) });
  const key = messageKeyState(home);
  if (key.kind !== 'key') throw new Error('no key');
  expect(publishRecordRead({ dropDir: dirs.legacy, id, to: seat, root, session: SESSION, home, key: key.key, at: new Date().toISOString(), readBy: 'channel' }).kind).toBe('published');
  expect(proveOffer(dirs.legacy, id, token, listenerKeyOf(listener), { root, session: SESSION, seat, key: key.key })).not.toBeNull();
}

describe('team doctor on an active root: unproven Claude seats and stale pairs', () => {
  test('no listener, and a lead with no pair in its folder', async () => {
    activateRoot();
    const out = await doctor();
    expect(out).toContain('lead: no proven channel (no listener; no pair)');
    expect(out).toContain('worker: no proven channel (no listener)');
  });

  test('a live listener that never proved its channel: unproven since launch', async () => {
    activateRoot();
    listen('worker');
    const out = await doctor();
    expect(out).toContain('worker: no proven channel (unproven since launch)');
  });

  test('a pair naming a retained daemon runtime copy, and a pair pinning --epoch, are stale', async () => {
    activateRoot();
    pair([join(home, '.config', 'team', 'daemon-runtime', COPY, 'dist', 'cli.js'), 'mcp', 'serve', '--seat', 'lead', '--session', SESSION]);
    expect(await doctor()).toContain('stale pair (a daemon-runtime/ server path)');
    pair(['/opt/team/dist/cli.js', 'mcp', 'serve', '--seat', 'lead', '--session', SESSION, '--epoch', 'run_000000000000']);
    expect(await doctor()).toContain('stale pair (a pinned --epoch)');
  });

  test('a launch line that pins --resume', async () => {
    activateRoot();
    expect(await doctor(teamText('claude --resume 00000000-0000-4000-8000-000000000000'))).toContain('a pinned --resume on the launch line');
  });

  test('a proven seat with a good pair draws nothing', async () => {
    activateRoot();
    pair(['/opt/team/dist/cli.js', 'mcp', 'serve', '--seat', 'lead', '--session', SESSION]);
    prove('lead', listen('lead'));
    const out = await doctor();
    expect(out).not.toContain('lead: no proven channel');
  });

  test('a dark root has no such entry', async () => {
    const out = await doctor(teamText('claude --resume 00000000-0000-4000-8000-000000000000'));
    expect(out).not.toContain('no proven channel');
  });
});

describe('team doctor: a label persona another seat carries', () => {
  test('the worker\'s persona is another registered seat\'s nickname: noted, and messages name it by its seat', async () => {
    const teamId = teamIdOf(root);
    const reg = (seat: string): string => registerAgent(home, {
      name: seat, signing: { model: 'Test', version: '1', role: 'worker' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'claude',
      reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'owner',
    }).id;
    const leadId = reg('lead');
    const workerId = reg('worker');
    upsertTeam(home, teamId, { project: 'acme', session: SESSION, root, roster: [{ agent: leadId, seat: 'lead', role: 'coordinator', nickname: 'Wren' }, { agent: workerId, seat: 'worker', role: 'worker' }] });
    const out = await doctor(teamText('claude', '    label: "Wren · worker"\n'));
    expect(out).toContain('worker: label persona "Wren" is another seat\'s name; messages name it as worker');
  });
});

describe('team mcp setup: the checkout pair names no epoch', () => {
  test('a pair planned for a checkout folder drops the epoch it is handed', () => {
    const plan = planChannelPair({ root, seat: 'lead', session: SESSION, cwd: root, epoch: 'run_000000000000', home }, false);
    const mcp = JSON.parse(plan.documents[0]!.text!) as { mcpServers: Record<string, { args: string[] }> };
    expect(mcp.mcpServers['team-inbox']!.args).not.toContain('--epoch');
    expect(mcp.mcpServers['team-inbox']!.args.join(' ')).not.toContain('daemon-runtime');
  });
});
