// The up page's deny rows, held to the binary. The page says a caller the run does not
// admit is answered alike on a real run and a `--dry-run` — the one word `deny` on stderr,
// nothing on stdout, no `team up:` prefix, no reason, no plan — and that a `--file` other
// than this folder's own is refused before the file is read, the dry run included. The
// real-run deny and the admitted callers' dry-run plans are pinned elsewhere; these rows
// pin the alike claim and the aimed example the page added.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T09:00:00Z');
// A seat of the team's own session that nothing names for `up`: no grant, no delegates entry.
const PLAIN_SEAT = { kind: 'seat' as const, name: 'worker', pane: 'worker-pane', session: 'alpha' };

let base: string;
let root: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

// The default file of this folder: valid, trusted, and plain — no `grant`, no `delegates` —
// so no gate is asked and the caller's admission falls to the ordinary rule alone.
function teamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator')}
${seat('worker', 'implementer')}
`;
}

function sources(): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    now: () => NOW,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-up-deny-doc-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml());
  updateState(join(root, '.agents'), (file) => {
    file.sessions.alpha = {
      ...emptySession(),
      seats: { worker: { stage: 'ready', pane: 'worker-pane' } },
    };
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the up page\'s deny rows', () => {
  test('a caller the run does not admit is answered alike: deny on the real run and on the dry run', async () => {
    const real = testIo(root, PLAIN_SEAT);
    const realCode = await runUp([], real, sources());
    expect(realCode).toBe(1);
    expect(real.err).toBe('deny\n');
    expect(real.out).toBe('');

    const dry = testIo(root, PLAIN_SEAT);
    const dryCode = await runUp(['--dry-run'], dry, sources());
    expect(dryCode).toBe(1);
    expect(dry.err).toBe('deny\n');
    expect(dry.out).toBe('');
  });

  test('the aimed example: --file other.yaml is deny before the file is read, the dry run and the real run alike', async () => {
    // The named file does not exist. The deny comes before any flagged target is opened,
    // so neither run reports the missing file (that exit is 2 with a `team up:` line).
    const dry = testIo(root, PLAIN_SEAT);
    const dryCode = await runUp(['--dry-run', '--file', 'other.yaml'], dry, sources());
    expect(dryCode).toBe(1);
    expect(dry.err).toBe('deny\n');
    expect(dry.out).toBe('');
    expect(existsSync(join(root, 'other.yaml'))).toBe(false);

    const real = testIo(root, PLAIN_SEAT);
    const realCode = await runUp(['--file', 'other.yaml'], real, sources());
    expect(realCode).toBe(1);
    expect(real.err).toBe('deny\n');
    expect(real.out).toBe('');
  });
});
