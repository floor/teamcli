// `doctor` runs the owner's approved budget checks once, the way the watch runs them: the
// approved command, hashed again before it runs, its raw output parsed and dropped. Only the
// owner's `doctor` runs a check; a seat's reads everything else, and no check. Fixtures only:
// no check here is a real one, and no caller is a real seat.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { resolveChecks } from '../../src/budgets/checks.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');

const SEATS = `seats:
  - role: implementer
    name: claude-keeper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const CHECKS = `budgets:
  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: .agents/deepseek-balance }
`;

// Claude and Codex have quota patterns; the unmatched account has none.
const UNREADABLE = `budgets:
  marks: [50, 75, 90]
  accounts:
    anthropic: { kind: subscription, reserve: 10%, sources: [status_line] }
    unreadable: { kind: subscription, reserve: 10%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: .agents/deepseek-balance }
`;

const CODEX_SEAT = `  - role: researcher
    name: codex-keeper
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
`;

function source(budgets: string, extraSeats = ''): string {
  return `format: 1
project: acme-web
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

${budgets}
${SEATS}${extraSeats}`;
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-checks-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const path = join(root, '.agents', name);
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return path;
}

function approve(text: string): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const resolved = resolveChecks(loaded.team, loaded.root, '');
  if (!resolved.ok) throw new Error(`the check for ${resolved.account} did not resolve`);
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW, resolved.checks), file: text },
    loaded.team.seats,
    home,
  );
}

/** Fine sources for one claude seat and one codex seat, with a check-run seam that records calls. */
function fakeSources(run: (path: string) => string | null): { sources: DoctorSources; ran: string[] } {
  const ran: string[] = [];
  const sources: DoctorSources = {
    version: (binary) => (binary === 'claude' ? '2.1.288' : binary === 'codex' ? '0.157.0' : null),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    runCheck(path) {
      ran.push(path);
      return run(path);
    },
  };
  return { sources, ran };
}

async function doctor(caller: Parameters<typeof testIo>[1], run: (path: string) => string | null) {
  const { sources, ran } = fakeSources(run);
  const io = testIo(root, caller);
  const code = await runDoctor(['--file', '.agents/team.yaml'], io, sources);
  return { io, code, ran };
}

describe('the owner\'s doctor runs each approved check once', () => {
  test('a subscription reading and a spend reading are one line each, and each check runs once', async () => {
    const openai = script('openai-quota', 'echo "weekly 40% used"\n');
    const deepseek = script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io, code, ran } = await doctor({ kind: 'owner' }, (path) =>
      path === openai ? 'weekly 40% used\n' : '6.20 USD\n');
    expect(ran).toEqual([openai, deepseek]);
    expect(io.out).toContain('ok    the check for openai reads weekly 40% used');
    expect(io.out).toContain('ok    the check for deepseek reads 6.20 USD');
    expect(code).toBe(0);
    // The file's own notice, for the legacy `coordinator:` spelling, is the one warning.
    expect(io.out).toContain('team doctor: nothing missing, 1 warning');
  });

  test('a check edited after its approval is not run, and is reported as changed', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    const deepseek = script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    script('openai-quota', 'echo "weekly 99% used"\n');
    const { io, code, ran } = await doctor({ kind: 'owner' }, () => 'weekly 40% used\n');
    // Only the unchanged approved file runs; the edited one never does.
    expect(ran).toEqual([deepseek]);
    expect(io.out).toContain('warn  the check for openai changed after approval and was not run; that account reads unknown');
    expect(code).toBe(0);
  });

  test('a check that fails or times out reads unknown, as a warning', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io, code } = await doctor({ kind: 'owner' }, (path) =>
      path.endsWith('openai-quota') ? null : '6.20 USD\n');
    expect(io.out).toContain('warn  the check for openai failed or timed out; that account reads unknown');
    expect(io.out).toContain('ok    the check for deepseek reads 6.20 USD');
    expect(code).toBe(0);
    expect(io.out).toContain('team doctor: nothing missing, 2 warnings');
  });

  test('output that breaks the contract reads unknown, as a warning', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io, code } = await doctor({ kind: 'owner' }, (path) =>
      path.endsWith('openai-quota') ? 'not a contract line\n' : '6.20 USD\n');
    expect(io.out).toContain('warn  the check for openai broke its output contract; that account reads unknown');
    expect(code).toBe(0);
  });
});

describe('only the owner runs the checks', () => {
  test('a seat\'s doctor runs no check, says so in one line, and reports everything else', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io, code, ran } = await doctor({ kind: 'seat', name: 'claude-keeper', pane: 'w0:p1' }, () => {
      throw new Error('no check may run');
    });
    expect(ran).toEqual([]);
    expect(io.out).toContain('--    the budget checks were not run: only the owner runs them');
    expect(io.out).not.toContain('the check for openai reads');
    expect(io.out).not.toContain('team approve');
    expect(io.out).not.toContain('the file is the one the owner approved');
    expect(io.out).toContain('ok    claude 2.1.288');
    expect(code).toBe(0);
  });

  test('an unplaced caller — an agent outside herdr — runs no check either', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io, ran } = await doctor({ kind: 'unplaced', reason: 'run by an agent outside herdr' }, () => {
      throw new Error('no check may run');
    });
    expect(ran).toEqual([]);
    expect(io.out).toContain('--    the budget checks were not run: only the owner runs them');
  });

  test('a file no account names a check for needs no such line', async () => {
    approve(source('budgets:\n  marks: [50, 75, 90]\n'));
    const { io } = await doctor({ kind: 'seat', name: 'claude-keeper', pane: 'w0:p1' }, () => {
      throw new Error('no check may run');
    });
    expect(io.out).not.toContain('only the owner runs them');
  });
});

describe('the raw output never reaches the report or the state', () => {
  test('a secret-looking line in a check\'s output is nowhere in doctor\'s output', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const { io } = await doctor({ kind: 'owner' }, (path) =>
      path.endsWith('openai-quota') ? 'api_key=sk-live-12345\n' : '6.20 USD\n');
    expect(io.out).toContain('warn  the check for openai broke its output contract');
    expect(io.out).not.toContain('api_key');
    expect(io.out).not.toContain('sk-live');
    expect(io.err).toBe('');
  });

  test('a reading is reported, never written into the state', async () => {
    script('openai-quota', 'echo "weekly 40% used"\n');
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(CHECKS));
    const state = join(root, '.agents', 'team.state.json');
    const before = existsSync(state) ? readFileSync(state, 'utf8') : null;
    await doctor({ kind: 'owner' }, () => 'weekly 40% used\n');
    const after = existsSync(state) ? readFileSync(state, 'utf8') : null;
    expect(after).toBe(before);
    expect(after ?? '').not.toContain('openai');
    expect(after ?? '').not.toContain('weekly');
  });
});

describe('accounts nothing can read', () => {
  test('an account the seats\' profiles have no pattern for is listed; a checked one is not', async () => {
    script('deepseek-balance', 'echo "6.20 USD"\n');
    approve(source(UNREADABLE, CODEX_SEAT));
    const { io, code } = await doctor({ kind: 'owner' }, () => '6.20 USD\n');
    expect(io.out).toContain('warn  unreadable: no pattern can read this account');
    expect(io.out).not.toContain('anthropic: no pattern');
    expect(io.out).not.toContain('openai: no pattern');
    expect(io.out).not.toContain('deepseek: no pattern');
    expect(code).toBe(0);
  });
});
