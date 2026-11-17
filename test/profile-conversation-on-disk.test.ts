import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// 17 Nov reboot simulation: the lead's line runs Claude through a forwarding wrapper that keeps
// the start folder and the CLI's store. Its lead never took a turn, so its recorded conversation
// had no transcript; with every wrapper unmeasured the resume ran anyway and stopped at the
// CLI's "No conversation found". A wrapper is now read through only when it is the very file the
// seat's own recorded launch line runs, and that file holds the forwarding recipe (review round
// 6). No path is built into the source: the wrapper here lives in a temporary folder.
const RECIPE = '#!/usr/bin/env zsh\nset -eu\nexport GIT_AUTHOR_NAME=someone\nexec "$@"\n';

function wrapperIn(text = RECIPE): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forwarder-'));
  const path = join(dir, 'forward.sh');
  writeFileSync(path, text);
  return { dir, path };
}

test('a wrapper is measured only when it is the file the seat\'s recorded line runs, with the recipe', () => {
  const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
  const wrapper = wrapperIn();
  const copy = wrapperIn();
  try {
    const env = { CLAUDE_CONFIG_DIR: config, HOME: wrapper.dir };
    const cwd = '/home/someone/work/sim';
    const recorded = `zsh ${wrapper.path} claude --model haiku`;
    const lines = [
      `zsh ${wrapper.path} claude --model haiku --resume abc-2`,
      `AGENT_UNATTENDED=1 zsh ${wrapper.path} claude --resume abc-2`,
      `${wrapper.path} claude --resume abc-2`,
      'zsh ~/forward.sh claude --resume abc-2',
    ];
    for (const line of lines) expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, line, recorded), line).toBe(false);
    mkdirSync(join(config, 'projects', '-home-someone-work-sim'), { recursive: true });
    writeFileSync(join(config, 'projects', '-home-someone-work-sim', 'abc-2.jsonl'), '{}\n');
    for (const line of lines) expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, line, recorded), line).toBe(true);
    // A link to the recorded file is that file.
    symlinkSync(wrapper.path, join(copy.dir, 'linked.sh'));
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, `zsh ${join(copy.dir, 'linked.sh')} claude --resume abc-2`, recorded)).toBe(true);
    // No recorded line, or a recorded line naming another file — even an identical copy — is not
    // proof: unknown, and the resume stays.
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, lines[0])).toBeNull();
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, `zsh ${copy.path} claude --resume abc-2`, recorded)).toBeNull();
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, lines[0], `zsh ${copy.path} claude`)).toBeNull();
    // The wrapper running another wrapper is not read through.
    expect(conversationOnDisk('claude-code', cwd, 'abc-2', env, `zsh ${wrapper.path} zsh /tools/endpoint.sh --resume abc-2`, recorded)).toBeNull();
  } finally {
    for (const dir of [config, wrapper.dir, copy.dir]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the recorded wrapper changed to move the folder or the store stays unknown', () => {
  const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
  try {
    for (const changed of ['cd /tmp\nexec "$@"\n', 'export CLAUDE_CONFIG_DIR=/x\nexec "$@"\n', 'export HOME=/x\nexec "$@"\n', 'exec claude "$@"\n']) {
      const wrapper = wrapperIn(changed);
      try {
        const line = `zsh ${wrapper.path} claude --resume abc-3`;
        expect(conversationOnDisk('claude-code', '/w', 'abc-3', { CLAUDE_CONFIG_DIR: config }, line, line), changed).toBeNull();
      } finally {
        rmSync(wrapper.dir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});
