import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runApprove } from '../src/approve/command.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, standingSource, type StatusSources } from '../src/commands/status.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { overridesInForce, overridesPath, quotaWith } from '../src/profiles/overrides.ts';
import { approvalStanding, readApproval, storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-04T09:00:00Z');

const OVERRIDE = `format: 1
profiles:
  codex:
    quota:
      - account: anthropic
        match: '\\bL: ([0-9]+)% \\(([0-9hm]+)\\)'
        used: '{1}%'
        resets: '{2}'
        window: session
`;

const EDITED = OVERRIDE.replace('account: anthropic', 'account: other');
const BROKEN = `format: 1
profiles:
  codex:
    composer:
      mode: status-last
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-overrides-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const path = () => overridesPath('acme-web', root, home);

async function approve(answer: string | null = '5') {
  const io = testIo(root, OWNER);
  const code = await runApprove(FILE, io, { ask: async () => answer, waiting: () => 'empty', now: () => NOW, home });
  return { code, out: io.out, err: io.err };
}

function doctorSources(): DoctorSources {
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

function statusSources(): StatusSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
  };
}

describe('an override is the owner\'s, by approval', () => {
  test('an unapproved file changes nothing, and doctor and status name it', async () => {
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), OVERRIDE);
    const force = overridesInForce('acme-web', root, home);
    expect(force.profiles).toEqual([]);
    expect(force.differences).toContain('`overrides` changed');
    expect(quotaWith('codex', force.profiles).some((pattern) => pattern.account === 'anthropic')).toBe(false);

    const doctor = testIo(root, OWNER);
    expect(await runDoctor(FILE, doctor, doctorSources())).toBe(1);
    expect(doctor.out).toContain('MISS  run `team approve`: `overrides` changed\n');

    const status = testIo(root, OWNER);
    expect(await runStatus(FILE, status, statusSources())).toBe(1);
    expect(status.out).toContain('the overrides differ from the approved copy: `overrides` changed');
  });

  test('approving the file puts it in force, and a later edit leaves the approved copy', async () => {
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), OVERRIDE);
    const shown = await approve();
    expect(shown.out).toContain('`overrides` changed');
    expect(shown.code).toBe(0);
    const force = overridesInForce('acme-web', root, home);
    expect(quotaWith('codex', force.profiles).some((pattern) => pattern.account === 'anthropic')).toBe(true);
    expect(force.differences).toEqual([]);

    writeFileSync(path(), EDITED);
    const edited = overridesInForce('acme-web', root, home);
    expect(quotaWith('codex', edited.profiles).some((pattern) => pattern.account === 'anthropic')).toBe(true);
    expect(quotaWith('codex', edited.profiles).some((pattern) => pattern.account === 'other')).toBe(false);
    expect(edited.differences).toContain('`overrides` changed');
  });

  test('one project\'s approval does not read another project\'s file', async () => {
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), OVERRIDE);
    expect((await approve()).code).toBe(0);
    const other = join(base, 'other');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(join(other, '.agents/team.yaml'), EXAMPLE);
    const io = testIo(other, OWNER);
    expect(await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home })).toBe(0);
    // The approval is keyed on the project root's path: a second checkout of the same
    // project name has its own store, and this one's patterns are not in it.
    expect(storePath('acme-web', other, home)).not.toBe(storePath('acme-web', root, home));
    const there = overridesInForce('acme-web', other, home);
    expect(there.profiles).toEqual([]);
    expect(quotaWith('codex', there.profiles).some((pattern) => pattern.account === 'anthropic')).toBe(false);
    expect(quotaWith('codex', overridesInForce('acme-web', root, home).profiles).some((pattern) => pattern.account === 'anthropic')).toBe(true);
  });

  test('a stored copy edited after approval leaves the shipped profiles: it is not an approval', async () => {
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), OVERRIDE);
    expect((await approve()).code).toBe(0);
    const record = readApproval(storePath('acme-web', root, home));
    if (!record) throw new Error('approval');
    // The overrides text is changed inside the stored record, after approval, without the
    // key: the signature no longer holds, nothing of the record is in force, and the
    // shipped profiles stay.
    writeFileSync(join(storePath('acme-web', root, home), 'approval.json'), JSON.stringify({ ...record.approval, file: record.file, overrides: '[\n', generation: record.generation, signature: record.signature }));
    rmSync(path());
    const force = overridesInForce('acme-web', root, home);
    expect(force.profiles).toEqual([]);
    expect(approvalStanding(root, home).kind).toBe('refused');
  });

  test('a malformed file is reported by approve, doctor, status, watch and up, and does not throw', async () => {
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), OVERRIDE);
    expect((await approve()).code).toBe(0);
    writeFileSync(path(), BROKEN);

    const refused = await approve();
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(`${path()}: line`);
    expect(refused.err).toContain('unknown key "composer"');
    expect(quotaWith('codex', overridesInForce('acme-web', root, home).profiles).some((pattern) => pattern.account === 'anthropic')).toBe(true);

    const doctor = testIo(root, OWNER);
    const doctorCode = await runDoctor(FILE, doctor, doctorSources());
    expect(doctorCode).toBe(1);
    expect(doctor.out).toContain('unknown key "composer"');

    const status = testIo(root, OWNER);
    const statusCode = await runStatus(FILE, status, statusSources());
    expect(statusCode).not.toBe(2);
    expect(`${status.out}${status.err}`).toContain('unknown key "composer"');

    const watch = testIo(root, OWNER);
    const watchCode = await runWatch(FILE, watch, {
      live: () => null,
      machine: () => { throw new Error('not read'); },
      standing: standingSource(home),
      readChecks: () => [],
      screen: () => null,
      status: () => null,
      foreground: () => null,
      typeText: () => false,
      pressEnter: () => false,
      notify: () => {},
      now: () => NOW,
      wait: async () => false,
      sleep: async () => {},
      alive: () => false,
      pid: 1,
      home,
    } satisfies WatchSources);
    expect(watchCode).toBe(0);
    expect(watch.out).toContain('unknown key "composer"');

    const up = testIo(root, OWNER);
    const upCode = await runUp(['--dry-run', ...FILE], up, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctorSources(),
    } satisfies Partial<UpSources> as UpSources);
    expect(upCode).toBe(1);
    expect(up.out).toContain('unknown key "composer"');
  });
});
