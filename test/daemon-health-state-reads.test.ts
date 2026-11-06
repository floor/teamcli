// One health answer used to read the team state file once per seat. Sixty-seven seats on one
// route must answer from one read, inside 50 ms, and an op that does not return roots must
// not read it at all. The next request reads again, so a verdict does not outlive the request.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import type { PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceIngestResult, PresenceIngester } from '../src/daemon/presence/ingest.ts';
import type { PresencePublishResult } from '../src/daemon/presence/publish.ts';
import { readStateCallCount, resetReadStateCallCount, STATE_FILE } from '../src/state.ts';

const SEATS = 67;
const LEAD = 'crew-lead';
const SESSION = 'crew';

function teamYaml(): string {
  const lines = [
    'format: 1',
    'project: acme-web',
    `session: ${SESSION}`,
    `coordinator: ${LEAD}`,
    'operator: crew-op',
    'workspace:',
    '  mode: shared',
    'seats:',
  ];
  const seat = (role: string, name: string): void => {
    lines.push(
      `  - role: ${role}`,
      `    name: ${name}`,
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude',
    );
  };
  seat('coordinator', LEAD);
  seat('operator', 'crew-op');
  for (let i = 1; i <= SEATS - 2; i += 1) seat('worker', `worker-${String(i)}`);
  return `${lines.join('\n')}\n`;
}

function stateText(binding: string): string {
  return JSON.stringify({
    format: 1,
    sessions: {
      [SESSION]: {
        seats: {
          [LEAD]: { presence_binding: binding },
        },
      },
    },
    // A few hundred kilobytes, so sixty-seven parses miss 50 ms and one parse does not.
    note: 'x'.repeat(400_000),
  });
}

const bases: string[] = [];
const daemons: MachineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    try { await daemon.close(); } catch { /* already closed */ }
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function ask(socketPath: string, op: string): Promise<{ ms: number; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    const started = performance.now();
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${op} timed out`));
    }, 2_000);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 2, id: op, op })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms: performance.now() - started, line: buffer.slice(0, buffer.indexOf('\n')) });
    });
  });
}

test('67 seats answer health from one state read per route, inside 50 ms', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'health-state-reads-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml());
  const statePath = join(root, '.agents', STATE_FILE);
  writeFileSync(statePath, stateText('prs_0123456789ab'));

  const ingest = (): PresenceIngestResult => ({
    ingested: [], rejected: [], stale: [], repaired: [], errors: [],
    healthy: true, pending: false, closed: false,
  });
  const ingester: PresenceIngester = {
    step: async () => ingest(),
    close: async () => ({ quiesced: true }),
    isClosed: () => false,
  };
  const activity = (): PresenceActivityResult => ({ seats: [], failed: null });
  const publish = (): PresencePublishResult => ({ seats: [], failed: null });
  const started = await startMachineDaemon({
    home,
    roots: [root],
    version: '0.0.0-health-reads',
    heartbeatMs: 60_000,
    presenceHosting: true,
    presenceEveryMs: 60_000,
    restoreSweep: false,
    presenceSubscriptions: () => [],
    presenceIngest: () => ingester,
    presenceActivity: () => async () => activity(),
    presencePublish: () => async () => publish(),
  });
  if (started.kind !== 'serving') throw new Error(`daemon did not start: ${started.kind}`);
  daemons.push(started.daemon);
  const socketPath = daemonSocketPath(home);

  const health = async (binding: string): Promise<void> => {
    resetReadStateCallCount();
    const answer = await ask(socketPath, 'health');
    const reads = readStateCallCount();
    const body = JSON.parse(answer.line) as {
      ok?: boolean;
      health?: { roots?: Array<{ presence?: { seats?: Array<{ seat: string; binding: string | null }> } }> };
    };
    expect(body.ok).toBe(true);
    const seats = body.health?.roots?.[0]?.presence?.seats ?? [];
    expect(seats).toHaveLength(SEATS);
    expect(seats.find((seat) => seat.seat === LEAD)?.binding).toBe(binding);
    expect(reads).toBe(1);
    expect(answer.ms).toBeLessThan(50);
  };

  await health('prs_0123456789ab');
  writeFileSync(statePath, stateText('prs_abcdefabcdef'));
  await health('prs_abcdefabcdef');

  resetReadStateCallCount();
  const refused = await ask(socketPath, 'send');
  expect(JSON.parse(refused.line).ok).toBe(false);
  expect(readStateCallCount()).toBe(0);
  expect(refused.ms).toBeLessThan(50);
}, 30_000);
