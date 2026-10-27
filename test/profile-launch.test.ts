import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TOOL_LOBBY_FILES, profileFor, shippedLobbyFiles, shippedStartupReads } from '../src/profiles/index.ts';
import { exitClearKey, inputBlockOf, launchCommand, lobbyFilesList, namedResumeTarget, resumeCarry, startupReadsList, supportsSessionResume, withResume } from '../src/profiles/profile.ts';
import { runningModel } from '../src/status/statusline.ts';

// Main's launch readers, copied here. The production files no longer have this code.
const FAMILIES: Record<string, string> = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable' };

function mainClaude(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model[= ]claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?=\s|$)/.exec(launch);
  if (!match) return null;
  const [, family = '', major = '', minor] = match;
  const model = FAMILIES[family];
  if (!model) return null;
  return { model, version: minor === undefined ? major : `${major}.${minor}` };
}

function mainCodexId(id: string): { model: string; version: string } | null {
  const match = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|luna|terra)$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return { model: `GPT ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] as string };
}

function mainCodex(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)(?:-m|--model)[= ]([^\s]+)(?=\s|$)/.exec(launch);
  return match ? mainCodexId(match[1] as string) : null;
}

function mainCursorId(id: string): { model: string; version: string } | null {
  const match = /^(?:cursor-)?grok-(\d+(?:\.\d+)*)(?:-(?:xhigh|high|medium|low)(?:-fast)?|-fast)?$/i.exec(id);
  const version = match?.[1];
  return version ? { model: 'Grok', version } : null;
}

function mainCursor(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model(?:=|\s+)(\S+)/.exec(launch);
  const id = match?.[1];
  return id ? mainCursorId(id) : null;
}

function mainAgyId(id: string): { model: string; version: string } | null {
  const match = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(high|medium|low))?$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return { model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] as string };
}

function mainAgy(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model[= ]([^\s]+)(?=\s|$)/.exec(launch);
  return match ? mainAgyId(match[1] as string) : null;
}

function mainRunning(cli: string, screen: string): { model: string; version: string } | null {
  const lines = screen.split('\n').slice(-6);
  if (cli === 'antigravity') {
    let found: { model: string; version: string } | null = null;
    for (const line of lines) {
      const match = /(?:^|[\s·|])Gemini\s+([0-9]+(?:\.[0-9]+)*)\s+(Flash|Pro)\b/i.exec(line);
      if (match && match[1] && match[2]) {
        const family = match[2];
        found = { model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] };
      }
    }
    return found;
  }
  if (cli === 'cursor') {
    let found: { model: string; version: string } | null = null;
    for (const line of lines) {
      const version = /(?:^|\s)Grok\s+(\d+(?:\.\d+)*)\b/.exec(line)?.[1];
      if (version) found = { model: 'Grok', version };
    }
    return found;
  }
  if (cli === 'codex') {
    const footer = lines.findLast((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
    const id = footer?.trim().split(/\s/)[0];
    return id ? mainCodexId(id) : null;
  }
  let found: { model: string; version: string } | null = null;
  for (const line of lines) {
    const match = /(?:^|[\s·|])(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)*)(?=$|[\s·|])/.exec(line);
    if (match) found = { model: `Claude ${match[1]}`, version: match[2] as string };
  }
  return found;
}

const launches: [string, string, (launch: string) => { model: string; version: string } | null][] = [
  ['claude-code', 'claude --model claude-opus-5-5', mainClaude],
  ['claude-code', 'claude --model=claude-fable-5-1 --verbose', mainClaude],
  ['claude-code', 'claude --model claude-haiku-4-5-20251001', mainClaude],
  ['claude-code', 'claude --model claude-opus-5', mainClaude],
  ['claude-code', 'team-deepseek', mainClaude],
  ['claude-code', 'claude --model claude-nova-9-1', mainClaude],
  ['claude-code', 'claude --model opus', mainClaude],
  ['codex', 'codex -m gpt-6-sol -c model_reasoning_effort=high', mainCodex],
  ['codex', 'codex --model=gpt-5.6-terra', mainCodex],
  ['codex', 'codex -m unknown', mainCodex],
  ['codex', 'launcher', mainCodex],
  ['cursor', 'cursor-agent --model grok-4.7-high', mainCursor],
  ['cursor', 'cursor-agent --model=grok-4.7-xhigh-fast', mainCursor],
  ['cursor', 'cursor-agent --model cursor-grok-4.5-high', mainCursor],
  ['cursor', 'cursor-agent --model cursor-grok-4.6-high-fast', mainCursor],
  ['cursor', 'cursor-agent --model grok-4.7', mainCursor],
  ['cursor', 'cursor-agent --model grok-4.7-high[context=256k]', mainCursor],
  ['cursor', 'cursor-agent --model gpt-5', mainCursor],
  ['cursor', 'cursor-agent', mainCursor],
  ['antigravity', 'agy --model gemini-3.8-flash-high', mainAgy],
  ['antigravity', 'agy --model=gemini-3.1-pro-low', mainAgy],
  ['antigravity', 'agy --model gemini-3.8-flash-medium', mainAgy],
  ['antigravity', 'agy --model gemini-3.7-flash-high', mainAgy],
  ['antigravity', 'agy --model unknown-model', mainAgy],
  ['antigravity', 'agy', mainAgy],
  ['claude-code', 'claude --model foo --model claude-opus-5-5', mainClaude],
];

// Main read null, or the first flag. The new reader keeps "=" or any whitespace, and the last flag.
const differences: [string, string, (launch: string) => { model: string; version: string } | null, { model: string; version: string } | null, { model: string; version: string } | null][] = [
  ['claude-code', 'claude --model  claude-opus-5-5', mainClaude, null, { model: 'Claude Opus', version: '5.5' }],
  ['claude-code', 'claude --model\tclaude-opus-5-5', mainClaude, null, { model: 'Claude Opus', version: '5.5' }],
  ['codex', 'codex -m  gpt-6-sol', mainCodex, null, { model: 'GPT Sol', version: '6' }],
  ['antigravity', 'agy --model  gemini-3.8-flash', mainAgy, null, { model: 'Gemini Flash', version: '3.8' }],
  ['codex', 'codex -m gpt-6-sol -m gpt-5.6-terra', mainCodex, { model: 'GPT Sol', version: '6' }, { model: 'GPT Terra', version: '5.6' }],
  ['cursor', 'cursor-agent --model grok-4.7 --model grok-4.5', mainCursor, { model: 'Grok', version: '4.7' }, { model: 'Grok', version: '4.5' }],
  ['antigravity', 'agy --model gemini-3.8-flash-high --model gemini-3.1-pro-low', mainAgy, { model: 'Gemini Flash', version: '3.8' }, { model: 'Gemini Pro', version: '3.1' }],
  ['claude-code', 'claude --model claude-opus-5-5 --model claude-sonnet-4-6', mainClaude, { model: 'Claude Opus', version: '5.5' }, { model: 'Claude Sonnet', version: '4.6' }],
];

const commands: [string, string, string, string][] = [
  ['claude-code', 'claude --model claude-opus-5-5 ', "Don't stop.\n- two", "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt 'Don'\\''t stop.\n- two'"],
  ['codex', 'codex -m gpt-6-sol', 'Rules.', 'AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen'],
  ['cursor', 'cursor-agent', 'Rules.', 'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled'],
  ['cursor', 'cursor-agent --model grok-4.7-high', 'Rules.', 'AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled'],
  ['antigravity', 'agy --model gemini-3.8-flash-high', 'Rules.', 'AGENT_UNATTENDED=1 agy --model gemini-3.8-flash-high --dangerously-skip-permissions'],
];

const screens: [string, string, string][] = [
  ['codex', 'codex/0.157.0/idle.txt', 'model'],
  ['codex', 'codex/0.157.0/trust.txt', 'none'],
  ['cursor', 'cursor/2026.10.01/idle.txt', 'model'],
  ['cursor', 'cursor/2026.10.01/rules-accepted.txt', 'model'],
  ['cursor', 'cursor/2026.10.01/trust.txt', 'none'],
  ['cursor', 'cursor/2026.10.01/exit.txt', 'none'],
  ['antigravity', 'antigravity/1.2.16/idle.txt', 'model'],
  ['antigravity', 'antigravity/1.2.16/rules-accepted.txt', 'model'],
  ['antigravity', 'antigravity/1.2.16/trust.txt', 'none'],
];

function same(label: string, after: unknown, before: unknown): void {
  expect(`${label}: ${JSON.stringify(after)}`).toBe(`${label}: ${JSON.stringify(before)}`);
}

describe('launch data through the profile files', () => {
  test('every launch the tests build matches main', () => {
    for (const [cli, launch, read] of launches) {
      const profile = profileFor(cli);
      same(`${cli} ${launch}`, profile?.modelOf(launch) ?? null, read(launch));
    }
    for (const [cli, launch, rules, expected] of commands) {
      const profile = profileFor(cli);
      if (!profile) throw new Error(cli);
      same(`${cli} command`, launchCommand(profile, launch, rules), expected);
    }
    const claudeScreen = `❯\n${'─'.repeat(40)}\n  main · …/floor/docs · Opus 5.5 · S: $5.8\n`;
    same('claude-code status', runningModel('claude-code', claudeScreen), mainRunning('claude-code', claudeScreen));
    same('claude-code bare', runningModel('claude-code', 'Do you want to proceed?\n1. Yes\n'), null);
    same('codex prose', runningModel('codex', 'GPT-6-Sol high'), null);
    const nova = '  GPT-9-Nova medium ·\n';
    same('codex unknown family', runningModel('codex', nova), mainRunning('codex', nova));
    const later = '  GPT-5.6-Terra medium ·\n  GPT-9-Nova medium ·\n';
    same('codex later unknown family', runningModel('codex', later), mainRunning('codex', later));
    for (const [cli, file] of screens) {
      const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
      same(`${cli} ${file}`, runningModel(cli, text), mainRunning(cli, text));
    }
  });

  test('the accepted modelOf differences', () => {
    for (const [cli, launch, read, before, after] of differences) {
      const profile = profileFor(cli);
      same(`${launch} on main`, read(launch), before);
      same(`${launch} now`, profile?.modelOf(launch) ?? null, after);
    }
  });
});

describe('the exit_clear a profile may name', () => {
  // One of the keys `pane send-keys` takes that empty an input box, or nothing. `enter` is
  // not among them on purpose: it sends what the box holds.
  test('one of the closed set, or absent for null', () => {
    expect(exitClearKey('exit: /exit')).toBe(null);
    expect(exitClearKey('exit: /exit\nexit_clear: ctrl+c')).toBe('ctrl+c');
    expect(exitClearKey('exit: /exit\nexit_clear: ctrl+u')).toBe('ctrl+u');
    expect(exitClearKey('exit: /exit\nexit_clear: escape')).toBe('escape');
    expect(exitClearKey('exit: /exit\nexit_clear: backspace')).toBe('backspace');
  });

  test('any other value is refused in words — enter included', () => {
    expect(() => exitClearKey('exit: /exit\nexit_clear: enter')).toThrow(
      '"exit_clear" must be one of: ctrl+c, ctrl+u, escape, backspace',
    );
    expect(() => exitClearKey('exit: /exit\nexit_clear: C-c')).toThrow(
      '"exit_clear" must be one of: ctrl+c, ctrl+u, escape, backspace',
    );
  });
});

describe('the lobby_files a profile may name', () => {
  // The exact relative paths of regular files a capture showed the CLI writing in its
  // working folder. The grammar is the profile's own, before any check of the disk: a
  // declaration is a value, not a folder.
  test('plain relative paths load, and an absent key is the empty list', () => {
    expect(lobbyFilesList('exit: /exit')).toEqual([]);
    expect(lobbyFilesList('exit: /exit\nlobby_files:\n  - .claude/scheduled_tasks.lock')).toEqual(['.claude/scheduled_tasks.lock']);
    expect(lobbyFilesList('exit: /exit\nlobby_files:\n  - a.lock\n  - b/c.lock')).toEqual(['a.lock', 'b/c.lock']);
  });

  test('a shape that is not a relative path of a file inside the lobby is refused', () => {
    for (const bad of [
      'lobby_files:\n  - /abs.lock',
      'lobby_files:\n  - .claude/',
      'lobby_files:\n  - .',
      'lobby_files:\n  - ..',
      'lobby_files:\n  - a/../b.lock',
      'lobby_files:\n  - a//b.lock',
      'lobby_files:\n  - ""',
      'lobby_files: not-a-list',
    ]) {
      expect(() => lobbyFilesList(`exit: /exit\n${bad}`)).toThrow(
        /"lobby_files" (must be a non-empty list|entries must be non-empty strings|holds ".*": not a relative path of a file inside the lobby)/,
      );
    }
  });

  test('a pattern character is refused: a declaration is one exact name at one exact place', () => {
    for (const bad of ['lobby_files:\n  - "*.lock"', 'lobby_files:\n  - .claude/*.lock', 'lobby_files:\n  - settings.[j]son', 'lobby_files:\n  - a/b?.lock']) {
      expect(() => lobbyFilesList(`exit: /exit\n${bad}`)).toThrow(
        /"lobby_files" holds ".*": a path is one exact name, not a pattern/,
      );
    }
  });

  test('one path running through another declares a file and a folder at once, and is refused', () => {
    expect(() => lobbyFilesList('exit: /exit\nlobby_files:\n  - a/b\n  - a/b/c.lock')).toThrow(
      '"lobby_files" holds "a/b" beside "a/b/c.lock": a file and a folder cannot share a path',
    );
  });

  test('the shipped profiles declare only what a capture showed, each path exactly once', () => {
    expect(profileFor('claude-code')?.lobbyFiles).toEqual(['.claude/scheduled_tasks.lock']);
    expect(profileFor('codex')?.lobbyFiles).toEqual([]);
    expect(profileFor('cursor')?.lobbyFiles).toEqual([]);
    expect(profileFor('antigravity')?.lobbyFiles).toEqual([]);
    expect(profileFor('grok')?.lobbyFiles).toEqual([]);
    expect(profileFor('gemini')?.lobbyFiles).toEqual([]);
    expect(profileFor('muse')?.lobbyFiles).toEqual([]);
  });

  test('the union of every shipped profile and the tool\'s own files is what a lobby may hold, whatever the team runs', () => {
    // The set a lobby gate reads cannot depend on a team's seats: it is every shipped
    // declaration together — plus the files the tool itself keeps there, today the reach
    // projection and its write's temporary — sorted and deduped, so a CLI another team runs
    // and the tool's own files are covered too.
    const perCli = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse']
      .flatMap((cli) => profileFor(cli)?.lobbyFiles ?? []);
    expect(shippedLobbyFiles()).toEqual([...new Set([...perCli, ...TOOL_LOBBY_FILES])].sort());
    expect(shippedLobbyFiles()).toContain('.claude/scheduled_tasks.lock');
    expect(shippedLobbyFiles()).toContain('reach-roster.json');
  });

  test('a path a CLI writes is not also a path a shipped CLI reads at start', () => {
    const reads = new Set(shippedStartupReads().map((read) => read.path));
    for (const path of shippedLobbyFiles()) expect(reads.has(path)).toBe(false);
  });
});

describe('the startup_reads a profile may name', () => {
  test('a trailing slash names a directory, and an absent key is the empty list', () => {
    expect(startupReadsList('exit: /exit')).toEqual([]);
    expect(startupReadsList('exit: /exit\nstartup_reads:\n  - CLAUDE.md\n  - .claude/rules/')).toEqual([
      { path: 'CLAUDE.md', directory: false },
      { path: '.claude/rules', directory: true },
    ]);
  });

  test('an absolute path, a parent, and a pattern are refused', () => {
    for (const bad of ['startup_reads:\n  - /abs.md', 'startup_reads:\n  - ..', 'startup_reads:\n  - a/../b.md', 'startup_reads:\n  - "*.md"']) {
      expect(() => startupReadsList(`exit: /exit\n${bad}`)).toThrow(/"startup_reads"/);
    }
  });

  // The session's own display name: a Claude Code launch carries `--name <display>` so a person
  // reading the session — its prompt box, its resume list, its terminal title — sees the seat's
  // readable name. The flag is appended after the unattended options, before the rules; a launch
  // line that writes `--name` or `-n` itself is the file's own word and is left alone; a CLI
  // whose help has not shown the flag takes none, and an empty name adds nothing.
  test('a claude-code launch carries the display name, and only where the CLI takes one', () => {
    const claude = profileFor('claude-code');
    const codex = profileFor('codex');
    if (!claude || !codex) throw new Error('the shipped profiles are missing');
    expect(launchCommand(claude, 'claude --model claude-opus-5-5', 'Rules.', undefined, undefined, 'Ada')).toBe(
      "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --name Ada --append-system-prompt Rules.",
    );
    expect(launchCommand(claude, 'claude --model claude-opus-5-5', 'Rules.', undefined, undefined, 'builder@floor')).toBe(
      "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --name builder@floor --append-system-prompt Rules.",
    );
    // The line's own `--name`, in either spelling, is what the file chose; an empty name adds none.
    expect(launchCommand(claude, 'claude --model claude-opus-5-5 --name mine', 'Rules.', undefined, undefined, 'Ada')).not.toContain('--name Ada');
    expect(launchCommand(claude, 'claude --model claude-opus-5-5 -n mine', 'Rules.', undefined, undefined, 'Ada')).not.toContain('--name Ada');
    expect(launchCommand(claude, 'claude', 'Rules.', undefined, undefined, '')).toBe(
      "AGENT_UNATTENDED=1 claude --dangerously-skip-permissions --append-system-prompt Rules.",
    );
    // No measured flag on the other CLIs: the name is not passed to one that has no such word.
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.', undefined, undefined, 'Ada')).not.toContain('--name');
  });

  test('the shipped profiles name the files a working-folder run showed each CLI reading at start', () => {
    expect(shippedStartupReads()).toEqual([
      { path: 'CLAUDE.md', directory: false, clis: ['claude-code', 'cursor', 'grok'] },
      { path: 'CLAUDE.local.md', directory: false, clis: ['claude-code', 'cursor', 'grok'] },
      { path: '.claude/CLAUDE.md', directory: false, clis: ['claude-code', 'grok'] },
      { path: '.claude/rules', directory: true, clis: ['claude-code', 'grok'] },
      { path: '.claude/settings.json', directory: false, clis: ['claude-code'] },
      { path: 'AGENTS.md', directory: false, clis: ['codex', 'cursor', 'antigravity', 'grok'] },
      { path: '.codex/config.toml', directory: false, clis: ['codex'] },
      { path: '.cursorrules', directory: false, clis: ['cursor'] },
      { path: '.cursor/rules', directory: true, clis: ['cursor'] },
      { path: 'GEMINI.md', directory: false, clis: ['antigravity', 'gemini'] },
      { path: '.gemini/settings.json', directory: false, clis: ['gemini'] },
    ]);
  });
});

describe('the input block a profile may name', () => {
  // The measured way into a CLI's box: the keys that empty it on an idle screen and mid-turn,
  // the paste surface, and whether the CLI takes text at all while a turn runs. Only the CLIs a
  // run measured carry it; every other profile reads null, and a delivery that meets unsent text
  // there holds instead of touching the box.
  test('an absent block reads as null', () => {
    expect(inputBlockOf('exit: /exit')).toBe(null);
  });

  test('the shipped profiles carry the keys their runs measured', () => {
    expect(profileFor('claude-code')?.input).toEqual({
      clear: ['ctrl+c'],
      clearWorking: ['ctrl+u'],
      paste: 'bracketed',
      midTurn: true,
    });
    expect(profileFor('codex')?.input).toEqual({
      clear: ['ctrl+u', 'ctrl+k'],
      clearWorking: null,
      paste: 'bracketed',
      midTurn: false,
    });
    expect(profileFor('cursor')?.input).toEqual({
      clear: ['ctrl+u'],
      clearWorking: null,
      paste: 'bracketed',
      midTurn: false,
    });
  });

  test('no other shipped profile claims one', () => {
    for (const cli of ['gemini', 'grok', 'antigravity', 'muse', 'jules']) {
      expect([cli, profileFor(cli)?.input]).toEqual([cli, null]);
    }
  });

  test('the block loads as the loader reads it, and mid_turn defaults to false', () => {
    expect(inputBlockOf(`exit: /exit
input:
  clear:
    - ctrl+u
    - ctrl+k
  paste: bracketed`)).toEqual({ clear: ['ctrl+u', 'ctrl+k'], clearWorking: null, paste: 'bracketed', midTurn: false });
    expect(inputBlockOf(`exit: /exit
input:
  clear:
    - ctrl+c
  clear_working:
    - ctrl+u
  paste: bracketed
  mid_turn: true`)).toEqual({ clear: ['ctrl+c'], clearWorking: ['ctrl+u'], paste: 'bracketed', midTurn: true });
  });

  test('a key no run measured, a shape that is not a list, an unknown paste surface or key is refused', () => {
    const block = (body: string): string => `exit: /exit\ninput:\n${body}`;
    expect(() => inputBlockOf(block('  clear:\n    - enter\n  paste: bracketed'))).toThrow(
      '"input.clear" must hold keys among: ctrl+c, ctrl+u, ctrl+k, escape, backspace',
    );
    expect(() => inputBlockOf(block('  clear: not-a-list\n  paste: bracketed'))).toThrow(
      '"input.clear" must be a non-empty list of keys',
    );
    expect(() => inputBlockOf(block('  clear:\n    - ctrl+u\n  paste: clipboard'))).toThrow(
      '"input.paste" must be one of: bracketed',
    );
    expect(() => inputBlockOf(block('  clear:\n    - ctrl+u\n  paste: bracketed\n  keys:\n    - ctrl+u'))).toThrow(
      'unknown key "keys"',
    );
  });

  test('mid_turn without clear_working is refused: the idle keys could end the turn', () => {
    expect(() => inputBlockOf(`exit: /exit
input:
  clear:
    - ctrl+c
  paste: bracketed
  mid_turn: true`)).toThrow('"input.clear_working" is required when "input.mid_turn" is true');
  });
});

describe('the resume line a launch appends', () => {
  test('a launch line that already names a session is left as it is', () => {
    for (const line of ['claude --resume abc', 'claude -r abc', 'claude --continue', 'claude -c', 'claude --session-id abc']) {
      expect(withResume('claude-code', line, 'ses_1')).toBeNull();
    }
  });

  test('a plain launch line takes the recorded id', () => {
    expect(withResume('claude-code', 'claude --model deepseek-flash', 'ses_1')).toBe('claude --model deepseek-flash --resume ses_1');
  });

  test('a Codex line takes the id as the word after its own resume subcommand', () => {
    // `codex resume --help` on 0.161.0: `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
    // The `-c` here is Codex's config override, not Claude Code's continue flag: it stays.
    expect(withResume('codex', 'codex -m gpt-6-sol -c model_reasoning_effort=high', 'ses_1'))
      .toBe('codex -m gpt-6-sol -c model_reasoning_effort=high resume ses_1');
  });

  test('a Codex line that already names resume keeps its own choice', () => {
    for (const line of ['codex -m gpt-6-sol resume abc', 'codex resume --last']) {
      expect(withResume('codex', line, 'ses_1')).toBeNull();
    }
  });

  test('a CLI with no measured resume form takes no id', () => {
    expect(withResume('cursor', 'cursor-agent --model x', 'ses_1')).toBeNull();
  });

  test('an Antigravity line takes --conversation=<id>, including a wrapper that forwards its arguments', () => {
    // Measured on the owner's Mac: `agy --conversation=<uuid>` resumes that conversation.
    const id = 'b4b1b021-e8af-4213-9b7e-470b233b712f';
    expect(supportsSessionResume('antigravity')).toBe(true);
    expect(withResume('antigravity', 'agy', id)).toBe(`agy --conversation=${id}`);
    expect(withResume('antigravity', 'agy --model gemini-3.1-pro', id))
      .toBe(`agy --model gemini-3.1-pro --conversation=${id}`);
    // The wrapper execs its arguments, so the flag is the launch line's last word, not a rewrite of `agy`.
    expect(withResume('antigravity', 'zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro', id))
      .toBe(`zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro --conversation=${id}`);
    // A quoted script is the program zsh runs: a flag after the quotes never reaches agy.
    expect(withResume('antigravity', 'zsh -lc "agy --model gemini-3.1-pro"', id))
      .toBe(`zsh -lc "agy --model gemini-3.1-pro --conversation=${id}"`);
    const profile = profileFor('antigravity');
    if (!profile) throw new Error('antigravity has no profile');
    expect(launchCommand(profile, `agy --conversation=${id}`, 'Rules.'))
      .toBe(`AGENT_UNATTENDED=1 agy --conversation=${id} --dangerously-skip-permissions`);
  });

  test('an Antigravity line that already names a conversation keeps its own choice', () => {
    const id = 'b4b1b021-e8af-4213-9b7e-470b233b712f';
    for (const line of [`agy --conversation=${id}`, 'agy --conversation other', 'zsh /Users/owner/as-floor.sh agy --conversation']) {
      expect(withResume('antigravity', line, 'ses_1')).toBeNull();
    }
  });
});

describe('a launch line that already selects a conversation', () => {
  test('the id it names is read from the measured form', () => {
    expect(namedResumeTarget('claude-code', 'claude --resume ses_9')).toBe('ses_9');
    expect(namedResumeTarget('claude-code', 'claude -r ses_9')).toBe('ses_9');
    expect(namedResumeTarget('claude-code', 'claude --resume=ses_9')).toBe('ses_9');
    expect(namedResumeTarget('codex', 'codex -m gpt-6-sol resume ses_9')).toBe('ses_9');
    const id = 'b4b1b021-e8af-4213-9b7e-470b233b712f';
    expect(namedResumeTarget('antigravity', `agy --conversation=${id}`)).toBe(id);
    expect(namedResumeTarget('antigravity', `agy --conversation ${id}`)).toBe(id);
    expect(namedResumeTarget('antigravity', `zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro --conversation=${id}`)).toBe(id);
    expect(namedResumeTarget('antigravity', `zsh -lc "agy --conversation=${id}"`)).toBe(id);
  });

  test('a selection that names no id reads as empty', () => {
    for (const line of ['claude --continue', 'claude -c', 'claude --resume']) {
      expect(namedResumeTarget('claude-code', line)).toBe('');
    }
    for (const line of ['codex resume', 'codex resume --last', 'codex resume --all']) {
      expect(namedResumeTarget('codex', line)).toBe('');
    }
    for (const line of ['agy --conversation', 'agy --conversation=', 'zsh /Users/owner/as-floor.sh agy --conversation --model x']) {
      expect(namedResumeTarget('antigravity', line)).toBe('');
    }
  });

  test('a line with no resume form reads as none', () => {
    expect(namedResumeTarget('claude-code', 'claude --model x')).toBeNull();
    expect(namedResumeTarget('codex', 'codex -m gpt-6-sol -c model_reasoning_effort=high')).toBeNull();
    expect(namedResumeTarget('cursor', 'cursor-agent --resume ses_1')).toBeNull();
    expect(namedResumeTarget('antigravity', 'agy --model gemini-3.1-pro')).toBeNull();
  });

  test('a proven id is carried only when the line selects it or names none', () => {
    expect(resumeCarry('claude-code', 'claude --resume ses_1', 'ses_1'))
      .toEqual({ kind: 'line', line: 'claude --resume ses_1' });
    expect(resumeCarry('claude-code', 'claude --model x', 'ses_1'))
      .toEqual({ kind: 'line', line: 'claude --model x --resume ses_1' });
    expect(resumeCarry('claude-code', 'claude --resume ses_9', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes a different conversation' });
    expect(resumeCarry('claude-code', 'claude --continue', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes without naming the recorded conversation' });
    expect(resumeCarry('codex', 'codex resume ses_9', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes a different conversation' });
    expect(resumeCarry('codex', 'codex resume --last', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes without naming the recorded conversation' });
    expect(resumeCarry('cursor', 'cursor-agent --model x', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line has no measured resume form' });
    const id = 'b4b1b021-e8af-4213-9b7e-470b233b712f';
    expect(resumeCarry('antigravity', 'agy', id))
      .toEqual({ kind: 'line', line: `agy --conversation=${id}` });
    expect(resumeCarry('antigravity', 'zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro', id))
      .toEqual({ kind: 'line', line: `zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro --conversation=${id}` });
    expect(resumeCarry('antigravity', `agy --conversation=${id}`, id))
      .toEqual({ kind: 'line', line: `agy --conversation=${id}` });
    expect(resumeCarry('antigravity', `zsh -lc "agy --conversation=${id}"`, id))
      .toEqual({ kind: 'line', line: `zsh -lc "agy --conversation=${id}"` });
    expect(resumeCarry('antigravity', 'agy --conversation=ses_9', id))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes a different conversation' });
    expect(resumeCarry('antigravity', 'agy --conversation', id))
      .toEqual({ kind: 'refuse', why: 'its launch line resumes without naming the recorded conversation' });
    // A line that starts a named new session is not a resume form for the recorded one.
    expect(resumeCarry('claude-code', 'claude --session-id 7f1c2a53-0e5a-4f4c-9a4b-1d2e3f4a5b6c', 'ses_1'))
      .toEqual({ kind: 'refuse', why: 'its launch line already sets a new session id' });
  });
});
