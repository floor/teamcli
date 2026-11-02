// A wildcard general grant reaches ops that ship after it was signed without a new owner
// approval. `team check` and `team doctor` name each such grant once, in plain words, as
// information: the note is never a difference, never a finding that counts, and never changes an
// exit. The release each op first shipped in is measured from the repository's tags.
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

const NOW = new Date('2026-11-01T20:00:00Z');
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

/** The note one grant draws, spelled the way both surfaces print it (without their prefix). */
function note(id: string, day: string, ops: string): string {
  return `wildcard general grant ${id} signed ${day} now reaches ${ops}, which shipped in later releases; re-sign the grant to stop this note`;
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

const SHIPPED = 'agents, approvals, batch, forget, setup';

describe('team check names a wildcard grant that reaches newer ops', () => {
  test('one note per grant, not a difference, exit unchanged', () => {
    const { root, home } = place();
    const before = check(root, home);
    expect(before.out).not.toContain('wildcard general grant');
    expect(before.code).toBe(0);

    const signed = grant(home, '2026-10-27T12:00:00Z');
    const after = check(root, home);
    expect(after.out).toContain(`note: ${note(signed.id, '2026-10-27', SHIPPED)}`);
    // Exactly one more note than the same world draws without the grant.
    expect(notesOtherThanSocket(after.out).length).toBe(notesOtherThanSocket(before.out).length + 1);
    // A note is not a difference: the file works as it stands, and the exit stays 0.
    expect(after.out).not.toContain('difference:');
    expect(after.out).toContain('no differences');
    expect(after.code).toBe(0);
  });

  test('the note carries in the --json report and adds no difference', () => {
    const { root, home } = place();
    const signed = grant(home, '2026-10-27T12:00:00Z');
    const { code, stdout } = check(root, home, true);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(note(signed.id, '2026-10-27', SHIPPED));
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

  test('the grant is one note finding; the counts and the exit are the same with and without it', async () => {
    const before = await doctorJson();
    const signed = grant(home, '2026-10-27T12:00:00Z');
    const after = await doctorJson();
    const text = note(signed.id, '2026-10-27', SHIPPED);
    expect(after.doc.findings.filter((finding) => finding.text === text)).toEqual([{ level: 'note', text, blocks_launch: false }]);
    expect(before.doc.findings.some((finding) => finding.text.includes('wildcard general grant'))).toBe(false);
    // Information, not failure: neither count moves, and the exit is the same.
    expect(after.doc.summary).toEqual(before.doc.summary);
    expect(after.code).toBe(before.code);
  });

  test('the text report prints the note line, and a focused report does not carry it', async () => {
    const signed = grant(home, '2026-10-27T12:00:00Z');
    expect(await doctorText()).toContain(note(signed.id, '2026-10-27', SHIPPED));
    const focused = await doctorJson('--login');
    expect(focused.doc.findings.some((finding) => finding.text.includes('wildcard general grant'))).toBe(false);
  });
});
