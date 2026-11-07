// Independent verification of `team usage` on a synthetic home. The registry, the machine
// reading file, a seat pane and a CLI usage print are fixtures. The report, the pace and the
// screen parser run for real. No live host, CLI, credential store or session file is opened.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runUsage } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { sourceText } from '../src/budgets/table.ts';
import { machineReadingsPath } from '../src/information/machine-readings.ts';
import { observeQuota } from '../src/information/quota-observe.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-04T09:00:00.000Z');
const HOUR = 3_600_000;
const OWNER: Caller = { kind: 'owner' };
const PANE = 'fixture-pane-one';
const FROM_BAR = sourceText('status line');
const FROM_CLI = sourceText('cli usage');
const ESTIMATED = sourceText('state record');

const SCREEN = [
  '❯',
  '─'.repeat(40),
  '  main · fixture · Opus 5.5 · S: $1.2 · L: 40% (3h) · W: 96% (9h)',
  '  ⏵⏵ bypass permissions on',
].join('\n');

let bases: string[] = [];
let scratch = '';

afterEach(() => {
  if (bases.length > 0) discardFixtures(bases, { roots: scratch === '' ? [] : [scratch] });
  bases = [];
});

type World = { root: string; home: string; dir: string };

function world(textFor: (root: string) => string): World {
  const base = fixtureBase('usage-');
  bases.push(base);
  scratch = dirname(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  const text = textFor(root);
  writeFileSync(join(dir, 'team.yaml'), text);
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath(checked.team.project, root, home), {
    approval: approvalOf(checked.team, root, NOW),
    file: text,
  }, [], home);
  return { root, home, dir };
}

function teamText(root: string, extraAccounts = '', extraSeats = ''): string {
  return `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [status_line]
    anthropic:
      kind: subscription
      reserve: 10%
${extraAccounts}seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Fixture
    version: "1"
    launch: claude
${extraSeats}`;
}

async function usage(made: World, argv: string[] = [], observe?: NonNullable<Parameters<typeof runUsage>[2]['observe']>) {
  const io = testIo(made.root, OWNER);
  const code = await runUsage(argv, io, {
    home: made.home,
    now: () => NOW,
    ...(observe === undefined ? {} : { observe }),
  });
  return { code, out: io.out, err: io.err };
}

function row(out: string, account: string, window: string): string {
  return out.split('\n').find((line) => new RegExp(`^${account}\\s+${window}\\b`).test(line)) ?? '';
}

function sourcesIn(value: unknown, found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const one of value) sourcesIn(one, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.source === 'string') found.push(record.source);
  for (const one of Object.values(record)) sourcesIn(one, found);
  return found;
}

test('a registry-backed team is read from the registry and gets a per-team view', async () => {
  const made = world((root) => teamText(root));
  updateState(made.dir, (state) => {
    state.budgets = {
      'openai/weekly/lead': {
        account: 'openai', window: 'weekly', left: 5, used: 95,
        changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z',
        seat: 'lead', source: 'status_line', confirmed: true,
      },
    } as never;
    state.sessions['acme-web'] = { ...emptySession() };
  });
  intoRegistry(made.root, made.home);

  const out = await underRegistry(() => usage(made, ['--tree']));
  expect(out.code).toBe(0);
  expect(out.out).not.toContain('could not be read');
  expect(out.out).toContain('openai  acme  weekly');
  expect(out.out).toContain('\nacme\n');
  expect(out.out).toContain(ESTIMATED);
  expect(out.out).toContain('2m ago');

  const json = await underRegistry(() => usage(made, ['--json']));
  expect(json.code).toBe(0);
  const doc = JSON.parse(json.out) as unknown;
  expect(sourcesIn(doc)).toContain('state record');
});

test('a reading older than its own window shows no figure and says how to get one', async () => {
  const made = world((root) => teamText(root));
  updateState(made.dir, (state) => {
    state.budgets = {};
    state.sessions['acme-web'] = { ...emptySession() };
  });
  const path = machineReadingsPath(made.home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify([{
    account: 'anthropic',
    window: 'session',
    left: 100,
    used: 0,
    observedAt: NOW.getTime() - (97 * 60 + 35) * 60_000,
    resetsAt: NOW.getTime() + 30_000,
  }])}\n`, { mode: 0o600 });

  const out = await usage(made);
  expect(out.code).toBe(0);
  const line = row(out.out, 'anthropic', 'session');
  expect(line).toContain('no fresh reading');
  expect(line).toContain('read 97h35m ago');
  expect(line).not.toContain('100%');
  expect(line).not.toContain('in 0m');
  expect(out.out).toContain('no fresh reading on anthropic (session)');
  expect(out.out).toContain('reads one on the next run');

  const json = await usage(made, ['--json']);
  const doc = JSON.parse(json.out) as {
    labs: { lab: string; accounts: { account: string; machine: { window: string | null; left: number | null; used: number | null; expired: boolean } }[] }[];
  };
  const machine = doc.labs.find((lab) => lab.lab === 'anthropic')?.accounts.find((one) => one.account === 'anthropic')?.machine;
  if (machine === undefined) throw new Error('the anthropic reading was not in the document');
  expect(machine.expired).toBe(true);
  expect(machine.window).toBe('session');
  expect(machine.left).toBeNull();
  expect(machine.used).toBeNull();
});

test('the state follows the pace, and a screen figure keeps its reset and its plain source', async () => {
  const made = world((root) => teamText(
    root,
    '',
    `  - role: member
    name: scout
    label: scout
    cli: antigravity
    vendor: google
    model: Fixture
    version: "1"
    launch: agy
`,
  ));
  updateState(made.dir, (state) => {
    state.budgets = {};
    state.sessions['acme-web'] = {
      ...emptySession(),
      seats: { lead: { stage: 'ready', pane: PANE } },
    };
  });
  const reset = new Date(NOW.getTime() + 150 * HOUR).toISOString();
  const print = `Gemini Models\tWeekly Limit Remaining\t53%\t${reset}\n`;
  const observe: NonNullable<Parameters<typeof runUsage>[2]['observe']> = (machine, view, now) => observeQuota(machine, view, {
    now,
    pane: (pane) => (pane === PANE ? SCREEN : null),
    usage: () => print,
  });

  const out = await usage(made, ['--tree'], observe);
  expect(out.code).toBe(0);
  const weekly = out.out.split('\n').find((line) => line.includes('used 96%')) ?? '';
  expect(weekly).toContain('left 4%');
  expect(weekly).toContain('resets in 9h');
  expect(weekly).toContain('on pace');
  expect(weekly).not.toContain('near cap');
  expect(weekly).toContain(`${FROM_BAR}, 0m ago`);

  const google = out.out.split('\n').find((line) => line.includes('used 47%')) ?? '';
  expect(google).toContain('runs out in about 20h17m, before the reset in 150h');
  expect(google).toContain(`${FROM_CLI}, 0m ago`);
  const googleRow = row(out.out, 'google \\(Gemini models\\)', 'weekly');
  expect(googleRow).toContain('near cap');
  expect(googleRow).toContain('runs out in about 20h17m, before the reset in 150h');
  expect(googleRow).toContain(FROM_CLI);

  const json = await usage(made, ['--json'], observe);
  const names = sourcesIn(JSON.parse(json.out) as unknown);
  expect(names).toContain('status line');
  expect(names).toContain('cli usage');
  expect(json.out).not.toContain(FROM_BAR);
  expect(json.out).not.toContain(FROM_CLI);
});

test('an account no screen on this machine exposes says why', async () => {
  const made = world((root) => teamText(
    root,
    `    xai:
      kind: subscription
      reserve: 20%
      sources: [status_line]
`,
    `  - role: member
    name: scout
    label: scout
    cli: cursor
    vendor: cursor
    model: Fixture
    version: "1"
    launch: cursor-agent
`,
  ));
  updateState(made.dir, (state) => {
    state.budgets = {};
    state.sessions['acme-web'] = { ...emptySession() };
  });

  const out = await usage(made);
  expect(out.code).toBe(0);
  const line = out.out.split('\n').find((text) => /^xai\s/.test(text)) ?? '';
  expect(line).toContain('not readable from a CLI screen');
  expect(line).not.toContain('96%');
});
