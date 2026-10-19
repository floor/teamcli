// Independent fixtures for `team usage` at the head that tells a file it cannot read from one
// that does not load: a missing file, a directory where the file would be, and a file whose read
// fails (EACCES) are notes with exit 0, while an invocation error and a store folder that cannot
// be read stay the two exit-2 refusals. The scene, project, seat, timestamps and assertions are
// independent of the author test; everything runs in a throwaway temp tree with a throwaway
// home, and no real store, checkout or credential is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { NO_PROJECT, runUsage, USAGE } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T05:00:00Z');
const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'h1:p1', session: 'harbor-night' };
const OWNER: Caller = { kind: 'owner' };

const READ_SUFFIX = 'cannot be read: the owner reads the reason';
const LOAD_SUFFIX = 'does not load';

let base: string;
let root: string;
let home: string;
let file: string;

/** The team file: a project of its own, its session, the lobby and the checkout in trust. */
function teamText(): string {
  return `format: 1
project: harbor
session: harbor-night
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function resetTeamFile(): void {
  rmSync(file, { recursive: true, force: true });
  writeFileSync(file, teamText());
}

/** The store's record for this project: what `team approve` leaves before the file disappears. */
function approve(): void {
  const text = teamText();
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath('harbor', root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);
}

async function usageAt(cwd: string, caller: Caller, ...argv: string[]) {
  const io = testIo(cwd, caller);
  const code = await runUsage(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

/** No path this machine derived — the fixture root, home, store or team file — in a seat's face. */
function expectNoDerivedPath(...faces: string[]): void {
  const derived = [base, root, home, storePath('harbor', root, home), file, join(root, '.agents', 'team.state.json')];
  for (const face of faces) {
    for (const path of derived) expect(face).not.toContain(path);
    expect(face.match(/(?:^|[\s"'()[\]=:,])\/[^\s"',;)\]]+/g) ?? []).toEqual([]);
  }
}

function notesOf(raw: string): { scope: string; why: string }[] {
  return (JSON.parse(raw) as { notes: { scope: string; why: string }[] }).notes;
}

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// The scene: a checkout with the team file, a home with the lobby folder, and a seat caller handed
// in so the view never depends on the process tree this suite runs from.
function scene(): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'harbor-usage-')));
  home = join(base, 'home');
  root = join(base, 'harbor');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env: gitEnv(), stdio: 'ignore' });
  file = join(root, '.agents', 'team.yaml');
  resetTeamFile();
}

describe('usage independent: a team file that is not there is a note, never a refusal', () => {
  test('a checkout with no team file answers NO_PROJECT with exit 0 in both faces', async () => {
    scene();
    rmSync(file);

    const text = await usageAt(root, SEAT);
    expect(text.code).toBe(0);
    expect(text.err).toBe('');
    expect(text.out).toContain(`note: ${NO_PROJECT}\n`);
    expect(text.out).not.toContain(READ_SUFFIX);
    expect(text.out).not.toContain(LOAD_SUFFIX);

    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { view: string; mine: string | null; notes: unknown[] };
    expect(doc.view).toBe('restricted');
    expect(doc.mine).toBeNull();
    expect(doc.notes).toEqual([{ scope: 'mine', why: NO_PROJECT }]);
    expectNoDerivedPath(text.out, raw);
  });

  test('a team the store records, whose file is gone, prints by its recorded name', async () => {
    scene();
    approve();
    rmSync(file);

    const seat = await usageAt(root, SEAT);
    expect(seat.code).toBe(0);
    expect(seat.err).toBe('');
    // The caller's own resolution is a plain missing file; the machine's own record still names
    // the team and says its file could not be read. Neither line is a refusal.
    expect(seat.out).toContain(`note: ${NO_PROJECT}\n`);
    expect(seat.out).toContain('note: harbor: its file could not be read\n');
    expect(seat.out).not.toContain(READ_SUFFIX);
    expectNoDerivedPath(seat.out);

    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.err).toBe('');
    expect(owner.out).toContain('the team "harbor"');
    expect(owner.out).toContain('its file could not be read');
  });
});

describe('usage independent: a file that cannot be read is the read class, not the load class', () => {
  test('a directory where the team file would be: owner reads the loader sentence, a seat a fixed one', async () => {
    scene();
    rmSync(file);
    mkdirSync(file);

    const seatText = await usageAt(root, SEAT);
    expect(seatText.code).toBe(0);
    expect(seatText.err).toBe('');
    expect(seatText.out).toContain(`note: .agents/team.yaml ${READ_SUFFIX}\n`);
    // The read failed before any text existed, so the parse/placement sentence must not stand.
    expect(seatText.out).not.toContain(LOAD_SUFFIX);
    expect(seatText.out).not.toContain(NO_PROJECT);
    expectNoDerivedPath(seatText.out);

    const seatJson = await usageAt(root, SEAT, '--json');
    expect(seatJson.code).toBe(0);
    expect(notesOf(seatJson.out)).toEqual([{ scope: 'mine', why: `.agents/team.yaml ${READ_SUFFIX}` }]);
    expectNoDerivedPath(seatJson.out);

    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.err).toBe('');
    expect(owner.out).toContain(`note: the team file at ${file} could not be read\n`);
    expect(owner.out).not.toContain(`.agents/team.yaml ${READ_SUFFIX}`);
  });

  test('a file that is text but does not load keeps the load sentence for a seat', async () => {
    scene();
    writeFileSync(file, 'format: 1\nproject: harbor\n');

    const seat = await usageAt(root, SEAT);
    expect(seat.code).toBe(0);
    expect(seat.err).toBe('');
    expect(seat.out).toContain(`note: .agents/team.yaml ${LOAD_SUFFIX} (line 1): the owner reads the reason\n`);
    expect(seat.out).not.toContain(READ_SUFFIX);
    expect(seat.out).not.toContain(NO_PROJECT);
    expectNoDerivedPath(seat.out);

    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(notesOf(raw)).toEqual([{ scope: 'mine', why: `.agents/team.yaml ${LOAD_SUFFIX} (line 1): the owner reads the reason` }]);
  });
});

describe('usage independent: the two refusals stay exit 2', () => {
  test('an unknown option is usage.invocation, in text and in --json', async () => {
    scene();
    const text = await usageAt(root, SEAT, '--bogus');
    expect(text.code).toBe(2);
    expect(text.out).toBe('');
    expect(text.err).toBe(`team usage: unknown option --bogus\n${USAGE}`);
    expect(text.err).not.toContain(READ_SUFFIX);

    const raw = await usageAt(root, SEAT, '--bogus', '--json');
    expect(raw.code).toBe(2);
    expect(raw.err).toBe('');
    expect(JSON.parse(raw.out)).toEqual({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'usage.invocation', message: 'unknown option --bogus', repair: null },
    });
  });

  test('a store folder that cannot be read is usage.store: exit 2, reason to the owner only', async () => {
    scene();
    rmSync(join(home, '.config', 'team'), { recursive: true, force: true });
    writeFileSync(join(home, '.config', 'team'), 'not a folder\n');

    const seatText = await usageAt(root, SEAT);
    expect(seatText.code).toBe(2);
    expect(seatText.out).toBe('');
    expect(seatText.err).toBe('team usage: the store folder cannot be read: the owner reads the reason\n');
    expectNoDerivedPath(seatText.err);

    const seatJson = await usageAt(root, SEAT, '--json');
    expect(seatJson.code).toBe(2);
    expect(seatJson.err).toBe('');
    expect(JSON.parse(seatJson.out)).toEqual({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'usage.store', message: 'the store folder cannot be read: the owner reads the reason', repair: null },
    });

    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(2);
    expect(owner.out).toBe('');
    expect(owner.err).toContain(`the store folder ${join(home, '.config', 'team')} could not be read`);
  });
});
