// The whole `watch` section is the owner's, thresholds included: a file that stretches
// `unsent_after` or `interval` has changed nothing until the owner approves it. Until then the
// watch runs with the values of the approved copy — or with the defaults when nothing was
// approved — and reports the difference (RFC 0002 § 4.2).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, budgetsInForce, watchInForce } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints, OWNER_SECTIONS } from '../src/approve/fingerprint.ts';
import { runApprove } from '../src/commands/approve.ts';
import { standingSource, runStatus, type StatusSources } from '../src/commands/status.ts';
import type { TeamFile } from '../src/file/types.ts';
import { defaultWatch, validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

/** The example with watch fields changed where a test changes them, and checks turned off. */
function source(edits: Record<string, string> = {}, off: string[] = []): string {
  let text = example;
  for (const [field, value] of Object.entries(edits)) {
    text = text.replace(new RegExp(`^(  ${field}: ).*$`, 'm'), `$1${value}`);
  }
  if (off.length) {
    text = text.replace(/^(  unsent_after: .*)$/m, `$1\n  checks:\n${off.map((name) => `    ${name}: off`).join('\n')}`);
  }
  return text;
}

function teamFile(edits: Record<string, string> = {}, off: string[] = []): TeamFile {
  const result = validateTeamFile(source(edits, off));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

describe('the watch section, owner-only', () => {
  test('its thresholds need a new approval, and its checks keep the finer line inside it', () => {
    expect(OWNER_SECTIONS).toContain('watch');
    const before = fingerprints(teamFile());
    const stretched = fingerprints(teamFile({ unsent_after: '30m', interval: '60s' }));
    expect(stretched.sections['watch']).not.toBe(before.sections['watch']);
    expect(compare(before, stretched).map(describeDifference)).toEqual(['`watch` changed']);
    // A file that only turns a check off is not a threshold change: the section's digest leaves
    // the checks out, so their own line is the one that reads — and both together read as both.
    const off = fingerprints(teamFile({}, ['disk']));
    expect(off.sections['watch']).toBe(before.sections['watch']);
    expect(compare(before, off).map(describeDifference)).toEqual(['`watch.checks` changed']);
    expect(compare(before, fingerprints(teamFile({ unsent_after: '30m' }, ['disk']))).map(describeDifference))
      .toEqual(['`watch` changed', '`watch.checks` changed']);
  });
});

describe('a threshold edit, and the approval', () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-owner-')));
    root = join(base, 'acme-web');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const write = (text: string) => writeFileSync(join(root, '.agents/team.yaml'), text);

  async function approve() {
    const io = testIo(root, { kind: 'owner' });
    const code = await runApprove(['--file', '.agents/team.yaml'], io, {
      ask: async () => String(teamFile().seats.length),
      waiting: () => 'empty',
      now: () => new Date('2026-10-04T00:00:00Z'),
      home,
    });
    return { code, err: io.err };
  }

  test('an edit to a threshold is drift, and the approved values stay in force', async () => {
    write(source());
    expect((await approve()).code).toBe(0);
    write(source({ unsent_after: '30m', interval: '60s' }));
    const edited = teamFile({ unsent_after: '30m', interval: '60s' });
    expect(approvalDifferences(edited, root, home)).toEqual(['`watch` changed']);
    const inForce = watchInForce(edited, root, home);
    expect(inForce.unsentAfter).toBe(60);
    expect(inForce.interval).toBe(120);
    // What the file says now is not what runs: the stretched values wait for the owner.
    expect(edited.watch.unsentAfter).toBe(30 * 60);
    expect(edited.watch.interval).toBe(60);
  });

  test('approving the edit puts the new values in force', async () => {
    write(source());
    expect((await approve()).code).toBe(0);
    write(source({ unsent_after: '30m', interval: '60s' }));
    expect((await approve()).code).toBe(0);
    const edited = teamFile({ unsent_after: '30m', interval: '60s' });
    expect(approvalDifferences(edited, root, home)).toEqual([]);
    expect(watchInForce(edited, root, home).unsentAfter).toBe(30 * 60);
    expect(watchInForce(edited, root, home).interval).toBe(60);
  });

  test('a file never approved runs with the defaults, whatever it sets', async () => {
    write(source({ unsent_after: '30m', interval: '60s' }));
    const file = teamFile({ unsent_after: '30m', interval: '60s' });
    expect(approvalDifferences(file, root, home)).toBeNull();
    expect(watchInForce(file, root, home)).toEqual(defaultWatch());
  });

  test('an unapproved interval edit leaves the staleness verdict on the approved value', async () => {
    write(source());
    expect((await approve()).code).toBe(0);
    const NOW = new Date('2026-10-04T00:00:00Z');
    const state = (heartbeat: Date) =>
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: { 'acme-web': { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat: heartbeat.toISOString() } } },
        }),
      );
    const live: Live = {
      running: true,
      agents: [{ name: 'claude-coordinator-acme', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
      workspaces: [{ id: 'w1', label: 'claude-coordinator-acme' }],
      screens: {},
    };
    const sources: StatusSources = {
      live: () => live,
      branch: () => 'main',
      standing: standingSource(home),
      now: () => NOW,
      home,
    };
    const status = async () => {
      const io = testIo(root, { kind: 'owner' });
      await runStatus(['--file', '.agents/team.yaml'], io, sources);
      return io.out;
    };
    // A stretch to a thousand hours is unapproved, so the approved two minutes still decide:
    // the ten-minute-old heartbeat is stale, not hidden by the edit.
    write(source({ interval: '1000h' }));
    state(new Date(NOW.getTime() - 10 * 60_000));
    expect(await status()).toContain("the watch's last pass was 10 minute(s) ago");
    // And a shrink is no better: three minutes are inside the approved two intervals, whoever
    // wrote ten seconds in the file.
    write(source({ interval: '10s' }));
    state(new Date(NOW.getTime() - 3 * 60_000));
    expect(await status()).not.toContain("last pass");
  });

  test('an approval recorded before the section existed stays valid while the section is unchanged', async () => {
    write(source());
    const current = teamFile();
    const stored = fingerprints(current);
    const sections = { ...stored.sections };
    // What a record written before the section existed holds: no fingerprint for `watch`, and
    // none for `watch.checks`, which arrived with it.
    delete sections['watch'];
    delete sections['watch.checks'];
    writeApproval(storePath(current.project, root, home), {
      approval: {
        format: 2,
        approvedAt: '2026-10-01T00:00:00.000Z',
        root,
        fingerprints: { sections, seats: stored.seats },
        ceilings: { seats: current.limits.seats, temporary: current.limits.temporary, vendors: {} },
      },
      file: readFileSync(join(root, '.agents/team.yaml'), 'utf8'),
    }, [], home);
    expect(approvalDifferences(current, root, home)).toEqual([]);
    expect(watchInForce(current, root, home).unsentAfter).toBe(60);
    // An edit to the section is a difference again, and the copy's values go on running.
    write(source({ unsent_after: '30m' }));
    const edited = teamFile({ unsent_after: '30m' });
    expect(approvalDifferences(edited, root, home)).toEqual(['`watch` changed']);
    expect(watchInForce(edited, root, home).unsentAfter).toBe(60);
  });
});
