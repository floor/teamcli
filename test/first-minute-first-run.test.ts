import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorLoginFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { codexOwnServerArgv, firstRunLine, firstRunVerdicts } from '../src/launchers/first-run.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

describe('first-run skips', () => {
  test('Codex in the documented range starts its own server and skips the feature-settings dialog', () => {
    const argv = codexOwnServerArgv('unix://seat.sock');
    expect(argv).toEqual(['codex', 'app-server', '--listen', 'unix://seat.sock']);
    expect(argv).not.toContain('--remote');
    const verdicts = firstRunVerdicts('codex', 'codex-cli 0.161.0', argv);
    const feature = verdicts.find((one) => one.class === 'feature-settings');
    expect(feature).toEqual({
      state: 'skipped',
      class: 'feature-settings',
      mechanism: "the seat's own app-server (--listen), not a shared server (--remote)",
    });
  });

  test('a shared Codex server and a version outside the range stay waiting', () => {
    const shared = firstRunVerdicts('codex', '0.160.0', ['codex', '--remote', 'unix://shared']);
    expect(shared.find((one) => one.class === 'feature-settings')?.state).toBe('waiting');
    const old = firstRunVerdicts('codex', '0.100.0', codexOwnServerArgv('unix://seat.sock'));
    expect(old.find((one) => one.class === 'feature-settings')?.state).toBe('waiting');
  });

  test('a kind with no documented survey, telemetry, or tips skip is waiting and sends no key', () => {
    for (const kind of ['gemini', 'antigravity', 'claude-code', 'cursor', 'grok', 'codex']) {
      const verdicts = firstRunVerdicts(kind, '1.0.0', codexOwnServerArgv('unix://seat.sock'));
      for (const cls of ['survey', 'telemetry', 'tips'] as const) {
        const verdict = verdicts.find((one) => one.class === cls);
        expect(verdict?.state).toBe('waiting');
        expect(firstRunLine(kind, verdict!)).not.toContain('0');
        expect(JSON.stringify(verdict)).not.toContain('skip_key');
      }
    }
  });

  test('doctor checks the skip against the version it sees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-fm-firstrun-'));
    try {
      mkdirSync(join(dir, '.agents'));
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, example);
      const loaded = loadTeamFile(dir, { file });
      if (!loaded.ok) throw new Error('example must load');
      const sources: DoctorSources = {
        version: (binary) => (binary === 'codex' ? 'codex-cli 0.161.0' : '1.2.3'),
        onPath: () => true,
        loggedIn: () => true,
        herdrVersion: () => null,
        sessionRunning: () => null,
        now: () => new Date('2026-11-06T00:00:00Z'),
        home: dir,
      };
      const lines = doctorLoginFindings(loaded.team, sources).map((finding) => finding.text);
      expect(lines).toContain("codex: first-run feature-settings skipped (the seat's own app-server (--listen), not a shared server (--remote))");
      expect(lines.some((line) => line.startsWith('codex: waiting, first-run survey'))).toBe(true);
      expect(lines.some((line) => line.includes('skip_key'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
