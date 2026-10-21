// Independent acceptance for the 0.5.5 quota-out state, written red-first at source
// 2f056c6b1871006453dd6e37122cf6ff924c02e1 before the quota-out implementation.
//
// Provenance of every frame is in ./README.md: the `test/fixtures/` captures are the
// repository's retained real panes (read in place, never copied); every frame in this folder is
// either a byte-for-byte capture copy or labelled synthetic. The synthetic agy frames carry the
// two sentences of a 2026-10-21 field report laid above the retained agy 1.4.2 idle box; they
// are not, and must not be read as, a native agy trace.
//
// The rows below pin the contract, not a wording beyond it:
//   send    a positively read wall refuses (exit 1, `send.refused`) before any record, socket,
//           fallback or typing effect, with the reset it read; a quote inside a working turn,
//           a finished turn's history, and a healthy prompt keep ordinary sends.
//   status  one canonical `quota out` seat state, human and JSON, with the reset as displayed:
//           `resets at 11:00`, `resets in 47h31m`, or an explicit no-reset; no parsed instant,
//           no invented zone; Codex/Cursor status rows are not a wall.
//   check   the existing `stuck at a quota prompt` difference (exit 1), now for agy too, with
//           the reset form it read; a quote in a working turn is not quota.
//
// A wall frame whose pane draws no readable composer is still a wall on every surface: the send
// is held with no effects, status names it, and check reports it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { runTeamCheck } from '../../src/check/team.ts';
import { runSend } from '../../src/commands/send.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { rulesOf } from '../../src/launch/rules.ts';
import { rulesFileHash, writeRulesFile } from '../../src/launch/rules-file.ts';
import { emptySession, updateState, type SeatState } from '../../src/state.ts';
import type { Standing } from '../../src/store/store.ts';
import type { Live } from '../../src/status/compare.ts';
import { fake, owner, scripted, world, type World } from '../send-native-fixtures.ts';
import { testIo } from '../helpers.ts';

const HERE = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');
const CAPTURE = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// Captures: the repository's own retained panes.
const CLAUDE_LIMIT = CAPTURE('claude-code/rate-limit.txt');
const CLAUDE_PROVIDER_ERROR = CAPTURE('claude-code/provider-error.txt');
const CLAUDE_QUESTION = CAPTURE('claude-code/2.1.289/question-plain.txt');
const GEMINI_LIMIT = CAPTURE('gemini/0.64.0/rate-limit.txt');
const AGY_IDLE = CAPTURE('antigravity/1.4.2/idle.txt');
const CODEX_WARNING = CAPTURE('codex/0.157.0/idle.txt');

// Synthetic frames (see README.md): never a native agy/Codex/Cursor trace.
const AGY_QUOTA = HERE('./agy-individual-quota.txt');
const AGY_NO_RESET = HERE('./agy-individual-quota-no-reset.txt');
const CLAUDE_HISTORY = HERE('./claude-quota-history.txt');
const CLAUDE_QUOTE = HERE('./claude-quota-in-turn-quote.txt');
const CODEX_WEEKLY_ZERO = HERE('./codex-weekly-zero.txt');
const CURSOR_ZERO = HERE('./cursor-zero.txt');
// A wall whose pane draws no composer at all: the reported sentence, nothing else.
const NO_COMPOSER = 'API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n';

const NOW = new Date('2026-10-03T14:10:00Z');
const AT = '2026-10-03T14:06:00Z';

function listing(at: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(at, path));
    }
  };
  try {
    walk(at);
  } catch {
    return [];
  }
  return out.sort();
}

/** The record-bearing files a send may leave behind: a drop, its fallback copy, a retry
 *  (`pending`), a history entry or an outbox copy. A refusal must create none. */
function sendRecords(made: World): string[] {
  return listing(made.dir).filter((one) => /send-drops|pending|history|outbox/.test(one));
}

describe('send at a quota-out screen', () => {
  const made: World[] = [];
  afterEach(() => {
    for (const one of made.splice(0)) one.cleanup();
  });

  function claudeWorld(): World {
    const one = world(null);
    made.push(one);
    return one;
  }

  function agyWorld(): World {
    const one = world(null, [{ name: 'agy1', role: 'implementer' }]);
    made.push(one);
    const file = join(one.dir, 'team.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        '    name: agy1\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n',
        '    name: agy1\n    cli: antigravity\n    vendor: google\n    model: Gemini\n    version: "1"\n    launch: agy\n',
      ),
    );
    return one;
  }

  type Scene = { code: number; out: string; typed: string[]; enters: number; frames: number; records: string[]; doc: any };

  async function sendAt(one: World, target: 'helper' | 'agy1', screen: string, status: string): Promise<Scene> {
    const pane = scripted([status, status, status, status, status], screen);
    const host = fake(one, {
      agents: () => [
        { name: 'lead', pane: 'w1:p1' },
        { name: 'helper', pane: 'w3:p1' },
        { name: 'agy1', pane: 'w2:p1' },
      ],
      native: pane,
    });
    const io = owner(one.root);
    const code = await runSend([target, 'hello', '--json'], io, host);
    let doc: any = null;
    try {
      doc = JSON.parse(io.out);
    } catch {
      doc = null;
    }
    return { code, out: io.out, typed: pane.typed, enters: pane.enters, frames: host.frames.length, records: sendRecords(one), doc };
  }

  test('a live individual-quota frame refuses the send with no record, no socket frame and no typing', async () => {
    const scene = await sendAt(agyWorld(), 'agy1', AGY_QUOTA, 'done');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.id).toBe('send.refused');
    expect(scene.out).toContain('quota');
    expect(scene.out).toContain('47h31m');
    expect(scene.out).not.toContain('sent (unconfirmed)');
    expect(scene.typed).toEqual([]);
    expect(scene.enters).toBe(0);
    expect(scene.frames).toBe(0);
    expect(scene.records).toEqual([]);
  });

  test('a wall the host still calls working refuses too: a busy host never bypasses a read wall', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', CLAUDE_LIMIT, 'working');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.id).toBe('send.refused');
    expect(scene.out).toContain('quota');
    expect(scene.out).toContain('11:00');
    expect(scene.typed).toEqual([]);
    expect(scene.records).toEqual([]);
  });

  test('a wall frame the profile cannot place in a composer stays held, with no effects', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', NO_COMPOSER, 'done');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.id).toBe('send.refused');
    expect(scene.out).toContain('quota');
    expect(scene.out).toContain('11:00');
    expect(scene.typed).toEqual([]);
    expect(scene.records).toEqual([]);
  });

  test('a quota frame that names no reset says so and invents no time', async () => {
    const scene = await sendAt(agyWorld(), 'agy1', AGY_NO_RESET, 'done');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.id).toBe('send.refused');
    expect(scene.out).toContain('quota');
    expect(scene.out).toMatch(/no reset/i);
    expect(scene.out).not.toMatch(/resets?\s+(?:at|in)\s/i);
    expect(scene.out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(scene.typed).toEqual([]);
    expect(scene.records).toEqual([]);
  });

  test('a sentence quoted inside a working turn is not a wall, and the send goes through', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', CLAUDE_QUOTE, 'working');
    expect(scene.code).toBe(0);
    expect(scene.doc?.error).toBeUndefined();
    expect(scene.typed.length).toBe(1);
    expect(scene.enters).toBeGreaterThan(0);
  });

  test('a wall sentence above a finished turn is history, and the next send goes through', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', CLAUDE_HISTORY, 'done');
    expect(scene.code).toBe(0);
    expect(scene.doc?.error).toBeUndefined();
    expect(scene.typed.length).toBe(1);
    expect(scene.enters).toBeGreaterThan(0);
  });

  test('an ordinary provider error keeps its existing caution and is not read as quota', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', CLAUDE_PROVIDER_ERROR, 'idle');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.message).toContain('provider error');
    expect(scene.out).not.toContain('quota');
    expect(scene.typed).toEqual([]);
    expect(scene.enters).toBe(0);
  });

  test('an ordinary dialog keeps its own hold and is not read as quota', async () => {
    const scene = await sendAt(claudeWorld(), 'helper', CLAUDE_QUESTION, 'idle');
    expect(scene.code).toBe(1);
    expect(scene.doc?.error?.id).toBe('send.unreachable');
    expect(scene.doc?.error?.message).toContain('question');
    expect(scene.out).not.toContain('quota');
    expect(scene.typed).toEqual([]);
    expect(scene.enters).toBe(0);
  });

  test('a healthy prompt keeps sending as before', async () => {
    const scene = await sendAt(agyWorld(), 'agy1', AGY_IDLE, 'done');
    expect(scene.code).toBe(0);
    expect(scene.typed.length).toBe(1);
    expect(scene.enters).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// status / check: one canonical quota-out state, with the reset as printed.

const TEAM = HERE('./team.yaml');
const SESSION = 'acme-web';
const PANES: Record<string, string> = {
  'agy-acme': 'w7:p1',
  'gemini-acme': 'w8:p1',
  'cursor-acme': 'w5:p1',
  'codex-acme': 'w2:p1',
  'deepseek-acme': 'w3:p1',
};
const CLI: Record<string, string> = {
  'agy-acme': 'antigravity',
  'gemini-acme': 'gemini',
  'cursor-acme': 'cursor',
  'codex-acme': 'codex',
  'deepseek-acme': 'claude-code',
};
const AGENT: Record<string, string> = {
  'agy-acme': 'agy',
  'gemini-acme': 'gemini',
  'cursor-acme': 'cursor-agent',
  'codex-acme': 'codex',
  'deepseek-acme': 'claude',
};

type Seat = { name: string; screen: string; status?: string };

let dir: string;
let home: string;
let standing: Standing;

/** One live session whose seats each answer on their recorded pane, with only the frames the
 *  scene names; every other seat stays off the session so its rows cannot enter an assertion. */
function live(seats: Seat[]): Live {
  const agents: HerdrAgent[] = seats.map((seat) => ({
    name: seat.name,
    agent: AGENT[seat.name] ?? 'claude',
    pane: PANES[seat.name] ?? 'w1:p1',
    workspace: (PANES[seat.name] ?? 'w1:p1').split(':')[0] ?? 'w1',
    status: seat.status ?? 'done',
    cwd: null,
  }));
  const screens: Record<string, string> = {};
  for (const seat of seats) screens[PANES[seat.name] ?? 'w1:p1'] = seat.screen;
  return { running: true, agents, workspaces: [], screens };
}

function checkOf(seats: Seat[]): { out: string; code: number } {
  const io = testIo(dir, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(seats),
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home,
  });
  return { out: io.out, code };
}

/** Every active declared seat answers, so `compare()` has no missing-seat difference and a
 *  `--json` run's exit code can speak about the quota row alone. `grok-acme` is stopped in the
 *  file, as in the existing status suite's clean scene. */
function healthyLive(quotaScreen: string): Live {
  const agents: HerdrAgent[] = [
    { name: 'claude-coordinator-acme', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'working', cwd: null },
    { name: 'codex-acme', agent: 'codex', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
    { name: 'deepseek-acme', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'done', cwd: null },
    { name: 'deepseek-acme-2', agent: 'claude', pane: 'w4:p1', workspace: 'w4', status: 'idle', cwd: null },
    { name: 'agy-acme', agent: 'agy', pane: 'w7:p1', workspace: 'w7', status: 'done', cwd: null },
    { name: 'gemini-acme', agent: 'gemini', pane: 'w8:p1', workspace: 'w8', status: 'idle', cwd: null },
    { name: 'cursor-acme', agent: 'cursor-agent', pane: 'w5:p1', workspace: 'w5', status: 'idle', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: { 'w7:p1': quotaScreen } };
}

function rowFor(out: string, name: string): string {
  const row = out.split('\n').find((line) => line.trimStart().startsWith(`${name} `) || line.trimStart().startsWith(`${name}\t`));
  if (row === undefined) throw new Error(`status printed no row for ${name}:\n${out}`);
  return row;
}

function linesAbout(out: string, name: string): string[] {
  return out.split('\n').filter((line) => line.includes(`${name}:`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't2-quota-acceptance-'));
  home = join(dir, 'home');
  mkdirSync(join(dir, '.agents'));
  mkdirSync(home);
  // The store lives in this home, so `team`'s per-user state root is there with it (the same
  // setup the existing status suite gives its rules-file scenes).
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.agents', 'team.yaml'), TEAM);
  const checked = validateTeamFile(TEAM);
  if (!checked.ok) throw new Error('the quota acceptance team fixture does not validate');
  standing = verifiedOf(checked.team, TEAM, dir, NOW);
  // Every running seat's rules file, planted as `team reload` writes it: an otherwise healthy
  // team, so a status difference or a check line in these scenes is the one under test.
  for (const seat of checked.team.seats) {
    if (seat.stopped) continue;
    const text = rulesOf(checked.team, seat, dir);
    if (!writeRulesFile(standing, seat.name, dir, home, text, rulesFileHash(text)).ok) {
      throw new Error(`the rules file for ${seat.name} did not write`);
    }
  }
  updateState(join(dir, '.agents'), (state) => {
    state.sessions[SESSION] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
    const session = state.sessions[SESSION];
    if (session === undefined) throw new Error('the session record was not created');
    for (const name of Object.keys(PANES)) {
      const record: SeatState = {
        stage: 'ready',
        pane: PANES[name] ?? '',
        workspace: (PANES[name] ?? '').split(':')[0] ?? '',
        cli: CLI[name] ?? '',
        last_active: AT,
      };
      session.seats[name] = record;
    }
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('status at a quota-out screen', () => {
  test('an agy individual-quota frame reads quota out with the relative reset it shows', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'agy-acme', screen: AGY_QUOTA }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    const row = rowFor(io.out, 'agy-acme');
    expect(row).toMatch(/quota out/i);
    expect(row).toContain('47h31m');
    expect(row).not.toMatch(/^agy-acme\s+done\b/);
  });

  test('status JSON carries the same quota-out seat state', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => healthyLive(AGY_QUOTA), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    const code = await runStatus(['--json'], io, sources);
    // Every active declared seat answers, so no missing-seat difference is in play: the exit and
    // the empty difference list belong to this fixture, not to the quota reading.
    expect(code).toBe(0);
    const doc = JSON.parse(io.out);
    expect(doc.differences).toEqual([]);
    const row = (doc.rows as Array<Record<string, unknown>>).find((one) => one.name === 'agy-acme');
    expect(row).toBeDefined();
    expect(String(row?.seat_state)).toMatch(/quota/i);
    for (const word of ['done', 'idle', 'blocked', 'working', 'held', 'unreachable', 'unknown']) {
      expect(row?.seat_state).not.toBe(word);
    }
  });

  test('the Claude Code capture keeps its absolute reset verbatim', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'deepseek-acme', screen: CLAUDE_LIMIT, status: 'idle' }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    const row = rowFor(io.out, 'deepseek-acme');
    expect(row).toMatch(/quota out/i);
    expect(row).toContain('11:00');
    expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('a quota frame with no reset says so and invents no time', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'agy-acme', screen: AGY_NO_RESET }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    const row = rowFor(io.out, 'agy-acme');
    expect(row).toMatch(/quota out/i);
    expect(row).toMatch(/no reset/i);
    expect(row).not.toMatch(/resets?\s+(?:at|in)\s/i);
    expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('the Gemini capture prints the reset with its zone exactly as shown', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'gemini-acme', screen: GEMINI_LIMIT, status: 'done' }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    const row = rowFor(io.out, 'gemini-acme');
    expect(row).toMatch(/quota out/i);
    expect(row).toContain('2:10 PM GMT+2');
  });

  test('a wall without a readable composer keeps its status word', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'deepseek-acme', screen: NO_COMPOSER }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    const row = rowFor(io.out, 'deepseek-acme');
    expect(row).toMatch(/quota out/i);
    expect(row).toContain('11:00');
  });

  test('a Codex weekly-zero status row is not a wall', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'codex-acme', screen: CODEX_WEEKLY_ZERO, status: 'idle' }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    expect(rowFor(io.out, 'codex-acme')).not.toMatch(/quota/i);
  });

  test('a real Codex near-cap warning is a warning, not a wall', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'codex-acme', screen: CODEX_WARNING, status: 'idle' }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    expect(rowFor(io.out, 'codex-acme')).not.toMatch(/quota/i);
  });

  test('a Cursor zero-percent row is not a wall', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const sources: StatusSources = { live: () => live([{ name: 'cursor-acme', screen: CURSOR_ZERO, status: 'idle' }]), branch: () => 'main', standing: () => standing, now: () => NOW, home };
    await runStatus([], io, sources);
    expect(rowFor(io.out, 'cursor-acme')).not.toMatch(/quota/i);
  });
});

describe('check at a quota-out screen', () => {
  test('check names an agy quota prompt with the reset it shows', () => {
    const { out, code } = checkOf([{ name: 'agy-acme', screen: AGY_QUOTA }]);
    const line = linesAbout(out, 'agy-acme').find((one) => one.includes('quota')) ?? '';
    expect(line).toContain('stuck at a quota prompt');
    expect(line).toContain('47h31m');
    expect(code).toBe(1);
  });

  test('the Claude Code quota difference and its exit stay exactly as pinned', () => {
    const { out, code } = checkOf([{ name: 'deepseek-acme', screen: CLAUDE_LIMIT, status: 'idle' }]);
    expect(out).toContain('difference: deepseek-acme: stuck at a quota prompt (last active 4m ago): resets at 11:00\n');
    expect(out).toContain('  repair: the owner waits for the reset; team never types into that screen\n');
    expect(code).toBe(1);
  });

  test('a quota frame with no reset is still a prompt, with no invented time', () => {
    const { out } = checkOf([{ name: 'agy-acme', screen: AGY_NO_RESET }]);
    const line = linesAbout(out, 'agy-acme').find((one) => one.includes('quota')) ?? '';
    expect(line).toContain('stuck at a quota prompt');
    expect(line).not.toMatch(/resets?\s+(?:at|in)\s/i);
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('a wall without a readable composer keeps its check line', () => {
    const { out } = checkOf([{ name: 'deepseek-acme', screen: NO_COMPOSER }]);
    const line = linesAbout(out, 'deepseek-acme').find((one) => one.includes('quota')) ?? '';
    expect(line).toContain('stuck at a quota prompt');
    expect(line).toContain('11:00');
  });

  test('a quote inside a working turn is not named quota', () => {
    const { out } = checkOf([{ name: 'deepseek-acme', screen: CLAUDE_QUOTE, status: 'working' }]);
    expect(linesAbout(out, 'deepseek-acme').filter((one) => one.includes('quota'))).toEqual([]);
  });

  test('a wall above a finished turn is history, not a held seat', () => {
    const { out } = checkOf([{ name: 'deepseek-acme', screen: CLAUDE_HISTORY, status: 'done' }]);
    expect(linesAbout(out, 'deepseek-acme').filter((one) => one.includes('quota'))).toEqual([]);
  });

  test('Codex and Cursor status rows are not named quota', () => {
    const { out } = checkOf([
      { name: 'codex-acme', screen: CODEX_WEEKLY_ZERO, status: 'idle' },
      { name: 'cursor-acme', screen: CURSOR_ZERO, status: 'idle' },
    ]);
    expect(linesAbout(out, 'codex-acme').filter((one) => one.includes('quota'))).toEqual([]);
    expect(linesAbout(out, 'cursor-acme').filter((one) => one.includes('quota'))).toEqual([]);
  });
});
