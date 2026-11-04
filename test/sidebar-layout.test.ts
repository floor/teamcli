import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applySidebarLayout,
  DEFAULT_SIDEBAR_ROWS,
  hostConfigPath,
  SIDEBAR_BLOCK_MARKER,
  spliceSidebarRows,
  STATUS_INDICATOR_VALUES,
  type SidebarApplyDeps,
} from '../src/herdr.ts';

// The sidebar splice and the apply around it, against a scratch home. The host's two answers —
// config check and per-session reload — are injected, so a scene never needs a live session.

const ROWS = DEFAULT_SIDEBAR_ROWS;
const MARKED_TABLE = `[ui.sidebar.agents] ${SIDEBAR_BLOCK_MARKER}`;
const MARKED_UI = `status_indicators = "symbols" ${SIDEBAR_BLOCK_MARKER}`;

describe('hostConfigPath', () => {
  const prior = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  });

  test('an absolute XDG base is honored, a relative one is not', () => {
    process.env.XDG_CONFIG_HOME = '/xdg/base';
    expect(hostConfigPath('/home/o')).toBe('/xdg/base/herdr/config.toml');
    process.env.XDG_CONFIG_HOME = 'relative/base';
    expect(hostConfigPath('/home/o')).toBe('/home/o/.config/herdr/config.toml');
  });

  test('without XDG the config lives under the home', () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(hostConfigPath('/home/o')).toBe('/home/o/.config/herdr/config.toml');
  });
});

describe('the sidebar vocabulary', () => {
  test('the token and indicator vocabularies and the default layout are exported', () => {
    expect(STATUS_INDICATOR_VALUES).toEqual(['dots', 'symbols']);
    expect(ROWS).toEqual([
      ['state_icon', 'machine', 'workspace', 'tab'],
      ['state_text', 'agent'],
    ]);
  });
});

describe('spliceSidebarRows', () => {
  test('an empty config gains both keys, the table marked at its header', () => {
    const out = spliceSidebarRows('', ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(true);
    expect(out.text).toBe(
      [
        '[ui.sidebar.agents] # managed by team',
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        '',
        '[ui]',
        'status_indicators = "symbols" # managed by team',
        '',
      ].join('\n'),
    );
  });

  test('a marked table is replaced whole, stray lines inside it included', () => {
    const prior = [
      '# the owner keeps notes above',
      '[ui.sidebar.agents] # managed by team',
      'rows = [["agent"]]',
      'stale = true',
      '',
      '[ui]',
      'status_indicators = "dots" # managed by team',
      'font_size = 14',
      '',
    ].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      [
        '# the owner keeps notes above',
        MARKED_TABLE,
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        '',
        '[ui]',
        MARKED_UI,
        'font_size = 14',
        '',
      ].join('\n'),
    );
  });

  test('an unmarked table is adopted: rows spliced, marker added, other keys kept', () => {
    const prior = [
      '[ui.sidebar.agents]',
      'rows = [["agent"]]',
      'theme = "x"',
      '',
      '[ui]',
      'font_size = 14',
      '',
    ].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      [
        MARKED_TABLE,
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        'theme = "x"',
        '',
        '[ui]',
        MARKED_UI,
        'font_size = 14',
        '',
      ].join('\n'),
    );
  });

  test('an unmarked table without a rows key gains one under the header', () => {
    const prior = ['[ui.sidebar.agents]', 'theme = "x"', ''].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      [
        MARKED_TABLE,
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        'theme = "x"',
        '',
        '[ui]',
        MARKED_UI,
        '',
      ].join('\n'),
    );
  });

  test('a rows value spanning lines is replaced across its whole span', () => {
    const prior = [
      '[ui.sidebar.agents]',
      'rows = [',
      '  ["agent"],',
      ']',
      '',
      '[ui]',
      '',
    ].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      [
        MARKED_TABLE,
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        '',
        '[ui]',
        MARKED_UI,
        '',
      ].join('\n'),
    );
  });

  test('a hand-set status_indicators is adopted at its line, neighbours untouched', () => {
    const prior = ['[ui]', 'font_size = 14', 'status_indicators = "dots"', 'bold = true', ''].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      ['[ui]', 'font_size = 14', MARKED_UI, 'bold = true', '', MARKED_TABLE, 'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]', ''].join('\n'),
    );
  });

  test('commented anchors never match', () => {
    const prior = [
      '# [ui.sidebar.agents]',
      '# rows = [["agent"]]',
      '# status_indicators = "dots"',
      '[other]',
      'key = 1',
      '',
    ].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      [
        '# [ui.sidebar.agents]',
        '# rows = [["agent"]]',
        '# status_indicators = "dots"',
        '[other]',
        'key = 1',
        '',
        MARKED_TABLE,
        'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]',
        '',
        '[ui]',
        MARKED_UI,
        '',
      ].join('\n'),
    );
  });

  test('a dotted rows key is refused naming its line', () => {
    const prior = ['ui.sidebar.agents.rows = [["agent"]]', ''].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('dotted');
    expect(out.reason).toContain('line 1');
  });

  test('a dotted status_indicators key is refused naming its line', () => {
    const prior = ['[theme]', 'dark = true', 'ui.status_indicators = "dots"', ''].join('\n');
    const out = spliceSidebarRows(prior, ROWS, 'symbols');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('dotted');
    expect(out.reason).toContain('line 3');
  });

  test('a splice onto the target shape reads back equal', () => {
    const once = spliceSidebarRows('', ROWS, 'symbols');
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = spliceSidebarRows(once.text, ROWS, 'symbols');
    expect(twice).toEqual({ ok: true, text: once.text, changed: false });
  });

  test('an append separates with exactly one blank line, keeping the file’s own ending', () => {
    const noFinalNewline = '[other]\nkey = 1';
    const out = spliceSidebarRows(noFinalNewline, ROWS, 'symbols');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(
      ['[other]', 'key = 1', '', MARKED_TABLE, 'rows = [["state_icon", "machine", "workspace", "tab"], ["state_text", "agent"]]', '', '[ui]', MARKED_UI, ''].join('\n'),
    );
    const again = spliceSidebarRows(out.text, ROWS, 'symbols');
    expect(again).toEqual({ ok: true, text: out.text, changed: false });
  });
});

// The apply: a scratch home, the host's check and reload injected. Every scene states what the
// config, the backup and the mode hold afterwards.
describe('applySidebarLayout', () => {
  let home: string;
  let file: string;
  let reloads: string[];
  let reloadFailures: Record<string, string>;
  let checkOk: boolean;
  let deps: SidebarApplyDeps;
  let xdgBefore: string | undefined;

  const writeConfig = (text: string, mode = 0o600): void => {
    mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
    writeFileSync(file, text, { mode });
  };

  beforeEach(() => {
    xdgBefore = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    home = mkdtempSync(join(realpathSync(tmpdir()), 'sidebar-apply-'));
    file = hostConfigPath(home);
    reloads = [];
    reloadFailures = {};
    checkOk = true;
    deps = {
      checkConfig: () => (checkOk ? { ok: true, text: 'config: ok' } : { ok: false, text: 'config: issues found' }),
      reload: (session) => {
        reloads.push(session);
        const text = reloadFailures[session];
        return text === undefined ? { applied: true, text: 'applied' } : { applied: false, text };
      },
    };
  });

  afterEach(() => {
    if (xdgBefore === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdgBefore;
    reloads = [];
  });

  test('a fresh apply writes the spliced config at 0600, reloads each session, no backup', () => {
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one', 'two'], deps);
    expect(out).toEqual({ kind: 'applied', reloaded: ['one', 'two'], failed: [] });
    const text = readFileSync(file, 'utf8');
    const spliced = spliceSidebarRows('', ROWS, 'symbols');
    expect(spliced.ok && text === spliced.text).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(reloads).toEqual(['one', 'two']);
    // The backup is written only when a prior config existed.
    expect(() => readFileSync(`${file}.team-backup`)).toThrow();
  });

  test('a prior config is backed up byte-for-byte and its mode is preserved', () => {
    const prior = '[ui]\nfont_size = 14\n';
    writeConfig(prior, 0o644);
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], deps);
    expect(out.kind).toBe('applied');
    expect(readFileSync(`${file}.team-backup`, 'utf8')).toBe(prior);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readFileSync(file, 'utf8')).toContain('font_size = 14');
  });

  test('a refused check restores the prior bytes', () => {
    const prior = '[ui]\nfont_size = 14\n';
    writeConfig(prior, 0o600);
    checkOk = false;
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], deps);
    expect(out).toEqual({ kind: 'refused', reason: 'config: issues found', restored: true });
    expect(readFileSync(file, 'utf8')).toBe(prior);
    expect(reloads).toEqual([]);
  });

  test('a refused check on a fresh apply unlinks the file back', () => {
    checkOk = false;
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], deps);
    expect(out).toEqual({ kind: 'refused', reason: 'config: issues found', restored: true });
    expect(() => readFileSync(file)).toThrow();
  });

  test('a reload failure is named, not restored: the edit stands', () => {
    const prior = '[ui]\nfont_size = 14\n';
    writeConfig(prior);
    reloadFailures['two'] = 'server_not_running';
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one', 'two'], deps);
    expect(out).toEqual({
      kind: 'applied',
      reloaded: ['one'],
      failed: [{ session: 'two', text: 'server_not_running' }],
    });
    expect(readFileSync(file, 'utf8')).not.toBe(prior);
    expect(readFileSync(`${file}.team-backup`, 'utf8')).toBe(prior);
  });

  test('an unchanged config writes nothing but still reloads', () => {
    const target = spliceSidebarRows('', ROWS, 'symbols');
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    writeConfig(target.text);
    const before = statSync(file);
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], deps);
    expect(out).toEqual({ kind: 'unchanged', reloaded: ['one'], failed: [] });
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(file, 'utf8')).toBe(target.text);
    expect(() => readFileSync(`${file}.team-backup`)).toThrow();
  });

  test('a symlinked config is refused, nothing written', () => {
    const outside = join(home, 'elsewhere.toml');
    writeFileSync(outside, '[ui]\n');
    mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
    symlinkSync(outside, file);
    const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], deps);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.reason).toContain('a symbolic link');
    expect(out.restored).toBe('untouched');
    expect(reloads).toEqual([]);
    unlinkSync(file);
  });

  test('a refused check whose rollback throws reports restored: false', () => {
    const prior = '[ui]\nfont_size = 14\n';
    writeConfig(prior, 0o600);
    const dir = dirname(file);
    try {
      const out = applySidebarLayout(home, ROWS, 'symbols', ['one'], {
        checkConfig: () => {
          chmodSync(dir, 0o500);
          return { ok: false, text: 'config: issues found' };
        },
        reload: deps.reload,
      });
      expect(out).toEqual({ kind: 'refused', reason: 'config: issues found', restored: false });
      expect(reloads).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
