// `doctor` reads the team file through the same sections `team check` does, so a word it cannot
// read is refused before any finding: the `drop` leg validates like the other three, and an
// unknown leg names every word the file may write — the same list `team check` and the schema use.
// Fixtures only: the sample team file, a scratch home, and a doctor whose sources answer instead
// of reading this machine.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-04T09:00:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-drop-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function sources(): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

async function doctor(extra: string): Promise<{ code: number; out: string; err: string }> {
  writeFileSync(join(root, '.agents/team.yaml'), `${EXAMPLE}${extra}`);
  const io = testIo(root, OWNER);
  const code = await runDoctor(FILE, io, sources());
  return { code, out: io.out, err: io.err };
}

describe('doctor reads the delivery_order legs the file may write', () => {
  test('drop is a leg the file may write: no complaint about the key', async () => {
    const run = await doctor('delivery_order: [drop]\n');
    expect(run.err).not.toContain('delivery_order');
    // Exit 2 is the file's own refusal; the sample file's findings never reach it.
    expect(run.code).not.toBe(2);
  });

  test('an unknown leg is refused, naming every leg the file may write', async () => {
    const run = await doctor('delivery_order: [telepathy]\n');
    expect(run.code).toBe(2);
    expect(run.err).toContain('delivery_order "telepathy" must be one of: native, mcp-inbox, typed, drop');
  });
});
