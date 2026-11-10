import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorLoginFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { codexOwnServerArgv, firstRunVerdicts } from '../src/launchers/first-run.ts';
import { profileFor } from '../src/profiles/index.ts';
import { versionVerdict } from '../src/profiles/profile.ts';
import { questionAnswerFor } from '../src/profiles/question-answer.ts';
import { TRUST_CAPTURES } from '../src/profiles/trust-captures.ts';
import { runningModel } from '../src/status/statusline.ts';
import { classify, classifyComposer, readScreen } from '../src/watch/screen.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const ROOT = join(import.meta.dir, '..');
const codex = profileFor('codex');
if (!codex) throw new Error('codex profile missing');

function capture0167(name: string): string {
  return readFileSync(join(ROOT, 'test', 'fixtures', 'codex', '0.167.0', `${name}.txt`), 'utf8');
}

function capture0161(name: string): string {
  return readFileSync(join(ROOT, 'test', 'fixtures', 'codex', '0.161.0', `${name}.txt`), 'utf8');
}

describe('independent Codex 0.167.0 profile, dialog, and contract boundaries', () => {
  test('scene 1 (tested range and own-server first-run skip): 0.157.0 through 0.167.0 are tested and skip feature-settings on own app-server, while 0.167.1+ and shared servers stay newer/waiting', () => {
    expect(codex.tested).toEqual({ from: '0.157.0', to: '0.167.0' });
    expect(versionVerdict('codex-cli 0.156.9', codex.tested)).toBe('older');
    for (const ver of ['0.157.0', '0.160.0', '0.161.0', '0.162.0', '0.166.0', '0.167.0']) {
      expect(versionVerdict(`codex-cli ${ver}`, codex.tested)).toBe('tested');
    }
    expect(versionVerdict('codex-cli 0.167.1', codex.tested)).toBe('newer');
    expect(versionVerdict('codex-cli 0.168.0', codex.tested)).toBe('newer');

    const ownArgv = codexOwnServerArgv('unix://seat.sock');
    const at0167 = firstRunVerdicts('codex', 'codex-cli 0.167.0', ownArgv);
    expect(at0167.find((v) => v.class === 'feature-settings')).toEqual({
      state: 'skipped',
      class: 'feature-settings',
      mechanism: "the seat's own app-server (--listen), not a shared server (--remote)",
    });

    const at01671 = firstRunVerdicts('codex', 'codex-cli 0.167.1', ownArgv);
    expect(at01671.find((v) => v.class === 'feature-settings')?.state).toBe('waiting');

    const sharedAt0167 = firstRunVerdicts('codex', 'codex-cli 0.167.0', ['codex', '--remote', 'unix://shared.sock']);
    expect(sharedAt0167.find((v) => v.class === 'feature-settings')?.state).toBe('waiting');

    const dir = mkdtempSync(join(tmpdir(), 'team-codex-0167-doc-'));
    try {
      mkdirSync(join(dir, '.agents'));
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, readFileSync(join(ROOT, 'test', 'fixtures', 'example.yaml'), 'utf8'));
      const loaded = loadTeamFile(dir, { file });
      if (!loaded.ok) throw new Error('example team.yaml must load');
      const sources: DoctorSources = {
        version: (binary) => (binary === 'codex' ? 'codex-cli 0.167.0' : '1.2.3'),
        onPath: () => true,
        loggedIn: () => true,
        herdrVersion: () => null,
        sessionRunning: () => null,
        now: () => new Date('2026-11-10T00:00:00Z'),
        home: dir,
      };
      const lines = doctorLoginFindings(loaded.team, sources).map((f) => f.text);
      expect(lines).toContain(
        "codex: first-run feature-settings skipped (the seat's own app-server (--listen), not a shared server (--remote))",
      );
    } finally {
      discardFixtures([dir]);
    }
  });

  test('scene 2 (exact question_answer records): codex-cli 0.167.0 answers question and plan approval with escape while refusing bare, intermediate, newer, and confirmation queries', () => {
    expect(questionAnswerFor(codex.questionAnswers, 'question', 'codex-cli 0.167.0')).toEqual({
      kind: 'question',
      key: 'escape',
      from: 'codex-cli 0.167.0',
      to: 'codex-cli 0.167.0',
    });
    expect(questionAnswerFor(codex.questionAnswers, 'plan approval', 'codex-cli 0.167.0')).toEqual({
      kind: 'plan approval',
      key: 'escape',
      from: 'codex-cli 0.167.0',
      to: 'codex-cli 0.167.0',
    });
    expect(questionAnswerFor(codex.questionAnswers, 'question', 'codex-cli 0.161.0')?.key).toBe('escape');
    expect(questionAnswerFor(codex.questionAnswers, 'plan approval', 'codex-cli 0.161.0')?.key).toBe('escape');

    // Bare version without prefix, uncaptured intermediate versions, and newer versions must return null.
    for (const uncaptured of ['0.167.0', 'codex-cli 0.160.0', 'codex-cli 0.162.0', 'codex-cli 0.166.0', 'codex-cli 0.167.1']) {
      expect(questionAnswerFor(codex.questionAnswers, 'question', uncaptured)).toBeNull();
      expect(questionAnswerFor(codex.questionAnswers, 'plan approval', uncaptured)).toBeNull();
    }
    expect(questionAnswerFor(codex.questionAnswers, 'confirmation', 'codex-cli 0.167.0')).toBeNull();
  });

  test('scene 3 (captured 0.167.0 fixtures): all nine 0.167.0 captures classify screen, composer, and running model accurately', () => {
    const expectations = [
      { name: 'idle', screen: 'idle', composer: 'idle', model: { model: 'GPT Sol', version: '6.1' } },
      { name: 'idle-unattended', screen: 'idle', composer: 'idle', model: { model: 'GPT Sol', version: '6.1' } },
      { name: 'unsent', screen: 'unsent', composer: 'unsent', model: { model: 'GPT Sol', version: '6.1' } },
      { name: 'working', screen: 'working', composer: 'idle', model: { model: 'GPT Sol', version: '6.1' } },
      { name: 'trust', screen: 'trust', composer: 'unknown', model: null },
      { name: 'permission', screen: 'permission', composer: 'unknown', model: null },
      { name: 'plan-approval', screen: 'plan approval', composer: 'unknown', model: null },
      { name: 'question', screen: 'question', composer: 'unknown', model: null },
      { name: 'exit', screen: 'unknown', composer: 'unknown', model: null },
    ] as const;

    for (const item of expectations) {
      const raw = capture0167(item.name);
      expect(readScreen('codex', raw).kind, `${item.name} readScreen`).toBe(item.screen);
      expect(classify('codex', raw.split('\n')).kind, `${item.name} classify`).toBe(item.screen);
      expect(classifyComposer('codex', raw.split('\n')).kind, `${item.name} classifyComposer`).toBe(item.composer);
      expect(runningModel('codex', raw), `${item.name} runningModel`).toEqual(item.model);
      if (item.name !== 'plan-approval') {
        const plain = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        expect(plain, `${item.name} redacted workspace token`).toContain('<workspace>');
      }
    }
  });

  test('scene 4 (wide vs narrow dialog variant boundaries): wide 0.167.0 plan approval and question variants require their full header, choice, and footer rows while preserving 0.161.0 narrow variants', () => {
    // 0.161.0 narrow variants still match.
    expect(readScreen('codex', capture0161('plan-approval')).kind).toBe('plan approval');
    expect(readScreen('codex', capture0161('question')).kind).toBe('question');

    // Wide 0.167.0 plan-approval accepts any digits in "current context: NN% used".
    const planRaw = capture0167('plan-approval');
    expect(readScreen('codex', planRaw.replace('2% used', '87% used')).kind).toBe('plan approval');

    // Dropping a choice description or the footer must not classify as plan approval.
    expect(readScreen('codex', planRaw.replace('Switch to Default and start coding', '')).kind).toBe('unknown');
    expect(readScreen('codex', planRaw.replace('Continue planning with the model', '')).kind).toBe('unknown');
    expect(readScreen('codex', planRaw.replace(/enter.*esc.*back/, 'press any key')).kind).toBe('unknown');

    // Wide 0.167.0 question requires both the Question N/N header and the combined footer.
    const questionRaw = capture0167('question');
    expect(readScreen('codex', questionRaw.replace('Question 1/1 (1 unanswered)', 'Question 2/3 (2 unanswered)')).kind).toBe(
      'question',
    );
    expect(readScreen('codex', questionRaw.replace('Question 1/1 (1 unanswered)', 'Select a greeting:')).kind).not.toBe(
      'question',
    );
    expect(
      readScreen('codex', questionRaw.replace(/tab.*to add notes.*enter.*to submit answer.*esc.*to interrupt/, 'enter to submit'))
        .kind,
    ).toBe('unknown');
  });

  test('scene 5 (trust-captures, conformance, capture-coverage, and docs lockstep): all nine 0.167.0 captures and range docs are synchronized', () => {
    const stages = ['exit', 'idle-unattended', 'idle', 'permission', 'plan-approval', 'question', 'trust', 'unsent', 'working'];
    const conformance = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'conformance.json'), 'utf8')) as {
      screens: { file: string; cli: string; classify: string; composer: string; provenance: string }[];
    };
    const coverage = JSON.parse(readFileSync(join(ROOT, 'contract', 'capture-coverage.json'), 'utf8')) as {
      fixtures: { file: string; cli: string; kind: string; provenance: string }[];
    };

    for (const stage of stages) {
      const rel = `codex/0.167.0/${stage}.txt`;
      expect(TRUST_CAPTURES).toContain(`codex ${rel}`);
      expect(conformance.screens.some((entry) => entry.file === rel && entry.cli === 'codex' && entry.provenance === 'capture')).toBe(
        true,
      );
      expect(coverage.fixtures.some((entry) => entry.file === rel && entry.cli === 'codex' && entry.provenance === 'capture')).toBe(
        true,
      );
    }

    const teamFileDoc = readFileSync(join(ROOT, 'docs', 'team-file.md'), 'utf8');
    expect(teamFileDoc).toContain('The Codex profile is tested with CLI 0.157.0 to 0.167.0.');
    const cliRangesDoc = readFileSync(join(ROOT, 'docs', 'specs', 'registries', 'cli-ranges.md'), 'utf8');
    expect(cliRangesDoc).toContain('Tested from `0.157.0` through `0.167.0` inclusive.');
  });
});
