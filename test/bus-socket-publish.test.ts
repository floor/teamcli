// A socket caller may publish an arrival, which is still held to its record, or a seat
// observation. A kind the bus writes itself is refused and is not appended.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { publishToBus, startBus, type BusHandle } from '../src/bus/server.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const TEAM = `format: 1
project: acme
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;

const made: string[] = [];
const buses: BusHandle[] = [];
afterEach(async () => {
  for (const handle of buses.splice(0)) await handle.close();
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('a socket publish of a kind the bus writes is refused, and a seat observation is taken', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-publish-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const parsed = validateTeamFile(TEAM);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const started = await startBus({ root, team: parsed.team, home, stderr: () => {}, reconcileIntervalMs: 0 });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') return;
  buses.push(started.handle);

  const idle = await publishToBus(root, {
    ts: '2026-11-03T00:00:00.000Z',
    kind: 'seat.idle',
    session: 'acme',
    record_id: 'seat:lead:idle',
    seat: 'lead',
    subject: 'lead',
  });
  expect(idle.kind).toBe('published');

  const grant = await publishToBus(root, {
    ts: '2026-11-03T00:00:00.000Z',
    kind: 'team.grant-issued',
    session: 'acme',
    record_id: 'grant-1',
    subject: 'lead',
  });
  expect(grant.kind).toBe('refused');
  if (grant.kind === 'refused') expect(grant.message).toBe('a socket publish of team.grant-issued is not taken');

  const read = readEvents('acme', root, home);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.events.map((event) => event.payload.kind)).toEqual(['seat.idle']);
});
