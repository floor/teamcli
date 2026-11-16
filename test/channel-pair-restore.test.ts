// A lead's channel pair that went missing from its project folder (material, vlist and jedi,
// found 2026-11-16): setup keeps the pair out of untracked cleans with the checkout's own
// info/exclude, and the restore recreates it through setup for a lead whose launch line already
// carries the channel. Synthetic folders and fakes only: no real config writer, no real lead.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeLines, excludeLocally, excludeTarget } from '../src/mcp/local-exclude.ts';
import { channelOptionProven, channelRepairCandidates, channelRepairLine, noticeId, restoreLeadChannels } from '../src/launch/restore-channel.ts';
import { bareShellEmptyPrompt } from '../src/launch/bare-shell.ts';
import { CHANNEL_LOCAL_FILES } from '../src/mcp/setup.ts';
import type { Io } from '../src/io.ts';
import { gitEnv } from './helpers.ts';

let base: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(),
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-pair-restore-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("setup keeps the pair in the checkout's local exclude", () => {
  test('the files become ignored, a clean of untracked files leaves them, and nothing is committed', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'first');
    mkdirSync(join(repo, '.claude'));
    for (const name of CHANNEL_LOCAL_FILES) writeFileSync(join(repo, name), '{}\n');
    const done = excludeLocally(repo, CHANNEL_LOCAL_FILES);
    expect(done).toEqual({ added: ['/.mcp.json', '/.claude/settings.local.json', '/.team-channel-setup.json'] });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    git(repo, 'clean', '-fd');
    for (const name of CHANNEL_LOCAL_FILES) expect(readFileSync(join(repo, name), 'utf8')).toBe('{}\n');
    // Running again adds nothing, and the exclude file is the repository's own, never tracked.
    expect(excludeLocally(repo, CHANNEL_LOCAL_FILES)).toEqual({ added: [] });
    expect(git(repo, 'ls-files')).toBe('README.md\n');
  });

  test("a linked worktree writes the shared repository's exclude, anchored at its own top", () => {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'first');
    const tree = join(base, 'tree');
    git(repo, 'worktree', 'add', '-q', tree, '-b', 'side');
    const target = excludeTarget(tree);
    expect(target?.top).toBe(tree);
    expect(realpathSync(target!.gitDir)).toBe(realpathSync(join(repo, '.git')));
    expect(excludeLines(tree, join(tree, 'sub'), ['.mcp.json'])).toEqual(['/sub/.mcp.json']);
  });

  test('a folder outside any checkout is skipped', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(excludeLocally(plain, ['.mcp.json'])).toEqual({ skipped: 'the folder is not inside a git checkout' });
  });

  test('existing lines are kept and a file without a final newline is continued cleanly', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.log');
    expect(excludeLocally(repo, ['.mcp.json'])).toEqual({ added: ['/.mcp.json'] });
    const text = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(text.startsWith('*.log\n# team mcp setup')).toBe(true);
    expect(text.endsWith('/.mcp.json\n')).toBe(true);
  });
});

describe('an empty shell prompt, read from the screen', () => {
  test('only the primary prompt alone under its folder line is empty; anything else is not proof', () => {
    expect(bareShellEmptyPrompt('~/Code/acme\n❯\n\n')).toBe(true);
    expect(bareShellEmptyPrompt('~/Code/floor/md3.io main *1 ?1\n❯   ')).toBe(true);
    expect(bareShellEmptyPrompt('/tmp/x\n%')).toBe(true);
    // A glyph closing typed text, a continuation prompt, a prompt with words before it.
    expect(bareShellEmptyPrompt('~/Code/acme\n❯ echo #')).toBe(false);
    expect(bareShellEmptyPrompt('~/Code/acme\n❯ cat >')).toBe(false);
    expect(bareShellEmptyPrompt('~/Code/acme\n❯ cat <<EOF\n>')).toBe(false);
    expect(bareShellEmptyPrompt('jvial@mac acme %')).toBe(false);
    // No folder line above the prompt.
    expect(bareShellEmptyPrompt('❯')).toBe(false);
    expect(bareShellEmptyPrompt('some output\n❯')).toBe(false);
    expect(bareShellEmptyPrompt('❯ git status')).toBe(false);
    expect(bareShellEmptyPrompt('Resume this session with:\nclaude --resume x')).toBe(false);
    expect(bareShellEmptyPrompt('price$')).toBe(false);
    expect(bareShellEmptyPrompt('')).toBe(false);
    expect(bareShellEmptyPrompt(null)).toBe(false);
    expect(bareShellEmptyPrompt('\n\n  \n')).toBe(false);
  });
});

const ROOT = '/fixture/acme';
const seat = (name: string, over: Partial<{ cli: string; cwd: string; launch: string; stopped: boolean; human: boolean }> = {}) => ({
  name, cli: 'claude-code', cwd: '.', launch: 'claude --dangerously-load-development-channels server:team-inbox', ...over,
});

describe('the restore recreates a missing lead pair through setup', () => {
  const team = (seats: ReturnType<typeof seat>[]) => ({ orchestrator: 'lead', operator: 'op', session: 'acme', seats }) as never;

  test('only a running Claude lead in the root whose line carries the channel and whose pair is gone', () => {
    const present = (_dir: string, name: string) => name === 'op';
    expect(channelRepairCandidates(team([seat('lead'), seat('op')]), ROOT, present)).toEqual(['lead']);
    // No channel flag on the line: setup never ran for it, so no pair is invented.
    expect(channelRepairCandidates(team([seat('lead', { launch: 'claude --model opus' }), seat('op')]), ROOT, () => false)).toEqual(['op']);
    // Another folder, a stopped or human lead, or another CLI is never touched.
    expect(channelRepairCandidates(team([seat('lead', { cwd: 'worktrees/x' }), seat('op', { stopped: true })]), ROOT, () => false)).toEqual([]);
    expect(channelRepairCandidates(team([seat('lead', { human: true }), seat('op', { cli: 'codex' })]), ROOT, () => false)).toEqual([]);
    // A worker seat is never a candidate, whatever its line says.
    expect(channelRepairCandidates(team([seat('lead'), seat('op'), seat('worker')]), ROOT, (_d, n) => n !== 'worker')).toEqual([]);
  });

  test('a recreated pair notifies the lead once, as the owner, with the pane variable left out', async () => {
    let made = false;
    const ran: { seat: string; io: Io }[] = [];
    const told: { lead: string; body: string; id: string }[] = [];
    const repairs = await restoreLeadChannels({
      home: '/fixture/home', root: ROOT, team: team([seat('lead'), seat('op')]), caller: { kind: 'owner' },
      deps: {
        present: (_dir, name) => name === 'op' || made,
        setup: async (name, io) => { ran.push({ seat: name, io }); made = true; return 0; },
        notify: (one) => { told.push(one); return true; },
        now: () => new Date('2026-11-16T09:00:00Z'),
      },
    });
    expect(repairs).toEqual([{ seat: 'lead', outcome: 'recreated', detail: 'the lead was told to reconnect /mcp' }]);
    expect(ran.map((one) => one.seat)).toEqual(['lead']);
    expect(ran[0]!.io.cwd).toBe(ROOT);
    expect(ran[0]!.io.env.HERDR_PANE_ID).toBeUndefined();
    expect(told).toHaveLength(1);
    expect(told[0]!.lead).toBe('lead');
    expect(told[0]!.body).toContain('reconnect team-inbox');
    expect(told[0]!.id).toBe(noticeId(ROOT, 'acme', 'lead', '20261116'));
    expect(told[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(channelRepairLine(repairs)).toBe('lead: channel pair recreated (the lead was told to reconnect /mcp)');
  });

  test("a setup refusal is reported with setup's own last line, and no one is told", async () => {
    const told: unknown[] = [];
    const repairs = await restoreLeadChannels({
      home: '/fixture/home', root: ROOT, team: team([seat('lead'), seat('op', { stopped: true })]), caller: { kind: 'owner' },
      deps: {
        present: () => false,
        setup: async (_name, io) => { io.stderr('team mcp setup: the launch claim changed during setup\n'); return 1; },
        notify: (one) => { told.push(one); return true; },
      },
    });
    expect(repairs).toEqual([{ seat: 'lead', outcome: 'refused', detail: 'team mcp setup: the launch claim changed during setup' }]);
    expect(told).toEqual([]);
  });

  test('a setup that exits 0 without leaving the pair counts as refused', async () => {
    const repairs = await restoreLeadChannels({
      home: '/fixture/home', root: ROOT, team: team([seat('lead'), seat('op', { stopped: true })]), caller: { kind: 'owner' },
      deps: { present: () => false, setup: async () => 0, notify: () => true },
    });
    expect(repairs[0]?.outcome).toBe('refused');
  });

  test('a flag-shaped word in a quoted prompt, after --, or behind an unknown option is no evidence', async () => {
    const lines = [
      "claude --append-system-prompt 'remember --dangerously-load-development-channels server:team-inbox later'",
      'claude --append-system-prompt --dangerously-load-development-channels server:team-inbox',
      'claude --model opus -- --dangerously-load-development-channels server:team-inbox',
      'claude --some-new-option --dangerously-load-development-channels server:team-inbox',
      'echo claude --dangerously-load-development-channels server:team-inbox | sh',
      'echo claude --dangerously-load-development-channels server:team-inbox',
      'printf %s claude --dangerously-load-development-channels server:team-inbox',
      'zsh ~/tools/other.sh claude --dangerously-load-development-channels server:team-inbox',
      'nice claude --dangerously-load-development-channels server:team-inbox',
      'zsh ~/tools/launch.sh --dangerously-load-development-channels server:team-inbox',
      'claude --dangerously-load-development-channels server:other-server',
    ];
    for (const launch of lines) {
      expect(channelOptionProven(launch), launch).toBe(false);
      let ran = false;
      await restoreLeadChannels({
        home: '/fixture/home', root: ROOT, team: team([seat('lead', { launch }), seat('op', { stopped: true })]), caller: { kind: 'owner' },
        deps: { present: () => false, setup: async () => { ran = true; return 0; }, notify: () => true },
      });
      expect(ran, launch).toBe(false);
    }
  });

  test("the channel option in the CLI's own argv, plain or through a forwarding wrapper, is evidence", () => {
    for (const launch of [
      'claude --model opus --dangerously-load-development-channels server:team-inbox',
      'claude --dangerously-load-development-channels=server:other,server:team-inbox --name Priam',
      "AGENT_UNATTENDED=1 zsh ~/tools/as-floor.sh claude --model opus --append-system-prompt-file /x/rules.md --dangerously-skip-permissions --dangerously-load-development-channels server:team-inbox",
      'zsh -lc "claude --model opus --dangerously-load-development-channels server:team-inbox"',
    ]) {
      expect(channelOptionProven(launch), launch).toBe(true);
    }
  });

  test('nothing missing means nothing run', async () => {
    const repairs = await restoreLeadChannels({
      home: '/fixture/home', root: ROOT, team: team([seat('lead'), seat('op')]), caller: { kind: 'owner' },
      deps: { present: () => true, setup: async () => { throw new Error('setup must not run'); } },
    });
    expect(repairs).toEqual([]);
    expect(channelRepairLine(repairs)).toBeNull();
  });
});
