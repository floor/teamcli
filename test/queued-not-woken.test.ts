// The `queued, not woken` outcome: a send whose walk ends on the drop leg says so, including
// a seat whose class names an event adapter when no adapter leg ran. The class is not a leg.
// The same words ride the history line, the `--json` status and the lead's status note.
// `sent (unconfirmed)` is not this ending. A live inbox listener is no leg in this build's
// walk. Every scene runs the real walk over a synthetic team; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writeListener } from '../src/mcp/inbox.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { readHistory, statusOfOutcome } from '../src/send/history.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-11-03T09:00:00.000Z');
const PUSH_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';

/** One checkout with a team whose seats are the delivery classes this outcome turns on: a
 *  pull-only Claude seat, a person's seat (class none), a seat whose launch installs the event
 *  adapter (push) and one more Claude seat that registers a live inbox listener — no leg under
 *  this build's walk. No `delivery_order` is
 *  declared, so every seat walks the default chain and the drop leg is where a wakeless send
 *  lands. */
function world(): { base: string; root: string; dir: string; sockets: string; home: string; dropOf: (seat: string) => string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'queued-not-woken-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  const lobby = resolveLobby(home, { entity: 'floor' });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: pull-seat
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: human-seat
    human: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: push-seat
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${PUSH_LAUNCH}
  - role: implementer
    name: inbox-seat
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  const dir = join(root, '.agents');
  return { base, root, dir, sockets, home, dropOf: (seat) => join(dir, 'send-drops', 'acme', seat) };
}

/** The host the walk runs on: no live pane to type into (the no-pane-messaging guard skips the
 *  typed leg for exactly this reason), no socket dialed, and an inbox grace of zero so no
 *  listener scene needs a clock. */
function host(made: ReturnType<typeof world>): SendHost {
  return {
    agents: () => [],
    processInfo: () => null,
    socketsDir: made.sockets,
    deliver: async () => {
      throw new Error('this walk dials no socket');
    },
    inboxGraceMs: 0,
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
    now: () => NOW,
    home: made.home,
  };
}

let made: ReturnType<typeof world> | null = null;
afterEach(() => {
  if (made !== null) rmSync(made.base, { recursive: true, force: true });
  made = null;
});

/** The history lines this file's sends left behind, as outcome/via pairs. */
function entries(): Array<{ outcome: string; via: string | undefined }> {
  if (made === null) throw new Error('no world');
  const read = readHistory('acme', made.root, made.home);
  if (!read.ok) throw new Error(`the history does not read: ${read.reason}`);
  return read.entries.map((entry) => ({ outcome: entry.outcome, via: entry.via }));
}

describe('the queued, not woken outcome', () => {
  test('the word changes no status: without a receipt the record is still a sent one', () => {
    // The outcome words are for the person reading the line; the receipt machinery is untouched,
    // so a queued, not woken record keeps the status every attempt outcome maps to.
    expect(statusOfOutcome('queued, not woken')).toBe('sent');
  });
});
