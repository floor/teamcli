// Independent check of the lead pinned in a signed approval (src/approve/approval.ts,
// src/store/store.ts). Homes, checkouts and keys are the test's own. No live key store is read.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalDifferences, approvalOf, approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { devModeFileApproval, devModeState } from '../src/dev_mode.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const made: string[] = [];

afterEach(() => {
  const parent = made[0] !== undefined ? dirname(made[0]) : undefined;
  discardFixtures(made.splice(0), parent === undefined ? {} : { roots: [parent] });
});

function seat(name: string, mark = false): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${mark ? '    leads: true\n' : ''}`;
}

function teamText(home: string, root: string, marks: { lead?: boolean; worker?: boolean } = {}): string {
  return `format: 1
project: fixture
session: acme
operator: worker
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', marks.lead === true)}${seat('worker', marks.worker === true)}`;
}

type World = { home: string; root: string; base: string };

function world(marks: { lead?: boolean; worker?: boolean } = {}): World {
  const base = fixtureBase('lead-pin-');
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'checkout');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(home, root, marks));
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  return { home, root, base };
}

function projectLead(at: World, word: string): void {
  const prov = '{ registered_by: owner, registered_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" }';
  writeFileSync(projectsFile(at.home), [
    'projects:',
    '  fixture:',
    '    name: Fixture',
    '    entity: fixture',
    '    lead: null',
    `    teams: [${teamIdOf(at.root)}]`,
    `    lead_seat: ${word}`,
    `    provenance: ${prov}`,
    '',
  ].join('\n'));
}

function load(at: World) {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  return loaded;
}

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

function recordFile(store: string): string {
  return join(store, 'approval.json');
}

test('a team file edited to name another lead keeps the signed lead', () => {
  const at = world();
  projectLead(at, 'lead');
  const store = approve(at);
  expect(readApproval(store)?.approval.lead).toBe('lead');

  const path = join(at.root, '.agents', 'team.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('name: worker\n', 'name: worker\n    leads: true\n'));
  const live = load(at);
  expect(live.team.orchestrator).toBe('worker');
  const standing = approvalStanding(at.root, at.home);
  expect(standing.kind).toBe('verified');
  if (standing.kind !== 'verified') return;
  expect(standing.record.approval.lead).toBe('lead');
  expect(approvalDifferences(live.team, live.root, at.home)).toContain('`orchestrator` changed');

  const rewritten = JSON.parse(readFileSync(recordFile(store), 'utf8')) as { file: string; lead: string };
  rewritten.file = readFileSync(path, 'utf8');
  writeFileSync(recordFile(store), `${JSON.stringify(rewritten, null, 2)}\n`);
  expect(approvalStanding(at.root, at.home).kind).toBe('refused');
});

test('a pin naming a missing seat is refused', () => {
  const at = world();
  projectLead(at, 'lead');
  const text = readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8');
  const pinned = validateTeamFile(text, { home: at.home, root: at.root, lead: 'ghost' });
  expect(pinned.ok).toBe(false);
  if (!pinned.ok) expect(pinned.errors.map((error) => error.message).join('\n')).toContain('names no declared seat');

  const store = approve(at);
  const record = JSON.parse(readFileSync(recordFile(store), 'utf8')) as { lead: string };
  record.lead = 'ghost';
  writeFileSync(recordFile(store), `${JSON.stringify(record, null, 2)}\n`);
  expect(approvalStanding(at.root, at.home).kind).toBe('refused');
});

test('two leads are refused', () => {
  const at = world({ lead: true, worker: true });
  const text = readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8');
  const parsed = validateTeamFile(text, { home: at.home, root: at.root });
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.errors.map((error) => error.message).join('\n')).toContain('one lead');
  expect(approvalStanding(at.root, at.home).kind).not.toBe('verified');
});

test('the same file under another home or root keeps the pin or refuses', () => {
  const at = world();
  projectLead(at, 'lead');
  const store = approve(at);
  const record = readApproval(store);
  if (record === null) throw new Error('the record must be there');
  const pinned = approvedFingerprints(record, at.home).sections.orchestrator;

  const other = world();
  projectLead(other, 'worker');
  const moved = approvedFingerprints(record, other.home).sections.orchestrator;
  expect(moved).toBe(pinned);
  const chain = load(other);
  expect(chain.team.orchestrator).toBe('worker');
  expect(approvedFingerprints(record, other.home).sections.orchestrator).not.toBe(fingerprints(chain.team).sections.orchestrator);

  const elsewhere = join(at.base, 'other-root');
  mkdirSync(elsewhere);
  expect(approvalStanding(elsewhere, at.home).kind).not.toBe('verified');
  const text = readFileSync(join(at.root, '.agents', 'team.yaml'), 'utf8');
  const reread = validateTeamFile(text, { home: at.home, root: elsewhere, lead: 'lead' });
  if (reread.ok) expect(reread.team.orchestrator).toBe('lead');
});

test('an unsigned record is refused in normal mode and in dev mode', () => {
  const at = world();
  projectLead(at, 'lead');
  const store = approve(at);
  const record = JSON.parse(readFileSync(recordFile(store), 'utf8')) as { lead: string; signature?: string };
  delete record.signature;
  record.lead = 'worker';
  writeFileSync(recordFile(store), `${JSON.stringify(record, null, 2)}\n`);

  const off = devModeState({ env: {} }, { home: at.home });
  const on = devModeState({ env: { TEAMCLI_DEV_MODE: '1' } }, { home: at.home });
  expect(off.on).toBe(false);
  expect(on.on).toBe(true);
  expect(approvalStanding(at.root, at.home).kind).toBe('refused');
  expect(devModeFileApproval(off, 'the record is unsigned', join(at.root, '.agents', 'team.yaml'))).toBeNull();
  const folded = devModeFileApproval(on, 'the record is unsigned', join(at.root, '.agents', 'team.yaml'));
  expect(folded).not.toBeNull();
  expect(approvalStanding(at.root, at.home).kind).toBe('refused');
});
