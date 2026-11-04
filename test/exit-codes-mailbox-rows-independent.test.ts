import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, loadContract, problems, render } from '../scripts/exit-codes.ts';

const ENTRY_PATH = fileURLToPath(new URL('../src/daemon/mailbox/entry.ts', import.meta.url));
const CONTRACT_DOC_PATH = fileURLToPath(new URL('../docs/reference/exit-codes.md', import.meta.url));
const EXPECTED_STDERR = 'team daemon: the mailbox router child has no readable one-use token; it routed nothing\n';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mbx-entry-ind-')));
  tempDirs.push(dir);
  return dir;
}

function runMailboxEntry(argv: string[], stdinText = ''): { status: number | null; stdout: string; stderr: string } {
  const cwd = makeTempDir();
  const res = spawnSync(process.execPath, [ENTRY_PATH, ...argv], {
    cwd,
    input: stdinText,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('independent verification of mailbox router child exit row (team.mailbox-entry-refused)', () => {
  test('src/daemon/mailbox/entry.ts has a single marked exit site for team.mailbox-entry-refused and the exit-codes contract check is clean', () => {
    const analysis = analyze();
    const mailboxSites = analysis.sites.filter((s) => s.file === 'src/daemon/mailbox/entry.ts');
    expect(mailboxSites).toHaveLength(1);
    expect(mailboxSites[0]).toMatchObject({
      file: 'src/daemon/mailbox/entry.ts',
      command: 'team',
      codes: [1],
      ids: ['team.mailbox-entry-refused'],
    });

    const contract = loadContract();
    const row = contract.rows.find((r) => r.id === 'team.mailbox-entry-refused');
    expect(row).toEqual({
      code: 1,
      command: 'team',
      id: 'team.mailbox-entry-refused',
      meaning: "the machine daemon's mailbox router child was started without a readable one-use token, so it routed nothing",
      trigger: 'the daemon starts its mailbox router child entry',
    });

    const renderedDoc = readFileSync(CONTRACT_DOC_PATH, 'utf8');
    expect(renderedDoc).toBe(render(contract.rows));
    expect(renderedDoc).toContain('| `team.mailbox-entry-refused` | `team` | 1 |');

    // Full exit-codes gate on the repository is clean
    expect(problems()).toEqual([]);

    // Pre-fix regression check: unmarked module-level process.exit(1) sites in entry.ts are caught by problems()
    const preFixEntry = `import { readFileSync, unlinkSync } from 'node:fs';
const token = process.argv[2];
if (token === undefined || token === '') process.exit(1);
try {
  readFileSync(token);
  unlinkSync(token);
} catch {
  process.exit(1);
}
`;
    const preFixProblems = problems({
      files: new Map([['src/daemon/mailbox/entry.ts', preFixEntry]]),
    });
    expect(preFixProblems.some((p) => p.includes('src/daemon/mailbox/entry.ts') && p.includes('exit site has no row'))).toBe(true);
    expect(preFixProblems.some((p) => p.includes('team.mailbox-entry-refused'))).toBe(true);
  }, 30_000);

  test('mailbox router child started with no token or an empty token exits 1 with the refusal reason on stderr and routes nothing', () => {
    const tickLine = `${JSON.stringify({ type: 'tick', at: '2026-11-04T10:00:00.000Z' })}\n`;

    const noToken = runMailboxEntry([], tickLine);
    expect(noToken.status).toBe(1);
    expect(noToken.stdout).toBe('');
    expect(noToken.stderr).toBe(EXPECTED_STDERR);

    const emptyToken = runMailboxEntry([''], tickLine);
    expect(emptyToken.status).toBe(1);
    expect(emptyToken.stdout).toBe('');
    expect(emptyToken.stderr).toBe(EXPECTED_STDERR);
  });

  test('mailbox router child started with a missing token, a directory token, or an unreadable token exits 1 with the refusal reason on stderr', () => {
    const dir = makeTempDir();
    const tickLine = `${JSON.stringify({ type: 'tick', at: '2026-11-04T10:00:00.000Z' })}\n`;

    // 1. Missing token file
    const missingToken = join(dir, 'missing-one-use.token');
    const missingRes = runMailboxEntry([missingToken], tickLine);
    expect(missingRes.status).toBe(1);
    expect(missingRes.stdout).toBe('');
    expect(missingRes.stderr).toBe(EXPECTED_STDERR);

    // 2. Directory passed where a token file is expected (readFileSync throws EISDIR)
    const dirToken = join(dir, 'directory-token');
    mkdirSync(dirToken);
    const dirRes = runMailboxEntry([dirToken], tickLine);
    expect(dirRes.status).toBe(1);
    expect(dirRes.stdout).toBe('');
    expect(dirRes.stderr).toBe(EXPECTED_STDERR);

    // 3. Unreadable token file (chmod 0o000)
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const unreadableToken = join(dir, 'unreadable.token');
      writeFileSync(unreadableToken, 'secret-token');
      chmodSync(unreadableToken, 0o000);
      try {
        const unreadableRes = runMailboxEntry([unreadableToken], tickLine);
        expect(unreadableRes.status).toBe(1);
        expect(unreadableRes.stdout).toBe('');
        expect(unreadableRes.stderr).toBe(EXPECTED_STDERR);
      } finally {
        chmodSync(unreadableToken, 0o600);
      }
    }
  });

  test('mailbox router child spends a valid one-use token once, answers tick with heartbeat, and refuses a replay of the spent token', () => {
    const dir = makeTempDir();
    const tokenPath = join(dir, 'valid-one-use.token');
    writeFileSync(tokenPath, 'one-use-token-payload\n');
    expect(existsSync(tokenPath)).toBe(true);

    const tickAt = '2026-11-04T10:05:00.000Z';
    const firstRun = runMailboxEntry([tokenPath], `${JSON.stringify({ type: 'tick', at: tickAt })}\n`);
    expect(firstRun.status).toBe(0);
    expect(firstRun.stderr).toBe('');
    expect(firstRun.stdout).toBe(`${JSON.stringify({ type: 'heartbeat', at: tickAt })}\n`);
    expect(existsSync(tokenPath)).toBe(false);

    // Second run with the same (now-spent) token path refuses with code 1 and routes nothing
    const replayRun = runMailboxEntry([tokenPath], `${JSON.stringify({ type: 'tick', at: '2026-11-04T10:06:00.000Z' })}\n`);
    expect(replayRun.status).toBe(1);
    expect(replayRun.stdout).toBe('');
    expect(replayRun.stderr).toBe(EXPECTED_STDERR);
  });
});
