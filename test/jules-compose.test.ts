// The Jules compose walk, scene by scene. The TUI is a small state machine that draws the
// captured screens (test/fixtures/jules/0.1.42/) with the table's own words, and answers keys
// the way the 0.1.42 captures showed it: `/` then Enter opens the repo list, Enter on a repo
// collapses it into ` Choose a repo` / ` <owner>/<repo>` and puts the cursor in the task box, a
// second Enter asks the yes/no confirmation, and the created screen prints the proof.
//
// The safety property this file exists for: a brief is created on the seat's own repo and no
// other. The scene starts the chooser on a different repo, and the walk must still prove the
// seat's repo on the collapsed form before it types. The probe repo every scene names is
// floor/jules-sandbox, the private repo Jules probes are confined to.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComposeError, type ComposeIo, type ComposeSeat } from '../src/profiles/compose.ts';
import { compose, reposArgs } from '../src/profiles/jules-compose.ts';
import { profileFor } from '../src/profiles/index.ts';
import { deliverCompose, repoFromUrl } from '../src/send/compose.ts';
import type { NativePane } from '../src/send/native.ts';

const SANDBOX = 'floor/jules-sandbox';
const MESSAGE = 'Say PING in one line.';
const PROOF = 'Session created: https://jules.google.com/session/<id>';

/** The account's list: nine repos, an `<add a new repo>` row, then the sandbox at index 9
 *  (row 10), then two more. The walk has to count the add row to reach it. */
const REPOS = [
  'alpha/one',
  'alpha/two',
  'alpha/three',
  'alpha/four',
  'alpha/five',
  'alpha/six',
  'alpha/seven',
  'alpha/eight',
  'alpha/nine',
  SANDBOX,
  'probe/two',
  'probe/three',
];

type ScreenName = 'table' | 'list' | 'form' | 'confirm' | 'created' | 'loggedOut';

/** The rows the chooser draws: one `<add a new repo>` after every ninth repo. */
function chooserRows(repos: readonly string[]): string[] {
  const rows: string[] = [];
  for (const [at, repo] of repos.entries()) {
    rows.push(repo);
    if ((at + 1) % 9 === 0) rows.push('<add a new repo>');
  }
  return rows;
}

/** A jules 0.1.42 TUI at its captured screens, answering the keys the walk sends. */
class FakeJules {
  screen: ScreenName;
  repos: readonly string[];
  rows: string[];
  cursor: number;
  tableInput = '';
  box = '';
  chosen: string | null = null;
  markedYes = true;
  readonly keys: string[] = [];
  readonly created: string[] = [];
  /** Set if any path ever sends the table's delete key. Nothing may. */
  deleted = false;

  constructor(options: { screen?: ScreenName; repos?: readonly string[]; cursor?: number } = {}) {
    this.screen = options.screen ?? 'table';
    this.repos = options.repos ?? REPOS;
    this.rows = chooserRows(this.repos);
    this.cursor = options.cursor ?? 5;
  }

  text(): string {
    const lines: string[] = [];
    switch (this.screen) {
      case 'table':
        lines.push(` > ${this.tableInput === '' ? 'Search sessions or type / to use' : this.tableInput}`);
        lines.push('╭───────────────────────────────────────────────────╮');
        lines.push('│ <id>   <session>          <repo>   <when>         │');
        lines.push('╰───────────────────────────────────────────────────╯');
        lines.push(' enter: select session | ctrl+r: refresh |');
        lines.push('ctrl+d: delete | ctrl+c: quit');
        lines.push(' Working in: /work');
        break;
      case 'list':
        for (const [at, row] of this.rows.entries()) lines.push(at === this.cursor ? ` > ${row}` : `   ${row}`);
        lines.push(' enter: select repo | esc: go back');
        break;
      case 'form':
        lines.push(' Choose a repo');
        lines.push(` ${this.chosen}`);
        lines.push(' Type the task description');
        lines.push(` ${this.box}`);
        lines.push(' enter: create the session | esc: go back');
        break;
      case 'confirm':
        lines.push(' Create a new remote session based on the description a');
        lines.push(this.markedYes ? '   > yes' : '     yes');
        lines.push(this.markedYes ? '     no' : '   > no');
        lines.push(' ↑/↓: up/down | enter to select');
        break;
      case 'created':
        lines.push(` ${PROOF}`);
        lines.push(' Press any key to go back to the session table');
        break;
      case 'loggedOut':
        lines.push(' Welcome to Jules CLI!');
        lines.push(' Failed to list tasks: Trying to make a GET request without a valid client (did you forget to login?)');
        lines.push(' Jules authentication is required. Please use the /login command');
        break;
    }
    return `${lines.join('\n')}\n`;
  }

  type(text: string): boolean {
    if (this.screen === 'table') {
      this.tableInput += text;
      return true;
    }
    if (this.screen === 'form') {
      this.box += text;
      return true;
    }
    return false;
  }

  key(key: string): boolean {
    this.keys.push(key);
    if (/^ctrl[+-]d$/i.test(key)) {
      this.deleted = true;
      return true;
    }
    switch (this.screen) {
      case 'table':
        if (key === 'enter' && this.tableInput === '/') {
          this.tableInput = '';
          this.screen = 'list';
          return true;
        }
        return false;
      case 'list':
        if (key === 'up') {
          this.cursor = Math.max(0, this.cursor - 1);
          return true;
        }
        if (key === 'down') {
          this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
          return true;
        }
        if (key === 'enter') {
          const row = this.rows[this.cursor] ?? '';
          if (this.repos.includes(row)) {
            this.chosen = row;
            this.screen = 'form';
          }
          return true;
        }
        if (key === 'escape') {
          this.screen = 'table';
          return true;
        }
        return false;
      case 'form':
        if (key === 'enter') {
          this.screen = 'confirm';
          return true;
        }
        if (key === 'escape') {
          this.screen = 'list';
          return true;
        }
        return false;
      case 'confirm':
        if (key === 'up' || key === 'down') {
          this.markedYes = !this.markedYes;
          return true;
        }
        if (key === 'enter') {
          if (this.markedYes && this.chosen !== null) {
            this.created.push(this.chosen);
            this.screen = 'created';
          }
          return true;
        }
        if (key === 'escape') {
          this.screen = 'form';
          return true;
        }
        return false;
      case 'created':
        if (key === 'enter') {
          this.screen = 'table';
          return true;
        }
        return false;
      case 'loggedOut':
        return false;
    }
  }
}

function seatOf(repo: string | null, repos: readonly string[] | null): ComposeSeat {
  return { cwd: '/work', repo, repos };
}

function ioOf(pane: FakeJules, seat: ComposeSeat): ComposeIo {
  return {
    text: () => pane.text(),
    type: (text) => pane.type(text),
    key: (key) => pane.key(key),
    wait: async () => {},
    idleTimeout: 1,
    seat,
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the jules compose walk', () => {
  test('a brief is created on the seat\'s repo, though the chooser sat on another', async () => {
    const pane = new FakeJules({ cursor: 11 }); // the list opens on probe/two
    const proof = await compose(ioOf(pane, seatOf(SANDBOX, REPOS)), MESSAGE);
    expect(proof).toBe(PROOF);
    expect(pane.created).toEqual([SANDBOX]);
    expect(pane.box).toBe(MESSAGE);
    expect(pane.deleted).toBe(false);
  });

  test('the walk proves the collapsed repo before it types anything', async () => {
    const pane = new FakeJules();
    // The box only exists on the form screen, and the form is only reachable from a repo row:
    // the recorded repo the box was typed on is the one the chooser collapsed.
    await compose(ioOf(pane, seatOf(SANDBOX, REPOS)), MESSAGE);
    expect(pane.chosen).toBe(SANDBOX);
    expect(pane.box).toBe(MESSAGE);
  });

  test('a list without the seat\'s repo is refused before anything is typed', async () => {
    const pane = new FakeJules();
    const error = await compose(ioOf(pane, seatOf(SANDBOX, REPOS.filter((repo) => repo !== SANDBOX))), MESSAGE).catch((caught) => caught);
    expect(error).toBeInstanceOf(ComposeError);
    expect((error as ComposeError).message).toBe(`its repo list does not hold ${SANDBOX}`);
    expect((error as ComposeError).repair).toBe(`add ${SANDBOX} to the Jules account, then retry`);
    expect((error as ComposeError).typed).toBe(false);
    expect(pane.box).toBe('');
    expect(pane.created).toEqual([]);
  });

  test('a logged-out CLI is refused before anything is typed', async () => {
    const pane = new FakeJules({ screen: 'loggedOut' });
    const error = await compose(ioOf(pane, seatOf(SANDBOX, REPOS)), MESSAGE).catch((caught) => caught);
    expect(error).toBeInstanceOf(ComposeError);
    expect((error as ComposeError).message).toBe('its CLI is logged out, and nothing was sent');
    expect((error as ComposeError).repair).toBe('run jules login in its pane, then retry');
    expect((error as ComposeError).typed).toBe(false);
    expect(pane.box).toBe('');
  });

  test('a draft in the table\'s input is refused, not typed over', async () => {
    const pane = new FakeJules();
    pane.tableInput = 'unfinished search';
    const error = await compose(ioOf(pane, seatOf(SANDBOX, REPOS)), MESSAGE).catch((caught) => caught);
    expect(error).toBeInstanceOf(ComposeError);
    expect((error as ComposeError).message).toBe('its table\'s input holds "unfinished search"');
    expect((error as ComposeError).typed).toBe(false);
    expect(pane.box).toBe('');
  });

  test('the seat\'s repo is the one the account lists, never another', () => {
    // The walk only ever chooses seat.repo; this scene pins the list itself and the profile's
    // own listing command, so the choice and the account cannot drift apart.
    expect(REPOS).toContain(SANDBOX);
    expect(profileFor('jules')?.compose?.repos).toEqual(['remote', 'list', '--repo']);
    expect(reposArgs).toEqual(['remote', 'list', '--repo']);
  });
});

describe('the send glue names the seat\'s own origin as the repo', () => {
  test('a folder whose origin is floor/jules-sandbox delivers there and nowhere else', async () => {
    const base = mkdtempSync(join(tmpdir(), 'jules-seat-'));
    made.push(base);
    execFileSync('git', ['init', '-q', base], { stdio: 'ignore' });
    execFileSync('git', ['-C', base, 'remote', 'add', 'origin', 'git@github.com:floor/jules-sandbox.git'], { stdio: 'ignore' });
    expect(repoFromUrl('git@github.com:floor/jules-sandbox.git')).toBe(SANDBOX);

    // The listing command runs the CLI's own `repos` arguments; the scene stands a bun script
    // in place of the binary so no live account is asked, and the walk itself is unchanged.
    const scriptDir = mkdtempSync(join(tmpdir(), 'jules-repos-'));
    made.push(scriptDir);
    const script = join(scriptDir, 'repos.ts');
    writeFileSync(script, `console.log(${JSON.stringify(REPOS.join('\n'))});`);

    const pane = new FakeJules();
    const native: NativePane = {
      typeText: (_session, _pane, text) => pane.type(text),
      pressEnter: () => pane.key('enter'),
      status: () => 'unknown',
      wait: async () => {},
      paneText: () => pane.text(),
      sendKey: (_session, _pane, key) => pane.key(key),
      foregroundCwd: () => base,
    };
    const shipped = profileFor('jules')?.compose;
    if (!shipped) throw new Error('the jules profile carries no compose module');
    const result = await deliverCompose(native, {
      profile: { ...shipped, repos: [script, ...shipped.repos] },
      binary: 'bun',
      session: 'session',
      pane: 'pane',
      seatCwd: base,
      idleTimeout: 1,
      message: MESSAGE,
    });
    expect(result).toEqual({ outcome: 'delivered', evidence: PROOF });
    expect(pane.created).toEqual([SANDBOX]);
    expect(pane.deleted).toBe(false);
  });

  test('a non-lead seat started in the lobby still sends to its project\'s repo', async () => {
    // `team up` starts a non-lead seat in the lobby, and the TUI never leaves that folder, so
    // the pane's foreground cwd has no git origin. The seat's record carries the project, and
    // its origin is the repo the brief is created on.
    const base = mkdtempSync(join(tmpdir(), 'jules-seat-'));
    made.push(base);
    execFileSync('git', ['init', '-q', base], { stdio: 'ignore' });
    execFileSync('git', ['-C', base, 'remote', 'add', 'origin', 'git@github.com:floor/jules-sandbox.git'], { stdio: 'ignore' });
    const lobby = mkdtempSync(join(tmpdir(), 'jules-lobby-'));
    made.push(lobby);

    const scriptDir = mkdtempSync(join(tmpdir(), 'jules-repos-'));
    made.push(scriptDir);
    const script = join(scriptDir, 'repos.ts');
    writeFileSync(script, `console.log(${JSON.stringify(REPOS.join('\n'))});`);

    const pane = new FakeJules();
    const native: NativePane = {
      typeText: (_session, _pane, text) => pane.type(text),
      pressEnter: () => pane.key('enter'),
      status: () => 'unknown',
      wait: async () => {},
      paneText: () => pane.text(),
      sendKey: (_session, _pane, key) => pane.key(key),
      foregroundCwd: () => lobby,
    };
    const shipped = profileFor('jules')?.compose;
    if (!shipped) throw new Error('the jules profile carries no compose module');
    const result = await deliverCompose(native, {
      profile: { ...shipped, repos: [script, ...shipped.repos] },
      binary: 'bun',
      session: 'session',
      pane: 'pane',
      seatCwd: base,
      idleTimeout: 1,
      message: MESSAGE,
    });
    expect(result).toEqual({ outcome: 'delivered', evidence: PROOF });
    expect(pane.created).toEqual([SANDBOX]);
    expect(pane.deleted).toBe(false);
  });
});
