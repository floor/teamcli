// The unread pass under a daemon-hosted watch: the N re-wake reaches the seat, once, and the
// 2N report follows.
//
// A hosted source set closes every raw writer — typing, a key, a notice — but keeps the one
// gated seam a profile's typed wake runs through (`hostedWatchSources`). The unread pass is part
// of the shared loop (`runWatch`), so a hosted pass runs it too; the wake must take that kept
// seam rather than being left out of the pass, or a daemon-hosted root reports a seat at 2N
// without ever having tried to wake it at N. The pane here is the interrupted Codex frame, read
// as a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import type { TypedWakeResult } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { reportedPath, wakePath } from '../src/watch/unread.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const WIN = '5.5';
const UNREAD = 'cccccccc-0000-4000-8000-000000000201';

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

/** The interrupted Codex frame: the banner, the empty placeholder and the warning on the status
 *  row. It reads as an idle box, which is what the typed wake needs before it types. */
const CODEX_INTERRUPTED = readFileSync(new URL('./fixtures/codex/0.161.0/interrupted-idle.txt', import.meta.url), 'utf8');

const CREW = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-1
    cli: codex
    vendor: test
    model: Test
    version: "0.161.0"
    launch: codex
`;

type World = { base: string; root: string; home: string };

let world: World | null = null;

function scratch(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-unread-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), CREW);
  return { base, root, home };
}

afterEach(() => {
  if (world !== null) rmSync(world.base, { recursive: true, force: true });
  world = null;
});

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'worker-1', agent: 'codex', pane: 'fixture-pane-1', workspace: 'fixture-work-1', status: 'idle', cwd: null,
  }];
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: {} };
}

/** A signed message in the worker's folder, its file time set to the instant it landed: the
 *  unread pass counts from that time, as `team drops` does. */
function seedMessage(at: World, id: string, ts: Date): string {
  const dropDir = join(at.root, '.agents', 'send-drops', 'crew', 'worker-1');
  const record = signRecord({
    kind: 'message',
    id,
    to: 'worker-1',
    to_id: null,
    root: realpathSync(at.root),
    session: 'crew',
    at: ts.toISOString(),
    body: 'from the owner\n\nnobody came',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, id), new Date(), ts);
  return dropDir;
}

const TYPED_DELIVERED: TypedWakeResult = {
  delivered: true,
  typed: true,
  tries: 1,
  reason: 'the working screen showed after 1 Enter',
};

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the unread pass of a daemon-hosted watch', () => {
  test('an unread message gets one wake through the kept typed seam, and the 2N report once', async () => {
    const made = scratch();
    world = made;
    // Well past twice the window: the wake is due at N, and the report at 2N.
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 21 * MIN));

    const clock = { at: NOW };
    const typed: { pane: string; line: string; cli: string }[] = [];
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => (clock.at === NOW ? CODEX_INTERRUPTED : idleScreen),
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      // The raw writers must never be reached: the hosted set closes them, and the typed wake
      // is the one seam this test lets through.
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async (pane, line, cli) => {
        typed.push({ pane, line, cli });
        return TYPED_DELIVERED;
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const log: string[] = [];
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: (text) => log.push(text), base: sources, pid: 4244 }),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      // The wake ran on the hosted pass, through the kept typed-wake seam and no raw writer.
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatchObject({ pane: 'fixture-pane-1', cli: 'codex' });
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      // At twice the window the same pass reports the message once.
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);

      // A later pass changes nothing: the wake marker is spent and the report marker stands.
      clock.at = NOW + 5 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 2);
      expect(typed).toHaveLength(1);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);
    } finally {
      await host.stop('the test is done');
    }
  });
});
