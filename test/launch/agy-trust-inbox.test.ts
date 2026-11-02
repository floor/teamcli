// An Antigravity seat launches with its own folder trusted for the session, and its team inbox
// is one per-seat entry in the CLI's user-level store, removed when `team down` closes the seat.
// The trust value and the add/remove words are measured on agy 1.4.12 in a scratch HOME; every
// scene below is synthetic.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { fillInboxPlace, inboxEntryName, launchCommand, shellQuote } from '../../src/profiles/profile.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { claudeBox, gitEnv, testIo } from '../helpers.ts';

const antigravity = profileFor('antigravity');
if (!antigravity) throw new Error('antigravity has no profile');

describe('the antigravity profile carries the measured session settings', () => {
  test('one inline JSON value, the seat folder, and nothing saved', () => {
    expect(antigravity.settings).toEqual({ option: '--settings', value: '{"trustedWorkspaces":["{cwd}"]}' });
  });

  test('the inbox is user-level, so its delivery class is the installed one', () => {
    expect(antigravity.mcpInbox?.target).toBeNull();
    expect(antigravity.mcpInbox?.file).toBeNull();
    expect(antigravity.delivery).toBe('pull-on-turn');
  });
});

describe('launchCommand with a seat folder', () => {
  test('the seat\'s absolute folder is trusted for the session, after the unattended flag', () => {
    expect(launchCommand(antigravity, 'agy --model gemini-3.8-flash-high', 'Rules.', undefined, undefined, undefined, undefined, undefined, undefined, '/work/acme'))
      .toBe(`AGENT_UNATTENDED=1 agy --model gemini-3.8-flash-high --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/work/acme"]}'`);
  });

  test('a folder holding a quote reaches the JSON escaped, and the shell as one word', () => {
    expect(launchCommand(antigravity, 'agy', 'Rules.', undefined, undefined, undefined, undefined, undefined, undefined, '/work/ac"me'))
      .toBe(`AGENT_UNATTENDED=1 agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/work/ac\\"me"]}'`);
  });

  test('a folder holding a replacement pattern reaches the JSON as itself', () => {
    // A string replacement would read these as patterns: "$&" the whole match, "$'" and "$`"
    // the text after and before it, "$$" one dollar. The fill is a function, so each stays part
    // of the folder.
    for (const folder of ['/work/$&', "/work/$'", '/work/$`', '/work/$$']) {
      const value = JSON.stringify({ trustedWorkspaces: [folder] });
      expect(launchCommand(antigravity, 'agy', 'Rules.', undefined, undefined, undefined, undefined, undefined, undefined, folder))
        .toBe(`AGENT_UNATTENDED=1 agy --dangerously-skip-permissions --settings ${shellQuote(value)}`);
    }
  });

  test('a seat name holding a replacement pattern is filled in literally', () => {
    const place = { seat: 'a$&b', session: "c$'d", command: 'e$$f', entry: 'g$`h' };
    expect(fillInboxPlace('{seat}:{session}:{command}:{entry}', place)).toBe("a$&b:c$'d:e$$f:g$`h");
  });

  test('no folder means no settings: a caller that launches nothing invents no trust', () => {
    expect(launchCommand(antigravity, 'agy', 'Rules.'))
      .toBe('AGENT_UNATTENDED=1 agy --dangerously-skip-permissions');
  });

  test('a line that names its own --settings keeps it, and no second value is appended', () => {
    expect(launchCommand(antigravity, 'agy --settings ./mine.json', 'Rules.', undefined, undefined, undefined, undefined, undefined, undefined, '/work/acme'))
      .toBe('AGENT_UNATTENDED=1 agy --settings ./mine.json --dangerously-skip-permissions');
    expect(launchCommand(antigravity, 'agy --settings=./mine.json', 'Rules.', undefined, undefined, undefined, undefined, undefined, undefined, '/work/acme'))
      .toBe('AGENT_UNATTENDED=1 agy --settings=./mine.json --dangerously-skip-permissions');
  });

  test('the settings ride before a first-message rules line, which stays last', () => {
    const line = '/home/owner/.config/team/demo/rules/gemini.md';
    expect(launchCommand(antigravity, 'agy', 'Rules.', undefined, undefined, undefined, undefined, line, undefined, '/work/acme'))
      .toBe(`AGENT_UNATTENDED=1 agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/work/acme"]}' --prompt-interactive ${line}`);
  });
});

describe('upPlan trusts each seat\'s own resolved folder', () => {
  const seat = (cwd: string, extra: Record<string, unknown> = {}) => ({
    name: 'gemini', cli: 'antigravity', launch: 'agy', cwd, label: 'gemini', stopped: false, rules: 'Rules.',
    repairLine: '`team remove gemini --keep` then `team add gemini`',
    ...extra,
  });
  const launchOf = (plan: ReturnType<typeof upPlan>): { command: string; cwd?: string } => {
    const step = plan.find((item) => item.do?.do === 'launch');
    if (step?.do?.do !== 'launch') throw new Error('the plan has no launch step');
    return { command: step.do.command, cwd: step.do.cwd };
  };

  test('a relative seat folder is resolved against the root, and that path is trusted', () => {
    const plan = upPlan({
      root: '/work/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [seat('.')],
    });
    expect(launchOf(plan)).toEqual({
      command: `AGENT_UNATTENDED=1 agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/work/acme"]}'`,
      cwd: '/work/acme',
    });
  });

  test('an absolute seat folder is trusted as itself', () => {
    const plan = upPlan({
      root: '/work/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [seat('/elsewhere/seat')],
    });
    expect(launchOf(plan).command)
      .toBe(`AGENT_UNATTENDED=1 agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/elsewhere/seat"]}'`);
  });

  test('a resumed conversation and the trust settings both ride the line, trust after the flag', () => {
    const plan = upPlan({
      root: '/work/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [seat('.', { resume: 'b4b1b021-e8af-4213-9b7e-470b233b712f' })],
    });
    expect(launchOf(plan).command).toBe(
      `AGENT_UNATTENDED=1 agy --conversation=b4b1b021-e8af-4213-9b7e-470b233b712f --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/work/acme"]}'`,
    );
  });

  test('a seat whose line names its own settings file is left as it is', () => {
    const plan = upPlan({
      root: '/work/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [seat('.', { launch: 'agy --settings ./seat.json' })],
    });
    expect(launchOf(plan).command).toBe('AGENT_UNATTENDED=1 agy --settings ./seat.json --dangerously-skip-permissions');
  });
});

describe('the per-seat inbox entry name', () => {
  test('it names the team and the seat, in the characters the store accepts, with the pair\'s hash', () => {
    const name = inboxEntryName('acme-web', 'builder-4');
    expect(name).toMatch(/^team-inbox-acme-web-builder-4-[0-9a-f]{8}$/);
    // The folded parts are readable but not one-to-one, so the hash is what tells two pairs
    // that fold alike apart — and a pair that folds away still leaves a usable name.
    const spaces = inboxEntryName('acme/web', 'builder 4');
    expect(spaces).toMatch(/^team-inbox-acme-web-builder-4-[0-9a-f]{8}$/);
    expect(spaces).not.toBe(name);
    expect(inboxEntryName('...', '...')).toMatch(/^team-inbox-x-x-[0-9a-f]{8}$/);
  });

  test('two pairs that fold to the same readable name are still two entries', () => {
    const first = inboxEntryName('red-team', 'writer');
    const second = inboxEntryName('red', 'team-writer');
    for (const entry of [first, second]) expect(entry).toMatch(/^team-inbox-red-team-writer-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------------------------
// A down world: a file session of three seats, two antigravity and one human's, with herdr
// listing them idle. A closed seat is typed its profile's exit and its workspace closed; a human
// seat is left running. Only the closed seats' own entries may be removed.

const SEAT = (name: string, role: string, cli: string, extra = ''): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${cli === 'antigravity' ? 'agy' : 'claude'}
${extra}`;

function teamYaml(root: string, home: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('lead', 'coordinator', 'antigravity')}
${SEAT('worker', 'implementer', 'antigravity')}
${SEAT('person', 'implementer', 'claude-code', '    human: true\n')}`;
}

type Fixture = { root: string; home: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-agy-inbox-down-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, home));
  updateState(dir, (state) => {
    const current = (state.sessions.acme ??= emptySession());
    current.launched_file = join(dir, 'team.yaml');
    for (const name of ['lead', 'worker', 'person']) {
      current.seats[name] = { stage: 'ready', pane: `pane-${name}`, workspace: `ws-${name}` };
    }
  });
  return { root, home, dir };
}

const NOW = new Date('2026-11-02T09:00:00Z');
const owner = { kind: 'owner' } as const;

function downSources(fixture: Fixture): { sources: DownSources; removals: { cli: string; seat: string; session: string }[] } {
  const alive = new Set<string>(['lead', 'worker', 'person']);
  const shelled = new Set<string>();
  const boxes = new Map<string, string>();
  const removals: { cli: string; seat: string; session: string }[] = [];
  const agyIdle = readFileSync(new URL('../fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
  const agyBox = (text: string): string => {
    if (text === '') return agyIdle;
    const [first = '', ...rest] = text.split('\n');
    return agyIdle.replace('\n>\n', `\n${[`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n')}\n`);
  };
  const paneCli = (pane: string): string => cliOf[pane.replace('pane-', '')] ?? '';
  const cliOf: Record<string, string> = { lead: 'antigravity', worker: 'antigravity', person: 'claude-code' };
  const listed = (): HerdrAgent[] => [...alive].map((name) => ({
    name, agent: cliOf[name]!, pane: `pane-${name}`, workspace: `ws-${name}`, status: 'idle', cwd: fixture.root,
  }));
  const launch: DownLaunch = {
    typeText: (_session, pane, text) => { shelled.delete(pane); boxes.set(pane, text); return true; },
    sendKey: () => true,
    pressEnter: (_session, pane) => { shelled.add(pane); return true; },
    agentPanes: () => listed().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      alive.delete(workspace.replace('ws-', ''));
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: DownSources = {
    home: fixture.home,
    sessionRunning: () => true,
    agents: () => listed(),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => {
      const text = boxes.get(pane) ?? '';
      return paneCli(pane) === 'antigravity' ? agyBox(text) : claudeBox(text);
    },
    status: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : [cliOf[pane.replace('pane-', '')] === 'antigravity' ? 'agy' : 'claude']),
    now: () => NOW,
    sleep: async () => {},
    launch,
    inboxRemove: (input) => { removals.push(input); return { ok: true, removed: true }; },
  };
  return { sources, removals };
}

describe('team down removes only the closed seat\'s entry', () => {
  test('the two antigravity seats that end are removed; the kept human seat is not', async () => {
    const fixture = makeFixture();
    const world = downSources(fixture);
    const io = testIo(fixture.root, owner);
    expect(await runDown([], io, world.sources)).toBe(0);
    expect(world.removals.map((item) => item.seat).sort()).toEqual(['lead', 'worker']);
    expect(world.removals.every((item) => item.cli === 'antigravity' && item.session === 'acme')).toBe(true);
    expect(io.err).toBe('');
  });

  test('a removal that cannot be made is said on stderr and the seat still ends', async () => {
    const fixture = makeFixture();
    const world = downSources(fixture);
    const io = testIo(fixture.root, owner);
    world.sources.inboxRemove = (input) => {
      world.removals.push(input);
      return input.seat === 'worker' ? { ok: false, reason: '`agy mcp remove` exited 2' } : { ok: true, removed: true };
    };
    expect(await runDown([], io, world.sources)).toBe(0);
    expect(io.err).toContain('worker: its team inbox entry was not removed: `agy mcp remove` exited 2');
  });
});
