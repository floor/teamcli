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

test('the resume is taken off a Claude Code line, and only there', () => {
  expect(withoutResume('claude-code', 'claude --model m --resume abc-1')).toBe('claude --model m');
  expect(withoutResume('claude-code', 'claude -r abc-1 --model m')).toBe('claude --model m');
  expect(withoutResume('claude-code', 'claude --model m')).toBeNull();
  expect(withoutResume('codex', 'codex resume abc')).toBeNull();
});

test('the refusal is read from the screen', () => {
  expect(conversationMissingOnScreen('claude-code', 'No conversation found with session ID:\nabc')).toBe(true);
  expect(conversationMissingOnScreen('claude-code', '❯ ')).toBe(false);
  expect(conversationMissingOnScreen('codex', 'No conversation found with session ID')).toBe(false);
});
