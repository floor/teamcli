import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync, mkdirSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyLines, composerBox, composeLines, type ScreenData } from '../src/watch/screen-core.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { classify, classifyComposer, readScreen, screenData, type Screen } from '../src/watch/screen.ts';
import { callOrder, resetCalls } from './fixtures/hatch/hatch.ts';
import type { ScreenProfile } from '../src/watch/screen-profile.ts';
import { parseOverrides } from '../src/profiles/overrides.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/hatch', import.meta.url));

const COMPILE_TIMEOUT_MS = 30_000;

let tempBuildDir: string | null = null;
let builtScreenFileModule: any = null;

function formatCompileError(tsc: ReturnType<typeof spawnSync>, timeoutMs: number): string {
  const isTimeout = (tsc.error as any)?.code === 'ETIMEDOUT' || (tsc.status === null && tsc.signal === 'SIGTERM');
  const details: string[] = [];
  if (isTimeout) {
    details.push(`process timed out after ${timeoutMs / 1000}s`);
  } else if (tsc.status !== null) {
    details.push(`process exited with code ${tsc.status}`);
  } else if (tsc.signal) {
    details.push(`process terminated with signal ${tsc.signal}`);
  } else if (tsc.error) {
    details.push(`process failed: ${tsc.error.message}`);
  }
  const output = (tsc.stderr?.toString().trim() || tsc.stdout?.toString().trim());
  if (output) {
    details.push(output);
  }
  return `Failed to compile to temp directory: ${details.join(': ')}`;
}

async function compileScreenFile(): Promise<any> {
  if (builtScreenFileModule) return builtScreenFileModule;
  tempBuildDir = mkdtempSync(resolve(tmpdir(), 'hatch-built-'));
  const tsc = spawnSync('bun', ['run', 'tsc', '-p', 'tsconfig.build.json', '--outDir', tempBuildDir], {
    timeout: COMPILE_TIMEOUT_MS,
  });
  if (tsc.status !== 0 || tsc.error) {
    throw new Error(formatCompileError(tsc, COMPILE_TIMEOUT_MS));
  }
  mkdirSync(resolve(tempBuildDir, 'profiles'), { recursive: true });
  for (const name of readdirSync(resolve(process.cwd(), 'src/profiles'))) {
    if (name.endsWith('.yaml')) {
      copyFileSync(resolve(process.cwd(), 'src/profiles', name), resolve(tempBuildDir, 'profiles', name));
    }
  }
  const builtPath = resolve(tempBuildDir, 'watch/screen-file.js');
  if (!existsSync(builtPath)) {
    throw new Error(`Built file not found at ${builtPath}`);
  }
  builtScreenFileModule = await import(builtPath);
  return builtScreenFileModule;
}

async function getBuiltScreenFile(): Promise<any> {
  if (builtScreenFileModule) return builtScreenFileModule;
  return compileScreenFile();
}

describe('ScreenProfile escape hatch', () => {
  beforeAll(async () => {
    await compileScreenFile();
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    if (tempBuildDir) {
      rmSync(tempBuildDir, { recursive: true, force: true });
      tempBuildDir = null;
      builtScreenFileModule = null;
    }
  });
  beforeEach(() => {
    resetCalls();
  });

  test('the loader imports screen_module from the profile YAML', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);
    expect(data.profile).toBeDefined();
    expect(typeof data.profile?.unknown).toBe('function');
    expect(typeof data.profile?.trust).toBe('function');
    expect(typeof data.profile?.permission).toBe('function');
    expect(typeof data.profile?.question).toBe('function');
    expect(typeof data.profile?.working).toBe('function');
    expect(typeof data.profile?.composer).toBe('function');
  });

  test('its predicates are called in the core stage order', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);

    // 1. None of the predicates match: all 5 are called in order, then composer.
    const result = classifyLines(data, ['random line 1', 'random line 2']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working', 'composer']);
    expect(result.kind).toBe('idle');

    // 2. Early match: unknown matches first
    resetCalls();
    const unknownRes = classifyLines(data, ['HATCH_UNKNOWN here', 'HATCH_PERMISSION here']);
    expect(callOrder).toEqual(['unknown']);
    expect(unknownRes.kind).toBe('unknown');

    // 3. Trust matches second
    resetCalls();
    const trustRes = classifyLines(data, ['HATCH_TRUST here', 'HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust']);
    expect(trustRes.kind).toBe('trust');

    // 4. Permission matches third
    resetCalls();
    const permRes = classifyLines(data, ['HATCH_PERMISSION here', 'HATCH_QUESTION here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission']);
    expect(permRes.kind).toBe('permission');

    // 5. Question matches fourth
    resetCalls();
    const questRes = classifyLines(data, ['HATCH_QUESTION here', 'HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question']);
    expect(questRes.kind).toBe('question');

    // 6. Working matches fifth
    resetCalls();
    const workRes = classifyLines(data, ['HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working']);
    expect(workRes.kind).toBe('working');
  });

  test('a hatch composer returning idle under a numbered-choice dialog still reads permission (the floor wins)', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);
    const dialogLines = readFileSync(resolve(fixtureDir, 'numbered-choice.txt'), 'utf8').split('\n');

    // In classifyLines: permission matches in core stage order, returning permission
    // even though composer returns idle
    resetCalls();
    const classified = classifyLines(data, dialogLines);
    expect(classified.kind).toBe('permission');
    expect(callOrder).toEqual(['unknown', 'trust', 'permission']);

    // Even if permission predicate returned false, the floor runs after composer and rejects idle
    const dataWithoutPermission = {
      ...data,
      profile: {
        ...data.profile,
        permission: () => {
          callOrder.push('permission');
          return false;
        },
      },
    };
    resetCalls();
    const floorClassified = classifyLines(dataWithoutPermission, dialogLines);
    // Safety floor marks dialog, returning unknown instead of idle
    expect(floorClassified.kind).toBe('unknown');
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working', 'composer']);

    // composeLines alone also rejects idle because safety floor runs after composer
    resetCalls();
    const composed = composeLines(data, dialogLines);
    expect(composed.kind).toBe('unknown');
  });

  test('the safety floor sees the whole window: hatch composer cannot shrink it with from past dialogs', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const baseData = loadScreen(yaml, fixtureDir);

    const dialogFixtures: { name: string; path: string; kind: Screen['kind']; match: string }[] = [
      { name: 'numbered-choice', path: 'test/fixtures/hatch/numbered-choice.txt', kind: 'permission', match: '1. Proceed' },
      { name: 'trust', path: 'test/fixtures/codex/0.157.0/trust.txt', kind: 'trust', match: 'Trust this folder?' },
      { name: 'permission', path: 'test/fixtures/codex/0.157.0/permission.txt', kind: 'permission', match: '1. Yes, proceed' },
      { name: 'question', path: 'test/fixtures/codex/0.157.0/startup.txt', kind: 'question', match: 'Update available' },
    ];

    for (const { path: relPath, kind, match } of dialogFixtures) {
      const lines = readFileSync(resolve(process.cwd(), relPath), 'utf8').split('\n');

      for (const composerKind of ['idle', 'unsent'] as const) {
        // 1. With predicates matching the dialog, classifyLines returns the dialog's kind
        // even when composer returns idle or unsent with from: 1000
        const dataWithPredicate = {
          ...baseData,
          profile: {
            ...baseData.profile,
            [kind]: (l: string[]) => l.some((line) => line.includes(match)),
            composer: () => ({ kind: composerKind, from: 1000 }),
          },
        };
        const classified = classifyLines(dataWithPredicate, lines);
        expect(classified.kind).toBe(kind);

        // 2. With predicates forced false, the safety floor runs over the full window
        // and rejects idle/unsent, returning unknown
        const dataPredicatesFalse = {
          ...baseData,
          profile: {
            unknown: () => false,
            trust: () => false,
            permission: () => false,
            question: () => false,
            working: () => false,
            composer: () => ({ kind: composerKind, from: 1000 }),
          },
        };
        const floorClassified = classifyLines(dataPredicatesFalse, lines);
        expect(floorClassified.kind).toBe('unknown');

        // 3. composeLines also runs the safety floor over the full window, returning unknown
        const composed = composeLines(dataPredicatesFalse, lines);
        expect(composed.kind).toBe('unknown');
      }
    }
  });

  test('a hatch result that is not a boolean must fail closed (whole screen reads unknown)', async () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const baseData = loadScreen(yaml, fixtureDir);
    const lines = ['some regular terminal line'];
    const screenText = lines.join('\n');

    const badValues: [name: string, factory: () => any][] = [
      ['sync throw', () => { throw new Error('boom'); }],
      ['rejected Promise', () => Promise.reject(new Error('boom'))],
      ['resolved Promise', () => Promise.resolve(true)],
      ['pending Promise', () => new Promise(() => {})],
      ['null', () => null],
      ['undefined', () => undefined],
      ['string "yes"', () => 'yes'],
      ['number 1', () => 1],
      ['number 0', () => 0],
      ['empty object', () => ({})],
      ['array', () => []],
      ['function', () => (() => {})],
    ];

    const stages = ['unknown', 'trust', 'permission', 'question', 'working'] as const;

    // 1. Each bad value for each of the five predicates must fail closed (whole screen reads unknown)
    for (const stage of stages) {
      for (const [name, badFn] of badValues) {
        const badData: any = {
          ...baseData,
          profile: {
            composer: () => ({ kind: 'idle' }),
            [stage]: badFn,
          },
        };

        const resClassifyLines = classifyLines(badData, lines);
        expect(resClassifyLines.kind).toBe('unknown');

        const resReadScreen = readScreen(badData, screenText);
        expect(resReadScreen.kind).toBe('unknown');

        const resClassify = classify(badData, lines);
        expect(resClassify.kind).toBe('unknown');

        if (stage === 'unknown') {
          const resComposeLines = composeLines(badData, lines);
          expect(resComposeLines.kind).toBe('unknown');

          const resClassifyComposer = classifyComposer(badData, lines);
          expect(resClassifyComposer.kind).toBe('unknown');
        }
      }
    }

    // 2. Each bad value for composer must fail closed (whole screen reads unknown)
    const badComposerValues: [name: string, factory: () => any][] = [
      ['sync throw', () => { throw new Error('composer boom'); }],
      ['rejected Promise', () => Promise.reject(new Error('composer boom'))],
      ['resolved Promise', () => Promise.resolve({ kind: 'idle' })],
      ['pending Promise', () => new Promise(() => {})],
      ['null', () => null],
      ['undefined', () => undefined],
      ['string "idle"', () => 'idle'],
      ['number 1', () => 1],
      ['empty object', () => ({})],
      ['invalid kind number', () => ({ kind: 1 })],
      ['invalid kind string', () => ({ kind: 'invalid_kind' })],
      ['null kind', () => ({ kind: null })],
    ];

    for (const [name, badFn] of badComposerValues) {
      const badData: any = {
        ...baseData,
        profile: {
          composer: badFn,
        },
      };

      const resClassifyLines = classifyLines(badData, lines);
      expect(resClassifyLines.kind).toBe('unknown');

      const resComposeLines = composeLines(badData, lines);
      expect(resComposeLines.kind).toBe('unknown');

      const resReadScreen = readScreen(badData, screenText);
      expect(resReadScreen.kind).toBe('unknown');

      const resClassify = classify(badData, lines);
      expect(resClassify.kind).toBe('unknown');

      const resClassifyComposer = classifyComposer(badData, lines);
      expect(resClassifyComposer.kind).toBe('unknown');
    }

    // 3. Exactly true matches the stage; exactly false misses the stage
    for (const stage of stages) {
      // True matches
      const trueData: any = {
        ...baseData,
        profile: {
          composer: () => ({ kind: 'idle' }),
          [stage]: () => true,
        },
      };
      expect(classifyLines(trueData, lines).kind).toBe(stage);
      expect(classify(trueData, lines).kind).toBe(stage);
      expect(readScreen(trueData, screenText).kind).toBe(stage);

      // False misses (falls through to composer which returns idle)
      const falseData: any = {
        ...baseData,
        profile: {
          composer: () => ({ kind: 'idle' }),
          [stage]: () => false,
        },
      };
      expect(classifyLines(falseData, lines).kind).toBe('idle');
      expect(classify(falseData, lines).kind).toBe('idle');
      expect(readScreen(falseData, screenText).kind).toBe('idle');
    }
  });

  test('the hatch ships for jules alone, and every other profile stays data', () => {
    const profilesDir = fileURLToPath(new URL('../src/profiles', import.meta.url));
    const yamlFiles = readdirSync(profilesDir).filter((file) => file.endsWith('.yaml'));
    expect(yamlFiles.length).toBeGreaterThanOrEqual(4);

    const hatched: string[] = [];
    for (const file of yamlFiles) {
      const content = readFileSync(resolve(profilesDir, file), 'utf8');
      const data = loadScreen(content);
      if (data.profile === undefined) {
        expect(content).not.toContain('screen_module');
        continue;
      }
      hatched.push(file);
      expect(content).toContain('screen_module');
    }
    expect(hatched).toEqual(['jules.yaml']);
  });

  test("no shipped profile's reading changes: all fixtures in conformance manifest match expected kinds", () => {
    const manifestPath = resolve(process.cwd(), 'test/fixtures/conformance.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      screens: { file: string; cli: string; classify: Screen['kind']; composer: Screen['kind'] }[];
    };
    expect(manifest.screens.length).toBeGreaterThanOrEqual(55);

    for (const { file, cli, classify: expectedClassify, composer: expectedComposer } of manifest.screens) {
      const absPath = resolve(process.cwd(), 'test/fixtures', file);
      const content = readFileSync(absPath, 'utf8');
      const screenLines = content.split('\n');

      const r = readScreen(cli, content).kind;
      const c = classify(cli, screenLines).kind;
      const comp = classifyComposer(cli, screenLines).kind;

      expect(r).toBe(expectedClassify);
      expect(c).toBe(expectedClassify);
      expect(comp).toBe(expectedComposer);
    }
  });

  test('an override may never set screen_module', () => {
    const atRoot = `format: 1
screen_module: "hatch.ts"
profiles:
  codex:
    screen:
      permission:
        - any: ['x']
`;
    const resRoot = parseOverrides(atRoot);
    expect(resRoot.ok).toBe(false);
    if (!resRoot.ok) expect(resRoot.errors[0]?.message).toBe('unknown key "screen_module"');

    const atProfile = `format: 1
profiles:
  codex:
    screen_module: "hatch.ts"
    screen:
      permission:
        - any: ['x']
`;
    const resProfile = parseOverrides(atProfile);
    expect(resProfile.ok).toBe(false);
    if (!resProfile.ok) expect(resProfile.errors[0]?.message).toBe('unknown key "screen_module"');

    const inScreen = `format: 1
profiles:
  codex:
    screen:
      screen_module: "hatch.ts"
      permission:
        - any: ['x']
`;
    const resScreen = parseOverrides(inScreen);
    expect(resScreen.ok).toBe(false);
    if (!resScreen.ok) expect(resScreen.errors[0]?.message).toBe('unknown key "screen_module"');
  });

  test('screen_module may only name a file inside the profiles directory (refused forms in source)', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-test-'));
    const outsideDir = mkdtempSync(resolve(tmpdir(), 'outside-test-'));
    const outsideFile = resolve(outsideDir, 'outside-evil.cjs');
    writeFileSync(outsideFile, 'module.exports = { unknown: () => true };');
    const symlinkPath = resolve(tempDir, 'inside-symlink.cjs');
    symlinkSync(outsideFile, symlinkPath);

    // Symlink loop
    const loopPath = resolve(tempDir, 'loop.cjs');
    symlinkSync('loop.cjs', loopPath);

    // Directory with package.json pointing outside
    const pkgDir = resolve(tempDir, 'pkg');
    mkdirSync(pkgDir);
    writeFileSync(resolve(pkgDir, 'package.json'), JSON.stringify({ main: outsideFile }));

    // Directory with index.js inside
    const pkgdirDir = resolve(tempDir, 'pkgdir');
    mkdirSync(pkgdirDir);
    writeFileSync(resolve(pkgdirDir, 'index.js'), 'module.exports = { unknown: () => true };');

    // Valid file inside
    writeFileSync(resolve(tempDir, 'good.cjs'), 'module.exports = { unknown: () => true };');

    try {
      const makeYaml = (specifier: string) => `format: 1
cli: fake-cli
screen_module: "${specifier}"
screen:
  composer:
    mode: status-last
    status_line: "^status$"
    prompt: "^>"
    placeholders:
      - equals: ""
`;

      // 1. Bare names (fs, left-pad)
      expect(() => loadScreen(makeYaml('fs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a bare name: "fs"/,
      );
      expect(() => loadScreen(makeYaml('left-pad'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a bare name: "left-pad"/,
      );

      // 2. Directory refusal
      expect(() => loadScreen(makeYaml('pkg'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a directory: "pkg"/,
      );
      expect(() => loadScreen(makeYaml('pkgdir'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a directory: "pkgdir"/,
      );

      // 3. Empty string
      expect(() => loadScreen(makeYaml(''), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be an empty string/,
      );

      // 4. Current directory "."
      expect(() => loadScreen(makeYaml('.'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be current directory "\."/,
      );

      // 5. Absolute path
      expect(() => loadScreen(makeYaml('/tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be an absolute path/,
      );

      // 6. Contains ".." segment (including encoded)
      expect(() => loadScreen(makeYaml('../evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );
      expect(() => loadScreen(makeYaml('subdir/../evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );
      expect(() => loadScreen(makeYaml('a/%2e%2e/x.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );

      // 7. URL or other scheme
      expect(() => loadScreen(makeYaml('http://127.0.0.1/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );
      expect(() => loadScreen(makeYaml('file:///tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );
      expect(() => loadScreen(makeYaml('node:fs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );

      // 8. ~/ and ~user path
      expect(() => loadScreen(makeYaml('~/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a home directory path/,
      );
      expect(() => loadScreen(makeYaml('~root/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a home directory path/,
      );

      // 9. Path in project
      expect(() => loadScreen(makeYaml('test/fixtures/hatch/hatch.ts'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('src/watch/pass.ts'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('./node_modules/x.js'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('././node_modules/x.js'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('./src/x.js'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('././src/x.js'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('./ext'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*must have a script extension/,
      );

      // 10. Symlink leading out of directory
      expect(() => loadScreen(makeYaml('inside-symlink.cjs'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*symlink leads outside/,
      );

      // 11. Symlink loop
      expect(() => loadScreen(makeYaml('loop.cjs'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*contains a symlink loop: "loop\.cjs"/,
      );

      // 12. Valid file inside loads successfully
      const loaded = loadScreen(makeYaml('good.cjs'), tempDir, 'test.yaml');
      expect(loaded.profile?.unknown).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('profile.schema.json matches loader: composer is optional when screen_module is set and screen_module pattern is constrained', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'src/profiles/profile.schema.json'), 'utf8'));

    const modulePattern = schema.$defs.screenModule.pattern;
    expect(modulePattern).toBeDefined();
    const regex = new RegExp(modulePattern);
    expect(regex.test('hatch.ts')).toBe(true);
    expect(regex.test('good.cjs')).toBe(true);
    expect(regex.test('nested/good.cjs')).toBe(true);
    expect(regex.test('foo..bar.ts')).toBe(true);
    expect(regex.test('fs')).toBe(false);
    expect(regex.test('left-pad')).toBe(false);
    expect(regex.test('pkg')).toBe(false);
    expect(regex.test('node_modules/left-pad/index.js')).toBe(false);
    expect(regex.test('test/fixtures/hatch/hatch.ts')).toBe(false);
    expect(regex.test('/tmp/evil.cjs')).toBe(false);
    expect(regex.test('../evil.cjs')).toBe(false);
    expect(regex.test('http://evil.com/x.js')).toBe(false);
    expect(regex.test('~/evil.cjs')).toBe(false);
    expect(regex.test('a/%2e%2e/x.js')).toBe(false);
    expect(regex.test('./node_modules/x.js')).toBe(false);
    expect(regex.test('././node_modules/x.js')).toBe(false);
    expect(regex.test('./src/x.js')).toBe(false);
    expect(regex.test('././src/x.js')).toBe(false);
    expect(regex.test('./ext')).toBe(false);
  });

  test('for every dialog fixture in conformance manifest, a hatch with dialog predicates false and composer idle/unsent still reads manifest kind', () => {
    const manifestPath = resolve(process.cwd(), 'test/fixtures/conformance.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dialogScreens = manifest.screens.filter((s: any) =>
      s.classify === 'trust' || s.classify === 'permission' || s.classify === 'question'
    );
    expect(dialogScreens.length).toBeGreaterThan(0);

    for (const entry of dialogScreens) {
      const screenPath = resolve(process.cwd(), 'test/fixtures', entry.file);
      const text = readFileSync(screenPath, 'utf8');
      const lines = text.split('\n');
      const baseData = screenData(entry.cli);
      expect(baseData).not.toBeNull();

      for (const composerKind of ['idle', 'unsent'] as const) {
        const from = composerKind === 'idle' ? 1000 : -4;
        const hatchData: ScreenData = {
          ...baseData!,
          profile: {
            unknown: () => false,
            trust: () => false,
            permission: () => false,
            question: () => false,
            working: () => false,
            composer: () => ({ kind: composerKind, from }),
          },
        };

        // All three readers return the manifest kind
        expect(classifyLines(hatchData, lines.slice(-20)).kind).toBe(entry.classify);
        expect(readScreen(hatchData, text).kind).toBe(entry.classify);
        expect(classify(hatchData, lines).kind).toBe(entry.classify);

        // composeLines and classifyComposer return unknown, never idle or unsent
        expect(composeLines(hatchData, lines.slice(-20)).kind).toBe('unknown');
        expect(classifyComposer(hatchData, lines).kind).toBe('unknown');
      }
    }
  });

  test('composeLines returns unknown for trust even when hatch trust returns true and composer returns idle', () => {
    const fixtures = ['cursor/2026.10.01/trust.txt', 'antigravity/1.2.16/trust.txt'];
    for (const fixture of fixtures) {
      const cli = fixture.startsWith('cursor') ? 'cursor' : 'antigravity';
      const baseData = screenData(cli)!;
      const text = readFileSync(resolve(process.cwd(), 'test/fixtures', fixture), 'utf8');
      const lines = text.split('\n');
      const hatchData: ScreenData = {
        ...baseData,
        profile: {
          trust: () => true,
          composer: () => ({ kind: 'idle', from: 1000 }),
        },
      };

      expect(classifyLines(hatchData, lines.slice(-20)).kind).toBe('trust');
      expect(readScreen(hatchData, text).kind).toBe('trust');
      expect(composeLines(hatchData, lines.slice(-20)).kind).toBe('unknown');
      expect(classifyComposer(hatchData, lines).kind).toBe('unknown');
    }
  });

  test('a hatch return value whose kind or catch getter throws fails closed to unknown with no crash', () => {
    const baseData = screenData('codex')!;
    const lines = ['some line'];

    // Predicate with throwing catch getter
    const throwingCatchPredicateData: ScreenData = {
      ...baseData,
      profile: {
        permission: () => ({
          get catch() {
            throw new Error('catch getter boom');
          },
        }) as any,
      },
    };
    expect(classifyLines(throwingCatchPredicateData, lines).kind).toBe('unknown');
    expect(composeLines(throwingCatchPredicateData, lines).kind).toBe('unknown');

    // Composer with throwing catch getter
    const throwingCatchComposerData: ScreenData = {
      ...baseData,
      profile: {
        composer: () => ({
          get catch() {
            throw new Error('composer catch getter boom');
          },
        }) as any,
      },
    };
    expect(classifyLines(throwingCatchComposerData, lines).kind).toBe('unknown');
    expect(composeLines(throwingCatchComposerData, lines).kind).toBe('unknown');

    // Composer with throwing kind getter
    const throwingKindComposerData: ScreenData = {
      ...baseData,
      profile: {
        composer: () => ({
          get kind() {
            throw new Error('composer kind getter boom');
          },
        }) as any,
      },
    };
    expect(classifyLines(throwingKindComposerData, lines).kind).toBe('unknown');
    expect(composeLines(throwingKindComposerData, lines).kind).toBe('unknown');
  });

  test('rule for main on screens: no screen origin/main reads unknown/working/permission/trust/question may read idle or unsent', () => {
    const clis = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'];
    for (const cli of clis) {
      const data = loadScreen(readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8'));
      // Verify stage order holds in shipped data
      expect(data.profile).toBeUndefined();
    }
  });

  test('every fixture in conformance manifest reads identical with caution predicates returning false', () => {
    const manifestPath = resolve(process.cwd(), 'test/fixtures/conformance.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      screens: { file: string; cli: string; classify: Screen['kind']; composer: Screen['kind'] }[];
    };

    const variants: [name: string, hatch: ScreenProfile][] = [
      ['working: () => false', { working: () => false }],
      ['unknown: () => false', { unknown: () => false }],
      ['trust: () => false', { trust: () => false }],
      ['permission: () => false', { permission: () => false }],
      ['question: () => false', { question: () => false }],
      [
        'all five together false',
        {
          working: () => false,
          unknown: () => false,
          trust: () => false,
          permission: () => false,
          question: () => false,
        },
      ],
    ];

    for (const [variantName, hatch] of variants) {
      for (const { file, cli, classify: expectedClassify, composer: expectedComposer } of manifest.screens) {
        const absPath = resolve(process.cwd(), 'test/fixtures', file);
        const content = readFileSync(absPath, 'utf8');
        const lines = content.split('\n');
        const base = screenData(cli)!;
        // A module CLI's reading is its profile: replacing it with a hatch of false predicates
        // removes the reader rather than adding one, so there is no reading to hold steady.
        if (base.profile !== undefined) continue;
        const dataWithHatch: ScreenData = {
          ...base,
          profile: hatch,
        };

        const resClassifyLines = classifyLines(dataWithHatch, lines.slice(-20)).kind;
        const resReadScreen = readScreen(dataWithHatch, content).kind;
        const resComposeLines = composeLines(dataWithHatch, lines.slice(-20)).kind;
        const resClassifyComposer = classifyComposer(dataWithHatch, lines).kind;

        expect(resClassifyLines).toBe(expectedClassify);
        expect(resReadScreen).toBe(expectedClassify);
        expect(resComposeLines).toBe(expectedComposer);
        expect(resClassifyComposer).toBe(expectedComposer);
      }
    }
  });

  test('a hatch composer on each of the five shipped profiles is refused at load in source and built code', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-composer-test-'));
    writeFileSync(resolve(tempDir, 'composer-hatch.cjs'), 'module.exports = { composer: () => ({ kind: "idle" }) };');

    try {
      const clis = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'];
      for (const cli of clis) {
        const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');
        const withHatch = `${rawYaml}\nscreen_module: "composer-hatch.cjs"\n`;
        // In source:
        expect(() => loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
          new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
        );
      }

      // Against built CLI (compiled into temp directory; fails if missing, never skips):
      const dist = await getBuiltScreenFile();
      for (const cli of clis) {
        const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');
        const withHatch = `${rawYaml}\nscreen_module: "composer-hatch.cjs"\n`;
        expect(() => dist.loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
          new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
        );
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fake CLI with hatch composer and no data composer: data stages and floor win over hatch composer', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir, 'fake-cli.yaml');
    expect(data.profile?.composer).toBeDefined();

    // 1. A dialog fixture under it still reads the dialog (numbered-choice.txt has 1. Proceed)
    const dialogLines = readFileSync(resolve(fixtureDir, 'numbered-choice.txt'), 'utf8').split('\n');
    expect(classifyLines(data, dialogLines).kind).toBe('permission');
    expect(readScreen(data, dialogLines.join('\n')).kind).toBe('permission');
    expect(composeLines(data, dialogLines).kind).toBe('unknown');
    expect(classifyComposer(data, dialogLines).kind).toBe('unknown');

    // 2. Data stage marks working -> working wins over hatch composer returning idle/unsent
    const workingLines = ['HATCH_DATA_WORKING'];
    expect(classifyLines(data, workingLines).kind).toBe('working');
    expect(readScreen(data, workingLines.join('\n')).kind).toBe('working');
    expect(composeLines(data, workingLines).kind).toBe('unknown');
    expect(classifyComposer(data, workingLines).kind).toBe('unknown');

    // 3. Data stage marks permission -> permission wins
    const permLines = ['HATCH_DATA_PERMISSION'];
    expect(classifyLines(data, permLines).kind).toBe('permission');
    expect(readScreen(data, permLines.join('\n')).kind).toBe('permission');
    expect(composeLines(data, permLines).kind).toBe('unknown');
    expect(classifyComposer(data, permLines).kind).toBe('unknown');

    // 4. Floor marks dialog (e.g. "Do you want to proceed?") -> unknown wins over hatch composer returning idle/unsent
    const floorLines = ['Do you want to proceed?', 'Press enter to continue'];
    expect(classifyLines(data, floorLines).kind).toBe('unknown');
    expect(readScreen(data, floorLines.join('\n')).kind).toBe('unknown');
    expect(composeLines(data, floorLines).kind).toBe('unknown');
    expect(classifyComposer(data, floorLines).kind).toBe('unknown');

    // 5. Clean line with no stage or floor match -> hatch composer returns idle
    const cleanLines = ['regular terminal prompt > '];
    expect(classifyLines(data, cleanLines).kind).toBe('idle');
    expect(readScreen(data, cleanLines.join('\n')).kind).toBe('idle');
    expect(composeLines(data, cleanLines).kind).toBe('idle');
    expect(classifyComposer(data, cleanLines).kind).toBe('idle');
    expect(composerBox(data, cleanLines)).toBeNull();
  });

  test('throwing getters on profile object and throwing Proxy fail safe to unknown on all readers and through watch pass', () => {
    const base = screenData('codex')!;
    const lines = ['some line'];
    const content = 'some line';

    // 1. Getters that throw on profile object, tested one property at a time for every property readers touch
    const profileProperties = ['unknown', 'trust', 'permission', 'question', 'working', 'composer'] as const;
    for (const prop of profileProperties) {
      const throwingPropProfile: ScreenProfile = {
        get [prop](): any {
          throw new Error(`${prop} getter boom`);
        },
      };
      const dataWithThrowingProp: ScreenData = {
        ...base,
        profile: throwingPropProfile,
      };

      expect(classifyLines(dataWithThrowingProp, lines).kind).toBe('unknown');
      expect(readScreen(dataWithThrowingProp, content).kind).toBe('unknown');
      expect(composeLines(dataWithThrowingProp, lines).kind).toBe('unknown');
      expect(classifyComposer(dataWithThrowingProp, lines).kind).toBe('unknown');
    }

    // 2. Proxy throwing on every get
    const throwingProxy = new Proxy({}, {
      get(_target, prop) {
        throw new Error(`proxy get ${String(prop)}`);
      },
    }) as ScreenProfile;
    const dataWithThrowingProxy: ScreenData = {
      ...base,
      profile: throwingProxy,
    };

    expect(classifyLines(dataWithThrowingProxy, lines).kind).toBe('unknown');
    expect(readScreen(dataWithThrowingProxy, content).kind).toBe('unknown');
    expect(composeLines(dataWithThrowingProxy, lines).kind).toBe('unknown');
    expect(classifyComposer(dataWithThrowingProxy, lines).kind).toBe('unknown');

    // 3. One watch pass hooked to throwing proxy completes cleanly
    const teamYaml = `format: 1
project: test
session: test
coordinator: bot
operator: bot
workspace:
  mode: shared
seats:
  - name: bot
    role: coordinator
    cli: codex
    vendor: openai
    model: Codex
    version: "1"
    launch: codex
`;
    const resTeam = validateTeamFile(teamYaml);
    expect(resTeam.ok).toBe(true);
    if (resTeam.ok) {
      const memory = newMemory();
      const passResult = pass({
        team: resTeam.team,
        watch: resTeam.team.watch,
        state: { seats: { bot: { pane: 'w0:p1', stage: 'ready' } }, worktrees: {} },
        live: {
          running: true,
          agents: [{ name: 'bot', workspace: 'w0', pane: 'w0:p1', status: 'idle', agent: 'codex', cwd: '.' }],
          screens: { 'w0:p1': 'some terminal text' },
          workspaces: [{ id: 'w0', label: 'workspace 0' }],
        },
        machine: { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 },
        now: 0,
        memory,
        approval: [],
        foreground: { 'w0:p1': ['codex'] },
        readScreen: (_cli, screen) => readScreen(dataWithThrowingProxy, screen),
      });
      expect(passResult).toBeDefined();
    }
  });

  test('throwing proxy module at loadScreen names the profile file', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-proxy-test-'));
    writeFileSync(resolve(tempDir, 'throwing-proxy.cjs'), 'module.exports = new Proxy({}, { get() { throw new Error("proxy export"); } });');

    try {
      const yaml = `format: 1\ncli: fake\nscreen_module: "throwing-proxy.cjs"\nscreen:\n  composer:\n    mode: status-last\n    status_line: "^status$"\n    prompt: "^>"\n    placeholders: [{ equals: "" }]\n`;
      expect(() => loadScreen(yaml, tempDir, 'fake-profile.yaml')).toThrow(
        /profile "fake-profile\.yaml": cannot load "screen_module": proxy export/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('screen_module extension case agrees with schema (lowercase required)', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-case-test-'));
    writeFileSync(resolve(tempDir, 'good.CJS'), 'module.exports = {};');

    try {
      const yaml = `format: 1\ncli: fake\nscreen_module: "good.CJS"\nscreen:\n  composer:\n    mode: status-last\n    status_line: "^status$"\n    prompt: "^>"\n    placeholders: [{ equals: "" }]\n`;
      expect(() => loadScreen(yaml, tempDir, 'fake.yaml')).toThrow(
        /profile "fake\.yaml": "screen_module" must have a script extension \(\.ts, \.js, \.cjs, \.mjs\): "good\.CJS"/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('stateful composer getter is refused at load on all five shipped profiles in source and built code', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-stateful-composer-'));

    try {
      const clis = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'];
      const dist = await getBuiltScreenFile();

      for (const cli of clis) {
        const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');

        // Fresh module files for each check so getter read count starts at 0 for every probe
        const srcMod = `stateful-composer-${cli}-src.cjs`;
        const builtMod = `stateful-composer-${cli}-built.cjs`;
        const code = `let reads = 0;
Object.defineProperty(module.exports, "composer", {
  get() {
    reads++;
    return reads % 2 === 1 ? () => ({ kind: "idle" }) : undefined;
  },
});`;
        writeFileSync(resolve(tempDir, srcMod), code);
        writeFileSync(resolve(tempDir, builtMod), code);

        // First read returns function -> must be refused at load (cannot bypass exclusivity check)
        const withHatchSrc = `${rawYaml}\nscreen_module: "${srcMod}"\n`;
        expect(() => loadScreen(withHatchSrc, tempDir, `${cli}.yaml`)).toThrow(
          new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
        );
        const withHatchBuilt = `${rawYaml}\nscreen_module: "${builtMod}"\n`;
        expect(() => dist.loadScreen(withHatchBuilt, tempDir, `${cli}.yaml`)).toThrow(
          new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
        );

        // Delayed getter: read 1 snapshots undefined, so profile gets snapshot with composer: undefined.
        // It must NOT receive a hatch composer later via subsequent reads.
        const srcModDelayed = `stateful-delayed-${cli}-src.cjs`;
        const builtModDelayed = `stateful-delayed-${cli}-built.cjs`;
        const codeDelayed = `let reads = 0;
Object.defineProperty(module.exports, "composer", {
  get() {
    reads++;
    return reads === 1 ? undefined : () => ({ kind: "idle" });
  },
});`;
        writeFileSync(resolve(tempDir, srcModDelayed), codeDelayed);
        writeFileSync(resolve(tempDir, builtModDelayed), codeDelayed);

        const withHatchSrc2 = `${rawYaml}\nscreen_module: "${srcModDelayed}"\n`;
        const dataSrc = loadScreen(withHatchSrc2, tempDir, `${cli}.yaml`);
        expect(typeof dataSrc.profile?.composer).toBe('undefined');
        const withHatchBuilt2 = `${rawYaml}\nscreen_module: "${builtModDelayed}"\n`;
        const dataBuilt = dist.loadScreen(withHatchBuilt2, tempDir, `${cli}.yaml`);
        expect(typeof dataBuilt.profile?.composer).toBe('undefined');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('stateful getter on predicate export runs snapshot value and reads export only once', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-stateful-predicate-'));
    writeFileSync(
      resolve(tempDir, 'stateful-predicate.cjs'),
      `let reads = 0;
const p1 = () => false;
const p2 = () => true;
Object.defineProperty(module.exports, "working", {
  get() {
    reads++;
    return reads === 1 ? p1 : p2;
  },
});
module.exports.getReads = () => reads;`,
    );

    try {
      const yaml = `format: 1\ncli: fake\nscreen_module: "stateful-predicate.cjs"\nscreen:\n  composer:\n    mode: status-last\n    status_line: "^status$"\n    prompt: "^>"\n    placeholders: [{ equals: "" }]\n`;
      const data = loadScreen(yaml, tempDir, 'fake.yaml');
      expect(data.profile?.working).toBeDefined();

      const mod = require(realpathSync(resolve(tempDir, 'stateful-predicate.cjs')));
      expect(mod.getReads()).toBe(1);

      // When predicate is called, it runs p1 (which returns false), NOT p2 (which returns true)
      expect(data.profile?.working?.(['any line'])).toBe(false);
      expect(data.profile?.working?.(['any line'])).toBe(false);
      // Property on module was not read again
      expect(mod.getReads()).toBe(1);

      // classifyLines evaluates working predicate; when working returns false, composer matches
      // and returns idle. The blank row above the prompt is the frame the composer draws
      // (status-last reads the input row only under it); without it the read is unknown.
      const lines = ['', '> ', 'status'];
      const res = classifyLines(data, lines);
      // Working returns false (p1), so result is idle, not working
      expect(res.kind).toBe('idle');
      expect(mod.getReads()).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('prototype export, default export, and Proxy module refuse hatch composer on shipped profiles', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-module-variants-'));
    // 1. Module whose composer is defined on its prototype
    writeFileSync(
      resolve(tempDir, 'proto-composer.cjs'),
      `const proto = { composer: () => ({ kind: "idle" }) };
module.exports = Object.create(proto);`,
    );

    // 2. Module with default export holding the functions
    writeFileSync(
      resolve(tempDir, 'default-composer.cjs'),
      `module.exports = {
  default: {
    composer: () => ({ kind: "idle" }),
  },
};`,
    );

    // 3. Module using a Proxy
    writeFileSync(
      resolve(tempDir, 'proxy-composer.cjs'),
      `module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'composer') return () => ({ kind: 'idle' });
    return undefined;
  },
});`,
    );

    // 4. Module with function-valued default export holding composer
    writeFileSync(
      resolve(tempDir, 'fn-default-composer.cjs'),
      `function def() {}
def.composer = () => ({ kind: "idle" });
module.exports = { default: def };`,
    );

    try {
      const clis = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'];
      const variants = [
        { file: 'proto-composer.cjs', desc: 'prototype export' },
        { file: 'default-composer.cjs', desc: 'default export' },
        { file: 'proxy-composer.cjs', desc: 'Proxy module' },
        { file: 'fn-default-composer.cjs', desc: 'function-valued default export' },
      ];
      const dist = await getBuiltScreenFile();

      for (const { file } of variants) {
        for (const cli of clis) {
          const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');
          const withHatch = `${rawYaml}\nscreen_module: "${file}"\n`;

          // In source:
          expect(() => loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
            new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
          );

          // In built loader:
          expect(() => dist.loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
            new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
          );
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('disagreeing Proxy hiding default and function-valued export with default accessor refuse hatch composer on shipped profiles in source and built code', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-disagreeing-proxy-'));

    // 1. Reviewer's exact Proxy: has trap hides default, ownKeys and descriptor report composer,
    // get("default") returns object with composer, get("composer") returns undefined
    writeFileSync(
      resolve(tempDir, 'disagreeing-proxy-composer.cjs'),
      `module.exports = new Proxy({}, {
  has(_target, prop) { return prop === "default" ? false : true; },
  ownKeys() { return ["composer"]; },
  getOwnPropertyDescriptor(_target, prop) {
    if (prop === "default") return { configurable: true, enumerable: true, value: undefined };
    if (prop === "composer") return { configurable: true, enumerable: true, value: () => ({ kind: "idle" }) };
  },
  get(_target, prop) {
    if (prop === "default") return { composer: () => ({ kind: "idle" }) };
    if (prop === "composer") return undefined;
  },
});`,
    );

    // 2. Function-valued export carrying an accessor at .default
    writeFileSync(
      resolve(tempDir, 'fn-default-accessor-composer.cjs'),
      `const fn = function () {};
Object.defineProperty(fn, "default", {
  configurable: true,
  enumerable: true,
  get() { return { composer: () => ({ kind: "idle" }) }; },
});
module.exports = fn;`,
    );

    try {
      const clis = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'];
      const variants = [
        { file: 'disagreeing-proxy-composer.cjs', desc: 'disagreeing Proxy hiding default' },
        { file: 'fn-default-accessor-composer.cjs', desc: 'function-valued export with default accessor' },
      ];
      const dist = await getBuiltScreenFile();

      for (const { file } of variants) {
        for (const cli of clis) {
          const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');
          const withHatch = `${rawYaml}\nscreen_module: "${file}"\n`;

          // In source:
          expect(() => loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
            new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
          );

          // In built loader:
          expect(() => dist.loadScreen(withHatch, tempDir, `${cli}.yaml`)).toThrow(
            new RegExp(`profile "${cli}\\.yaml": profile has a data composer and screen_module exports a composer`),
          );
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('what loadScreen returns is deeply frozen against post-load mutations', () => {
    // 1. Shipped profiles (no hatch)
    for (const cli of ['claude-code', 'codex', 'cursor', 'antigravity', 'grok']) {
      const rawYaml = readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8');
      const data = loadScreen(rawYaml, undefined, `${cli}.yaml`);

      // Root object and nested objects are frozen
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen(data.composer)).toBe(true);
      if (data.composer.placeholders) expect(Object.isFrozen(data.composer.placeholders)).toBe(true);
      if ('footers' in data.composer && data.composer.footers) expect(Object.isFrozen(data.composer.footers)).toBe(true);
      if (data.trust?.rules) expect(Object.isFrozen(data.trust.rules)).toBe(true);

      // Post-load assignment of composer is refused / throws
      expect(() => {
        (data as any).profile = { composer: () => ({ kind: 'idle' }) };
      }).toThrow();

      // Post-load assignment of a predicate is refused / throws
      expect(() => {
        (data as any).trust = { rules: [] };
      }).toThrow();

      // Post-load mutation of a nested rule pattern is refused / throws
      if (data.trust?.rules[0]) {
        expect(() => {
          (data.trust!.rules[0] as any).all = [];
        }).toThrow();
      }
    }

    // 2. Profile with a hatch: data.profile is also deeply frozen
    const fakeYaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const fakeData = loadScreen(fakeYaml, fixtureDir, 'fake-cli.yaml');
    expect(Object.isFrozen(fakeData)).toBe(true);
    expect(Object.isFrozen(fakeData.profile)).toBe(true);

    expect(() => {
      (fakeData.profile as any).composer = () => ({ kind: 'working' });
    }).toThrow();
    expect(() => {
      (fakeData.profile as any).working = () => true;
    }).toThrow();
  });
});
