import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove, type Waiting } from '../../src/approve/command.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { rulesOf } from '../../src/launch/rules.ts';
import { rulesFileHash, rulesFilePath, rulesFilePathOf, writeRulesFile } from '../../src/launch/rules-file.ts';
import { approvalStanding } from '../../src/store/store.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { paneStillRunning, runDown, type DownSources } from '../../src/commands/down.ts';
import { runUp, type UpSources } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { installKey, keyFolder, recordedGeneration } from '../../src/store/keys.ts';
import { readApproval, readLedger, storePath } from '../../src/store/store.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { claudeBox, testIo } from '../helpers.ts';
import { emptySession, updateState } from '../../src/state.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
/** `team approve` no longer prints deprecation warnings on stderr (0.5.0 output contract §2.4). */
const WARNING = '';
/** The same notice as doctor prints it, among the file's own lines. */
const FILE_WARNING = 'warn  the file, line 5: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read';
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const COORDINATOR: Caller = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' };
const WORKER: Caller = { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' };
const NOW = new Date('2026-10-03T14:02:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-commands-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  // A project, so a run that finds its team file without `--file` (a non-owner may not aim the
  // flag since round 4) resolves the same file rather than failing as "not inside a git
  // repository" before it reaches the gate under test.
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  // Every approval in this file signs with the fixed fixture key, so the fingerprint the
  // commands print is the same on every run.
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const store = () => storePath('acme-web', root, home);
const edit = (change: (text: string) => string) =>
  writeFileSync(join(root, '.agents/team.yaml'), change(readFileSync(join(root, '.agents/team.yaml'), 'utf8')));

async function approve(argv: string[], caller: Caller, answer: string | null = '5', waiting: Waiting = 'empty') {
  const io = testIo(root, caller);
  const asked: string[] = [];
  const code = await runApprove([...argv, ...FILE], io, {
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    waiting: () => waiting,
    now: () => NOW,
    home,
  });
  return { code, out: io.out, err: io.err, asked };
}

describe('team approve', () => {
  test('--show prints the whole file and the ceilings to any caller, and writes nothing', async () => {
    const run = await approve(['--show'], WORKER);
    expect(run.code).toBe(0);
    expect(run.out).toContain('never approved on this machine. The whole file:');
    expect(run.out).toContain('  1: format: 1\n');
    expect(run.out).toContain('Ceilings this approval fixes: 6 seats at most, 2 temporary, openai 1, deepseek 3.\n');
    expect(run.out).toContain(
      'Seats: 5 (claude-coordinator-acme, codex-acme, deepseek-acme, deepseek-acme-2, grok-acme).\n',
    );
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test.each([
    ['a seat', COORDINATOR, 'claude-coordinator-acme'],
    [
      'a call that cannot be placed',
      { kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' } as Caller,
      'unplaced (AGENT_UNATTENDED is set)',
    ],
  ])('refuses %s, without asking', async (_, caller, described) => {
    const run = await approve([], caller);
    expect(run.code).toBe(1);
    expect(run.err).toBe(
      `${WARNING}team approve: only the owner approves a team file, from a terminal outside herdr; this call is ${described}\n`,
    );
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test('approves with no question by default: nothing is asked, the summary prints, and the record is written', async () => {
    const run = await approve([], OWNER);
    expect(run.code).toBe(0);
    expect(run.asked).toEqual([]);
    expect(run.out).toContain('Seats: 5 (claude-coordinator-acme, codex-acme, deepseek-acme, deepseek-acme-2, grok-acme).\n');
    expect(run.out).toContain('Ceilings this approval fixes: 6 seats at most, 2 temporary, openai 1, deepseek 3.\n');
    expect(run.out).toContain('Approved. The record is in ');
    expect(readApproval(store())?.file).toBe(EXAMPLE);
  });

  test('refuses input already waiting on the terminal before writing anything', async () => {
    const run = await approve([], OWNER, '5', 'waiting');
    expect(run.code).toBe(1);
    expect(run.err).toBe(`${WARNING}team approve: input was waiting on the terminal: this command needs the terminal to itself\n`);
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test('a terminal that cannot be read refuses too: only an empty one lets the write through', async () => {
    const run = await approve([], OWNER, '5', 'unreadable');
    expect(run.code).toBe(1);
    expect(run.err).toBe(
      `${WARNING}team approve: the terminal this call runs on could not be read to check for input waiting on it; nothing was written\n`,
    );
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test('a waiting line does not change a refusal made earlier: a seat still gets the owner refusal', async () => {
    const run = await approve([], COORDINATOR, '5', 'waiting');
    expect(run.code).toBe(1);
    expect(run.err).toBe(
      `${WARNING}team approve: only the owner approves a team file, from a terminal outside herdr; this call is claude-coordinator-acme\n`,
    );
    expect(existsSync(store())).toBe(false);
  });

  test.each([['4'], ['yes'], [''], [null]])('--confirm writes nothing when the owner types %p', async (answer) => {
    const run = await approve(['--confirm'], OWNER, answer);
    expect(run.code).toBe(1);
    expect(run.err).toBe(`${WARNING}team approve: not approved; nothing was written\n`);
    expect(existsSync(store())).toBe(false);
  });

  test('--confirm asks the seat-count question, and the right answer approves', async () => {
    const run = await approve(['--confirm'], OWNER, ' 5\n');
    expect(run.code).toBe(0);
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]).toContain('Type the number of seats (5)');
    expect(readApproval(store())?.file).toBe(EXAMPLE);
  });

  describe('a first approval', () => {
    // Every other test starts with the key already installed; here it is removed, so the run
    // below is the first this machine would do — the case the review found: a refusal before
    // any writing must leave no key, no record, no generation and no log behind.
    beforeEach(() => rmSync(keyFolder(home), { recursive: true, force: true }));

    const expectNothingWritten = () => {
      expect(existsSync(keyFolder(home))).toBe(false);
      expect(recordedGeneration(root, home)).toBeNull();
      expect(existsSync(store())).toBe(false);
      expect(existsSync(join(root, '.agents/team.log'))).toBe(false);
    };

    test('input waiting: no key folder, no record, no generation, no log', async () => {
      const run = await approve([], OWNER, '5', 'waiting');
      expect(run.code).toBe(1);
      expect(run.err).toBe(`${WARNING}team approve: input was waiting on the terminal: this command needs the terminal to itself\n`);
      expectNothingWritten();
    });

    test('terminal unreadable: no key folder, no record, no generation, no log', async () => {
      const run = await approve([], OWNER, '5', 'unreadable');
      expect(run.code).toBe(1);
      expect(run.err).toBe(
        `${WARNING}team approve: the terminal this call runs on could not be read to check for input waiting on it; nothing was written\n`,
      );
      expectNothingWritten();
    });

    test('not the owner: no key folder, no record, no generation, no log', async () => {
      const run = await approve([], COORDINATOR);
      expect(run.code).toBe(1);
      expect(run.err).toBe(
        `${WARNING}team approve: only the owner approves a team file, from a terminal outside herdr; this call is claude-coordinator-acme\n`,
      );
      expect(run.asked).toEqual([]);
      expectNothingWritten();
    });

    test('a rejected --confirm answer: no key folder, no record, no generation, no log', async () => {
      const run = await approve(['--confirm'], OWNER, '4');
      expect(run.code).toBe(1);
      expect(run.err).toBe(`${WARNING}team approve: not approved; nothing was written\n`);
      expectNothingWritten();
    });

    test('the first approval that goes through creates all four', async () => {
      const run = await approve([], OWNER);
      expect(run.code).toBe(0);
      expect(run.asked).toEqual([]);
      expect(run.out).toContain('Approved. The record is in ');
      expect(existsSync(join(keyFolder(home), 'key.json'))).toBe(true);
      expect(recordedGeneration(root, home)?.generation).toBe(1);
      expect(readApproval(store())?.file).toBe(EXAMPLE);
      expect(existsSync(join(root, '.agents/team.log'))).toBe(true);
      expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('approve [owner] approved 5 seats');
    });
  });

  describe('a key that cannot be read', () => {
    // The key exists — as it does on the machine of an owner whose key file was torn, or written
    // by something else — and must fail closed before anything is asked: a run that can never
    // sign must not consume a deliberate answer, and the repair names itself.
    beforeEach(() => {
      rmSync(keyFolder(home), { recursive: true, force: true });
      mkdirSync(keyFolder(home), { recursive: true });
      writeFileSync(join(keyFolder(home), 'key.json'), '{');
    });

    const refusal = () =>
      `team approve: ${join(keyFolder(home), 'key.json')}: the signing key is not whole JSON: restore it from a copy — a new key would orphan every record already signed\n`;

    const expectNothingWritten = () => {
      expect(readFileSync(join(keyFolder(home), 'key.json'), 'utf8')).toBe('{');
      expect(recordedGeneration(root, home)).toBeNull();
      expect(existsSync(store())).toBe(false);
      expect(existsSync(join(root, '.agents/team.log'))).toBe(false);
    };

    // The run's seams, counted: the two refusals below must come before the question is asked
    // and before the terminal is read.
    const approveWithSpies = async (argv: string[]) => {
      const io = testIo(root, OWNER);
      const asked: string[] = [];
      let probed = 0;
      const code = await runApprove([...argv, ...FILE], io, {
        ask: async (question) => {
          asked.push(question);
          return '5';
        },
        waiting: () => {
          probed += 1;
          return 'empty';
        },
        now: () => NOW,
        home,
      });
      return { code, out: io.out, err: io.err, asked, probed: () => probed };
    };

    test('--confirm asks nothing and writes nothing', async () => {
      const refused = await approveWithSpies(['--confirm']);
      expect(refused.code).toBe(1);
      expect(refused.err).toBe(`${WARNING}${refusal()}`);
      expect(refused.asked).toEqual([]);
      expectNothingWritten();
    });

    test('the default path the same: the terminal is never read for a run that cannot sign', async () => {
      const refused = await approveWithSpies([]);
      expect(refused.code).toBe(1);
      expect(refused.err).toBe(`${WARNING}${refusal()}`);
      expect(refused.probed()).toBe(0);
      expect(refused.asked).toEqual([]);
      expectNothingWritten();
    });
  });

  test('records the file, its ceilings and its seats once the owner types the number of seats', async () => {
    const run = await approve(['--confirm'], OWNER, ' 5\n');
    expect(run.code).toBe(0);
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]).toContain('Type the number of seats (5)');
    const record = readApproval(store());
    expect(record?.file).toBe(EXAMPLE);
    expect(record?.approval).toMatchObject({
      approvedAt: NOW.toISOString(),
      root,
      ceilings: { seats: 6, temporary: 2, vendors: { openai: 1, deepseek: 3 } },
    });
    expect(readLedger(store()).map((entry) => `${entry.display} · ${entry.role}`)).toEqual([
      'Claude Opus 5.5 · project coordinator',
      'GPT-6 Sol · implementer',
      'DeepSeek V4.1 Flash · implementer',
      'Grok 4.7 · reviewer',
    ]);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toBe(
      '2026-10-03T14:02:00.000Z approve [owner] approved 5 seats; ceilings: 6 seats at most, 2 temporary, openai 1, deepseek 3\n',
    );
  });

  test('shows what changed since the approved copy, and what needs a new approval', async () => {
    await approve([], OWNER);
    const same = await approve(['--show'], WORKER);
    expect(same.out).toContain('the same text as the copy approved on 2026-10-03T14:02:00.000Z.');
    expect(same.out).toContain('Nothing in it needs a new approval.\n');

    edit((text) =>
      text
        .replace('launch: grok --model grok-4.7', 'launch: grok --model grok-4.7 --yolo')
        .replace('seats: 6 ', 'seats: 9 '),
    );
    const changed = await approve(['--show'], WORKER);
    expect(changed.out).toContain(
      '  - 106:     launch: grok --model grok-4.7\n  + 106:     launch: grok --model grok-4.7 --yolo\n',
    );
    expect(changed.out).toContain('Needs a new approval: `limits` changed; seat grok-acme changed.\n');
    expect(changed.out).toContain('Ceilings approved: 6 seats at most, 2 temporary, openai 1, deepseek 3.\n');
    expect(changed.out).toContain(
      'Ceilings this approval fixes: 9 seats at most, 2 temporary, openai 1, deepseek 3.\n',
    );
    expect(readApproval(store())?.approval.ceilings.seats).toBe(6);
  });

  test('refuses a store that sits where seats work', async () => {
    const io = testIo(root, OWNER);
    const inProject = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home: root });
    expect(inProject).toBe(1);
    expect(io.err).toContain(`is inside ${root}, where seats work`);

    const trusted = join(base, 'worktrees/acme-web');
    mkdirSync(trusted, { recursive: true });
    const other = testIo(root, OWNER);
    expect(await runApprove(FILE, other, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home: trusted })).toBe(1);
    expect(other.err).toContain(`is inside ${trusted}, where seats work`);
  });

  test('refuses a file that does not validate, and a usage error', async () => {
    edit((text) => text.replace('format: 1', 'format: 2'));
    const invalid = await approve([], OWNER);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toStartWith('team approve: line 1: ');
    expect((await approve(['--force'], OWNER)).code).toBe(2);
  });
});

describe('the check file loader, after an approval', () => {
  test('accepts the signature of a seat the team has had and the file no longer holds', async () => {
    await approve([], OWNER);
    const before = loadConfig(root, '.agents/team.yaml', home);
    edit((text) => text.replace('version: "4.7"', 'version: "4.8"').replace('grok-4.7', 'grok-4.8'));
    const after = loadConfig(root, '.agents/team.yaml', home);
    if (!before.ok || !after.ok) throw new Error('the file must load');
    const displays = (config: typeof before.config) => config.ledger.map((seat) => `${seat.display} · ${seat.role}`);
    expect(displays(before.config)).not.toContain('Grok 4.8 · reviewer');
    expect(displays(after.config)).toEqual([...displays(before.config), 'Grok 4.8 · reviewer']);
    expect(displays(after.config)).toContain('Grok 4.7 · reviewer');
  });

  test('without an approval, accepts the seats of the file', () => {
    const loaded = loadConfig(root, '.agents/team.yaml', home);
    if (!loaded.ok) throw new Error('the file must load');
    expect(loaded.config.ledger).toHaveLength(4);
  });
});

function doctorSources(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: (binary) => (binary === 'claude' ? '2.1.288 (Claude Code)' : binary === 'codex' ? 'codex-cli 0.157.0' : null),
    onPath: (binary) => binary === 'team-deepseek',
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

/** Writes every unstopped message seat's rules file, as `up` leaves them: the machine these
 *  tests stand for has a team that ran. */
function writeRulesFiles() {
  // Written through the approval in force, as the writer itself insists: every caller has run
  // `team approve` on the file first.
  const standing = approvalStanding(root, home);
  const parsed = validateTeamFile(readFileSync(join(root, '.agents/team.yaml'), 'utf8'));
  if (!parsed.ok) throw new Error('the fixture does not validate');
  for (const seat of parsed.team.seats) {
    if (seat.stopped) continue;
    const text = rulesOf(parsed.team, seat, root);
    const written = writeRulesFile(standing, seat.name, root, home, text, rulesFileHash(text));
    if (!written.ok) throw new Error('the rules file did not write');
  }
}

async function doctor(overrides: Partial<DoctorSources> = {}, argv: string[] = []) {
  const io = testIo(root, WORKER);
  const code = await runDoctor([...argv, ...FILE], io, doctorSources(overrides));
  return { code, out: io.out, err: io.err };
}

describe('team doctor', () => {
  test('a file that was never approved is not a doctor miss', async () => {
    const run = await doctor();
    expect(run.out).not.toContain('team approve');
    expect(run.out).not.toContain('never approved');
  });

  test('passes on an approved file with everything in place, and names what it leaves out', async () => {
    await approve([], OWNER);
    writeRulesFiles();
    const run = await doctor();
    expect(run.err).toBe('');
    expect(run.out).toBe(
      [
        'team acme-web, session "acme-web"',
        FILE_WARNING,
        'ok    herdr 0.7.1',
        'note  session acme-web is not running',
        'ok    claude 2.1.288 (Claude Code)',
        'ok    claude-code: logged in',
        'warn  deepseek-acme: the launch runs team-deepseek, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
        'warn  deepseek-acme-2: the launch runs team-deepseek, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
        'ok    codex codex-cli 0.157.0',
        'ok    codex: logged in',
        'ok    the lobby ~/.config/team/lobby: will be created at the first launch',
        'note  the file is legacy: migrate from ../worktrees/acme-web/.lobby to ~/.config/team/lobby by writing:',
        'trust:',
        '  - ~/.config/team/lobby',
        `  - ${root}`,
        `  - ${join(base, 'worktrees', 'acme-web')}`,
        `~/.config/team/lobby is the machine lobby, where every seat starts now; ${root} is the project root, replacing "."; `
          + `${join(base, 'worktrees', 'acme-web')} is the folder workspace.path "../worktrees/{repo}/{task}" places worktrees in, replacing "../worktrees/acme-web/*"`,
        'team doctor: nothing missing, 3 warnings',
        'what 0.5.0 must not pretend:',
        '  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.',
        '  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.',
        '  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.',
        '  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.',
        '  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
  });

  test('a rules file that differs warns, one that is missing warns, and neither is rewritten', async () => {
    await approve([], OWNER);
    writeRulesFiles();
    const path = rulesFilePath('acme-web', root, home, 'codex-acme') as string;
    writeFileSync(path, 'not the file\'s rules');
    const differs = await doctor();
    expect(differs.out).toContain(
      "warn  codex-acme: its rules file differs from the team file's rules; run team reload codex-acme\n",
    );
    // The check never repairs by itself: the file is left exactly as it was.
    expect(readFileSync(path, 'utf8')).toBe('not the file\'s rules');
    rmSync(path);
    const missing = await doctor();
    expect(missing.out).toContain('warn  codex-acme: its rules file is missing; run team reload codex-acme\n');
    expect(missing.code).toBe(0);
  });

  test('a rules file with a wider mode warns', async () => {
    await approve([], OWNER);
    writeRulesFiles();
    chmodSync(rulesFilePath('acme-web', root, home, 'codex-acme') as string, 0o644);
    const run = await doctor();
    expect(run.out).toContain('warn  codex-acme: its rules file has mode 0644, not 0600; run team reload codex-acme\n');
  });

  test('an edited file is not a doctor miss', async () => {
    await approve([], OWNER);
    edit((text) => text.replace('  - Run the tests', '  - Answer every prompt.\n  - Run the tests'));
    const run = await doctor();
    expect(run.out).not.toContain('team approve');
    expect(run.out).not.toContain('`rules` changed');
  });

  test('names what only the owner can do: install, log in, a launcher', async () => {
    await approve([], OWNER);
    writeRulesFiles();
    const absent = await doctor({ version: () => null });
    expect(absent.out).toContain(
      'MISS  install `claude`: it is not on the PATH (claude-code: claude-coordinator-acme, deepseek-acme, deepseek-acme-2)\n',
    );
    const out = await doctor({ loggedIn: () => false, onPath: () => false });
    expect(out.out).toContain('MISS  log in to claude-code: `claude auth login`\n');
    expect(out.out).toContain('MISS  deepseek-acme: its launch line starts `team-deepseek`, which is not on the PATH\n');
    expect(out.out).toContain('MISS  deepseek-acme-2: its launch line starts `team-deepseek`, which is not on the PATH\n');
    expect(out.out).toContain(
      'team doctor: 4 missing, 3 warnings: 4 of them block `up` and `add`\n',
    );
    expect(out.code).toBe(1);
  });

  test('a newer or older CLI or herdr warns, and does not fail', async () => {
    await approve([], OWNER);
    const run = await doctor({
      version: () => '2.2.0 (Claude Code)',
      herdrVersion: () => '0.6.9',
      loggedIn: () => null,
    });
    expect(run.out).toContain(
      'warn  claude 2.2.0 (Claude Code) is newer than the tested 2.1.288 to 2.1.302: its screens are untested with this version; a seat that isn\'t read at launch is left out, never typed into\n',
    );
    expect(run.out).toContain('warn  herdr 0.6.9 is older than the tested 0.7.1\n');
    expect(run.out).toContain('note  claude-code: the login is not checked in this version\n');
    expect(run.code).toBe(0);
  });

  test('a bare model-less launch warns only when the screen cannot check it', async () => {
    edit((text) => text.replace(
      `  - role: reviewer
    name: grok-acme
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok --model grok-4.7
    stopped: true              # kept in the file; \`up\` doesn't start it, \`add grok-acme\` does`,
      `  - role: reviewer
    name: cursor-acme
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent
  - role: implementer
    name: agy-acme
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
  - role: implementer
    name: cursor-other
    cli: cursor
    vendor: xai
    model: Muse Spark
    version: "1.3"
    launch: cursor-agent`,
    ));
    // No approval call: a missing record is not a refusal, and every warning below is about a model.
    const run = await doctor({
      version: (binary) => binary === 'claude'
        ? '2.1.288 (Claude Code)'
        : binary === 'codex'
          ? 'codex-cli 0.157.0'
          : binary === 'cursor-agent'
            ? '2026.10.01-14929f9'
            : binary === 'agy'
              ? '1.2.16'
              : null,
      onPath: (binary) => binary === 'team-deepseek',
    });
    // cursor-agent started bare shows Grok 4.7, so this seat is checked on the running screen:
    // no line for it. Muse Spark is a family the cursor rules cannot spell, so nothing checks
    // that seat and the warning says so. `agy` shows Gemini Flash likewise.
    expect(run.out).not.toContain('cursor-acme');
    expect(run.out).toContain(
      "warn  cursor-other: no model flag, and this version can't read Muse Spark 1.3 on this CLI's screen: nothing checks that it runs it\n",
    );
    expect(run.out).not.toContain('agy-acme');
    // The deepseek seats run a launcher, which only `model_from: launcher` can settle.
    expect(run.out).toContain(
      'warn  deepseek-acme: the launch runs team-deepseek, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher\n',
    );
    expect(run.out).not.toContain('cursor-other: the launch names no model this version knows');
    expect(run.out).toContain('team doctor: nothing missing, 4 warnings\nwhat 0.5.0 must not pretend:\n');
  });

  test("a launch whose model is not the file's warns", async () => {
    edit((text) => text.replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-fable-5-1'));
    const run = await doctor();
    expect(run.out).toContain(
      'warn  claude-coordinator-acme: the launch starts Claude Fable 5.1, the file says Claude Opus 5.5\n',
    );
  });

  test('herdr that is absent or silent is missing', async () => {
    await approve([], OWNER);
    expect((await doctor({ herdrVersion: () => null })).out).toContain('MISS  install herdr: it is not on the PATH\n');
    const silent = await doctor({ sessionRunning: () => null });
    expect(silent.out).toContain("MISS  herdr doesn't answer\n");
    expect(silent.code).toBe(1);
  });

  test('a running session needs a watch with a fresh heartbeat', async () => {
    await approve([], OWNER);
    writeRulesFiles();
    const none = await doctor({ sessionRunning: () => true });
    expect(none.out).toContain('MISS  no watch has run for session acme-web: start `team watch`\n');
    // The watch is the only missing thing and it blocks nothing: the line ends with the counts.
    expect(none.out).toContain('team doctor: 1 missing, 3 warnings\n');
    expect(none.out).not.toContain('block `up` and `add`');

    const state = (heartbeat: string) =>
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: { 'acme-web': { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat } } },
        }),
      );
    state('2026-10-03T13:59:00Z');
    expect((await doctor({ sessionRunning: () => true })).out).toContain('ok    the watch is running\n');
    state('2026-10-03T13:50:00Z');
    const stale = await doctor({ sessionRunning: () => true });
    expect(stale.out).toContain(
      "MISS  the watch's heartbeat is 12 min old (two intervals are 4 min): start `team watch`\n",
    );
    expect(stale.out).toContain('team doctor: 1 missing, 3 warnings\n');
    expect(stale.code).toBe(1);
  });

  test('a live interval edit controls the heartbeat verdict', async () => {
    await approve([], OWNER);
    const state = (heartbeat: string) =>
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: { 'acme-web': { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat } } },
        }),
      );
    // Stretching the file's interval to a thousand hours is unapproved, so the approved two
    // minutes still decide: a twelve-minute-old heartbeat is stale, not hidden by the edit.
    edit((text) => text.replace(/^  interval: .*$/m, '  interval: 1000h'));
    state('2026-10-03T13:50:00Z');
    const stretched = await doctor({ sessionRunning: () => true });
    expect(stretched.out).toContain('ok    the watch is running\n');
    // And a shrink is no better: three minutes are inside the approved two intervals, whoever
    // wrote ten seconds in the file.
    edit((text) => text.replace(/^  interval: .*$/m, '  interval: 10s'));
    state('2026-10-03T13:59:00Z');
    expect((await doctor({ sessionRunning: () => true })).out).toContain("MISS  the watch's heartbeat is 3 min old");
  });

  test('--session names another session', async () => {
    await approve([], OWNER);
    expect((await doctor({}, ['--session', 'team-test'])).out).toContain('note  session team-test is not running\n');
  });
});

const agent = (name: string | null, status = 'idle', id = name ?? 'x'): HerdrAgent => ({
  name,
  agent: 'claude',
  pane: `${id}:p1`,
  workspace: id,
  status,
  cwd: null,
});

async function up(argv: string[], caller: Caller, overrides: Partial<UpSources> = {}) {
  const io = testIo(root, caller);
  const code = await runUp([...argv, ...FILE], io, {
    sessionRunning: () => false,
    agents: () => [],
    home,
    ...overrides,
  });
  return { code, out: io.out, err: io.err };
}

describe('team up', () => {
  test('a missing record does not refuse, and a legacy file still launches nothing', async () => {
    const run = await up([], OWNER);
    expect(run.err).not.toContain('never approved');
    expect(run.err).not.toContain('the file is legacy:');
    expect(run.err).toContain('the file lists project-relative trust: this run trusts only the lobby');
  });

  test("--dry-run prints the plan for the approved file, with each seat's rules and signature", async () => {
    await approve([], OWNER);
    const run = await up(['--dry-run'], OWNER);
    expect(run.out).not.toContain('the file is legacy');
    expect(run.err).toContain(`team up: the file lists project-relative trust: this run trusts only the lobby ${home}/.config/team/lobby and the project root ${root}`);
    expect(run.out).not.toContain('the file was never approved');
    expect(run.out).toContain(
      `+ herdr --session acme-web workspace create --cwd ${root} --label 'claude-coordinator-acme · project coordinator' --no-focus\n`,
    );
    expect(run.out).toContain(
      "+ herdr --session acme-web pane run <pane of claude-coordinator-acme> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --name claude-coordinator-acme --append-system-prompt '\\''Rules for this session, from the team file:",
    );
    expect(run.out).toContain(
      '- Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · project coordinator\n',
    );
    expect(run.out).toContain(
      '- Your signature in a pull request body, as its last line: **Agent:** DeepSeek V4.1 Flash · implementer\n',
    );
    expect(run.out).toContain('- Run a script with its interpreter; never chmod, chown, sudo or recursive rm.\n');
    expect(run.out).toContain('AGENT_UNATTENDED=1 team-deepseek --dangerously-skip-permissions --name deepseek-acme --append-system-prompt');
    expect(run.out).toContain('+ herdr --session acme-web agent rename <pane of deepseek-acme-2> deepseek-acme-2\n');
    expect(run.out).toContain('AGENT_UNATTENDED=1 codex -m gpt-6-sol -c model_reasoning_effort=high -a never -s danger-full-access');
    expect(run.out).toContain('pane send-text <pane of codex-acme>');
    expect(run.out).toContain('  skip grok-acme: stopped in the file; start it with `team add grok-acme`\n');
    // The plan's last steps: the watch's own workspace, then its command in that pane.
    expect(run.out).toContain(`+ herdr --session acme-web workspace create --cwd ${root} --label 'Watch · acme-web' --no-focus\n`);
    expect(run.out).toContain("+ herdr --session acme-web pane run <pane of Watch · acme-web> '");
    expect(run.out).toContain('watch --session acme-web');
    expect(run.out).toContain('    (a desktop notification follows when the watch exits)\n');
    expect(run.out).toEndWith('dry run: nothing was run\n');
  });

  test('a seat the file does not name: the dry run names the placement, the owner\'s command and the plan', async () => {
    const run = await up(['--dry-run'], WORKER, {
      sessionRunning: () => true,
      agents: () => [agent('stranger'), agent(null)],
    });
    expect(run.code).toBe(1);
    expect(run.err).toBe('');
    expect(run.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is deepseek-acme\n');
    expect(run.out).toContain('! to unblock: a `leads` seat runs `team up --file .agents/team.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(run.out).toEndWith('dry run: nothing was run\n');
  });

  test('--dry-run names an edited file and a silent herdr', async () => {
    await approve([], OWNER);
    edit((text) => text.replace('launch: team-deepseek', 'launch: team-deepseek --yolo'));
    const run = await up(['--dry-run', '--session', 'team-test'], OWNER, { sessionRunning: () => null });
    expect(run.out).not.toContain('not the approved one');
    // The plan's rules line still says never to run the command. That is not a refusal.
    expect(run.out).not.toContain('run `team approve`');
    expect(run.out).toContain("! up would refuse: herdr doesn't answer\n");
    expect(run.out).toContain('+ herdr --session team-test workspace create');
  });

  test('a resumed session passes when the state records its agents', async () => {
    await approve([], OWNER);
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: { 'acme-web': { seats: { 'deepseek-acme': { stage: 'ready' } }, worktrees: {} } },
      }),
    );
    const run = await up(['--dry-run'], OWNER, { sessionRunning: () => true, agents: () => [agent('deepseek-acme')] });
    expect(run.out).not.toContain("doesn't record");
    expect(run.err).toContain('the file lists project-relative trust: this run trusts only the lobby');
    expect(run.out).not.toContain('env -i');
  });
});

async function down(argv: string[], caller: Caller, overrides: Partial<DownSources> = {}) {
  await approve([], OWNER);
  const io = testIo(root, caller);
  const code = await runDown([...argv, ...(caller.kind === 'owner' ? FILE : [])], io, {
    sessionRunning: () => true,
    agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme'), agent('deepseek-acme-2', 'working')],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    home,
    ...overrides,
  });
  return { code, out: io.out, err: io.err };
}

describe('team down', () => {
  test('a seat other than the coordinator or the operator stops nothing', async () => {
    const run = await down([], WORKER);
    expect(run.code).toBe(1);
    expect(run.err).toContain('team down: only the owner or `leads` stops the team; this call is deepseek-acme\n');
    expect(run.out).toBe('');
  });

  test('--dry-run for the owner: free seats are stopped, a working one and the session are left', async () => {
    const run = await down(['--dry-run'], OWNER);
    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        '+ herdr --session acme-web pane run claude-coordinator-acme:p1 /exit',
        "  wait until claude-coordinator-acme's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close claude-coordinator-acme',
        '+ herdr --session acme-web pane run deepseek-acme:p1 /exit',
        "  wait until deepseek-acme's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close deepseek-acme',
        '  skip deepseek-acme-2: is working (`--wait` waits for it); left running',
        '  skip session acme-web: not stopped, 1 agent left in it',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test("--dry-run for the coordinator leaves its own seat; another seat's call would be refused", async () => {
    // The state `team up` writes for the coordinator's seat: the caller gate judges a seat on
    // the pane the state records for it, and a state that records no pane fails closed. Without
    // the record the call is refused for the missing pane, not read as the coordinator.
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: { 'acme-web': { seats: { 'claude-coordinator-acme': { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } },
      }),
    );
    const lead = await down(['--dry-run'], COORDINATOR);
    expect(lead.out).toStartWith(
      "  skip claude-coordinator-acme: left running; only the owner stops the orchestrator's or the operator's seat\n+ herdr --session acme-web pane run deepseek-acme:p1 /exit\n",
    );
    expect(lead.out).not.toContain('! down would refuse');

    const worker = await down(['--dry-run'], WORKER);
    expect(worker.out).toStartWith(
      '! down would refuse: only the owner or `leads` stops the team; this call is deepseek-acme\n',
    );
  });

  test('--dry-run never closes an agent the file does not name, and stops the watch it knows', async () => {
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'deepseek-acme-tmp-1': { stage: 'ready', temporary: { like: 'deepseek-acme', until: 'result:out.md' } },
            },
            worktrees: {},
            watch: { pid: 4242, heartbeat: '2026-10-03T14:00:00Z' },
          },
        },
      }),
    );
    const state = readFileSync(join(root, '.agents/team.state.json'), 'utf8');
    const run = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme-tmp-1'), agent('stranger'), agent(null), agent('codex-acme', 'blocked')],
    });
    // None of these panes is recorded, so the plan must not claim a close. The first head
    // printed the unnamed pane's leave-line in front of this text and closed nothing.
    expect(run.out).toStartWith(
      [
        'pane x:p1: not recorded for a seat of this team; left as it is',
        'deepseek-acme-tmp-1: its record is not an approved seat; left running (the owner cleans it: team remove deepseek-acme-tmp-1 --abandon)',
        'stranger: its record is not an approved seat; left running (the owner cleans it: team remove stranger --abandon)',
        'watch: its pid is only in the state; left running',
        '  skip codex-acme: is blocked at a prompt, which `team` never answers; left running',
        '  skip session acme-web: not stopped, 4 agents left in it',
      ].join('\n'),
    );
    expect(run.out).not.toContain('workspace close');
    expect(run.out).not.toContain('+ kill');
    expect(run.out).toContain('dry run: nothing was run\n');
    expect(readFileSync(join(root, '.agents/team.state.json'), 'utf8')).toBe(state);
  });

  test('--dry-run says it would close a pane whose ids match a record, and touches nothing', async () => {
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'deepseek-acme': { stage: 'launched', pane: 'seat-1:p1', workspace: 'seat-1' } },
            worktrees: {},
          },
        },
      }),
    );
    const state = readFileSync(join(root, '.agents/team.state.json'), 'utf8');
    const run = await down(['--dry-run'], OWNER, {
      agents: () => [agent(null, 'idle', 'seat-1')],
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("+ herdr --session acme-web workspace close seat-1\n    (created for this seat and never named; closed without typing)\n");
    expect(run.out).toContain('dry run: nothing was run\n');
    expect(readFileSync(join(root, '.agents/team.state.json'), 'utf8')).toBe(state);
  });

  test('an idle status at a permission prompt is blocked, and unsent text stays unsent', async () => {
    const blocked = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => ({ kind: 'permission' }),
    });
    expect(blocked.out).toContain('deepseek-acme: is blocked at a prompt, which `team` never answers; left running');
    expect(blocked.out).not.toContain('pane run deepseek-acme');

    const unsent = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => ({ kind: 'unsent' }),
    });
    expect(unsent.out).toContain('deepseek-acme: holds unsent text in its input box; left running');
    expect(unsent.out).not.toContain('pane run deepseek-acme');
  });

  test('a Cursor queue screen is working: its pane is not typed into', async () => {
    const queued = readScreen(
      'cursor',
      readFileSync(new URL('../fixtures/cursor/2026.10.01/follow-up-queue-two.txt', import.meta.url), 'utf8'),
    );
    expect(queued.kind).toBe('working');
    const run = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => queued,
    });
    expect(run.out).toContain('deepseek-acme: is working (`--wait` waits for it); left running');
    expect(run.out).not.toContain('pane run deepseek-acme');
  });

  test('--dry-run on a session that is not running, or a silent herdr', async () => {
    const stopped = await down(['--dry-run'], OWNER, { sessionRunning: () => false });
    expect(stopped).toMatchObject({
      code: 0,
      out: 'session acme-web is not running: nothing to stop\ndry run: nothing was run\n',
    });
    expect((await down(['--dry-run'], OWNER, { sessionRunning: () => null })).code).toBe(2);
    expect((await down(['--dry-run'], OWNER, { agents: () => null })).code).toBe(2);
  });

  test('a session every seat leaves is stopped and cleared in the same run, and the dry run says so', async () => {
    const free = {
      agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme'), agent('deepseek-acme-2')],
    };
    const dry = await down(['--dry-run'], OWNER, free);
    expect(dry.code).toBe(0);
    expect(dry.out).toEndWith(
      [
        '+ herdr session stop acme-web',
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test("a temporary seat's rules file goes with it when the team comes down", async () => {
    // The file's folder is resolved from the approval in force, so the team that ran has one.
    await approve([], OWNER);
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['deepseek-acme-tmp-1'] = { stage: 'ready', temporary: { like: 'deepseek-acme', until: 'result:out.md' } };
    });
    const standing = approvalStanding(root, home);
    const rulesFile = rulesFilePathOf(standing, 'deepseek-acme-tmp-1', root, home) as string;
    writeRulesFile(standing, 'deepseek-acme-tmp-1', root, home, 'Rules.\n', rulesFileHash('Rules.\n'));
    // The exit is typed at an idle prompt, read back, and sent; the pane leaves the agent list.
    let sent = false;
    // The pane's box, physically: the empty idle box before the typing, the typed text after.
    let box: string | undefined = claudeBox('');
    const run = await down([], OWNER, {
      agents: () => [agent('deepseek-acme-tmp-1')],
      screenText: () => box,
      foreground: () => (sent ? [] : ['claude']),
      home,
      launch: {
        typeText: (_session, _pane, text) => { box = claudeBox(text); return true; },
        sendKey: () => { box = claudeBox(''); return true; },
        pressEnter: () => { sent = true; return true; },
        agentPanes: () => ['deepseek-acme-tmp-1:p1'],
        closeWorkspace: () => true,
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => true,
        sleep: async () => {},
        now: () => NOW,
      },
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('deepseek-acme-tmp-1: its record is not an approved seat; left running (the owner cleans it: team remove deepseek-acme-tmp-1 --abandon)\n');
    expect(existsSync(rulesFile)).toBe(true);
  });

  test('a session herdr reports stopped before down acts is only reported, not stopped or cleared', async () => {
    const run = await down([], OWNER, { sessionRunning: () => false });
    expect(run).toMatchObject({ code: 0, out: 'session acme-web is not running: nothing to stop\n' });
  });

  test('a pane back at its shell is not the seat any more', () => {
    expect(paneStillRunning(['claude'], ['claude'])).toBe(true);
    expect(paneStillRunning(['zsh'], ['claude'])).toBe(false);
    expect(paneStillRunning([], ['claude'])).toBe(false);
    expect(paneStillRunning(null, ['claude'])).toBe(true);
  });
});
