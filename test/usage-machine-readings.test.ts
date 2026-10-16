import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runUsage } from '../src/commands/usage.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { payingPoolOf } from '../src/information/machine-accounts.ts';
import { machineReadingsPath, readMachineReadings, saveMachineReadings } from '../src/information/machine-readings.ts';
import { machineUsage, reportOf, reportText } from '../src/information/usage.ts';
import { figuresOf } from '../src/profiles/quota.ts';
import { quotaFor } from '../src/profiles/profile.ts';
import { statusRow } from '../src/watch/screen.ts';
import { testIo } from './helpers.ts';
import { approvalOf } from '../src/approve/approval.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval } from '../src/store/store.ts';

const NOW = Date.parse('2026-10-16T10:00:00Z');
let home: string;
let root: string;
const grok = `${readFileSync(new URL('./fixtures/grok/1.0.50/idle.txt', import.meta.url), 'utf8')}\n  Weekly limit left: 0% · Grok Build 1.0.60 [stable]\n`;
const zero = { account: 'xai', window: 'weekly' as const, left: 0, used: 100, resets: null };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'team-usage-home-')));
  root = join(home, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'accounts.yaml'), 'accounts:\n  - xai\n  - google-antigravity\n');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: fixture
session: fixture
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
    cli: grok
    vendor: wrong-vendor
    model: Grok
    version: "4.7"
    launch: grok --always-approve
`);
});
afterEach(() => { if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [home]); });

function sources(): WatchSources {
  return {
    home,
    live: () => ({ running: true, workspaces: [{ id: 'fixture-workspace', label: 'lead' }],
      agents: [{ name: 'lead', agent: 'grok', pane: 'fixture-pane', workspace: 'fixture-workspace', status: 'idle', cwd: null }],
      screens: { 'fixture-pane': grok } }),
    machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
    standing: () => ({ kind: 'none' }), readChecks: () => [], screen: () => grok,
    status: () => 'idle', foreground: () => ['grok'], typeText: () => false, pressEnter: () => false,
    sleep: async () => {}, notify: () => {}, now: () => new Date(NOW), wait: async () => false,
    alive: () => false, pid: 4242,
  };
}

test('a watch persists a Grok zero without team budgets; usage counts machine subscriptions', async () => {
  const io = testIo(root, { kind: 'owner' });
  const code = await runWatch(['--file', '.agents/team.yaml', '--no-nudge', '--no-notify'], io, sources());
  expect(code, io.err).toBe(0);
  expect(readMachineReadings(home)).toEqual([{ ...zero, resets: undefined, observedAt: NOW, resetsAt: null }].map(({ resets, ...one }) => one));
  const usage = testIo(root, { kind: 'owner' });
  expect(await runUsage([], usage, { home, now: () => new Date(NOW + 120000) })).toBe(0);
  expect(usage.out).toContain('2 accounts');
  expect(usage.out).toContain('xai  weekly  left 0%  used 100%  resets unknown');
  expect(usage.out).toContain('2m ago');
  expect(usage.out).toContain('google-antigravity  not readable from a CLI screen');
  expect(usage.out).toContain('lead  grok  xai');
  // The seat's own vendor forms a lab with no account under it, and says so; the machine's
  // readings are counted, so the "nothing is counted" sentence never prints.
  expect(usage.out).toContain('wrong-vendor  not known (no team declares an account for it yet)');
  expect(usage.out).not.toContain('nothing is counted');
});

test('machine subscriptions and a persisted reading remain visible outside any team', () => {
  saveMachineReadings(home, figuresOf(quotaFor('grok'), statusRow('grok', grok)), NOW);
  const view = { full: false, mine: null };
  const machine = machineUsage(home, NOW, view);
  expect(machine.counts).toEqual({ teams: 0, labs: 2, accounts: 2 });
  const report = reportOf(machine, view, NOW, []);
  expect(report.teams).toEqual([]);
  expect(reportText(report)).toContain('xai  weekly  left 0%');
});

test('the entity form of the machine list counts the same figures, the zero among them', () => {
  // The map keyed by entity is the same file the flat list is: the accounts it gives each entity
  // are still the machine's own, counted for every team and readable outside any project, and a
  // recorded zero is a figure, not an absence.
  writeFileSync(join(home, '.config', 'team', 'accounts.yaml'), 'accounts:\n  northwind: [xai, google-antigravity]\n');
  saveMachineReadings(home, figuresOf(quotaFor('grok'), statusRow('grok', grok)), NOW);
  const view = { full: false, mine: null };
  const machine = machineUsage(home, NOW, view);
  expect(machine.machineAccounts).toEqual(['google-antigravity', 'xai']);
  expect(machine.counts).toEqual({ teams: 0, labs: 2, accounts: 2 });
  const text = reportText(reportOf(machine, view, NOW, []));
  expect(text).toContain('xai  weekly  left 0%  used 100%  resets unknown');
  expect(text).toContain('google-antigravity  not readable from a CLI screen');
  expect(text).not.toContain('nothing is counted');
});

test('machine updates merge accounts and pools, reject older updates, and refresh observation age', () => {
  saveMachineReadings(home, [zero, { ...zero, account: 'google-antigravity', pool: 'gemini', left: 10, used: 90 }], NOW);
  saveMachineReadings(home, [{ ...zero, account: 'google-antigravity', pool: 'claude-gpt', left: 80, used: 20, resets: '1h' }], NOW + 1000);
  saveMachineReadings(home, [{ ...zero, left: 60, used: 40 }], NOW - 1000);
  saveMachineReadings(home, [zero], NOW + 60000);
  const readings = readMachineReadings(home);
  expect(readings).toHaveLength(3);
  expect(readings.find((one) => one.account === 'xai')).toMatchObject({ left: 0, observedAt: NOW + 60000 });
  expect(readings.find((one) => one.pool === 'claude-gpt')?.resetsAt).toBe(NOW + 3601000);
  const view = { full: true, mine: null };
  const text = reportText(reportOf(machineUsage(home, NOW + 60000, view), view, NOW + 60000, []));
  expect(text).toContain('google-antigravity (gemini)  weekly  left 10%');
  expect(text).toContain('google-antigravity (claude-gpt)  weekly  left 80%');
  expect(payingPoolOf({ cli: 'agy', launch: 'agy', vendor: 'anthropic', model: 'Gemini 3.1' })).toBe('gemini');
  expect(payingPoolOf({ cli: 'antigravity', launch: 'agy', vendor: 'google', model: 'Claude Opus' })).toBe('claude-gpt');
});

test('malformed machine readings cannot break the report or introduce fields', () => {
  saveMachineReadings(home, [zero], NOW);
  writeFileSync(machineReadingsPath(home), JSON.stringify([{ account: 'xai', window: 'weekly', left: 1000, used: -900, observedAt: NOW, resetsAt: null }]));
  expect(readMachineReadings(home)).toEqual([]);
});

test('an approved team account overrides a machine subscription of the same name', async () => {
  const path = join(root, '.agents', 'team.yaml');
  const text = readFileSync(path, 'utf8') + '\nbudgets:\n  accounts:\n    xai: { kind: spend, floor: 5 USD, sources: [check], check: .agents/balance }\n';
  writeFileSync(path, text);
  const loaded = validateTeamFile(text, { home, root });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath('fixture', root, home), { approval: approvalOf(loaded.team, root, new Date(NOW)), file: text }, [], home);
  saveMachineReadings(home, [zero], NOW);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUsage(['--json'], io, { home, now: () => new Date(NOW) })).toBe(0);
  const report = JSON.parse(io.out);
  const entries = report.labs.flatMap((lab: { accounts: { account: string; kind: string }[] }) => lab.accounts);
  expect(entries.filter((one: { account: string }) => one.account === 'xai').map((one: { kind: string }) => one.kind)).toEqual(['spend']);
});

test("a machine subscription in another team's lab prints under its own name, never that team's vendor", () => {
  // A custom account's lab is the vendor of the seat drawing on it in the team that declares it —
  // here a path, the rawest metadata a team's file can put in a lab. The account is in the
  // machine's own list, so a caller outside every project reads its machine subscription. That row
  // is the caller's to read; the other team's lab name is not, and the printed lab is the
  // account's own, the machine-owned name a subscription prints under with no team at all.
  const text = `format: 1
project: fixture
session: fixture
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    shared:
      kind: subscription
      reserve: 20%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: gemini
    account: shared
    vendor: /synthetic/private-project
    model: Gemini
    version: "3.1"
    launch: gemini --yolo
`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = validateTeamFile(text, { home, root });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath('fixture', root, home), { approval: approvalOf(loaded.team, root, new Date(NOW)), file: text }, [], home);
  writeFileSync(join(home, '.config', 'team', 'accounts.yaml'), 'accounts:\n  - shared\n');

  const view = { full: false, mine: null };
  const machine = machineUsage(home, NOW, view);
  const report = reportOf(machine, view, NOW, []);
  expect(report.mine).toBeNull();
  expect(report.labs.map((lab) => lab.lab)).toEqual(['shared']);
  expect(report.labs.flatMap((lab) => lab.accounts.map((one) => one.account))).toEqual(['shared']);
  expect(JSON.stringify(report)).not.toContain('/synthetic/private-project');
  expect(reportText(report)).not.toContain('/synthetic/private-project');
  // The full view is not this rule's business: the owner reads the lab the team's own file gives.
  const full = { full: true, mine: null };
  expect(reportOf(machineUsage(home, NOW, full), full, NOW, []).labs.map((lab) => lab.lab)).toEqual(['/synthetic/private-project']);
});
