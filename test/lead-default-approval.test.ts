// An approval of a team whose lead comes from the default chain. The record signs the lead it
// approved (`approval.lead`), and the stored copy verifies without reading the chain again: an
// edit to the external default shows as section drift, never as a broken signature. The stored
// copy's fingerprints are read with the same home and root it was approved under, so a record
// written before a section still gets that section's omitted baseline backfilled.
// Every scene is synthetic: homes, checkouts and registries are the test's own.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf, approvedFingerprints, recordSeatRenameOf } from '../src/approve/approval.ts';
import { compare, describe, fingerprints } from '../src/approve/fingerprint.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type World = { home: string; root: string };

/** One seat's stanza, as the file writes it. */
function seat(name: string, extra = ''): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;
}

/** The team file: no seat marked unless asked, so the lead comes from the chain. */
function teamText(root: string, options: { mark?: boolean } = {}): string {
  return `format: 1
project: acme
session: acme
operator: worker
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', options.mark === true ? '    leads: true\n' : '')}${seat('worker')}`;
}

/** A machine: a home, and a checkout that is a project root with its team file. */
function world(options: { mark?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lead-approval-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root, options));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { home, root };
}

/** The project's word: its registry record names the team and carries `lead_seat`. */
function projectLead(at: World, word: string): void {
  const prov = '{ registered_by: owner, registered_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" }';
  const text = [
    'projects:',
    '  acme:',
    '    name: Acme',
    '    entity: floor',
    '    lead: null',
    `    teams: [${teamIdOf(at.root)}]`,
    `    lead_seat: ${word}`,
    `    provenance: ${prov}`,
    '',
  ].join('\n');
  writeFileSync(projectsFile(at.home), text);
}

function load(at: World): ReturnType<typeof loadTeamFile> & { ok: true } {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  return loaded;
}

/** The owner's approval, written the way `team approve` writes one. */
function approve(at: World): string {
  const loaded = load(at);
  const store = storePath(loaded.team.project, loaded.root, at.home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8') },
    loaded.team.seats,
    at.home,
    NOW,
  );
  return store;
}

test('a chain edit is section drift, and the signature still verifies', () => {
  const at = world();
  projectLead(at, 'lead');
  approve(at);
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');

  // The owner edits the home project's default lead. The stored approval was signed over the
  // lead it approved, so it still verifies; the move is the live file's difference to report.
  projectLead(at, 'worker');
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');

  const live = load(at);
  expect(live.team.orchestrator).toBe('worker');
  expect(approvalDifferences(live.team, live.root, at.home)).toContain('`orchestrator` changed');
});

test('removing the chain does not break the stored approval', () => {
  const at = world();
  projectLead(at, 'lead');
  approve(at);
  rmSync(projectsFile(at.home));
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');
});

test('a stored copy is read with the home, so an omitted section gets its baseline', () => {
  const at = world();
  projectLead(at, 'lead');
  const loaded = load(at);
  const approval = approvalOf(loaded.team, loaded.root, NOW);
  // A record written before `grant` joined the owner sections: no fingerprint for it.
  const sections = { ...approval.fingerprints.sections };
  delete sections.grant;
  const store = storePath(loaded.team.project, loaded.root, at.home);
  writeApproval(
    store,
    {
      approval: { ...approval, fingerprints: { sections, seats: approval.fingerprints.seats } },
      file: readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8'),
    },
    loaded.team.seats,
    at.home,
    NOW,
  );

  const record = readApproval(store);
  if (record === null) throw new Error('the record must be there');
  const approved = approvedFingerprints(record, at.home);
  expect(approved.sections.grant).toBe(fingerprints({ ...loaded.team, grant: null }).sections.grant);
  expect(compare(approved, fingerprints(loaded.team), loaded.team).map(describe)).toEqual([]);
});

test('renaming the lead seat carries the approved lead and keeps the record verifying', () => {
  const at = world({ mark: true });
  const store = approve(at);
  const path = join(at.root, '.agents', 'team.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('name: lead', 'name: lead2'));
  const live = load(at);
  expect(live.team.orchestrator).toBe('lead2');

  const standing = approvalStanding(at.root, at.home);
  if (standing.kind !== 'verified') throw new Error('the approval must verify before the rename');
  recordSeatRenameOf(standing, live.team, live.root, [{ from: 'lead', to: 'lead2' }], at.home);

  expect(approvalStanding(at.root, at.home).kind).toBe('verified');
  expect(readApproval(store)?.approval.lead).toBe('lead2');
  expect(approvalDifferences(live.team, live.root, at.home)).toEqual([]);
});
