// A CLI resumed after a machine restart can come back in another conversation of the same seat
// (floor's tester-codex, 2026-11-17: "its pane holds another conversation"). The re-tie accepts
// it when the pane stands in the seat's own worktree, inside no other seat's, and no other seat's
// record names the pane; it records the new conversation. Anything short of that keeps the
// refusal, and a pane in seat A's worktree never ties to seat B.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrAgent } from '../src/herdr.ts';
import { paneInOwnWorktree, restoreProof, restoreWorktreeOf, type RestoreProofInput, type RestoreWorktree } from '../src/launch/restore-proof.ts';

const PANE = 'w53:p1';
const SPACE = 'w53';
const ROOT = '/fixture/floor';
const OWN = `${ROOT}/worktrees/floor/floor/tester-codex`;
const OTHER = `${ROOT}/worktrees/floor/floor/operator-02`;
const RECORDED_ID = '01a1e31f-0000-7000-8000-000000000001';
const LIVE_ID = '01a1bfd3-0000-7000-8000-000000000002';

const entry = (over: Partial<HerdrAgent> = {}): HerdrAgent => ({
  name: null, agent: 'codex', pane: PANE, workspace: SPACE, status: 'idle', cwd: OWN, session: LIVE_ID, ...over,
});

const evidence = (over: Partial<RestoreWorktree> = {}): RestoreWorktree => ({ own: OWN, others: [OTHER], paneClaimed: false, ...over });

function input(over: Partial<RestoreProofInput> = {}, agent: Partial<HerdrAgent> = {}): RestoreProofInput {
  return {
    seat: { name: 'tester-codex', cli: 'codex' },
    recorded: { stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 100, cli: [200] } },
    agents: [entry(agent)],
    process: { shell: 101, foreground: [201] },
    foreground: ['codex'],
    recordedSession: RECORDED_ID,
    screen: null,
    worktree: evidence(),
    ...over,
  };
}

describe('a restored pane in another conversation of the same seat', () => {
  test('is re-tied when it stands in the seat\'s own worktree, and the record takes the new id', () => {
    const proof = restoreProof(input());
    expect(proof.kind).toBe('session');
    if (proof.kind !== 'session') return;
    expect(proof.rebound).toEqual({ from: RECORDED_ID, to: LIVE_ID });
    expect(proof.sentence).toContain(`moved from ${RECORDED_ID} to ${LIVE_ID}`);
  });

  test('a subfolder of the seat\'s worktree counts as its own', () => {
    expect(restoreProof(input({}, { cwd: `${OWN}/src` })).kind).toBe('session');
  });

  test('without worktree evidence the refusal stands', () => {
    const { worktree: _, ...bare } = input();
    expect(restoreProof(bare)).toMatchObject({ kind: 'none', specific: true });
  });

  test('impostor: a pane in another seat\'s worktree never ties to this seat', () => {
    expect(restoreProof(input({}, { cwd: OTHER })).kind).toBe('none');
    expect(restoreProof(input({}, { cwd: `${OTHER}/deep` })).kind).toBe('none');
  });

  test('impostor: a folder that only shares a prefix is not the worktree', () => {
    expect(restoreProof(input({}, { cwd: `${OWN}-copy` })).kind).toBe('none');
  });

  test('a pane at the team root or with no folder is refused', () => {
    expect(restoreProof(input({}, { cwd: ROOT })).kind).toBe('none');
    expect(restoreProof(input({}, { cwd: null })).kind).toBe('none');
  });

  test('a pane another seat\'s record names is refused', () => {
    expect(restoreProof(input({ worktree: evidence({ paneClaimed: true }) })).kind).toBe('none');
  });

  test('a worktree nested in another seat\'s is refused', () => {
    expect(restoreProof(input({ worktree: evidence({ others: [`${ROOT}/worktrees/floor/floor`] }) })).kind).toBe('none');
  });

  test('another CLI in the pane is refused', () => {
    expect(restoreProof(input({ foreground: ['claude'] }, { agent: 'claude' })).kind).toBe('none');
  });

  test('a pane named for another seat is refused', () => {
    expect(restoreProof(input({}, { name: 'operator-02' })).kind).toBe('none');
  });

  test('the recorded conversation itself is the plain strong proof', () => {
    const proof = restoreProof(input({}, { session: RECORDED_ID }));
    expect(proof).toMatchObject({ kind: 'session' });
    expect(proof.kind === 'session' ? proof.rebound : 'x').toBeUndefined();
  });
});

describe('paneInOwnWorktree', () => {
  test('needs all of the evidence', () => {
    expect(paneInOwnWorktree(OWN, evidence())).toBe(true);
    expect(paneInOwnWorktree(OWN, undefined)).toBe(false);
    expect(paneInOwnWorktree('', evidence())).toBe(false);
    expect(paneInOwnWorktree(OWN, evidence({ others: [OWN] }))).toBe(false);
  });
});

describe('restoreWorktreeOf', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rwt-')));
  const root = join(base, 'floor');
  mkdirSync(join(root, 'worktrees', 'a'), { recursive: true });
  mkdirSync(join(root, 'worktrees', 'b'), { recursive: true });
  const team = { seats: [
    { name: 'a', cwd: 'worktrees/a' },
    { name: 'b', cwd: 'worktrees/b' },
    { name: 'lead', cwd: '.' },
  ] } as never;

  test('names the seat\'s folder and every other seat\'s, never the shared root', () => {
    expect(restoreWorktreeOf(team, root, undefined, 'a')).toEqual({
      own: join(root, 'worktrees', 'a'),
      others: [join(root, 'worktrees', 'b')],
      paneClaimed: false,
    });
    expect(restoreWorktreeOf(team, root, undefined, 'lead')).toBeUndefined();
  });

  test('a recorded worktree wins, and another seat recorded on the pane claims it', () => {
    const held = {
      seats: { a: { pane: 'p1' }, b: { pane: 'p1' } },
      worktrees: { a: { path: 'worktrees/b', seat: 'a' } },
    } as never;
    const read = restoreWorktreeOf(team, root, held, 'a');
    expect(read?.own).toBe(join(root, 'worktrees', 'b'));
    expect(read?.paneClaimed).toBe(true);
  });
});
