import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationMissingOnScreen, conversationOnDisk, withoutResume } from '../src/profiles/profile.ts';

test('a Claude Code conversation is found under its project folder, named from the cwd', () => {
  const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: config };
    const cwd = '/home/someone/.config/team/lobby-material';
    expect(conversationOnDisk('claude-code', cwd, 'abc-1', env)).toBe(false);
    mkdirSync(join(config, 'projects', '-home-someone--config-team-lobby-material'), { recursive: true });
    writeFileSync(join(config, 'projects', '-home-someone--config-team-lobby-material', 'abc-1.jsonl'), '{}\n');
    expect(conversationOnDisk('claude-code', cwd, 'abc-1', env)).toBe(true);
    // Another folder's project is not this one: Claude resumes by the folder it runs in.
    expect(conversationOnDisk('claude-code', '/home/someone/elsewhere', 'abc-1', env)).toBe(false);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('a CLI whose store is not measured is unknown, never missing', () => {
  expect(conversationOnDisk('codex', '/x', 'id', {})).toBeNull();
  expect(conversationOnDisk('antigravity', '/x', 'id', {})).toBeNull();
});

test('a measured resume is taken off the launch line', () => {
  expect(withoutResume('claude-code', 'claude --model m --resume abc-1')).toBe('claude --model m');
  expect(withoutResume('claude-code', 'claude -r abc-1 --model m')).toBe('claude --model m');
  expect(withoutResume('claude-code', 'claude --model m')).toBeNull();
  expect(withoutResume('codex', 'codex resume abc')).toBe('codex');
  expect(withoutResume('grok', 'grok -r ses:1')).toBe('grok');
  // A resume inside a trailing quoted script is followed by the closing quote: it is stripped
  // there, and the quotes stay. The shell's own -c is not a resume, and a line with none is null.
  expect(withoutResume('claude-code', '/bin/sh -c "claude --model m --resume abc-1"'))
    .toBe('/bin/sh -c "claude --model m"');
  expect(withoutResume('claude-code', 'zsh -lc "claude --resume abc-1 --model m"'))
    .toBe('zsh -lc "claude --model m"');
  expect(withoutResume('claude-code', '/bin/sh -c "claude --model m"')).toBeNull();
});

test('the refusal is read from the screen', () => {
  expect(conversationMissingOnScreen('claude-code', 'No conversation found with session ID:\nabc')).toBe(true);
  expect(conversationMissingOnScreen('claude-code', '❯ ')).toBe(false);
  expect(conversationMissingOnScreen('codex', 'No conversation found with session ID')).toBe(false);
});

// 17 Nov reboot simulation: the lead's line runs Claude through the team's forwarding wrapper
// (`zsh ~/…/as-floor.sh claude …`), which keeps the start folder and the CLI's store. Its lead
// never took a turn, so its recorded conversation had no transcript; with the wrapper unmeasured
// the resume ran anyway and stopped at the CLI's "No conversation found". The forwarding wrapper
// is now read through; any other wrapper stays unmeasured.
test('a line through the forwarding wrapper is measured; other wrappers stay unknown', () => {
  const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: config };
    const cwd = '/home/someone/work/sim';
    const lines = [
      `zsh ~/tools/as-floor.sh claude --model haiku --resume abc-2`,
      `AGENT_UNATTENDED=1 zsh /home/someone/tools/as-floor.sh claude --resume abc-2`,
      `/home/someone/tools/as-floor.sh claude --resume abc-2`,
    ];
    for (const line of lines) expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, line), line).toBe(false);
    mkdirSync(join(config, 'projects', '-home-someone-work-sim'), { recursive: true });
    writeFileSync(join(config, 'projects', '-home-someone-work-sim', 'abc-2.jsonl'), '{}\n');
    for (const line of lines) expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, line), line).toBe(true);
    // The forwarding wrapper running another wrapper (an alternate endpoint's script), or an
    // unknown wrapper, is not read through: its store is not measured.
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, 'zsh ~/tools/as-floor.sh zsh ~/tools/claude-deepseek.sh --resume abc-2')).toBeNull();
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, 'zsh ~/tools/other.sh claude --resume abc-2')).toBeNull();
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});
