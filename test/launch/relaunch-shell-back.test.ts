import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';

// 0.5.10: the runtime "No conversation found" relaunch types a launch line into the pane, so it
// runs only once the CLI is gone — the same evidence 10139bc22 uses: herdr reads the pane's shell
// back, or no foreground process is one the seat's profile runs as. The names are the profile's
// own, never "anything that is not the pane's shell": a wrapper that has not exec'd its CLI is a
// foreground process of its own, and it is not the CLI that printed the error.
const SES = 'ses_a1b2c3d4e5f6';
const MISSING = `claude --resume ${SES}`;
const screenOf = (command: string): string => `${command}\nNo conversation found with session ID: ${SES}\n❯ `;

type Front = 'cli' | 'shell' | 'wrapper' | 'unread' | 'noread';

function hostOf(input: { front: Front; command?: string }): { host: Host; runs: string[]; typed: string[] } {
  const runs: string[] = [];
  const typed: string[] = [];
  const command = input.command ?? MISSING;
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: (_session, _pane, command) => { runs.push(command); return true; },
    typeLine: (_session, _pane, text) => { typed.push(text); return false; },
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => ['p1'],
    classify: () => 'unknown',
    paneText: () => screenOf(command),
    // Herdr reads its shell back in the scene that says so.
    shellBack: () => input.front === 'unread',
    // The pids in front say nothing on their own: a wrapper's own interpreter is one of them and
    // is not the CLI. The argv0 names are the reading.
    processInfo: () => (input.front === 'cli' || input.front === 'wrapper'
      ? { shell: 100, foreground: [200] }
      : { shell: 100, foreground: [] }),
    ...(input.front === 'unread' || input.front === 'noread' ? {} : {
      foreground: () => {
        if (input.front === 'cli') return ['claude'];
        if (input.front === 'wrapper') return ['zsh', 'sleep'];
        return [];
      },
    }),
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
  return { host, runs, typed };
}

function steps(command = MISSING): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: { do: 'launch', seat: 'worker', label: 'worker', command, pane: 'p1', cli: 'claude-code', cwd: '.' },
    },
    {
      kind: 'wait',
      text: 'until worker shows its idle prompt',
      do: { do: 'idle', seat: 'worker', label: 'worker', cli: 'claude-code', seconds: 5, command, pane: 'p1', repairLine: '`team remove worker --keep` then `team add worker`' },
    },
  ];
}

describe('the runtime relaunch types only once the CLI is gone', () => {
  test('a CLI still in front of the pane keeps it: no fresh line is typed into it', async () => {
    const { host, runs, typed } = hostOf({ front: 'cli' });
    await executePlan(steps(), 'acme', host);
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain(`--resume ${SES}`);
    expect(typed).toEqual([]);
  });

  test('a pane whose foreground names no CLI is back at its shell: the relaunch runs once, fresh', async () => {
    const { host, runs, typed } = hostOf({ front: 'shell' });
    await executePlan(steps(), 'acme', host);
    expect(runs.length).toBe(2);
    expect(runs[0]).toContain(`--resume ${SES}`);
    expect(runs[1]).not.toContain('--resume');
    expect(runs[1]).toContain('--session-id');
    expect(typed).toEqual([]);
  });

  test('a wrapper alive after its CLI exited is not a CLI: the relaunch runs, its pids notwithstanding', async () => {
    // The pane still lists a non-shell foreground pid; its argv0 is a wrapper's interpreter and
    // then a child of it, neither of them the CLI that printed the error.
    const { host, runs, typed } = hostOf({ front: 'wrapper' });
    await executePlan(steps(), 'acme', host);
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
    expect(runs[1]).toContain('--session-id');
    expect(typed).toEqual([]);
  });

  test('herdr reading the shell back is enough without a process read', async () => {
    const { host, runs } = hostOf({ front: 'unread' });
    await executePlan(steps(), 'acme', host);
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
  });

  test('a pane whose foreground cannot be read is not taken as gone: no fresh line is typed', async () => {
    const { host, runs, typed } = hostOf({ front: 'noread' });
    await executePlan(steps(), 'acme', host);
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain(`--resume ${SES}`);
    expect(typed).toEqual([]);
  });

  test('a resume inside a quoted script is stripped from the fresh line, and the CLI is handed none', async () => {
    // The runtime fallback relaunches the same line without its resume. Inside a quoted script the
    // resume is followed by the closing quote, so the line must be stripped there; the CLI the
    // fresh line runs is handed every other word and no --resume, read from a stub's argv.
    const command = `/bin/sh -c "claude --model claude-opus-5-5 --resume ${SES}"`;
    const { host, runs, typed } = hostOf({ front: 'shell', command });
    await executePlan(steps(command), 'acme', host);
    expect(runs.length).toBe(2);
    expect(runs[1]).not.toContain('--resume');
    expect(runs[1]?.startsWith('/bin/sh -c "claude --model claude-opus-5-5 --session-id ')).toBe(true);
    expect(runs[1]?.endsWith('"')).toBe(true);
    expect(typed).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), 'relaunch-argv-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const argvFile = join(dir, 'argv.txt');
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\n`, { mode: 0o755 });
      execFileSync('/bin/sh', ['-c', runs[1] ?? ''], {
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: dir },
      });
      const argv = readFileSync(argvFile, 'utf8').split('\0').filter((word) => word !== '');
      expect(argv).not.toContain('--resume');
      expect(argv).toContain('--session-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
