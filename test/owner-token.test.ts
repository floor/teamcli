// The fingerprint-bound owner-authorization gate (a minimal, throwaway gate pending the kernel
// rewrite). An out-of-band owner token — `TEAM_OWNER_APPROVAL=<fingerprint>` — admits a non-owner
// caller to `approve` and `up`, but only for the exact change the owner saw: the run recomputes
// the fingerprint from the live source now, so a token for any other change is refused, and the
// owner's "yes" can never leak. The signing is the owner's own key, never forged. Real signed
// stores in scratch homes, the real key; only herdr/launch are stood in for.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { approveFingerprint, upFingerprint } from '../src/approve/owner-token.ts';
import type { Caller } from '../src/caller.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, readApproval, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T = new Date('2026-10-12T12:00:00.000Z');

// A file with no `delegates` section: a non-owner has no standing grant here, so admission can
// only come from the token — the owner-token path on its own, never a delegate's.
const TEXT = `format: 1
project: acme
session: acme-web
operator: lead
workspace:
  mode: shared
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Place = { base: string; home: string; root: string; file: string };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-owner-token-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  return { base, home, root, file: join(root, '.agents', 'team.yaml') };
}

function checkedOf(place: Place, text: string): TeamFile {
  const checked = validateTeamFile(text, { home: place.home, root: place.root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

/** The store as an owner's approval leaves it: the file written, the record really signed. */
function approvedPlace(place: Place, text: string): TeamFile {
  const team = checkedOf(place, text);
  writeFileSync(place.file, text);
  writeApproval(storePath(team.project, place.root, place.home), { approval: approvalOf(team, place.root, T), file: text }, team.seats, place.home);
  return team;
}

// A non-owner caller: a seat, outside the owner's terminal. With no `delegates` grant it is the
// one the owner gate refuses today.
const SEAT: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p1', session: 'other' };

const neverAsked = async (): Promise<string | null> => {
  throw new Error('the token path asked a question');
};
const neverRead = (): never => {
  throw new Error('the token path read the terminal');
};

function connected(place: Place, over: Partial<ApproveSources> = {}): ApproveSources {
  return { ask: async () => '1', waiting: () => 'empty', now: () => T, home: place.home, ...over };
}

async function approveRun(place: Place, argv: string[], caller: Caller, env: Record<string, string | undefined>, sources: ApproveSources) {
  const io = testIo(place.root, caller);
  io.env = env;
  return { code: await runApprove(argv, io, sources), out: io.out, err: io.err };
}

describe('team approve with an out-of-band owner token', () => {
  test('--show prints the fingerprint the owner authorizes, recomputed from the live file', async () => {
    const p = place();
    approvedPlace(p, TEXT);
    const io = testIo(p.root, { kind: 'owner' });
    const code = await runApprove(['--show'], io, connected(p));
    expect(code).toBe(0);
    expect(io.out).toContain(`Owner-authorization fingerprint: ${approveFingerprint(checkedOf(p, TEXT))}`);
  });

  test('a matching token admits a non-owner caller; the record is signed with the real key and verifies', async () => {
    const p = place();
    approvedPlace(p, TEXT);
    const candidate = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(p.file, candidate);
    const fp = approveFingerprint(checkedOf(p, candidate));

    const run = await approveRun(p, [], SEAT, { TEAM_OWNER_APPROVAL: fp }, connected(p, { ask: neverAsked, waiting: neverRead }));
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain('Approved.');

    // The signed record verifies under the home's key (never forged), and matches the candidate.
    const standing = approvalStanding(p.root, p.home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('not verified');
    // Identical content to what an owner run would have written for the same file.
    expect(standing.record.approval.fingerprints).toEqual(fingerprints(checkedOf(p, candidate)));

    // Provenance is on the log line, naming the caller and the token authorization.
    const log = readFileSync(join(p.root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('approve [worker]');
    expect(log).toContain('owner-token-authorized');
  });

  test('no token, and an empty token, keep the owner gate exactly: a non-owner is refused, nothing signed', async () => {
    for (const env of [{}, { TEAM_OWNER_APPROVAL: '' }, { TEAM_OWNER_APPROVAL: '   ' }]) {
      const p = place();
      approvedPlace(p, TEXT);
      const store = storePath(checkedOf(p, TEXT).project, p.root, p.home);
      const before = readApproval(store);
      const run = await approveRun(p, [], SEAT, env, connected(p, { ask: neverAsked, waiting: neverRead }));
      expect(run.code).toBe(1);
      expect(run.err).toContain('only the owner approves a team file');
      expect(readApproval(store)).toEqual(before);
    }
  });

  test('a token for a different change is refused: the yes cannot leak to a mutated file', async () => {
    const p = place();
    approvedPlace(p, TEXT);
    // The owner authorized the candidate that only adds a rule.
    const authorized = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    const fp = approveFingerprint(checkedOf(p, authorized));
    // But the live file on disk was edited further after the yes: a second, unseen rule.
    const mutated = authorized.replace('  - Sign every commit.\n', '  - Sign every commit.\n  - Deploy to prod.\n');
    writeFileSync(p.file, mutated);
    const store = storePath(checkedOf(p, mutated).project, p.root, p.home);
    const before = readApproval(store);

    const run = await approveRun(p, [], SEAT, { TEAM_OWNER_APPROVAL: fp }, connected(p, { ask: neverAsked, waiting: neverRead }));
    expect(run.code).toBe(1);
    expect(run.err).toContain('only the owner approves a team file');
    expect(readApproval(store)).toEqual(before);
  });

  test('the owner at a terminal is unchanged when no token is set: the question still gates the write', async () => {
    const p = place();
    approvedPlace(p, TEXT);
    const candidate = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(p.file, candidate);
    // Owner, --confirm, a wrong answer: refused exactly as before, with no token in play.
    const wrong = await approveRun(p, ['--confirm'], { kind: 'owner' }, {}, connected(p, { ask: async () => '0' }));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('not approved; nothing was written');
    // Owner, empty terminal: the plain owner path still approves.
    const ok = await approveRun(p, [], { kind: 'owner' }, {}, connected(p));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('Approved.');
  });
});

// A verified standing for `up`, built from a team file the way the store records one.
function verified(team: TeamFile, file: string, root: string): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: T.toISOString(),
    record: {
      approval: approvalOf(team, root, T),
      file,
      generation: 1,
      signature: 'test',
    },
  };
}

describe('team up with an out-of-band owner token', () => {
  async function upDry(place: Place, caller: Caller, env: Record<string, string | undefined>, standing: Standing) {
    const io = testIo(place.root, caller);
    io.env = env;
    const sources: UpSources = {
      sessionRunning: () => false,
      sessionState: () => 'absent',
      agents: () => [],
      home: place.home,
      now: () => T,
      standing: () => standing,
    };
    const code = await runUp(['--dry-run'], io, sources);
    return { code, out: io.out, err: io.err };
  }

  test('a matching token drops the "only the owner" refusal; a wrong or absent token keeps it, in the dry run\'s words', async () => {
    const p = place();
    const team = approvedPlace(p, TEXT);
    const standing = verified(team, TEXT, p.root);
    const fp = upFingerprint(fingerprints(team), 1);

    // A dry run is never answered with the bare word: the caller the run does not admit is told
    // the reason and the owner's own command instead, through the same refusal the real run
    // denies on (this file's real runs are the boundary scenes').
    const without = await upDry(p, SEAT, {}, standing);
    expect(without.code).toBe(1);
    expect(without.err.replace(/^team up: the file lists no trust[^]*$/, '')).toBe('');
    expect(without.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(without.out).toContain('! to unblock: a `leads` seat runs `team up` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');

    const wrong = await upDry(p, SEAT, { TEAM_OWNER_APPROVAL: `${fp}00` }, standing);
    expect(wrong.code).toBe(1);
    expect(wrong.err.replace(/^team up: the file lists no trust[^]*$/, '')).toBe('');
    expect(wrong.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is ');
    expect(wrong.out).toContain('! to unblock: a `leads` seat runs `team up` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');

    const withToken = await upDry(p, SEAT, { TEAM_OWNER_APPROVAL: fp }, standing);
    expect(withToken.err.replace(/^team up: the file lists no trust[^]*$/, '')).toBe('');
    expect(withToken.out).not.toContain('deny');
  });
});
