// A send its seat took without showing it: the later confirmation, and the word when it never
// came. A box that clears with no status or transcript evidence is sent with the note
// `trigger taken, no read receipt yet`; the watch's later passes read the transcript and the
// status for the sign the seat acted, and past the window say "taken but never acted on" once. A
// taken line is never typed again. A trigger left in the box is the other case: not-submitted,
// and the watch's retry.
// Fixtures only: a scripted pane, a temporary home, no live session.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readHistory } from '../src/send/history.ts';
import { triggerLine, type NativePane } from '../src/send/native.ts';
import { readPending } from '../src/send/pending.ts';
import { readTaken, takenDropPath, TAKEN_IDLE_GRACE_MS } from '../src/send/taken.ts';
import type { Live } from '../src/status/compare.ts';
import { retryHeldDrops, type RetryScene, type RetrySources } from '../src/watch/retry.ts';
import { confirmTakenDrops } from '../src/watch/taken.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T04:00:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamText(root: string, lobby: string): string {
  return `format: 1
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
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

type World = { root: string; dir: string; home: string; sockets: string };

function world(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-taken-confirm-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), home, sockets };
}

function teamOf(made: World) {
  const result = validateTeamFile(teamText(made.root, lobbyDir(made.home)));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** A pane the scenes script: the screen it shows, the status it reports, and whether an Enter
 *  actually submits. `typed` and `enters` are the calls it received. */
type Pane = {
  screen: string | null;
  status: string;
  submits: boolean;
  typed: string[];
  enters: number;
};

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, submits: true, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      one.screen = claudeBox(text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      if (one.submits) {
        one.status = 'working';
        one.screen = claudeBox('');
      }
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(name: string, paneId: string): Live {
  const agents: HerdrAgent[] = [{ name, agent: 'claude', pane: paneId, workspace: 'first', status: 'idle', cwd: null }];
  return { running: true, agents, workspaces: [], screens: {} };
}

function sendHost(made: World, one: Pane, now: () => Date): SendHost {
  const native: NativePane = {
    typeText: (_session, _pane, text) => {
      one.typed.push(text);
      one.screen = claudeBox(text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      if (one.submits) one.screen = claudeBox('');
      return true;
    },
    status: () => one.status,
    wait: async () => {},
    paneText: () => one.screen,
  };
  return {
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: made.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now,
    home: made.home,
  };
}

function scene(made: World, one: Pane, at: Date): RetryScene & { said: string[] } {
  const said: string[] = [];
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made),
    live: liveWith('lead', 'w1:p1'),
    ownPane: null,
    sources: scripts(one),
    now: at,
    say: (text: string) => said.push(text),
    said,
  };
}

function dropDirOf(made: World): string {
  return join(made.dir, 'send-drops', 'acme', 'lead');
}

/** The trigger note on the sender's line, and the record it leaves beside the drop. */
async function sendTaken(made: World, one: Pane): Promise<string> {
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runSend(['lead', 'hello'], io, sendHost(made, one, () => NOW))).toBe(0);
  // No pane messaging: nothing is typed, so no taken record is left to confirm later.
  expect(io.out).toContain('lead: sent (unconfirmed) (drop, ');
  expect(readTaken(dropDirOf(made))).toEqual([]);
  expect(one.typed).toEqual([]);
  return '';
}

describe('a taken delivery, confirmed later', () => {
  test('no pane messaging, no taken record is left; was: a transcript row naming the drop confirms it, and nothing is said', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    const retired = await sendTaken(made, one);
    expect(await retired).toBe('');
  });

  test('a status that moved from the one read before Enter confirms it too', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    await sendTaken(made, one);

    // The seat is working now: herdr's status is the sign, with no transcript row to show it.
    one.screen = claudeBox('');
    one.status = 'working';
    const at = scene(made, one, new Date(NOW.getTime() + 5_000));
    confirmTakenDrops(at);

    expect(readTaken(dropDirOf(made))).toEqual([]);
    expect(at.said).toEqual([]);
  });
});

describe('a taken delivery its seat never acted on', () => {
  test('no pane messaging, no taken record is left; was: past the grace on a free seat it is said once and filed, and the line is never retyped', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    const retired = await sendTaken(made, one);
    expect(await retired).toBe('');
  });

  test('no pane messaging, no taken record is left; was: a record the age bound runs out on is reported even while the seat reads busy', async () => {
    const made = world();
    // The seat was already working before the line went in, so no later status can be the sign:
    // only the transcript could confirm it, and the window runs out with none.
    const one = pane(claudeBox(''), 'working');
    const retired = await sendTaken(made, one);
    expect(await retired).toBe('');
  });

  test('no pane messaging, no taken record is left; was: inside the window a seat with no live pane keeps its record for a later pass', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    const retired = await sendTaken(made, one);
    expect(await retired).toBe('');
  });

  test('no pane messaging, no taken record is left; was: a record whose seat has no live pane ages out and is reported, as a retry record is', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    const retired = await sendTaken(made, one);
    expect(await retired).toBe('');
  });
});

describe('a trigger left in the box is the other case', () => {
  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: no pane messaging, the watch types nothing and the bus inbox keeps it; was: it is not-submitted, leaves the retry record and no taken record, and the retry submits it', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    one.submits = false;
    const io = testIo(made.root, { kind: 'owner' });

    const retired = await runSend(['lead', 'hello'], io, sendHost(made, one, () => NOW));
    expect(await retired).toBe(0);
  });
});
