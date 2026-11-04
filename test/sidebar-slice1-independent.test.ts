import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySidebarLayout,
  DEFAULT_SIDEBAR_ROWS,
  hostConfigCheck,
  hostConfigPath,
  reloadConfig,
  reportDisplayAgent,
  setCaptureExec,
  setHerdrRun,
  SIDEBAR_BLOCK_MARKER,
  SIDEBAR_TOKENS,
  SIDEBAR_TTL_CAP_MS,
  spliceSidebarRows,
  STATUS_INDICATOR_VALUES,
  type SidebarApplyDeps,
} from '../src/herdr.ts';

const ROWS = DEFAULT_SIDEBAR_ROWS;
const CUSTOM_ROWS: readonly (readonly string[])[] = [
  ['state_icon', 'workspace', 'agent'],
  ['state_text', 'tab'],
];

describe('sidebar slice 1 independent verification', () => {
  let home: string;
  let configFile: string;
  let backupFile: string;
  let priorXdg: string | undefined;

  beforeEach(() => {
    priorXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    home = mkdtempSync(join(realpathSync(tmpdir()), 'sidebar-slice1-ind-'));
    configFile = hostConfigPath(home);
    backupFile = `${configFile}.team-backup`;
  });

  afterEach(() => {
    setCaptureExec(null);
    setHerdrRun(null);
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    rmSync(home, { recursive: true, force: true });
  });

  function writePriorConfig(content: string, mode = 0o600): void {
    mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
    writeFileSync(configFile, content, { mode });
    chmodSync(configFile, mode);
  }

  describe('rollback restores prior bytes on any check failure', () => {
    test('restores exact prior bytes and file mode on host config check parse failure, timeout, or empty output, without calling reload', () => {
      const priorBytes = [
        '# owner header comment',
        '[window]',
        'opacity = 0.92',
        '',
        '[ui]',
        'font_size = 15',
        'status_indicators = "dots"',
        '',
        '[keybindings]',
        'quit = "ctrl+q"',
        '',
      ].join('\n');
      writePriorConfig(priorBytes, 0o640);

      const failureModes: (() => string)[] = [
        () => {
          throw Object.assign(new Error('Command failed: herdr config check'), {
            stdout: 'config: issues found\nconfig parse error: unknown variant `bad`, expected `dots` or `symbols`\n',
          });
        },
        () => {
          throw Object.assign(new Error('spawnSync herdr ETIMEDOUT'), { code: 'ETIMEDOUT' });
        },
        () => {
          throw new Error('');
        },
      ];

      const reloadCalls: string[] = [];
      for (const failCheck of failureModes) {
        let observedDuringCheck = '';
        setCaptureExec((args) => {
          expect(args).toEqual(['config', 'check']);
          observedDuringCheck = readFileSync(configFile, 'utf8');
          return failCheck();
        });
        setHerdrRun((args, session) => {
          reloadCalls.push(`${session ?? 'default'}:${args.join(' ')}`);
          return { status: 'applied', diagnostics: [] };
        });

        const outcome = applySidebarLayout(home, CUSTOM_ROWS, 'symbols', ['alpha', 'beta'], {
          checkConfig: hostConfigCheck,
          reload: reloadConfig,
        });

        // During checkConfig the spliced candidate was on disk, then rolled back to priorBytes
        expect(observedDuringCheck).toContain(SIDEBAR_BLOCK_MARKER);
        expect(observedDuringCheck).not.toBe(priorBytes);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') {
          expect(outcome.restored).toBe(true);
          expect(outcome.reason.length).toBeGreaterThan(0);
        }
        expect(readFileSync(configFile, 'utf8')).toBe(priorBytes);
        expect(statSync(configFile).mode & 0o777).toBe(0o640);
        expect(readFileSync(backupFile, 'utf8')).toBe(priorBytes);
        expect(statSync(backupFile).mode & 0o777).toBe(0o600);
        expect(reloadCalls).toEqual([]);
      }
    });

    test('unlinks newly created config file when check fails on a fresh home and leaves no backup', () => {
      expect(existsSync(configFile)).toBe(false);
      let existedDuringCheck = false;
      const reloadCalls: string[] = [];

      const outcome = applySidebarLayout(home, ROWS, 'symbols', ['alpha'], {
        checkConfig: () => {
          existedDuringCheck = existsSync(configFile);
          return { ok: false, text: 'config: issues found' };
        },
        reload: (session) => {
          reloadCalls.push(session);
          return { applied: true, text: 'applied' };
        },
      });

      expect(existedDuringCheck).toBe(true);
      expect(outcome).toEqual({
        kind: 'refused',
        reason: 'config: issues found',
        restored: true,
      });
      expect(existsSync(configFile)).toBe(false);
      expect(existsSync(backupFile)).toBe(false);
      expect(reloadCalls).toEqual([]);
    });

    test('refuses dotted keys, unbounded arrays, inline tables, and symlinks before writing or checking', () => {
      const refusalInputs = [
        'ui.sidebar.agents.rows = [["agent"]]\n',
        '[other]\nx = 1\nui.status_indicators = "dots"\n',
        '[ui.sidebar.agents]\nrows = [\n  ["agent"]\n',
        '[ui.sidebar.agents]\nrows = { bad = true }\n',
      ];

      for (const badInput of refusalInputs) {
        writePriorConfig(badInput, 0o600);
        rmSync(backupFile, { force: true });
        let checkCalled = false;
        let reloadCalled = false;

        const outcome = applySidebarLayout(home, ROWS, 'symbols', ['alpha'], {
          checkConfig: () => {
            checkCalled = true;
            return { ok: true, text: 'config: ok' };
          },
          reload: () => {
            reloadCalled = true;
            return { applied: true, text: 'applied' };
          },
        });

        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') {
          expect(outcome.restored).toBe('untouched');
        }
        expect(checkCalled).toBe(false);
        expect(reloadCalled).toBe(false);
        expect(readFileSync(configFile, 'utf8')).toBe(badInput);
        expect(existsSync(backupFile)).toBe(false);
      }

      // Symlinked backup path is also refused without overwriting target
      const validPrior = '[ui]\nfont_size = 12\n';
      writePriorConfig(validPrior, 0o600);
      const outsideTarget = join(home, 'outside-target.toml');
      writeFileSync(outsideTarget, 'DO_NOT_TOUCH\n');
      symlinkSync(outsideTarget, backupFile);

      const symOutcome = applySidebarLayout(home, ROWS, 'symbols', ['alpha'], {
        checkConfig: () => ({ ok: true, text: 'config: ok' }),
        reload: () => ({ applied: true, text: 'applied' }),
      });
      expect(symOutcome.kind).toBe('refused');
      expect(readFileSync(configFile, 'utf8')).toBe(validPrior);
      expect(readFileSync(outsideTarget, 'utf8')).toBe('DO_NOT_TOUCH\n');
    });
  });

  describe('a commented header never ends a span', () => {
    test('commented headers inside a marked [ui.sidebar.agents] table do not terminate its replacement span', () => {
      const prior = [
        '[ui.sidebar.agents] # managed by team',
        'rows = [["agent"]]',
        '# [fake_header_one]',
        'stale_before = "remove-me"',
        '   # [ui]',
        'stale_after = "remove-me-too"',
        '',
        '[real_following_table]',
        'keep = "yes"',
        '',
      ].join('\n');

      const spliced = spliceSidebarRows(prior, CUSTOM_ROWS, 'dots');
      expect(spliced.ok).toBe(true);
      if (!spliced.ok) return;
      expect(spliced.changed).toBe(true);
      expect(spliced.text).toBe(
        [
          `[ui.sidebar.agents] ${SIDEBAR_BLOCK_MARKER}`,
          'rows = [["state_icon", "workspace", "agent"], ["state_text", "tab"]]',
          '',
          '[real_following_table]',
          'keep = "yes"',
          '',
          '[ui]',
          `status_indicators = "dots" ${SIDEBAR_BLOCK_MARKER}`,
          '',
        ].join('\n'),
      );
      expect(spliced.text).not.toContain('stale_before');
      expect(spliced.text).not.toContain('stale_after');
      expect(spliced.text).not.toContain('fake_header_one');
    });

    test('commented headers inside an unmarked [ui.sidebar.agents] or [ui] table do not hide keys below them', () => {
      const prior = [
        '[ui.sidebar.agents]',
        'custom_top = 1',
        '# [commented.section]',
        'rows = [',
        '  ["agent"],',
        '  ["tab"]',
        ']',
        '# [another.commented.header]',
        'custom_bottom = 2',
        '',
        '[ui]',
        'font_size = 13',
        '# [ui.commented_subtable]',
        'status_indicators = "dots"',
        'line_height = 1.4',
        '',
        '[after]',
        'ok = true',
        '',
      ].join('\n');

      const spliced = spliceSidebarRows(prior, ROWS, 'symbols');
      expect(spliced.ok).toBe(true);
      if (!spliced.ok) return;
      expect(spliced.text).toBe(
        [
          `[ui.sidebar.agents] ${SIDEBAR_BLOCK_MARKER}`,
          'custom_top = 1',
          '# [commented.section]',
          'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
          '# [another.commented.header]',
          'custom_bottom = 2',
          '',
          '[ui]',
          'font_size = 13',
          '# [ui.commented_subtable]',
          `status_indicators = "symbols" ${SIDEBAR_BLOCK_MARKER}`,
          'line_height = 1.4',
          '',
          '[after]',
          'ok = true',
          '',
        ].join('\n'),
      );
      // Exactly one `rows =` and one `status_indicators =` exist after adopting across commented headers
      expect(spliced.text.match(/^rows\s*=/gm)).toHaveLength(1);
      expect(spliced.text.match(/^status_indicators\s*=/gm)).toHaveLength(1);
    });
  });

  describe('a per-session reload failure keeps the validated edit and names the session', () => {
    test('keeps the spliced config and backup on disk and reports each failed session with its error text', () => {
      const prior = '[ui]\nfont_size = 16\n';
      writePriorConfig(prior, 0o600);

      setCaptureExec((args) => {
        expect(args).toEqual(['config', 'check']);
        return 'config: ok\n';
      });
      setHerdrRun((args, session) => {
        expect(args).toEqual(['server', 'reload-config']);
        if (session === 'session-alpha') return { status: 'applied', diagnostics: [] };
        if (session === 'session-beta') {
          return { status: 'applied', diagnostics: ['sidebar reload rejected by session-beta'] };
        }
        if (session === 'session-gamma') {
          throw new Error('server_not_running: session-gamma');
        }
        return { status: 'applied', diagnostics: [] };
      });

      const outcome = applySidebarLayout(
        home,
        CUSTOM_ROWS,
        'symbols',
        ['session-alpha', 'session-beta', 'session-gamma', 'session-delta'],
        {
          checkConfig: hostConfigCheck,
          reload: reloadConfig,
        },
      );

      expect(outcome).toEqual({
        kind: 'applied',
        reloaded: ['session-alpha', 'session-delta'],
        failed: [
          {
            session: 'session-beta',
            text: JSON.stringify({ status: 'applied', diagnostics: ['sidebar reload rejected by session-beta'] }),
          },
          {
            session: 'session-gamma',
            text: 'server_not_running: session-gamma',
          },
        ],
      });

      // The validated edit stands on disk and is not rolled back
      const expectedSplice = spliceSidebarRows(prior, CUSTOM_ROWS, 'symbols');
      expect(expectedSplice.ok).toBe(true);
      if (expectedSplice.ok) {
        expect(readFileSync(configFile, 'utf8')).toBe(expectedSplice.text);
      }
      expect(readFileSync(backupFile, 'utf8')).toBe(prior);
    });
  });

  describe('a second run is a no-op', () => {
    test('second apply with identical layout returns unchanged, skips disk write and checkConfig, preserves original backup, and still reloads sessions', () => {
      const originalPrior = '# initial user config\n[ui]\nfont_size = 14\n';
      writePriorConfig(originalPrior, 0o600);

      let checkCalls = 0;
      const reloadedSessions: string[] = [];
      const deps: SidebarApplyDeps = {
        checkConfig: () => {
          checkCalls += 1;
          return { ok: true, text: 'config: ok' };
        },
        reload: (session) => {
          reloadedSessions.push(session);
          if (session === 'flaky-session' && reloadedSessions.filter((s) => s === 'flaky-session').length === 2) {
            return { applied: false, text: 'reload_timeout' };
          }
          return { applied: true, text: 'applied' };
        },
      };

      // First run: writes config, creates backup of originalPrior, checks config, reloads
      const first = applySidebarLayout(home, CUSTOM_ROWS, 'dots', ['steady-session', 'flaky-session'], deps);
      expect(first).toEqual({
        kind: 'applied',
        reloaded: ['steady-session', 'flaky-session'],
        failed: [],
      });
      expect(checkCalls).toBe(1);
      expect(readFileSync(backupFile, 'utf8')).toBe(originalPrior);

      // Set an older mtime on both configFile and backupFile to prove the second run touches neither
      const fixedPast = new Date('2026-01-15T00:00:00.000Z');
      utimesSync(configFile, fixedPast, fixedPast);
      utimesSync(backupFile, fixedPast, fixedPast);
      const statBeforeSecond = statSync(configFile);
      const backupStatBeforeSecond = statSync(backupFile);

      // Second run with the same rows and indicators: no-op on disk, no checkConfig call, backup untouched
      const second = applySidebarLayout(home, CUSTOM_ROWS, 'dots', ['steady-session', 'flaky-session'], deps);
      expect(second).toEqual({
        kind: 'unchanged',
        reloaded: ['steady-session'],
        failed: [{ session: 'flaky-session', text: 'reload_timeout' }],
      });
      expect(checkCalls).toBe(1);

      const statAfterSecond = statSync(configFile);
      const backupStatAfterSecond = statSync(backupFile);
      expect(statAfterSecond.ino).toBe(statBeforeSecond.ino);
      expect(statAfterSecond.mtimeMs).toBe(statBeforeSecond.mtimeMs);
      expect(backupStatAfterSecond.ino).toBe(backupStatBeforeSecond.ino);
      expect(backupStatAfterSecond.mtimeMs).toBe(backupStatBeforeSecond.mtimeMs);
      expect(readFileSync(backupFile, 'utf8')).toBe(originalPrior);
    });
  });

  describe('reportDisplayAgent TTL boundaries and vocabulary exports', () => {
    test('accepts positive safe integers up to SIDEBAR_TTL_CAP_MS and refuses values outside the cap or non-integers without calling host', () => {
      expect(SIDEBAR_TOKENS).toEqual(['state_icon', 'machine', 'workspace', 'tab', 'state_text', 'agent']);
      expect(STATUS_INDICATOR_VALUES).toEqual(['dots', 'symbols']);
      expect(SIDEBAR_TTL_CAP_MS).toBe(86_400_000);

      const calls: string[][] = [];
      setCaptureExec((args) => {
        calls.push(args);
        return '{}';
      });

      expect(reportDisplayAgent('pane-alpha', 'Builder 1', 'acme', 1)).toBe(true);
      expect(reportDisplayAgent('pane-alpha', 'Builder 1', 'acme', SIDEBAR_TTL_CAP_MS)).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([
        '--session',
        'acme',
        'pane',
        'report-metadata',
        'pane-alpha',
        '--source',
        'team',
        '--display-agent',
        'Builder 1',
        '--ttl-ms',
        '1',
      ]);
      expect(calls[1]?.at(-1)).toBe(String(SIDEBAR_TTL_CAP_MS));

      for (const invalidTtl of [0, -1, SIDEBAR_TTL_CAP_MS + 1, 12.34, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(reportDisplayAgent('pane-alpha', 'Builder 1', 'acme', invalidTtl)).toBe(false);
      }
      expect(calls).toHaveLength(2);
    });
  });
});
