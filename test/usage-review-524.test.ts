// `team usage` — the three behaviours the review of the machine-account model pins: an explicit
// team declaration of an account stands over the machine's own subscription fallback whichever
// store is read first; a shared machine account's row in the restricted view carries nothing of
// another team's own file; and the default report's team rows follow the caller's own checkout,
// not the project name it displays. Synthetic homes and approved teams only: nothing here touches
// a real home, a pane or a CLI session.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { machineUsage, reportOf, viewFor } from '../src/information/usage.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = Date.parse('2026-10-16T10:00:00Z');
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) {
    if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [base]);
    else rmSync(base, { recursive: true, force: true });
  }
});

/** A synthetic home with the lobby folder the fixture files trust. */
function syntheticHome(): { home: string; base: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-usage-review-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  return { home, base };
}

/** A team file shaped like a real approved one — the loader's placed checks satisfied — with the
 *  budgets block handed in and one lead seat. */
function teamText(opts: { project: string; session: string; root: string; budgets: string; cli: string; vendor: string; account?: string }): string {
  const seat = [
    '  - role: orchestrator',
    '    name: lead',
    '    label: lead',
    '    leads: true',
    `    cli: ${opts.cli}`,
    `    vendor: ${opts.vendor}`,
    ...(opts.account === undefined ? [] : [`    account: ${opts.account}`]),
    `    model: ${opts.cli === 'grok' ? 'Grok' : 'Claude Opus'}`,
    '    version: "4.7"',
    `    launch: ${opts.cli} --always-approve`,
  ];
  return `format: 1
project: ${opts.project}
session: ${opts.session}
operator: lead
trust:
  - ~/.config/team/lobby
  - ${opts.root}
workspace:
  mode: shared
${opts.budgets}seats:
${seat.join('\n')}
`;
}

/** Write the checkout's file and its approval, the way `team approve` leaves them. */
function approved(home: string, root: string, text: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, new Date(NOW)), file: text }, [], home);
}

/** A spend balance the checkout's state holds, as a check reading would leave it. */
function recordSpend(root: string, session: string, account: string, amount: number): void {
  updateState(join(root, '.agents'), (state) => {
    state.spend = { [account]: { account, amount, currency: 'USD', at: '2026-10-16T09:56:00Z' } } as never;
    state.sessions[session] = { ...emptySession() } as never;
  });
}

test('an explicit team account stands over the machine fallback in both store orders', () => {
  const betaBudgets = 'budgets:\n  accounts:\n    xai: { kind: spend, floor: 5 USD, sources: [check], check: beta-balance }\n';
  for (const fallbackName of ['alpha', 'zeta']) {
    const { home, base } = syntheticHome();
    writeFileSync(join(home, '.config', 'team', 'accounts.yaml'), 'accounts:\n  - xai\n');
    // beta declares the account the machine's own list carries, as a spend account with a balance.
    const betaRoot = join(base, 'beta-checkout');
    approved(home, betaRoot, teamText({ project: 'beta', session: 'beta-session', root: betaRoot, budgets: betaBudgets, cli: 'claude-code', vendor: 'anthropic' }));
    recordSpend(betaRoot, 'beta-session', 'xai', 25);
    // The other team names no account at all, so the machine's fallback is its only declaration.
    // Its own name orders the stores: `alpha` is read before beta, `zeta` after it.
    const otherRoot = join(base, `${fallbackName}-checkout`);
    approved(home, otherRoot, teamText({ project: fallbackName, session: `${fallbackName}-session`, root: otherRoot, budgets: '', cli: 'grok', vendor: 'grok' }));
    const view = viewFor(testIo(betaRoot, { kind: 'owner' }), betaRoot);
    const machine = machineUsage(home, NOW, view);
    for (const allTeams of [false, true]) {
      const where = `${fallbackName} read first, --all ${allTeams}`;
      const report = reportOf(machine, view, NOW, [], allTeams);
      const entries = report.labs.flatMap((lab) => lab.accounts).filter((one) => one.account === 'xai');
      expect(entries, where).toHaveLength(1);
      const entry = entries[0];
      expect(entry?.kind, where).toBe('spend');
      if (entry === undefined || entry.kind !== 'spend') throw new Error(`${where}: no spend line for xai`);
      expect(entry.machine.amount, where).toBe(25);
      expect(entry.machine.currency, where).toBe('USD');
    }
  }
});

test("a shared machine account's restricted row keeps a foreign team's own metadata out", () => {
  const { home, base } = syntheticHome();
  writeFileSync(join(home, '.config', 'team', 'accounts.yaml'), 'accounts:\n  - shared\n');
  const foreignRoot = join(base, 'foreign-checkout');
  const text = teamText({
    project: 'foreign-lab', session: 'foreign-session', root: foreignRoot,
    budgets: 'budgets:\n  accounts:\n    shared: { kind: spend, floor: 5 USD, sources: [check], check: foreign-balance }\n',
    cli: 'grok', vendor: '/synthetic/private-project', account: 'shared',
  });
  approved(home, foreignRoot, text);
  recordSpend(foreignRoot, 'foreign-session', 'shared', 25);
  // A caller outside every project: the restricted view with no team of its own.
  const view = { full: false, mine: null };
  const machine = machineUsage(home, NOW, view);
  const report = reportOf(machine, view, NOW, []);
  const face = JSON.stringify(report);
  expect(report.view).toBe('restricted');
  expect(report.mine).toBeNull();
  // The shared account and its figures are public; the lab a foreign seat's `vendor` produced is not.
  expect(face).not.toContain('/synthetic/private-project');
  expect(face).not.toContain('private-project');
  const entries = report.labs.flatMap((lab) => lab.accounts).filter((one) => one.account === 'shared');
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry?.kind).toBe('spend');
  if (entry === undefined || entry.kind !== 'spend') throw new Error('no spend line for the shared account');
  expect(entry.machine.amount).toBe(25);
});

test("the default report keeps the caller's own rows when two checkouts share a project name", () => {
  const { home, base } = syntheticHome();
  const openaiBudgets = 'budgets:\n  accounts:\n    openai:\n      kind: subscription\n      reserve: 20%\n      sources: [check, status_line]\n      check: shared-quota\n';
  const rootA = join(base, 'checkout-a');
  const rootB = join(base, 'checkout-b');
  const checkouts = [
    { root: rootA, session: 'shared-session-a', used: 75 },
    { root: rootB, session: 'shared-session-b', used: 25 },
  ];
  for (const one of checkouts) {
    approved(home, one.root, teamText({ project: 'shared-name', session: one.session, root: one.root, budgets: openaiBudgets, cli: 'claude-code', vendor: 'anthropic' }));
    updateState(join(one.root, '.agents'), (state) => {
      state.budgets = {
        'openai/session': { account: 'openai', window: 'session', left: 100 - one.used, used: one.used, changedAt: '2026-10-16T09:58:00Z', resetsAt: null, seat: null, source: 'check', confirmed: true },
      } as never;
      state.sessions[one.session] = { ...emptySession() } as never;
    });
  }
  const view = viewFor(testIo(rootA, { kind: 'owner' }), rootA);
  const machine = machineUsage(home, NOW, view);
  const sessionRows = (allTeams: boolean): (number | null)[] => {
    const report = reportOf(machine, view, NOW, [], allTeams);
    const entry = report.labs.flatMap((lab) => lab.accounts).find((one) => one.account === 'openai');
    if (entry === undefined || entry.kind !== 'subscription') throw new Error('the openai subscription line is missing');
    return entry.teams.map((one) => one.row.used).sort((a, b) => (a ?? 0) - (b ?? 0));
  };
  // The caller's own checkout only; `--all` is what carries the second project's rows.
  expect(sessionRows(false)).toEqual([75]);
  expect(sessionRows(true)).toEqual([25, 75]);
});
