// RFC 0003 § 5: a check command's output contract, its run, and the approval that gates it.
// The raw output lives only inside `run.ts` — parsed and dropped — so no outcome, log line or
// error may ever carry a byte of it. Every fixture here is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { resolveChecks, type ApprovedCheck } from '../src/budgets/checks.ts';
import {
  checkOutcomes,
  parseSpend,
  parseSubscription,
  readCheck,
  runChecks,
  type CheckOutcome,
} from '../src/budgets/run.ts';
import type { BudgetAccount, TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath } from '../src/store/store.ts';
// The stored copy is not what these tests read: a text-signed record lets it be a stub.
import { writeTextSignedApproval } from './helpers/text-signed-approval.ts';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const PAST = String(Math.floor((NOW - 2 * MIN) / 1000));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An executable check command in a temp dir, printing just these lines. */
function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-check-run-'));
  made.push(dir);
  const path = join(dir, 'check');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const minimal = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function valid(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.team;
}

function spendAccount(floor = '5 USD'): BudgetAccount {
  const team = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: ${floor}, sources: [check], check: deepseek-balance }\n`);
  const account = team.budgets.accounts.deepseek;
  if (!account) throw new Error('no account');
  return account;
}

describe('the subscription output contract', () => {
  test('one to three lines, each a window, and a printed time is the line\'s own', () => {
    const reading = parseSubscription(
      `session 21% used resets 3h\ndaily 44% left\nweekly 39% used resets 114h4m at ${PAST}\n`,
      NOW,
    );
    expect(reading).toEqual({
      kind: 'subscription',
      windows: [
        { window: 'session', left: 79, used: 21, at: NOW, resetsAt: NOW + 3 * 3600_000 },
        { window: 'daily', left: 44, used: 56, at: NOW, resetsAt: null },
        // The reset counts from the reading's own time, not from the run's.
        { window: 'weekly', left: 61, used: 39, at: NOW - 2 * MIN, resetsAt: NOW - 2 * MIN + (114 * 60 + 4) * MIN },
      ],
    });
  });

  test('100% and 0% are figures; anything else off the contract reads unknown', () => {
    expect(parseSubscription('weekly 100% used\n', NOW)).toMatchObject({ windows: [{ left: 0, used: 100 }] });
    expect(parseSubscription('weekly 0% used\n', NOW)).toMatchObject({ windows: [{ left: 100, used: 0 }] });
    for (const text of [
      '',
      '\n',
      'weekly 39% used\n\n',
      'weekly 39 used\n',
      'weekly 39% used resets soon\n',
      'weekly 101% used\n',
      'weekly 39% USED\n',
      'monthly 39% used\n',
      'weekly 39% used at 123\n',
      'weekly 39% used\nweekly 39% used\n',
      'session 1% used\ndaily 2% used\nweekly 3% used\nextra 4% used\n',
    ]) {
      expect(parseSubscription(text, NOW)).toBeNull();
    }
  });

  test('a printed time later than the run is the run\'s', () => {
    const future = String(Math.floor((NOW + 10 * MIN) / 1000));
    expect(parseSubscription(`weekly 39% used at ${future}\n`, NOW)).toMatchObject({ windows: [{ at: NOW }] });
  });

  test('a CRLF line ending is the line ending, and a CR anywhere else is off the contract', () => {
    // A check that prints from a pty, or from Windows, ends its lines \r\n: the CR is part
    // of the ending, not a character of the line.
    expect(parseSubscription('weekly 39% used\r\n', NOW)).toMatchObject({ windows: [{ window: 'weekly', left: 61, used: 39 }] });
    expect(parseSubscription('session 21% used\r\ndaily 44% left\r\n', NOW)).toMatchObject({
      windows: [{ window: 'session' }, { window: 'daily' }],
    });
    expect(parseSpend('12.40 USD\r\n', 'USD', NOW)).toMatchObject({ amount: 12.4 });
    // A CR in the middle of a line is not a line ending, and the line stays off the contract.
    expect(parseSubscription('weekly 39%\r used\n', NOW)).toBeNull();
    expect(parseSubscription('weekly 39% used\r \n', NOW)).toBeNull();
  });
});

describe('the spend output contract', () => {
  test('exactly one line, in the floor\'s currency', () => {
    expect(parseSpend('12.40 USD\n', 'USD', NOW)).toEqual({ kind: 'spend', amount: 12.4, currency: 'USD', at: NOW });
    expect(parseSpend('12 USD\n', 'USD', NOW)).toMatchObject({ amount: 12 });
    for (const text of ['12.40 EUR\n', '12.40 USD\nmore\n', '3.2 usd\n', '12.12345 USD\n', '12,40 USD\n', '']) {
      expect(parseSpend(text, 'USD', NOW)).toBeNull();
    }
  });
});

describe('running a check command', () => {
  test('its output is parsed, and a contract break or a failure reads unknown', () => {
    const good = script('echo "12.40 USD"');
    expect(readCheck(spendAccount(), good, NOW)).toEqual({ kind: 'spend', amount: 12.4, currency: 'USD', at: NOW });
    expect(readCheck(spendAccount(), script('echo hello'), NOW)).toBeNull();
    expect(readCheck(spendAccount(), script('echo "12.40 USD"; exit 3'), NOW)).toBeNull();
    expect(readCheck(spendAccount(), script('echo "12.40 USD"; echo "12.40 USD"'), NOW)).toBeNull();
  });

  test('a figure past four decimals is refused, not truncated; four decimals count as read', () => {
    // § 5 holds a check to at most four decimals: `4.99605` matches nothing, so the reading is
    // dropped and the account unknown — never rounded to `4.9961` or cut to `4.9960`.
    expect(readCheck(spendAccount(), script('echo "4.99605 USD"'), NOW)).toBeNull();
    expect(readCheck(spendAccount(), script('echo "4.9960 USD"'), NOW))
      .toEqual({ kind: 'spend', amount: 4.996, currency: 'USD', at: NOW });
  });

  test('a command that does not finish in time reads unknown', () => {
    const slow = script('sleep 5; echo "12.40 USD"');
    const started = Date.now();
    expect(readCheck(spendAccount(), slow, NOW, 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test('a command that traps TERM is killed at the timeout, not waited out', () => {
    const trapped = script('trap "" TERM\nsleep 6\necho "12.40 USD"');
    const started = Date.now();
    expect(readCheck(spendAccount(), trapped, NOW, 200)).toBeNull();
    // The kill signal is SIGKILL: under the default SIGTERM the trap would swallow it and the
    // call would block for the whole sleep, well past twice the timeout. The bound is wide
    // enough for a slow runner to spawn `sh` inside it, and a tenfold margin under the sleep.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('it gets an empty environment with only PATH and HOME', () => {
    const look = script('if [ -n "$TEAM_CHECK_SECRET" ]; then echo "$TEAM_CHECK_SECRET"; else echo "5 USD"; fi');
    process.env.TEAM_CHECK_SECRET = 'synthetic-not-a-secret';
    try {
      expect(readCheck(spendAccount(), look, NOW)).toEqual({ kind: 'spend', amount: 5, currency: 'USD', at: NOW });
    } finally {
      delete process.env.TEAM_CHECK_SECRET;
    }
  });
});

describe('the approval gates the run', () => {
  function team(command: string): TeamFile {
    return valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: ${command} }\n`);
  }

  test('an unapproved check is not run at all', () => {
    const file = team('deepseek-balance');
    const ran: string[] = [];
    const run = () => {
      ran.push('ran');
      return null;
    };
    expect(checkOutcomes(file.budgets, undefined, run, NOW)).toEqual([{ account: 'deepseek', state: 'unapproved' }]);
    expect(checkOutcomes(file.budgets, {}, run, NOW)).toEqual([{ account: 'deepseek', state: 'unapproved' }]);
    expect(ran).toEqual([]);
  });

  test('a changed file is unapproved too, and still not run', () => {
    const dir = temp('team-check-dir-');
    const command = join(dir, 'balance');
    writeFileSync(command, '#!/bin/sh\necho "5 USD"\n', { mode: 0o755 });
    const file = team(command);
    const resolved = resolveChecks(file, dir, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    writeFileSync(command, '#!/bin/sh\necho "9 USD"\n', { mode: 0o755 });
    const ran: string[] = [];
    const outcomes = checkOutcomes(file.budgets, resolved.checks, (_account, path) => {
      ran.push(path);
      return null;
    }, NOW);
    expect(outcomes).toEqual([{ account: 'deepseek', state: 'unapproved' }]);
    expect(ran).toEqual([]);
  });

  test('an approved check runs its reading; a null reading is unreadable', () => {
    const dir = temp('team-check-dir-');
    const command = join(dir, 'balance');
    writeFileSync(command, '#!/bin/sh\necho "5 USD"\n', { mode: 0o755 });
    const file = team(command);
    const resolved = resolveChecks(file, dir, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    const reading = { kind: 'spend', amount: 6.2, currency: 'USD', at: NOW } as const;
    expect(checkOutcomes(file.budgets, resolved.checks, () => reading, NOW)).toEqual([
      { account: 'deepseek', state: 'read', reading },
    ]);
    expect(checkOutcomes(file.budgets, resolved.checks, () => null, NOW)).toEqual([{ account: 'deepseek', state: 'unreadable' }]);
  });

  test('an outcome and its reading carry exactly the contract\'s fields, so no point can enter them (§ 5)', () => {
    // § 5's point is written by the fold the watch runs over time, onto readings already in the
    // project's cache. A check reads its command fresh on every run, and what comes back is
    // exactly these keys; nothing upstream — store, gate or watch — can read a field that is not
    // here, so no point reaches anything this file pins. These pins fail the day one appears.
    const dir = temp('team-check-dir-');
    const command = join(dir, 'balance');
    writeFileSync(command, '#!/bin/sh\necho "6.20 USD"\n', { mode: 0o755 });
    const file = team(command);
    const resolved = resolveChecks(file, dir, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    const outcomes = checkOutcomes(file.budgets, resolved.checks, () => ({ kind: 'spend', amount: 6.2, currency: 'USD', at: NOW }), NOW);
    // Non-vacuity: the check really ran and really produced this outcome.
    expect(outcomes).toEqual([{ account: 'deepseek', state: 'read', reading: { kind: 'spend', amount: 6.2, currency: 'USD', at: NOW } }]);
    const outcome = outcomes[0];
    if (outcome?.state !== 'read') throw new Error('the check did not read');
    expect(Object.keys(outcome)).toEqual(['account', 'state', 'reading']);
    expect(Object.keys(outcome.reading)).toEqual(['kind', 'amount', 'currency', 'at']);
    // And the subscription reading's own shape: the windows a check fills are the same five
    // fields the cache stores, none of them a point.
    const reading = parseSubscription('weekly 39% used resets 114h4m\n', NOW);
    if (reading === null || reading.kind !== 'subscription') throw new Error('the subscription did not parse');
    expect(Object.keys(reading)).toEqual(['kind', 'windows']);
    expect(Object.keys(reading.windows[0]!)).toEqual(['window', 'left', 'used', 'at', 'resetsAt']);
  });
});

describe('runChecks, end to end', () => {
  test('reads the approved command, and never lets its output out', () => {
    const dir = temp('team-check-dir-');
    const home = temp('team-check-home-');
    const command = join(dir, 'balance');
    writeFileSync(command, `#!/bin/sh\necho "6.20 USD"\necho "synthetic-not-a-secret"\n`, { mode: 0o755 });
    const file = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: ${command} }\n`);
    const resolved = resolveChecks(file, dir, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    const approve = (checks: Record<string, ApprovedCheck>) => writeTextSignedApproval(storePath(file.project, dir, home), {
      approval: approvalOf(file, dir, new Date(NOW), checks),
      file: 'format: 1\n',
    }, [], home);

    // Two lines for a spend account break the contract; the account is unreadable, and the
    // second line — whatever it is — is nowhere in what comes back.
    approve(resolved.checks);
    const outcomes: CheckOutcome[] = runChecks(file, dir, NOW, home);
    expect(outcomes).toEqual([{ account: 'deepseek', state: 'unreadable' }]);
    expect(JSON.stringify(outcomes)).not.toContain('synthetic-not-a-secret');

    // The owner approves the fixed file's command; the approval of the old one named its hash.
    writeFileSync(command, '#!/bin/sh\necho "6.20 USD"\n', { mode: 0o755 });
    const fixed = resolveChecks(file, dir, '');
    if (!fixed.ok) throw new Error('the check did not resolve');
    approve(fixed.checks);
    expect(runChecks(file, dir, NOW, home)).toEqual([
      { account: 'deepseek', state: 'read', reading: { kind: 'spend', amount: 6.2, currency: 'USD', at: NOW } },
    ]);
  });

  test('a file changed since the approval is not run', () => {
    const dir = temp('team-check-dir-');
    const home = temp('team-check-home-');
    const command = join(dir, 'balance');
    writeFileSync(command, '#!/bin/sh\necho "6.20 USD"\n', { mode: 0o755 });
    const file = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: ${command} }\n`);
    const resolved = resolveChecks(file, dir, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    writeTextSignedApproval(storePath(file.project, dir, home), {
      approval: approvalOf(file, dir, new Date(NOW), resolved.checks),
      file: 'format: 1\n',
    }, [], home);
    writeFileSync(command, '#!/bin/sh\necho "9.90 USD"\n', { mode: 0o755 });
    expect(runChecks(file, dir, NOW, home)).toEqual([{ account: 'deepseek', state: 'unapproved' }]);
    // A file never approved on this machine runs no check and reads no account: the budgets
    // in force are the defaults, which name none, whatever the file's own section says.
    expect(runChecks(file, dir, NOW, temp('team-check-home-'))).toEqual([]);
  });
});
