import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { checkDrift, checkReadings, resolveCheck, resolveChecks } from '../src/budgets/checks.ts';
import { blocksLaunch, doctorFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, storePath } from '../src/store/store.ts';
// The stored copy is not what these tests read: a text-signed record lets it be a stub.
import { writeTextSignedApproval } from './helpers/text-signed-approval.ts';

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

// The notice a file spelled with the legacy `coordinator:` key carries, at line 3 of `minimal`.
const notice = { line: 3, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' };

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result;
}

describe('budgets', () => {
  test('defaults when the section is absent', () => {
    const { team, warnings } = valid(minimal);
    expect(warnings).toEqual([notice]);
    expect(team.budgets).toEqual({ staleAfter: 1800, checkEvery: 600, marks: [50, 75, 90], accounts: {} });
  });

  test('watch.quota_marks is still read, and budgets.marks replaces it', () => {
    const legacy = valid(`${minimal}watch:\n  quota_marks: [40, 80]\n`);
    expect(legacy.warnings.map((warning) => warning.message)).toEqual([
      notice.message,
      'watch.quota_marks is now budgets.marks, and is still read',
    ]);
    expect(legacy.team.budgets.marks).toEqual([40, 80]);
    // Every warning in file order: the key's notice on line 3, then `budgets.marks` above
    // `watch.quota_marks` — without the sort the sections' run order (watch runs before budgets,
    // which reads it) printed the lower one first.
    const both = valid(`${minimal}budgets:\n  marks: [50, 90]\nwatch:\n  quota_marks: [40, 80]\n`);
    expect(both.team.budgets.marks).toEqual([50, 90]);
    expect(both.warnings.map((warning) => warning.message)).toEqual([
      notice.message,
      'budgets.marks replaces watch.quota_marks',
      'watch.quota_marks is now budgets.marks, and is still read',
    ]);
  });

  test('a subscription reserve and a spend floor', () => {
    const { team } = valid(`${minimal}budgets:\n  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [status_line] }\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n`);
    expect(team.budgets.accounts.openai).toEqual({
      kind: 'subscription', shared: false, reserve: 10, floor: null, sources: ['status_line'], check: null,
    });
    expect(team.budgets.accounts.deepseek).toMatchObject({
      kind: 'spend', floor: { amount: 5, currency: 'USD' }, sources: ['check'], check: 'deepseek-balance',
    });
  });

  test('a spend account never reads a screen', () => {
    const result = validateTeamFile(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [status_line] }\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.message.includes('never reads a screen'))).toBe(true);
  });

  test('changing marks needs a new approval', () => {
    const before = valid(`${minimal}budgets:\n  marks: [50, 75, 90]\n`).team;
    const after = valid(`${minimal}budgets:\n  marks: [60]\n`).team;
    const names = fingerprints(after).sections;
    expect(names.budgets).not.toBe(fingerprints(before).sections.budgets);
  });

  test('kind is required, and a reserve outside 0 to 100 is refused', () => {
    const missing = validateTeamFile(`${minimal}budgets:\n  accounts:\n    openai: { reserve: 10%, sources: [status_line] }\n`);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.some((error) => error.message === 'budgets.accounts.openai needs kind')).toBe(true);
    for (const reserve of ['0%', '101%']) {
      const result = validateTeamFile(`${minimal}budgets:\n  accounts:\n    openai: { kind: subscription, reserve: ${reserve}, sources: [status_line] }\n`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => error.message.includes('above 0 and at most 100'))).toBe(true);
    }
  });

  test("the RFC's accounts example, and the source defaults", () => {
    const text = `${minimal}budgets:\n  accounts:\n    anthropic: { kind: subscription, shared: true, reserve: 20% }\n    openai:    { kind: subscription, reserve: 10% }\n    deepseek:  { kind: spend, check: deepseek-balance, floor: 5 USD }\n`;
    const { team } = valid(text);
    expect(team.budgets.accounts.anthropic?.sources).toEqual(['status_line']);
    expect(team.budgets.accounts.openai?.sources).toEqual(['status_line']);
    expect(team.budgets.accounts.deepseek?.sources).toEqual(['check']);
    const spend = validateTeamFile(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD }\n`);
    expect(spend.ok).toBe(false);
    if (!spend.ok) expect(spend.errors.some((error) => error.message === 'budgets.accounts.deepseek needs check')).toBe(true);
    const empty = validateTeamFile(`${minimal}budgets:\n  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [] }\n`);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.some((error) => error.message === 'budgets.accounts.openai needs a source')).toBe(true);
    const spaced = validateTeamFile(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: "deepseek balance" }\n`);
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) expect(spaced.errors.some((error) => error.message.includes('one command, with no arguments'))).toBe(true);
  });

  test('a changed check file leaves that account unknown, and the file stays approved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-check-'));
    const home = mkdtempSync(join(tmpdir(), 'team-home-'));
    try {
      const command = join(dir, 'balance');
      writeFileSync(command, '#!/bin/sh\necho ok\n');
      chmodSync(command, 0o755);
      const team = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: ${command} }\n`).team;
      const first = resolveChecks(team, dir, '');
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      writeTextSignedApproval(storePath(team.project, dir, home), {
        approval: approvalOf(team, dir, new Date('2026-10-04T00:00:00Z'), first.checks),
        file: 'format: 1\n',
      }, [], home);
      expect(approvalDifferences(team, dir, home)).toEqual([]);
      writeFileSync(command, '#!/bin/sh\necho other\n');
      const second = resolveChecks(team, dir, '');
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(checkDrift(first.checks, second.checks)).toEqual(['the check for deepseek changed']);
      expect(JSON.stringify(checkDrift(first.checks, second.checks))).not.toContain('echo');
      expect(approvalDifferences(team, dir, home)).toEqual([]);
      expect(checkReadings(team.budgets, first.checks)).toEqual([{ account: 'deepseek', state: 'unknown' }]);
      const sources: DoctorSources = {
        version: () => null,
        onPath: () => true,
        loggedIn: () => null,
        herdrVersion: () => null,
        sessionRunning: () => false,
        now: () => new Date('2026-10-04T00:00:00Z'),
        home,
      };
      const findings = doctorFindings(team, dir, dir, team.session, sources, [], approvalStanding(dir, home));
      const finding = findings.find((item) => item.text.includes('deepseek'));
      expect(finding).toEqual({ level: 'warn', text: 'the check for deepseek changed after approval and was not run; that account reads unknown' });
      expect(blocksLaunch(finding!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a relative PATH entry is skipped, and another PATH does not move an approved check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-check-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const command = join(bin, 'balance');
      writeFileSync(command, '#!/bin/sh\necho ok\n');
      chmodSync(command, 0o755);
      const team = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, check: balance }\n`).team;
      expect(resolveCheck('balance', dir, `rel:${bin}`)?.path).toBe(command);
      expect(isAbsolute(command)).toBe(true);
      expect(resolveCheck('balance', dir, 'rel')).toBeNull();
      const resolved = resolveChecks(team, dir, bin);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const approved = checkReadings(team.budgets, resolved.checks);
      expect(approved).toEqual([{ account: 'deepseek', state: 'approved' }]);
      expect(resolveCheck('balance', dir, join(dir, 'missing'))).toBeNull();
      expect(checkReadings(team.budgets, resolved.checks)).toEqual(approved);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
