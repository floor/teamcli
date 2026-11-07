// A launch line is read the way `team` has always split it — on whitespace — and its program and
// its relative paths are looked for where the line will run: the folder the seat starts in. A
// relative path that a hand run in the project root finds may resolve nowhere from the lobby, and
// that is the finding this check exists for. A line it cannot read is said to be unchecked, never
// refused.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession } from '../src/state.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  launchBinary,
  launchLineFinding,
  launchLineFindings,
  launchProgram,
  launchedCliBinary,
  startFolder,
  type LineSources,
} from '../src/launch/line.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';

// A single-quoted YAML scalar, so a launch line full of quotes survives the file and reaches the
// check as the string it was written as.
const yamlQuote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const TEAM = (launch: string, extra = '') => `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${yamlQuote(launch)}
${extra}`;

let base: string;
let root: string;
let home: string;
let lobby: string;

function team(launch: string, extra = ''): TeamFile {
  const result = validateTeamFile(TEAM(launch, extra));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function seat(launch: string, name = 'worker', extra = ''): Seat {
  const found = team(launch, extra).seats.find((item) => item.name === name);
  if (!found) throw new Error(`no seat ${name}`);
  return found;
}

const sources = (over: Partial<LineSources> = {}): LineSources => ({ onPath: () => true, home, ...over });
const file = (path: string, text = 'x\n'): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-line-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  lobby = join(base, 'worktrees', 'acme', '.lobby');
  mkdirSync(root, { recursive: true });
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the launch line check', () => {
  test('the program is the first word that is not an assignment', () => {
    expect(launchBinary('AGENT_UNATTENDED=1 claude --model x')).toBe('claude');
    expect(launchBinary('  team-deepseek  ')).toBe('team-deepseek');
    expect(launchBinary('')).toBeNull();
  });

  // A vendor line puts its credential lookup inside one assignment word. The word holds spaces,
  // and the program is the word after it, never a word the substitution runs.
  test('a vendor line names the CLI after its assignment words', () => {
    const line =
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ' +
      'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s deepseek-api-key -a "$USER" -w) ' +
      'ANTHROPIC_MODEL=deepseek-flash claude --model deepseek-flash';
    expect(launchBinary(line)).toBe('claude');
    expect(launchedCliBinary(line)).toBe('claude');
    expect(launchedCliBinary(`ANTHROPIC_MODEL=glm-5.3 zsh ~/tools/as-floor.sh claude --model glm-5.3`)).toBe('claude');
    // The program the line starts is still the wrapper shell, while the CLI it ends at is claude.
    expect(launchBinary('ANTHROPIC_MODEL=glm-5.3 zsh ~/tools/as-floor.sh claude --model glm-5.3')).toBe('zsh');
  });

  test('a vendor line is checked for its CLI, never for a word inside its credential lookup', () => {
    const launch =
      'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s item -a "$USER" -w) claude --model m';
    // `find-generic-password` is not on this PATH, and it is not the program: the line runs
    // claude, and the substitution's words are not checked.
    const finding = launchLineFinding(team(launch), seat(launch), root, sources({ onPath: (binary) => binary === 'claude' }));
    expect(finding?.level).toBe('note');
    expect(finding?.why).toContain('not checked');
  });

  // The program a launch line really starts, for the reader that decides whether a launcher
  // selects a model: plumbing (assignments, an `env` prefix, a shell reading a script, quotes)
  // is read off until a program is left, and a word this reader cannot follow names none.
  test('the program a launch line really starts is read through its plumbing', () => {
    expect(launchProgram('claude --model x')).toBe('claude');
    expect(launchProgram('/usr/local/bin/claude')).toBe('claude');
    expect(launchProgram('env claude')).toBe('claude');
    expect(launchProgram('env -i FOO=1 -- claude')).toBe('claude');
    expect(launchProgram('AGENT_UNATTENDED=1 claude')).toBe('claude');
    expect(launchProgram('"claude"')).toBe('claude');
    expect(launchProgram("'claude'")).toBe('claude');
    expect(launchProgram('zsh ~/tools/run.sh claude')).toBe('run.sh');
    expect(launchProgram('env -S "claude --model x"')).toBeNull();
    expect(launchProgram('bash -l x')).toBeNull();
    expect(launchProgram('$RUNNER claude')).toBeNull();
    expect(launchProgram('claude*')).toBeNull();
    expect(launchProgram('env')).toBeNull();
    expect(launchProgram('')).toBeNull();
  });

  test('a seat that works in worktrees starts in the lobby; a shared one where the file says', () => {
    const one = team('claude --model claude-opus-5-5');
    expect(startFolder(one, one.seats[1] as Seat)).toBe('../worktrees/acme/.lobby');
    expect(startFolder(one, one.seats[0] as Seat)).toBe('.');
  });

  test('a launcher on the PATH is fine; one that is not is a finding', () => {
    expect(launchLineFinding(team('team-deepseek --key x'), seat('team-deepseek --key x'), root, sources())).toBeNull();
    const finding = launchLineFinding(
      team('team-deepseek'),
      seat('team-deepseek'),
      root,
      sources({ onPath: (binary) => binary !== 'team-deepseek' }),
    );
    expect(finding).toEqual({ level: 'miss', why: 'its launch line starts `team-deepseek`, which is not on the PATH' });
  });

  test('a line whose quoting never closes is refused, never read as words it does not have', () => {
    // No shell can read this line: a word after the half-open quote is not a word at all, so the
    // check says so plainly rather than guessing at a program and paths inside the unread text.
    const text = team('/bin/sh -c "claude --model m');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())).toEqual({
      level: 'miss',
      why: 'its launch line has an unclosed quote or a trailing backslash: close it before the line can run',
    });
  });

  test("its profile's own binary is left to the install finding", () => {
    const text = team('claude --model claude-opus-5-5');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources({ onPath: () => false }))).toBeNull();
  });

  test("a seat's file that only the project root holds is a finding naming the lobby and the file", () => {
    file(join(base, 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh');
    const finding = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(finding).toEqual({
      level: 'miss',
      why:
        'its launch line runs `../tools/x.sh`, not found from its start folder ../worktrees/acme/.lobby; ' +
        `the same file is at \`${join(base, 'tools', 'x.sh')}\` from the project root — write that path`,
      // The same finding in words, folder-free: what a record and the log may hold.
      record: 'its launch line runs `../tools/x.sh`, not found from its start folder',
    });
  });

  test('the same line is fine for a seat that starts in the project root', () => {
    file(join(base, 'tools', 'x.sh'));
    const extra = `
  - role: implementer
    name: rooty
    label: rooty
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: zsh ../tools/x.sh
    mode: shared
`;
    const text = team('claude --model claude-opus-5-5', extra);
    const found = text.seats.find((item) => item.name === 'rooty');
    if (!found) throw new Error('no seat rooty');
    expect(startFolder(text, found)).toBe('.');
    expect(launchLineFinding(text, found, root, sources())).toBeNull();
  });

  test('the same line is fine when the file is there from the lobby too', () => {
    file(join(base, 'worktrees', 'acme', 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())).toBeNull();
  });

  test('a relative path that resolves from neither place is a note, not a refusal', () => {
    // The command may create the file it is given, so a path that exists nowhere yet is only said.
    const text = team('zsh ./nowhere.sh');
    const finding = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(finding).toEqual({
      level: 'note',
      why:
        'its launch line runs `./nowhere.sh`, not found from its start folder ../worktrees/acme/.lobby; ' +
        'not checked: the command may create it',
    });
  });

  test('a ~/… that expands to a file is fine; one that does not is a note', () => {
    file(join(home, 'bin', 'x.sh'));
    const good = team('zsh ~/bin/x.sh');
    expect(launchLineFinding(good, good.seats[1] as Seat, root, sources())).toBeNull();
    const bad = team('zsh ~/bin/missing.sh');
    expect(launchLineFinding(bad, bad.seats[1] as Seat, root, sources())).toEqual({
      level: 'note',
      why: 'its launch line runs `~/bin/missing.sh`, not found from `~`; not checked: the command may create it',
    });
  });

  test('a program written as a path is looked for from the folder it would run in', () => {
    const missing = team('./run.sh');
    expect(launchLineFinding(missing, missing.seats[1] as Seat, root, sources())?.level).toBe('miss');
    file(join(lobby, 'run.sh'));
    const there = team('./run.sh');
    expect(launchLineFinding(there, there.seats[1] as Seat, root, sources())).toBeNull();
    const absolute = team('/nowhere/at/all');
    expect(launchLineFinding(absolute, absolute.seats[1] as Seat, root, sources())).toEqual({
      level: 'miss',
      why: 'its launch line starts `/nowhere/at/all`, which does not exist',
    });
  });

  test('a path program that exists but would not run is a miss, as main refused it', () => {
    // Main's launcher test was `accessSync(…, X_OK)`: a file that is there but not executable is
    // no launcher, and the line would fail the moment the pane ran it.
    file(join(lobby, 'run.sh'));
    const text = team('./run.sh');
    const finding = launchLineFinding(
      text,
      text.seats[1] as Seat,
      root,
      sources({ onPath: (binary) => binary !== join(lobby, 'run.sh') }),
    );
    expect(finding).toEqual({
      level: 'miss',
      why: 'its launch line starts `./run.sh`, which is not executable',
    });
  });

  test('an argument the check does not examine is left alone', () => {
    const text = team('claude --model claude-opus-5-5 --add-dir relative/dir');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())).toBeNull();
  });

  test('a line that quotes or substitutes text is not checked, and never refused', () => {
    for (const launch of ['claude --model x --append-system-prompt "be terse"', 'claude $(which claude)', "zsh 'x.sh'"]) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources());
      expect(finding?.level).toBe('note');
      expect(finding?.why).toContain('not checked');
    }
  });

  test('a missing program is a miss whatever follows it, a quoted tail included', () => {
    // The first word is checked before the quoting is noticed: main refused `claude "$HOME"`
    // with `claude` off the PATH, and this check may refuse nothing less.
    for (const launch of ['team-deepseek "$HOME"', 'VAR=1 team-deepseek "x y"', 'team-deepseek $(pwd)']) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources({ onPath: () => false }));
      expect(finding).toEqual({
        level: 'miss',
        why: 'its launch line starts `team-deepseek`, which is not on the PATH',
      });
    }
  });

  test('a fully quoted first word is unquoted and checked, as main refused it', () => {
    // The reviewer's probe: `"definitely-missing" --flag` is a word a shell runs as written —
    // run from an empty scratch folder, `/bin/sh: definitely-missing: command not found`, exit
    // 127 — and main refused it. The quotes are the only thing the shell removes, so the word
    // inside is checked as the program, whatever the line looks like.
    for (const launch of [
      '"definitely-missing" --flag',
      "'definitely-missing' --flag",
      'VAR=1 "definitely-missing" --flag',
      '"definitely-missing"',
    ]) {
      const raw = launch.includes('"') ? '"definitely-missing"' : "'definitely-missing'";
      const finding = launchLineFinding(
        team(launch),
        seat(launch),
        root,
        sources({ onPath: (binary) => binary !== 'definitely-missing' }),
      );
      expect(finding).toEqual({
        level: 'miss',
        why: `its launch line starts \`${raw}\`, which is not on the PATH`,
      });
    }
  });

  test('a quoted first word the shell would still read is read; the rest stays a note', () => {
    // `"claude"` is the same word as `claude`; `"$HOME"` and `'a*'` are not — the shell would do
    // more than remove the quotes — and a line whose first word it would act on is only said to
    // be unchecked. A readable quoted first word does not make an unreadable tail readable.
    const good = team('"claude" --model x');
    expect(launchLineFinding(good, good.seats[1] as Seat, root, sources())).toBeNull();
    for (const launch of ['"$HOME" --flag', "'a*' --flag", '"claude" --append-system-prompt "be terse"']) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources());
      expect(finding?.level).toBe('note');
      expect(finding?.why).toContain('not checked');
    }
  });

  test('quoting suppresses tilde expansion: a quoted ~ path is the word it is written', () => {
    // `"~/x"` is not `~/x`: the shell removes only the quotes, and the word is then a pathname
    // with a literal `~` folder, resolved from the folder the line runs in — never the home.
    file(join(home, 'x'));
    const finding = launchLineFinding(team('"~/x"'), seat('"~/x"'), root, sources());
    expect(finding).toEqual({
      level: 'miss',
      why: 'its launch line starts `"~/x"`, not found from its start folder ../worktrees/acme/.lobby',
      record: 'its launch line starts `"~/x"`, not found from its start folder',
    });
  });

  test('an argument that runs is a note whatever the program: only a shell script path is refused', () => {
    // The reviewer's false refusals: `echo -c ../y` and `touch ../created.log` ran with exit 0
    // while the project-root copies existed and the start-folder ones did not. An argument's
    // meaning is not knowable in general — option text, an output path, a path a launcher
    // changes directory for — so every relative argument is a note naming the folder it was
    // looked for in. The refusal is kept only where failure is certain (the test below).
    file(join(base, 'y'));
    file(join(base, 'created.log'));
    for (const launch of ['echo -c ../y', 'touch ../created.log', 'claude --config=../y']) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources());
      expect(finding?.level).not.toBe('miss');
    }
    const note = launchLineFinding(team('touch ../created.log'), seat('touch ../created.log'), root, sources());
    expect(note).toEqual({
      level: 'note',
      why:
        'its launch line runs `../created.log`, not found from its start folder ../worktrees/acme/.lobby; ' +
        'not checked: the command may create it',
    });
  });

  test('a shell given a script path that is not where it runs cannot start, and is refused', () => {
    // A shell handed a relative script path that does not exist where the line runs exits 127
    // without reading anything: run from an empty scratch folder, `sh no-such-script.sh`,
    // `bash no-such-script.sh` and `zsh no-such-script.sh` each print their own "no such file"
    // line and exit 127. That, and only that, is the relative argument that can be refused.
    file(join(base, 'tools', 'x.sh'));
    const why =
      'its launch line runs `../tools/x.sh`, not found from its start folder ../worktrees/acme/.lobby; ' +
      `the same file is at \`${join(base, 'tools', 'x.sh')}\` from the project root — write that path`;
    for (const launch of ['zsh ../tools/x.sh', 'sh ../tools/x.sh', '/bin/bash ../tools/x.sh']) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources());
      expect(finding).toEqual({
        level: 'miss',
        why,
        record: 'its launch line runs `../tools/x.sh`, not found from its start folder',
      });
    }
  });

  test('a shell option is not a script: `zsh -c …` and `bash -l x` are not this refusal', () => {
    file(join(base, 'tools', 'x.sh'));
    file(join(base, 'tools', 'y.sh'));
    for (const launch of ['zsh -c "echo hi"', 'bash -l ../tools/y.sh']) {
      const finding = launchLineFinding(team(launch), seat(launch), root, sources());
      expect(finding?.level).not.toBe('miss');
    }
  });

  test('a VAR=… prefix is skipped and the program after it is the one checked', () => {
    file(join(lobby, 'run.sh'));
    expect(launchLineFinding(team('VAR=1 ./run.sh'), seat('VAR=1 ./run.sh'), root, sources())).toBeNull();
    const missing = launchLineFinding(team('VAR=1 ./run.sh'), seat('VAR=1 ./run.sh'), root, sources({ onPath: () => false }));
    expect(missing).toEqual({ level: 'miss', why: 'its launch line starts `./run.sh`, which is not executable' });
  });

  test('a started line is read where the caller says it ran, not where the file would put it', () => {
    // A resumed seat's pane keeps the folder it was started in: `start` names it, and the file's
    // own folder is not looked at. From `old` the same `../tools/x.sh` is a file; from the lobby
    // the file's seat would start in, it is not.
    file(join(base, 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())?.level).toBe('miss');
    expect(
      launchLineFinding(text, text.seats[1] as Seat, root, sources(), {
        cwd: join(base, 'old'),
        folder: join(base, 'old'),
      }),
    ).toBeNull();
  });

  test('the report names each seat it would start, and leaves the stopped ones out', () => {
    file(join(base, 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh', '    stopped: true\n');
    const stopped = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(stopped?.level).toBe('miss');
    expect(launchLineFindings(text, root, sources()).length).toBe(0);
  });
});


describe('review: launch diagnostics use occupied own-folder placement', () => {
  for (const cli of ['grok', 'cursor']) for (const kind of ['own', 'ancestor', 'occupied']) {
    test(`${cli} diagnostic checks ${kind} from the recorded placement`, () => {
      const own = join(base, 'worktrees/acme/own'); mkdirSync(own, { recursive: true });
      file(join(own, 'tools/run.sh'));
      const original = team('./tools/run.sh');
      const worker = { ...original.seats.find(s => s.name === 'worker')!, cli, cwd: kind === 'ancestor' ? home : '.' };
      const declared = { ...original, seats: original.seats.map(s => s.name === worker.name ? worker : s) };
      const state = emptySession(); state.worktrees.task = { seat: 'worker', path: own, branch: 'fix/own', setup: 'ok' };
      if (kind === 'occupied') state.worktrees.peer = { seat: 'lead', path: own, branch: 'fix/peer', setup: 'ok' };
      const found = launchLineFinding(declared, worker, root, sources({ state }));
      if (kind === 'own') expect(found).toBeNull();
      else { expect(found?.level).toBe('miss'); expect(found?.why).toContain(kind === 'ancestor' ? 'own worktree' : 'overlaps seat lead'); }
    });
  }
});
