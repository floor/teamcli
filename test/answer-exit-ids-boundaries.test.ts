// The internal answer table's two rows it lacked: `answer.another-pane` and `answer.detached`.
// The rows are pinned to the page and to the contract entries that carry the same words, and
// each id's refusal is pinned to the command itself: a run with no terminal is refused before
// anything is read — no log line is written beside any file — and the caller's seat on a pane
// the state does not record for it is refused with the pane the state names, and audited.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anotherPaneRefusal, DETACHED_REFUSAL } from '../src/caller.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const PAGE = '../docs/internal/answer.md';
const CONTRACT = '../contract/exit-codes.json';
const ANSWER_SRC = '../src/commands/answer.ts';
const NOW = new Date('2026-10-05T04:00:00.000Z');

// Whitespace runs collapse before the match, so a row survives table reflow but not rewording.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

/** A project with a loadable team file — the coordinator's seat is `lead`, session `acme` —
 *  and no approval: both refusals under test fire before any approval is asked for. */
function world(): { root: string; home: string; dir: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'answer-exit-ids-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const lobby = lobbyDir(home);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
  - role: worker
    name: helper
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
`);
  return { root, home, dir };
}

/** The host both refusals never touch: every read a trust answer would make throws, so a path
 *  that reached for one fails the scene. */
function host(home: string): AnswerHost {
  const never = () => {
    throw new Error('the refusal path read the host');
  };
  return {
    version: never,
    agents: never,
    pane: never,
    sendKey: never,
    rename: never,
    foreground: never,
    foregroundCwd: never,
    list: never,
    status: never,
    type: never,
    enter: never,
    standing: never,
    now: () => NOW,
    sleep: async () => {},
    home,
  };
}

describe("the answer table's two ids it lacked", () => {
  test('the rows, the contract entries and the command marks carry the same words', () => {
    const page = prose(PAGE);
    expect(
      page.includes('| 1 | `answer.another-pane` | the state records another pane for the caller\'s seat |'),
      'answer.md lost the another-pane row',
    ).toBe(true);
    expect(
      page.includes('| 1 | `answer.detached` | a run with no terminal |'),
      'answer.md lost the detached row',
    ).toBe(true);
    const contract = raw(CONTRACT);
    expect(
      contract.includes('"id": "answer.another-pane",\n      "meaning": "the state records another pane for the caller\'s seat",'),
      'the contract entry changed words',
    ).toBe(true);
    expect(
      contract.includes('"id": "answer.detached",\n      "meaning": "a run with no terminal",'),
      'the contract entry changed words',
    ).toBe(true);
    const src = raw(ANSWER_SRC);
    expect(src.includes('// exit: answer.another-pane'), 'answer.ts lost the another-pane mark').toBe(true);
    expect(src.includes('// exit: answer.detached'), 'answer.ts lost the detached mark').toBe(true);
  });

  test('a run with no terminal is refused before anything is read, leaving no log', async () => {
    const { root, home, dir } = world();
    const io = testIo(root, { kind: 'owner-no-tty' });
    const code = await runAnswer(['lead', 'trust'], io, host(home));
    expect(code).toBe(1);
    expect(io.err).toBe(`team answer: ${DETACHED_REFUSAL}\n`);
    expect(io.out).toBe('');
    expect(existsSync(join(dir, 'team.log'))).toBe(false);
  });

  test("the caller's seat on a pane the state does not record is refused and audited", async () => {
    const { root, home, dir } = world();
    updateState(dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: {
            stage: 'launched',
            pane: 'w1:p1',
            workspace: 'w1',
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        },
        worktrees: {},
      };
    });
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' });
    const code = await runAnswer(['lead', 'trust'], io, host(home));
    expect(code).toBe(1);
    expect(io.err).toBe(`team answer: ${anotherPaneRefusal('lead', 'w1:p1')}\n`);
    expect(io.out).toBe('');
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('lead: refused trust: caller');
  });
});
