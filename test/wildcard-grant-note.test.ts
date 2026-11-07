// A wildcard general grant reaches ops that ship after it was signed without a new owner
// approval. `team check` and `team doctor` print one widened note and one chain note per
// grant as information: neither is a difference or a finding that counts, and neither changes
// an exit. The release each op first shipped in is measured from the repository's tags.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { installKey } from '../src/store/keys.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, notesOtherThanSocket, testIo } from './helpers.ts';

const NOW = new Date('2026-11-02T20:00:00Z');
const EXPIRES = new Date('2027-01-01T00:00:00Z');
const KEY = join(import.meta.dir, 'fixtures', 'key.json');
const OWNER: Caller = { kind: 'owner' };

const SEAT = `  - role: orchestrator
    name: steward
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

/** One team, spelled in 0.5's words throughout, so no other note competes with the grant's. */
const TEAM = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
${SEAT}`;

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** The owner key, so a grant in this home verifies.
 *  Each scene installs it before its baseline run, so the only delta is the grant itself. */
function install(home: string): void {
  installKey(home, JSON.parse(readFileSync(KEY, 'utf8')));
}

/** One owner-signed wildcard grant in `home`, signed at `signed`. */
function grant(home: string, signed: string): { id: string } {
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'a'), pair);
  if (!written.ok) throw new Error(written.why);
  const issued = issueOwnerGeneralGrant(
    home,
    { clientId: 'a', publicKey: pair.publicKey, entities: ['*'], ops: ['*'], mayIssue: false, expires: EXPIRES },
    new Date(signed),
  );
  if (!issued.ok) throw new Error(issued.why);
  return { id: issued.grant.grant_id };
}

/** The widened note, distinct from the chain note (without the surface prefix). */
function widenedNote(id: string, day: string, ops: string): string {
  return `wildcard general grant ${id} signed ${day} now reaches ${ops}, which shipped in later releases; re-sign the grant to stop this note`;
}

/** An owner-signed root's chain shape: no parent, wildcard ops, no issuing right, and expiry. */
function chainNote(id: string): string {
  return `${id}; wildcard; may not issue; expires ${EXPIRES.toISOString()}`;
}

// ---- `team check` -------------------------------------------------------------------------

/** One clean world: the file in a git checkout, the seat recorded ready on its pane, a watch
 *  pass recent enough that the run itself is no difference, and an owner key in the home. */
function place(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-wildcard-grant-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  install(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEAM);
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: `pane${index + 1}`, workspace: `space${index + 1}` };
    });
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return { root, home };
}

function live(): Live {
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: `pane${index + 1}`,
      workspace: `space${index + 1}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `space${index + 1}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`pane${index + 1}`, CLAUDE_IDLE])),
  };
}

function check(root: string, home: string, json = false): { code: number; out: string; stdout: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', ...(json ? { json: true } : {}) }, io, {
    home,
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}`, stdout: io.out };
}

const SHIPPED = 'agents, analyse, approvals, batch, checkpoint, fallback, order, peek, setup, show, trace, waits';

describe('team check names a wildcard grant that reaches newer ops', () => {
  test('one widened note and one chain note per grant, neither a difference, exit unchanged', () => {
    const { root, home } = place();
    const before = check(root, home);
    expect(before.out).not.toContain('wildcard general grant');
    expect(before.code).toBe(0);

    const signed = grant(home, '2026-10-27T12:00:00Z');
    const after = check(root, home);
    const notes = notesOtherThanSocket(after.out);
    const widened = `note: ${widenedNote(signed.id, '2026-10-27', SHIPPED)}`;
    const chain = `note: ${chainNote(signed.id)}`;
    expect(notes.filter((line) => line.startsWith(`note: wildcard general grant ${signed.id} signed `))).toEqual([widened]);
    expect(notes.filter((line) => line.startsWith(`note: ${signed.id};`))).toEqual([chain]);
    // Both informational shapes appear once; no unrelated note is added or removed.
    expect([...notes].sort()).toEqual([...notesOtherThanSocket(before.out), chain, widened].sort());
    // A note is not a difference: the file works as it stands, and the exit stays 0.
    expect(after.out).not.toContain('difference:');
    expect(after.out).toContain('no differences');
    expect(after.code).toBe(0);
  });

  test('both note shapes appear once in the --json report and add no difference', () => {
    const { root, home } = place();
    const before = JSON.parse(check(root, home, true).stdout) as { notes: string[] };
    const signed = grant(home, '2026-10-27T12:00:00Z');
    const { code, stdout } = check(root, home, true);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { notes: string[]; differences: unknown[] };
    expect(doc.notes.filter((line) => line.startsWith(`wildcard general grant ${signed.id} signed `))).toEqual([widenedNote(signed.id, '2026-10-27', SHIPPED)]);
    expect(doc.notes.filter((line) => line.startsWith(`${signed.id};`))).toEqual([chainNote(signed.id)]);
    expect([...doc.notes].sort()).toEqual([...before.notes, chainNote(signed.id), widenedNote(signed.id, '2026-10-27', SHIPPED)].sort());
    expect(doc.differences).toEqual([]);
  });
});

// ---- `team doctor` -----------------------------------------------------------------------

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];

describe('team doctor names a wildcard grant that reaches newer ops', () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-wildcard-grant-')));
    made.push(base);
    root = join(base, 'acme-web');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    install(home);
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
  });

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

  type Report = {
    code: number;
    doc: { findings: { level: string; text: string; blocks_launch: boolean }[]; summary: Record<string, number> };
  };

  async function doctorJson(...argv: string[]): Promise<Report> {
    const io = testIo(root, OWNER);
    const code = await runDoctor([...FILE, '--json', ...argv], io, sources());
    return { code, doc: JSON.parse(io.out) as Report['doc'] };
  }

  async function doctorText(): Promise<string> {
    const io = testIo(root, OWNER);
    await runDoctor(FILE, io, sources());
    return `${io.out}${io.err}`;
  }

  test('each grant note shape appears once; counts and exit stay the same with and without it', async () => {
    const before = await doctorJson();
    const signed = grant(home, '2026-10-27T12:00:00Z');
    const after = await doctorJson();
    const text = widenedNote(signed.id, '2026-10-27', SHIPPED);
    expect(after.doc.findings.filter((finding) => finding.text.startsWith(`wildcard general grant ${signed.id} signed `))).toEqual([{ level: 'note', text, blocks_launch: false }]);
    expect(after.doc.findings.filter((finding) => finding.text.startsWith(`${signed.id};`))).toEqual([{ level: 'note', text: chainNote(signed.id), blocks_launch: false }]);
    expect(before.doc.findings.some((finding) => finding.text.includes('wildcard general grant'))).toBe(false);
    expect([...after.doc.findings].sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      ...before.doc.findings,
      { level: 'note', text: chainNote(signed.id), blocks_launch: false },
      { level: 'note', text, blocks_launch: false },
    ].sort((a, b) => a.text.localeCompare(b.text)));
    // Information, not failure: neither count moves, and the exit is the same.
    expect(after.doc.summary).toEqual(before.doc.summary);
    expect(after.code).toBe(before.code);
  });

  test('the text report prints both shapes once, and a focused report carries neither', async () => {
    const before = (await doctorText()).split('\n').filter((line) => line.startsWith('note  '));
    const signed = grant(home, '2026-10-27T12:00:00Z');
    const lines = (await doctorText()).split('\n');
    expect(lines.filter((line) => line.includes(widenedNote(signed.id, '2026-10-27', SHIPPED)))).toHaveLength(1);
    expect(lines.filter((line) => line.includes(chainNote(signed.id)))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('note  ')).sort()).toEqual([
      ...before,
      `note  ${chainNote(signed.id)}`,
      `note  ${widenedNote(signed.id, '2026-10-27', SHIPPED)}`,
    ].sort());
    const focused = await doctorJson('--login');
    expect(focused.doc.findings.some((finding) => finding.text.includes('wildcard general grant'))).toBe(false);
    expect(focused.doc.findings.some((finding) => finding.text.startsWith(`${signed.id};`))).toBe(false);
  });
});
