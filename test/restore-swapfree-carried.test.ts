import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf, approvedFingerprints } from '../src/approve/approval.ts';
import { canonical, fingerprints } from '../src/approve/fingerprint.ts';
import { canonicalRecord, teamRecordOf } from '../src/file/canonical-record.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, approvedRecordOf, storePath, writeApproval } from '../src/store/store.ts';
import { CHECK_NAMES, RETIRED_CHECK_NAMES } from '../src/watch/check.ts';
import { launchConcurrency, launchLimit, type Machine, type SwapSample } from '../src/watch/machine.ts';
import { TEAM_CHECKS } from '../src/watch/pass.ts';
import { writeTextSignedApproval } from './helpers/text-signed-approval.ts';

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function makeTeamYaml(options: {
  watchChecks?: string;
  machineBody?: string;
} = {}): string {
  const machineSection = options.machineBody !== undefined ? `machine:\n${options.machineBody}\n` : '';
  const watchChecksSection = options.watchChecks !== undefined ? `  checks:\n${options.watchChecks}\n` : '';
  return `format: 1
project: acme-web
visibility: public
session: acme-web
coordinator: claude-lead-acme
operator: claude-lead-acme
workspace:
  mode: shared
  base: main
trust:
  - .
${machineSection}watch:
  interval: 120s
${watchChecksSection}limits:
  seats: 4
  temporary: 1
seats:
  - role: coordinator
    name: claude-lead-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus 5.5
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-maker-acme
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;
}

describe('carried swap-free and swap_free_min across signed approvals and launch bounds', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'team-swapfree-carried-')));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('probe 1: a team file signed at an older build with watch.checks swap-free: off and machine.swap_free_min still verifies with unchanged fingerprints', () => {
    const root = join(home, 'acme-web');
    mkdirSync(root, { recursive: true });

    const text = makeTeamYaml({
      machineBody: '  load_start: 3\n  memory_start: 20%\n  swap_free_min: 4GB\n  swap_growth_max: 4GB',
      watchChecks: '    swap-free: off\n    disk: off',
    });

    const result = validateTeamFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedMachine = {
      loadStart: 3,
      loadMax: 6,
      memoryStart: 20,
      memoryMin: 15,
      diskMin: 10_000_000_000,
      swapFreeMin: 4_000_000_000,
      swapGrowthMax: 4_000_000_000,
      swapGrowthWindow: 600,
    };

    // Exact carried representations in the parsed TeamFile:
    expect(result.team.watch.checks).toEqual(['swap-free', 'disk']);
    expect(result.team.machine).toEqual(expectedMachine);

    // Fingerprints match the exact SHA-256 over canonical JSON that older builds produced:
    const fp = fingerprints(result.team);
    expect(fp.sections['watch.checks']).toBe(sha256(['swap-free', 'disk']));
    expect(fp.sections['machine']).toBe(sha256(expectedMachine));

    // Canonical record payload carries both fields identically:
    const recordJson = approvedRecordOf(text);
    expect(recordJson).toBe(canonicalRecord(teamRecordOf(result.team)));
    expect(recordJson).toContain('"checks":["swap-free","disk"]');
    expect(recordJson).toContain('"swapFreeMin":4000000000');

    // Record-signed approval verifies and reports zero differences:
    const store = storePath(result.team.project, root, home);
    const now = new Date('2026-10-15T12:00:00Z');
    writeApproval(
      store,
      { approval: approvalOf(result.team, root, now), file: text },
      result.team.seats,
      home,
      now,
    );

    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('verified');
    if (standing.kind === 'verified') {
      expect(standing.signedOver).toBe('record');
      expect(approvedFingerprints(standing.record)).toEqual(fp);
    }
    expect(approvalDifferences(result.team, root, home)).toEqual([]);

    // Editing watch.checks or machine.swap_free_min relative to the approved file is still detected as drift:
    const withoutSwapFreeCheck = validateTeamFile(
      makeTeamYaml({
        machineBody: '  load_start: 3\n  memory_start: 20%\n  swap_free_min: 4GB\n  swap_growth_stop: 4GB'.replace('swap_growth_stop', 'swap_growth_max'),
        watchChecks: '    disk: off',
      }),
    );
    expect(withoutSwapFreeCheck.ok).toBe(true);
    if (withoutSwapFreeCheck.ok) {
      expect(approvalDifferences(withoutSwapFreeCheck.team, root, home)).toEqual(['`watch.checks` changed']);
    }

    const editedSwapFreeMin = validateTeamFile(
      makeTeamYaml({
        machineBody: '  load_start: 3\n  memory_start: 20%\n  swap_free_min: 6GB\n  swap_growth_max: 4GB',
        watchChecks: '    swap-free: off\n    disk: off',
      }),
    );
    expect(editedSwapFreeMin.ok).toBe(true);
    if (editedSwapFreeMin.ok) {
      expect(approvalDifferences(editedSwapFreeMin.team, root, home)).toEqual(['`machine` changed']);
    }

    // Text-signed approval from pre-canonical builds also verifies with zero differences:
    const legacyRoot = join(home, 'acme-legacy');
    mkdirSync(legacyRoot, { recursive: true });
    const legacyStore = storePath(result.team.project, legacyRoot, home);
    writeTextSignedApproval(
      legacyStore,
      { approval: approvalOf(result.team, legacyRoot, now), file: text },
      result.team.seats,
      home,
      now,
    );
    const legacyStanding = approvalStanding(legacyRoot, home);
    expect(legacyStanding.kind).toBe('verified');
    if (legacyStanding.kind === 'verified') {
      expect(legacyStanding.signedOver).toBe('text');
    }
    expect(approvalDifferences(result.team, legacyRoot, home)).toEqual([]);
  });

  test('probe 2: watch.checks swap-free with any value other than off is refused, while off is carried and deprecated and no swap-free check runs', () => {
    expect(CHECK_NAMES).not.toContain('swap-free');
    expect(RETIRED_CHECK_NAMES).toEqual(['swap-free']);
    expect(TEAM_CHECKS.map((check) => check.name)).not.toContain('swap-free');

    const invalidSettings = [
      '    swap-free: on',
      '    swap-free: true',
      '    swap-free: false',
      '    swap-free: 0',
      '    swap-free: ""',
      '    swap-free:\n      - off',
      '    swap-free:\n      mode: off',
    ];

    for (const setting of invalidSettings) {
      const res = validateTeamFile(makeTeamYaml({ watchChecks: setting }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.map((e) => e.message)).toContain(
          'watch.checks.swap-free must be off: the only setting is off',
        );
      }
    }

    // `swap-free: off` is accepted, carried in order, and emits the deprecation notice:
    const valid = validateTeamFile(
      makeTeamYaml({ watchChecks: '    disk: off\n    swap-free: off\n    load: off' }),
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.team.watch.checks).toEqual(['disk', 'swap-free', 'load']);
    expect(valid.deprecations).toEqual([
      {
        line: 16,
        message: '`swap-free` is not a check any more: free swap is not reported',
        repair: 'remove swap-free from watch.checks in {file}',
      },
    ]);
  });

  test('probe 3: machine.swap_free_min is carried, defaults to 2GB when omitted, emits a deprecation when written, and never blocks launchLimit', () => {
    const withExplicit = validateTeamYamlWithMachine('  swap_free_min: 5GB');
    expect(withExplicit.ok).toBe(true);
    if (!withExplicit.ok) return;
    expect(withExplicit.team.machine.swapFreeMin).toBe(5_000_000_000);
    expect(withExplicit.deprecations).toEqual([
      {
        line: 13,
        message: '`machine.swap_free_min` is deprecated: free swap is not reported and never serializes a launch',
        repair:
          'remove swap_free_min from machine: in {file}; swap growth and memory pressure keep their limits',
      },
    ]);

    // When omitted, swapFreeMin defaults to 2GB with no deprecation, matching a written `swap_free_min: 2GB` fingerprint:
    const withDefault = validateTeamFile(makeTeamYaml());
    const withWritten2GB = validateTeamYamlWithMachine('  swap_free_min: 2GB');
    expect(withDefault.ok).toBe(true);
    expect(withWritten2GB.ok).toBe(true);
    if (withDefault.ok && withWritten2GB.ok) {
      expect(withDefault.team.machine.swapFreeMin).toBe(2_000_000_000);
      expect(withDefault.deprecations).toEqual([]);
      expect(fingerprints(withDefault.team).sections['machine']).toBe(
        fingerprints(withWritten2GB.team).sections['machine'],
      );
    }

    // Invalid swap_free_min measures are still refused:
    for (const bad of ['  swap_free_min: -1GB', '  swap_free_min: 0B', '  swap_free_min: bogus']) {
      const refused = validateTeamYamlWithMachine(bad);
      expect(refused.ok).toBe(false);
    }

    // launchLimit ignores swapFree even when 0 bytes are free against a 50GB swapFreeMin, but still enforces swapGrowthMax:
    const exhaustedSwap: Machine = {
      loadPerCore: 0.4,
      memoryFree: 50,
      pressure: 'normal',
      diskFree: 100e9,
      swapTotal: 64e9,
      swapFree: 0,
      swapUsed: 64e9,
    };
    const limits = {
      loadStart: 3,
      loadMax: 6,
      memoryStart: 20,
      memoryMin: 15,
      diskMin: 10_000_000_000,
      swapFreeMin: 50_000_000_000,
      swapGrowthMax: 4_000_000_000,
      swapGrowthWindow: 600,
    };
    const samples: SwapSample[] = [{ at: 1_000, used: 63e9 }];
    expect(launchLimit(exhaustedSwap, limits, samples, 2_000)).toBeNull();
    const highGrowthSamples: SwapSample[] = [{ at: 1_000, used: 58e9 }];
    expect(launchLimit(exhaustedSwap, limits, highGrowthSamples, 2_000)).toContain('swap grew by 6.0 GB');
  });

  test('probe 4: launchConcurrency bounds hold across load, memory, pressure, serial, and [2, 8] clamping regardless of swapFree', () => {
    const limits = {
      loadStart: 2.5,
      loadMax: 5.0,
      memoryStart: 15,
      memoryMin: 10,
      diskMin: 10_000_000_000,
      swapFreeMin: 20_000_000_000,
      swapGrowthMax: 4_000_000_000,
      swapGrowthWindow: 600,
    };
    const base: Machine = {
      loadPerCore: 0.25,
      memoryFree: 65,
      pressure: 'normal',
      diskFree: 200e9,
      swapTotal: 16e9,
      swapFree: 0,
      swapUsed: 16e9,
    };

    // 1. Free swap at 0, below swapFreeMin, below 1.5x swapFreeMin, or null never serializes:
    expect(launchConcurrency({ ...base, swapFree: 0 }, limits)).toBe(8);
    expect(launchConcurrency({ ...base, swapFree: 1_000 }, limits)).toBe(8);
    expect(launchConcurrency({ ...base, swapFree: null }, limits)).toBe(8);

    // 2. Serial flag, missing machine, or missing load/memory readings return 1:
    expect(launchConcurrency(base, limits, true)).toBe(1);
    expect(launchConcurrency(undefined, limits)).toBe(1);
    expect(launchConcurrency({ ...base, loadPerCore: null }, limits)).toBe(1);
    expect(launchConcurrency({ ...base, memoryFree: null }, limits)).toBe(1);

    // 3. Load boundary at 0.7 * loadStart (1.75):
    // At 1.75: loadSlots = floor((2.5 - 1.75) * 4) = 3
    expect(launchConcurrency({ ...base, loadPerCore: 1.75 }, limits)).toBe(3);
    expect(launchConcurrency({ ...base, loadPerCore: 1.76 }, limits)).toBe(1);

    // 4. Memory boundary at memoryStart + 10 (25):
    // At 25: memorySlots = floor((25 - 15) / 3) = 3
    expect(launchConcurrency({ ...base, memoryFree: 25 }, limits)).toBe(3);
    expect(launchConcurrency({ ...base, memoryFree: 24.9 }, limits)).toBe(1);

    // 5. Memory pressure boundary:
    expect(launchConcurrency({ ...base, pressure: 'warn' }, limits)).toBe(1);
    expect(launchConcurrency({ ...base, pressure: 'critical' }, limits)).toBe(1);
    expect(launchConcurrency({ ...base, pressure: 'normal' }, limits)).toBe(8);
    expect(launchConcurrency({ ...base, pressure: null }, limits)).toBe(8);

    // 6. Clamping to [2, 8] when all gates pass:
    expect(launchConcurrency({ ...base, loadPerCore: 0.6 }, { ...limits, loadStart: 1.0 })).toBe(2);
    expect(launchConcurrency({ ...base, loadPerCore: 0, memoryFree: 100 }, limits)).toBe(8);
  });
});

function validateTeamYamlWithMachine(machineBody: string) {
  return validateTeamFile(makeTeamYaml({ machineBody }));
}
