// A seat whose last webhook delivery did not arrive: `team check` and `team status` say so, in one
// sentence and the same words, with the outcome, the attempts, the fixed-words reason and the
// instant the delivery ended. A delivered record draws no line; a later delivery replaces the
// record, so the note clears itself. A note is a reading, not a difference: neither command's
// count nor its exit moves.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { displayPath } from '../src/output/text.ts';
import { emptySession, updateState, type WebhookDeliveryRecord } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T16:00:00Z');
const AT = NOW.toISOString();

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** A team with a lead and one remote seat that configures a webhook adapter, both recorded ready
 *  on their own panes, and a watch pass recent enough that the run itself is no difference. */
function world(): { root: string; text: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-webhook-note-')));
  made.push(base);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const hookUrl = join(base, 'hook-url');
  const hookSecret = join(base, 'hook-secret');
  writeFileSync(hookUrl, 'http://127.0.0.1:1/routine\n');
  writeFileSync(hookSecret, 'synthetic-secret-value\n', { mode: 0o600 });
  const text = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    webhook:
      url_file: ${JSON.stringify(hookUrl)}
      secret_file: ${JSON.stringify(hookSecret)}
`;
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      const workspace = `w${String(index + 1)}`;
      session.seats[seat.name] = { stage: 'ready', pane: `${workspace}-pane`, workspace, cli: seat.cli };
    });
  });
  return { root, text };
}

/** The live session as herdr answers it, each seat idle on its pane. */
function live(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => {
      const workspace = `w${String(index + 1)}`;
      return {
        name: seat.name,
        agent: 'claude',
        pane: `${workspace}-pane`,
        workspace,
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(seat),
      };
    }),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `w${String(index + 1)}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`w${String(index + 1)}-pane`, CLAUDE_IDLE])),
  };
}

function differences(out: string): number {
  return out.split('difference: ').length - 1;
}

function scene(w: { root: string; text: string }) {
  const parsed = validateTeamFile(w.text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const standing = verifiedOf(parsed.team, w.text, w.root, NOW);
  const sources = (alive?: (pid: number) => boolean): StatusSources => ({
    live: () => live(w.text),
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    ...(alive === undefined ? {} : { alive }),
  });
  const status = async (alive?: (pid: number) => boolean) => {
    const io = testIo(w.root, { kind: 'owner' });
    const code = await runStatus(['--file', join(w.root, '.agents/team.yaml')], io, sources(alive));
    return { code, out: `${io.out}${io.err}` };
  };
  const check = (alive?: (pid: number) => boolean) => {
    const io = testIo(w.root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, { ...sources(alive), home: w.root });
    return { code, out: `${io.out}${io.err}` };
  };
  return { status, check };
}

/** Sets (or replaces) iris's last recorded webhook delivery. */
function record(root: string, session: string, delivery: WebhookDeliveryRecord): void {
  updateState(join(root, '.agents'), (state) => {
    const seat = state.sessions[session]?.seats.iris;
    if (seat === undefined) throw new Error('the scene recorded no seat');
    seat.webhook_delivery = delivery;
  });
}

function sessionOf(w: { text: string }): string {
  const parsed = validateTeamFile(w.text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team.session;
}

test('check and status print the same delivery sentence, and it changes no count or exit', async () => {
  const w = world();
  const { status, check } = scene(w);
  const session = sessionOf(w);

  const statusBefore = await status();
  const checkBefore = check();
  expect(statusBefore.out).not.toContain('webhook delivery');
  expect(checkBefore.out).not.toContain('webhook delivery');

  record(w.root, session, {
    record_id: 'msg-1',
    at: AT,
    outcome: 'failed',
    attempts: 3,
    reason: 'could not connect (ConnectionRefused)',
  });

  const NOTE = `note: iris: its last webhook delivery did not arrive: it failed after 3 attempts at ${AT}: could not connect (ConnectionRefused); the delivery left the drop record for the seat's own pull`;
  const statusAfter = await status();
  const checkAfter = check();
  expect(statusAfter.out).toContain(NOTE);
  expect(checkAfter.out).toContain(NOTE);
  // A note is a reading, not a difference: the count and the exit are the baseline's.
  expect(statusAfter.code).toBe(statusBefore.code);
  expect(checkAfter.code).toBe(checkBefore.code);
  expect(differences(statusAfter.out)).toBe(differences(statusBefore.out));
  expect(differences(checkAfter.out)).toBe(differences(checkBefore.out));
});

test('a sent-unknown delivery is noted in its own words, and a delivered one clears the note', async () => {
  const w = world();
  const { status, check } = scene(w);
  const session = sessionOf(w);

  record(w.root, session, {
    record_id: 'msg-1',
    at: AT,
    outcome: 'sent-unknown',
    attempts: 1,
    reason: 'no answer within 5000 ms',
  });
  const LATE = `iris: its last webhook delivery did not arrive: it was sent with its response unknown after 1 attempt at ${AT}: no answer within 5000 ms`;
  expect((await status()).out).toContain(LATE);
  expect(check().out).toContain(LATE);

  // The next delivery the routine takes replaces the record: the failure reads as cleared.
  record(w.root, session, { record_id: 'msg-2', at: AT, outcome: 'delivered', attempts: 1, reason: 'HTTP 204' });
  expect((await status()).out).not.toContain('webhook delivery did not arrive');
  expect(check().out).not.toContain('webhook delivery did not arrive');
});

test('a sent claim with no bus serving the root is flagged, and clears once one serves', async () => {
  const w = world();
  const { status, check } = scene(w);
  const session = sessionOf(w);
  const drops = join(w.root, '.agents', 'send-drops', session, 'iris');
  mkdirSync(drops, { recursive: true });
  const claim = (id: string, state: string): void => {
    writeFileSync(join(drops, `${id}.posting`), `${JSON.stringify({ state, at: AT })}\n`);
  };
  // A claim still `claimed` proves the request was never handed to the transport: no line.
  claim('msg-1', 'claimed');
  expect((await status()).out).not.toContain('webhook post');
  expect(check().out).not.toContain('webhook post');

  // A `sent` claim may have reached the routine: with no bus serving the root, nobody finishes it.
  claim('msg-2', 'sent');
  const ONE = `1 webhook post awaits a bus that isn't serving (${w.root})`;
  // The check prints its notes through the home it was given — this scene's root — so its line
  // abbreviates that home; the status run is given no home and keeps the absolute path.
  expect((await status()).out).toContain(ONE);
  expect(check().out).toContain(displayPath(ONE, w.root));

  claim('msg-3', 'sent');
  const TWO = `2 webhook posts await a bus that isn't serving (${w.root})`;
  expect((await status()).out).toContain(TWO);
  expect(check().out).toContain(displayPath(TWO, w.root));

  // A dead bus is not serving: the line stands.
  writeFileSync(join(w.root, '.agents/bus.pid'), `${JSON.stringify({ pid: 4242, started: AT })}\n`);
  expect((await status(() => false)).out).toContain(TWO);
  expect(check(() => false).out).toContain(displayPath(TWO, w.root));

  // A serving bus finishes the claims itself: the line clears, and the delivery record stands.
  expect((await status(() => true)).out).not.toContain('webhook post');
  expect(check(() => true).out).not.toContain('webhook post');
});
