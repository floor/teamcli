import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLoggedInCli, init, runInit, skeleton } from '../src/commands/init.ts';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { version } from '../src/cli.ts';
import type { Profile } from '../src/profiles/profile.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { gitEnv, testIo } from './helpers.ts';

let base: string;
let project: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-init-')));
  project = join(base, 'acme');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const owner = { kind: 'owner' } as const;

/** No CLI is signed in: the pick is claude-code, and no real login is probed inside a test. */
const noLogin = { loggedIn: () => false };

describe('team init', () => {
  test('writes a skeleton that validates, and says how it stays private', async () => {
    const io = testIo(project, owner);
    expect(await runInit([], io, undefined, undefined, noLogin)).toBe(0);
    const loaded = loadTeamFile(project);
    expect(loaded).toMatchObject({ ok: true, team: { project: 'acme', orchestrator: 'orchestrator' } });
    expect(io.out).toContain('private to this clone');
    expect(io.out).toContain('team approve');
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toMatch(/ init \[owner\] wrote a skeleton as \.agents\/team\.yaml/);
  });

  test('writes # yaml-language-server: $schema line pointing at versioned schema as the first line', async () => {
    const io = testIo(project, owner);
    expect(await runInit([], io, undefined, undefined, noLogin)).toBe(0);
    const content = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const firstLine = content.split('\n')[0];
    const expected = `# yaml-language-server: $schema=https://raw.githubusercontent.com/floor/teamcli/v${version()}/schema/team.schema.json`;
    expect(firstLine).toBe(expected);
  });

  test('the written file is the new lead shape, loads, and warns nothing', async () => {
    const io = testIo(project, owner);
    expect(await runInit([], io, undefined, undefined, noLogin)).toBe(0);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    // The written bytes, pinned: no key, the operator naming the lead seat, the seat block whole.
    expect(text).not.toContain('coordinator');
    expect(text).toContain('operator: orchestrator        # the seat the watch reports to');
    expect(text).toContain('#   trust: owner              # owner | orchestrator');
    expect(text).toContain(
      [
        'seats:',
        '  - role: orchestrator',
        '    name: orchestrator',
        '    cli: claude-code          # the first shipped CLI this machine is signed in to: claude-code | codex | cursor | antigravity | grok; any CLI in any role',
        '    vendor: anthropic',
        '    model: Claude Opus        # the model\'s name without its version',
        '    version: "0"              # the release number alone, quoted',
        '    launch: claude            # the command and its model options; no approval flags',
        '    leads: true               # the seat that leads: dispatches work',
      ].join('\n'),
    );
    const result = validateTeamFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      expect(result.team.orchestrator).toBe('orchestrator');
      expect(result.team.seats).toHaveLength(1);
    }
  });

  test('a project under a runner-shaped TMPDIR writes a file that warns nothing', async () => {
    // The GitHub macOS runner's TMPDIR is /var/folders/<rand>/<rand>/T/: long, dotless, absolute.
    // It reaches the file as the trust entry — init writes the project root there — and read as a
    // random value there it failed CI (`secrets.ts`). This pins the case: the path is quiet.
    const real = realpathSync(tmpdir());
    const shaped = join(real, `team-init-runner-${randomBytes(24).toString('base64url')}`);
    mkdirSync(shaped);
    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = shaped;
    try {
      const runBase = realpathSync(mkdtempSync(join(tmpdir(), 'team-init-')));
      const runProject = join(runBase, 'acme');
      mkdirSync(runProject);
      git(runProject, 'init', '-q', '-b', 'main');
      writeFileSync(join(runProject, 'README.md'), 'acme\n');
      git(runProject, 'add', 'README.md');
      git(runProject, 'commit', '-q', '-m', 'first');
      expect(await runInit([], testIo(runProject, owner), undefined, undefined, noLogin)).toBe(0);
      const lines = readFileSync(join(runProject, '.agents', 'team.yaml'), 'utf8').split('\n');
      expect(lines[28]).toBe(`  - ${runProject}`); // the trust entry, by position, pinned
      const value = (lines[28] ?? '').trim().replace(/^- /, '');
      // The shape that made this red before: under the temp root we set, 32+ chars, dotless.
      expect(value.startsWith(`${realpathSync(shaped)}/`)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(32);
      expect(value).toMatch(/^\/[A-Za-z0-9/_-]+$/);
      expect(value.split('/').length).toBeGreaterThanOrEqual(4);
      const result = validateTeamFile(lines.join('\n'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.warnings).toEqual([]);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
      rmSync(shaped, { recursive: true, force: true });
    }
  });

  test('the trust line still warns on a token, and still refuses a key — a path prefix hides neither', async () => {
    const io = testIo(project, owner);
    expect(await runInit([], io, undefined, undefined, noLogin)).toBe(0);
    const lines = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8').split('\n');
    expect(lines[28]).toBe(`  - ${realpathSync(project)}`); // the trust entry, by position, pinned
    // The line above `trust:` holds the machine lobby entry; swapping in a value of a different
    // shape (legacy vs absolute) would make the two mix and the trust section refuse the file,
    // so the companion entry matches the swapped value's class and the verdict stays the scanner's.
    const swap = (value: string, companion = '  - .') => validateTeamFile([...lines.slice(0, 27), companion, `  - ${value}`, ...lines.slice(29)].join('\n'));
    // A genuine credential-shaped value at the same position still warns ...
    const token = swap('Zx8Kq2Lm9Pv4Rt7Wy1Bn6Cd3Fg5Hj0QsAeUiOpXc');
    expect(token.ok).toBe(true);
    if (token.ok) expect(token.warnings).toEqual([{ line: 29, message: expect.stringMatching(/random-looking/) }]);
    // ... and a key-shaped word there is still refused.
    const key = swap(`sk-${'A'.repeat(24)}`);
    expect(key.ok).toBe(false);
    if (!key.ok) expect(key.errors).toEqual([{ line: 29, message: expect.stringMatching(/shaped like a key or token/) }]);
    // A path prefix before a key-shaped tail never refused it — the prefix check is anchored at
    // the word's start — and this change leaves that verdict alone. The warn no longer goes
    // quiet: `/usr/sk-…` is not a directory, so nothing exempts it.
    const hidden = swap('/usr/sk-Zx8Kq2Lm9Pv4Rt7Wy1Bn6Cd3Fg5Hj0', '  - ~/.config/team/lobby');
    expect(hidden.ok).toBe(true);
    if (hidden.ok) expect(hidden.warnings).toEqual([{ line: 29, message: expect.stringMatching(/random-looking/) }]);
    // A credentialed URL after a path prefix is still refused: the URL check reads the value.
    const url = swap('/usr/https://user:pass@host', '  - ~/.config/team/lobby');
    expect(url.ok).toBe(false);
    if (!url.ok) expect(url.errors).toEqual([{ line: 29, message: expect.stringMatching(/URL with credentials/) }]);
  });

  test('the skeleton seat is the first CLI this machine is signed in to, in a fixed order', () => {
    // By `cli`: everything not named answers no; `unknown` answers "can't tell" (null).
    const login = (yes: string[], unknown: string[] = []) => ({
      loggedIn: (profile: Profile) => (yes.includes(profile.cli) ? true : unknown.includes(profile.cli) ? null : false),
    });
    // The fixed order: the earlier CLI wins whatever later ones answer.
    expect(firstLoggedInCli(login(['claude-code', 'codex', 'cursor', 'antigravity', 'grok']))).toBe('claude-code');
    expect(firstLoggedInCli(login(['codex', 'cursor', 'antigravity', 'grok']))).toBe('codex');
    expect(firstLoggedInCli(login(['cursor', 'antigravity', 'grok']))).toBe('cursor');
    expect(firstLoggedInCli(login(['antigravity', 'grok']))).toBe('antigravity');
    expect(firstLoggedInCli(login(['grok']))).toBe('grok');
    // A check that can't tell is not a yes: it neither selects that CLI nor ends the walk.
    expect(firstLoggedInCli(login(['cursor'], ['claude-code', 'codex']))).toBe('cursor');
    expect(firstLoggedInCli(login(['antigravity'], ['claude-code', 'codex', 'cursor']))).toBe('antigravity');
    expect(firstLoggedInCli(login(['grok'], ['claude-code', 'codex', 'cursor', 'antigravity']))).toBe('grok');
    // Nothing answers yes: claude-code.
    expect(firstLoggedInCli(login([], ['claude-code', 'codex', 'cursor', 'antigravity', 'grok']))).toBe('claude-code');
    expect(firstLoggedInCli(login([]))).toBe('claude-code');
  });

  test('a machine signed in beyond claude-code writes that CLI\'s seat', () => {
    const only = (cli: string) => ({ loggedIn: (profile: Profile) => profile.cli === cli });
    const codex = skeleton('acme', null, version(), undefined, firstLoggedInCli(only('codex')));
    expect(codex).toMatch(/^    cli: codex +# the first shipped CLI this machine is signed in to: claude-code \| codex \| cursor \| antigravity \| grok; any CLI in any role$/m);
    expect(codex).toContain('    vendor: openai\n');
    expect(codex).toMatch(/^    model: GPT Sol +# the model's name without its version$/m);
    expect(codex).toMatch(/^    launch: codex +# the command and its model options; no approval flags$/m);
    expect(validateTeamFile(codex).ok).toBe(true);
    const antigravity = skeleton('acme', null, version(), undefined, firstLoggedInCli(only('antigravity')));
    expect(antigravity).toContain('    vendor: google\n');
    expect(antigravity).toMatch(/^    launch: agy +# the command and its model options; no approval flags$/m);
    expect(validateTeamFile(antigravity).ok).toBe(true);
    const grok = skeleton('acme', null, version(), undefined, firstLoggedInCli(only('grok')));
    expect(grok).toContain('    vendor: xai\n');
    expect(grok).toMatch(/^    model: Grok +# the model's name without its version$/m);
    expect(grok).toMatch(/^    launch: grok +# the command and its model options; no approval flags$/m);
    expect(validateTeamFile(grok).ok).toBe(true);
  });

  test('a team file with and without the schema line produces identical approval fingerprints and zero drift', () => {
    const withLine = skeleton('my-proj', null);
    const withoutLine = withLine.replace(/^# yaml-language-server: [^\n]+\n/, '');
    expect(withLine).not.toBe(withoutLine);
    expect(withoutLine.startsWith('# The team of')).toBe(true);

    const resWithout = validateTeamFile(withoutLine);
    const resWith = validateTeamFile(withLine);
    expect(resWithout.ok).toBe(true);
    expect(resWith.ok).toBe(true);

    if (resWithout.ok && resWith.ok) {
      const fpWithout = fingerprints(resWithout.team);
      const fpWith = fingerprints(resWith.team);
      expect(fpWith.sections).toEqual(fpWithout.sections);
      expect(fpWith.seats).toEqual(fpWithout.seats);

      const fixedDate = new Date(1700000000000);
      expect(approvalOf(resWith.team, project, fixedDate)).toEqual(approvalOf(resWithout.team, project, fixedDate));

      const home = join(base, 'home');
      mkdirSync(home);
      writeApproval(storePath(resWithout.team.project, project, home), { approval: approvalOf(resWithout.team, project), file: withoutLine }, resWithout.team.seats, home);
      expect(approvalDifferences(resWith.team, project, home)).toEqual([]);

      writeApproval(storePath(resWith.team.project, project, home), { approval: approvalOf(resWith.team, project), file: withLine }, resWith.team.seats, home);
      expect(approvalDifferences(resWithout.team, project, home)).toEqual([]);
    }
  });

  test('suggests the current commit as identity.since, as a comment', async () => {
    await runInit([], testIo(project, owner), undefined, undefined, noLogin);
    const head = git(project, 'rev-parse', 'HEAD').trim();
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain(`#   since: ${head}`);
  });

  test('keeps the file and the runtime files out of git through info/exclude, never .gitignore', async () => {
    await runInit([], testIo(project, owner), undefined, undefined, noLogin);
    writeFileSync(join(project, '.agents', 'team.state.json'), '{}');
    writeFileSync(join(project, '.agents', 'team.log.1'), '');
    writeFileSync(join(project, '.agents', 'team.lock'), '1');
    writeFileSync(join(project, '.agents', 'broker.sock'), '');
    writeFileSync(join(project, '.agents', 'broker.sock.lock'), '');
    // The takeover claim beside the lock, and the private temp an atomic create keeps only
    // while it runs — the patterns the start protocol names in its write inventory.
    writeFileSync(join(project, '.agents', 'broker.sock.lock.takeover'), '');
    writeFileSync(join(project, '.agents', 'broker.sock.lock.1234.new'), '');
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(project, '.gitignore'))).toBe(false);
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/team.yaml\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/messages/\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/leases/\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/broker.sock\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/broker.sock.lock\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/broker.sock.lock.takeover\n');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/broker.sock.lock.*.new\n');
  });

  test('a linked worktree shares the exclusion', async () => {
    await runInit([], testIo(project, owner), undefined, undefined, noLogin);
    const worktree = join(base, 'wt');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
    mkdirSync(join(worktree, '.agents'));
    writeFileSync(join(worktree, '.agents', 'team.yaml'), 'x');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  test('run from a subfolder or a worktree, it writes in the main checkout', async () => {
    const worktree = join(base, 'wt');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
    expect(await runInit([], testIo(worktree, owner), undefined, undefined, noLogin)).toBe(0);
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(true);
    expect(existsSync(join(worktree, '.agents'))).toBe(false);
  });

  test('refuses when the file exists, and leaves it as it is', async () => {
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents', 'team.yaml'), 'mine\n');
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(1);
    expect(io.err).toContain('exists already');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe('mine\n');
  });

  test('refuses a file tracked by git, says how to untrack it, and rewrites nothing', async () => {
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents', 'team.yaml'), 'tracked\n');
    git(project, 'add', '.agents/team.yaml');
    git(project, 'commit', '-q', '-m', 'oops');
    const before = git(project, 'rev-parse', 'HEAD');
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(1);
    expect(io.err).toContain('git rm --cached .agents/team.yaml');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('refuses every caller but the owner, and writes nothing', async () => {
    for (const caller of [{ kind: 'seat', name: 'codex-acme', pane: 'w2:p1' }, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' }] as const) {
      const io = testIo(project, caller);
      expect(await init([], io)).toBe(1);
      expect(io.err).toContain('only the owner runs init');
    }
    const noTty = testIo(project, { kind: 'owner-no-tty' });
    expect(await init([], noTty)).toBe(1);
    expect(noTty.err).toBe('team init: only the owner runs this, from a terminal outside herdr\n');
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  test('--restore brings back the copy last approved on this machine', async () => {
    const home = join(base, 'home');
    const text = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error('the example does not validate');
    writeApproval(storePath(result.team.project, project, home), { approval: approvalOf(result.team, project), file: text }, [], home);
    const io = testIo(project, owner);
    expect(await runInit(['--restore'], io, home)).toBe(0);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(text);
    expect(io.out).toContain('Restored .agents/team.yaml');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  test('--restore with nothing approved writes nothing', async () => {
    const io = testIo(project, owner);
    expect(await runInit(['--restore'], io, join(base, 'home'))).toBe(1);
    expect(io.err).toContain('nothing to restore');
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  test('outside a repository, and with an unknown option', async () => {
    expect(await init([], testIo(base, owner))).toBe(2);
    const io = testIo(project, owner);
    expect(await init(['--force'], io)).toBe(2);
    expect(io.err).toContain('unknown option --force');
  });
});

test('the skeleton validates with and without a first commit', () => {
  expect(validateTeamFile(skeleton('acme', null)).ok).toBe(true);
  expect(validateTeamFile(skeleton('acme', 'abc1234')).ok).toBe(true);
});
