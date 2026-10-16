// TEAMCLI_DEV_MODE at its edges. The builder's test holds the middle: unset refuses,
// exactly `1` mounts, no approval artifacts. These scenes hold what the middle leans on —
// the value must be exactly `1` (anything else set leaves every refusal a refusal), a
// verified copy is not a drift refusal when the live file is edited (and a verified run mounts
// with no warning at all), the caller line converts alone (a placed-outside caller mounts an
// approved file on a warning), the warning is one line, joined and deduped, on the dry run
// too, and the mount's rules file still has to live at a path that can be typed and read
// back — dev mode does not relax that.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { approvalOf } from '../src/approve/approval.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readState } from '../src/state.ts';
import type { Caller } from '../src/caller.ts';
import { gitEnv, testIo } from './helpers.ts';

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const NOW = new Date('2026-10-15T12:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const UNPLACED: Caller = { kind: 'unplaced' as const, reason: 'it runs under herdr' };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string, model = 'Claude Opus', scribe = false): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: ${model}
    version: "5.5"
    launch: claude --model claude-opus-5-5
${scribe ? `  - role: reviewer
    name: scribe
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
` : ''}`;
}

/** A repo whose home folder's name carries a space: every store path under it is a path no
 *  read-back can prove. */
function repo(homeName = 'home', scribe = false): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-mode-edge-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, homeName);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), file(root, 'Claude Opus', scribe));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

/** Approves the file as it stands, so the run after it has a verified standing. */
function approve(root: string, home: string, yaml: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const panes: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.push(pane);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => panes,
    agents: () => [],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
    spawnWatch: () => 1,
  };
  return { launch, runs };
}

function sources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(home),
    launch,
    now: () => NOW,
  };
}

describe('TEAMCLI_DEV_MODE at the edges', () => {
  test('a value other than exactly 1 leaves every refusal where it is', async () => {
    for (const value of ['0', 'true', '2', '']) {
      const made = repo();
      const runs = world();
      const io = testIo(made.root, UNPLACED);
      io.env = { TEAMCLI_DEV_MODE: value };
      const code = await runUp([], io, sources(made.home, runs.launch));
      expect(code, `TEAMCLI_DEV_MODE=${JSON.stringify(value)} must not mount`).toBe(1);
      expect(io.err).toBe('deny\n');
      expect(io.out).toBe('');
      expect(runs.runs).toEqual([]);
    }
  });

  test('an edited live file mounts with no drift warning for the owner', async () => {
    const made = repo();
    const approved = file(made.root);
    approve(made.root, made.home, approved);
    // The live file is the record: editing the file after approval mounts without a drift refusal or warning.
    writeFileSync(
      join(made.root, '.agents', 'team.yaml'),
      approved.replace('claude --model claude-opus-5-5', 'claude --model claude-opus-5-5 --live-mount'),
    );
    const runs = world();
    const io = testIo(made.root, OWNER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp([], io, sources(made.home, runs.launch));
    expect(code).toBe(0);
    expect(io.err).not.toContain('not the approved one');
    expect(io.err).not.toContain('warning:');
    expect(runs.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5 --live-mount');
  });

  test('a verified run mounts as ever: dev mode adds no warning to it', async () => {
    const made = repo();
    approve(made.root, made.home, file(made.root));
    const runs = world();
    const io = testIo(made.root, OWNER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp([], io, sources(made.home, runs.launch));
    expect(code).toBe(0);
    expect(io.err).not.toContain('warning:');
    expect(io.err).not.toContain('never approved');
    expect(runs.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
    expect(readState(join(made.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  });

  test('a caller outside the owner mounts an approved file on the placement warning alone', async () => {
    const made = repo();
    approve(made.root, made.home, file(made.root));
    const runs = world();
    const io = testIo(made.root, UNPLACED);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp([], io, sources(made.home, runs.launch));
    expect(code).toBe(0);
    expect(io.err).toContain('team up: warning: only the owner runs `up`');
    // The approval is in force: its two never-approved sentences have nothing to warn about.
    expect(io.err).not.toContain('never approved');
    expect(io.err).not.toContain('team approve`');
    expect(runs.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
    expect(readState(join(made.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  });

  test('a dry run says the one warning line, joined and deduped, then the plan', async () => {
    const made = repo();
    const runs = world();
    const io = testIo(made.root, UNPLACED);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp(['--dry-run'], io, sources(made.home, runs.launch));
    expect(code).toBe(0);
    expect(io.out.split('\n')[0]).toBe(
      '! warning: only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr); the file was never approved on this machine',
    );
    expect(io.out).not.toContain('team up:');
    expect(io.err).not.toContain('team up:');
    expect(runs.runs).toEqual([]);
  });

  test("the mount's rules file still needs a typeable path: a home with a space refuses the seat", async () => {
    // The scribe is a message seat: its rules must reach a file whose path can be typed and
    // read back, and dev mode resolves that path from the live project when no approval is
    // in force. A home whose own name has a space makes every such path unprovable.
    const made = repo('ho me', true);
    const runs = world();
    const io = testIo(made.root, UNPLACED);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp(['--dry-run'], io, sources(made.home, runs.launch));
    expect(code).toBe(0);
    expect(io.out).toContain('! warning:');
    expect(io.out).toContain(
      "scribe: would refuse: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
    );
    expect(runs.runs).toEqual([]);
  });
});
