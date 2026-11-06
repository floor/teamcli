// Independent scene for a folder that already holds a team. team start, with the preset
// step not recorded, must refuse, leave the team file byte for byte, and not touch the
// registry record. Synthetic homes only.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runStart } from '../src/commands/start.ts';
import type { Io } from '../src/io.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const TEAM = 'format: 1\nproject: kept\n# existing-team\n';
const REGISTRY = 'teams: {}\n# registry-left-alone\n';
const homes: string[] = [];

afterEach(() => discardFixtures(homes.splice(0)));

test('a folder that already holds a team is refused, and the file and registry stay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'start-held-'));
  homes.push(home);
  const project = join(home, 'project');
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  mkdirSync(join(project, '.agents'), { recursive: true, mode: 0o700 });
  const teamFile = join(project, '.agents', 'team.yaml');
  const registry = join(home, '.config', 'team', 'teams.yaml');
  writeFileSync(teamFile, TEAM);
  writeFileSync(registry, REGISTRY);
  writeFileSync(join(project, '.agents', 'start.json'), `${JSON.stringify({ detect: true, clis: ['grok', 'cursor'] })}\n`);
  let stdout = '';
  let stderr = '';
  const caller: Caller = { kind: 'owner' };
  const io: Io = {
    cwd: project,
    env: {},
    stdinIsTTY: true,
    caller,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  };
  const code = await runStart([], io, {
    home,
    now: () => 1_000,
    notifyRoot: () => {},
    init: async () => 1,
    up: async () => 1,
    send: async () => ({ ok: false, id: null, arrived: false, read: false, working: false, claimedTask: null }),
    daemonRunning: () => false,
  });
  expect(code).not.toBe(0);
  expect(stderr).toContain('this folder already holds a team; run team up');
  expect(readFileSync(teamFile)).toEqual(Buffer.from(TEAM));
  expect(readFileSync(registry)).toEqual(Buffer.from(REGISTRY));
  expect(stdout).toBe('');
});
