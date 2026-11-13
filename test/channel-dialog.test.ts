// The one dialog a launch answers itself: Claude Code's development-channels warning, for the
// team's own inbox channel, on the seat's own pane, right after this run launched it.
//
// The frames are synthetic. They are built from the dialog's rows as the owner's record quotes
// them (the title, `Channels: server:team-inbox`, `❯ 1. I am using this for local development`,
// `2. Exit`) and the footer Claude Code draws under its other selection dialogs; no capture of
// this dialog is in the corpus yet. No CLI is started and no pane is touched.
import { describe, expect, test } from 'bun:test';
import { channelDialogFor, teamInboxChannel } from '../src/launch/channel-dialog.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import type { HerdrAgent } from '../src/herdr.ts';

const DIALOG = [
  '',
  ' WARNING: Loading development channels',
  '',
  ' --dangerously-load-development-channels is for local channel development only. Do not use',
  ' this option to run channels you have downloaded off the internet.',
  '',
  ' Channels: server:team-inbox',
  '',
  ' ❯ 1. I am using this for local development',
  '   2. Exit',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

const IDLE = ['╭──────────╮', '│ >        │', '╰──────────╯', '  ? for shortcuts'].join('\n');

describe('the dialog the launch answers', () => {
  test('the dialog for the team\'s inbox, option 1 marked, at the bottom of the pane', () => {
    expect(teamInboxChannel()).toBe('server:team-inbox');
    expect(channelDialogFor(DIALOG)).toBe(true);
    expect(channelDialogFor(DIALOG.replace(' Enter to confirm · Esc to cancel', ''))).toBe(true);
    // Styling and a frame's side borders are not part of the rows.
    expect(channelDialogFor(DIALOG.replace('WARNING', '\x1b[1;33mWARNING').replace('development channels', 'development channels\x1b[0m'))).toBe(true);
    expect(channelDialogFor(DIALOG.split('\n').map((row) => `│${row.padEnd(60)}│`).join('\n'))).toBe(true);
  });

  test('any other channel, or more than one, is not this dialog', () => {
    expect(channelDialogFor(DIALOG.replace('server:team-inbox', 'server:other'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace('server:team-inbox', 'server:team-inbox, server:other'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace('server:team-inbox', 'plugin:team-inbox@market'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace(' Channels: server:team-inbox', ''))).toBe(false);
  });

  test('the mark on another row, a third option, or other options are not this dialog', () => {
    expect(channelDialogFor(DIALOG.replace(' ❯ 1.', '   1.').replace('   2. Exit', ' ❯ 2. Exit'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace('   2. Exit', '   2. Exit\n   3. Always allow'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace('I am using this for local development', 'Yes'))).toBe(false);
    expect(channelDialogFor(DIALOG.replace('   2. Exit', '   2. Quit'))).toBe(false);
  });

  test('a dialog with anything drawn under it, or quoted above a prompt, is not this dialog', () => {
    expect(channelDialogFor(`${DIALOG}\n${IDLE}`)).toBe(false);
    expect(channelDialogFor(`${DIALOG}\n > `)).toBe(false);
    expect(channelDialogFor(`${DIALOG} · more`)).toBe(false);
    expect(channelDialogFor(IDLE)).toBe(false);
    expect(channelDialogFor('')).toBe(false);
    expect(channelDialogFor(null)).toBe(false);
  });
});

describe('the wait after a launch', () => {
  const CHANNEL_LINE = 'claude --dangerously-load-development-channels server:team-inbox --model claude-opus-5-5';

  type Scene = {
    line?: string;
    cli?: string;
    launchedHere?: boolean;
    answer?: 'answer' | 'leave';
    agents?: HerdrAgent[] | null;
    foreground?: string[] | null;
    /** The dialog comes back after the key: the second showing. */
    stuck?: boolean;
    screen?: string;
  };

  async function run(scene: Scene) {
    let answered = false;
    const keys: [string, string][] = [];
    const logged: [string, string][] = [];
    const said: string[] = [];
    const closed: string[] = [];
    let clock = 0;
    const screen = (): string => (answered && scene.stuck !== true ? IDLE : scene.screen ?? DIALOG);
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'w1:p1', workspace: 'w1' }),
      paneRun: () => true,
      typeLine: () => { throw new Error('unexpected terminal typing'); },
      renameAgent: () => true,
      closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
      stopSession: () => true,
      kill: () => { throw new Error('unexpected process signal'); },
      agentPanes: () => ['w1:p1'],
      agentList: () => scene.agents === undefined
        ? [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'blocked', cwd: null }]
        : scene.agents,
      classify: (): ScreenKind => (screen() === IDLE ? 'idle' : 'question'),
      paneText: () => screen(),
      foreground: () => (scene.foreground === undefined ? ['claude'] : scene.foreground),
      pressEnter: (session, pane) => {
        keys.push([session, pane]);
        answered = true;
        return true;
      },
      ...(scene.answer === undefined ? {} : { channelDialog: scene.answer }),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => true,
      say: (line) => { said.push(line); },
      log: (who, what) => { logged.push([who, what]); },
    };
    const cli = scene.cli ?? 'claude-code';
    const line = scene.line ?? CHANNEL_LINE;
    const launch: Step = {
      kind: 'run',
      argv: ['herdr', 'pane', 'run', 'w1:p1', line],
      do: { do: 'launch', seat: 'lead', label: 'lead', command: line, pane: 'w1:p1', workspace: 'w1', cli },
    };
    const wait: Step = {
      kind: 'wait',
      text: 'until lead shows its idle prompt',
      do: { do: 'idle', seat: 'lead', label: 'lead', cli, seconds: 10, command: line, pane: 'w1:p1', workspace: 'w1', repairLine: 'synthetic repair' },
    };
    const steps: Step[] = scene.launchedHere === false ? [wait] : [launch, wait];
    const report = await executePlan(steps, 'acme', host);
    return { report, keys, logged, said, closed };
  }

  test('the seat\'s own dialog for the team\'s inbox is answered once, with Enter, and logged', async () => {
    const { report, keys, logged, closed } = await run({});
    expect(keys).toEqual([['acme', 'w1:p1']]);
    // The log line carries the seat and the time; its words name the channel and the option.
    expect(logged).toContainEqual(['lead', 'answered its development-channels dialog for server:team-inbox with option 1 (I am using this for local development)']);
    expect(report.dropped).toEqual([]);
    expect(closed).toEqual([]);
  });

  test('a second showing in the same wait is never answered: the wait stops at it as at any dialog', async () => {
    const { report, keys, closed } = await run({ stuck: true });
    expect(keys).toHaveLength(1);
    expect(report.dropped).toContain('lead');
    expect(closed).toEqual(['w1']);
  });

  test('nothing is pressed when the launch is not this run\'s, the line names no channel, or the CLI is another', async () => {
    expect((await run({ launchedHere: false })).keys).toEqual([]);
    expect((await run({ line: 'claude --model claude-opus-5-5' })).keys).toEqual([]);
    expect((await run({ line: 'claude --dangerously-load-development-channels server:other' })).keys).toEqual([]);
    expect((await run({ cli: 'codex', line: `codex ${CHANNEL_LINE}` })).keys).toEqual([]);
  });

  test('nothing is pressed on a pane another seat holds, one the list cannot read, or with no CLI in front', async () => {
    expect((await run({ agents: [{ name: 'other', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'blocked', cwd: null }] })).keys).toEqual([]);
    expect((await run({ agents: null })).keys).toEqual([]);
    expect((await run({ foreground: ['zsh'] })).keys).toEqual([]);
    expect((await run({ foreground: null })).keys).toEqual([]);
  });

  test('no other dialog is answered, and a host that leaves the dialog presses nothing', async () => {
    expect((await run({ screen: DIALOG.replace('server:team-inbox', 'server:other') })).keys).toEqual([]);
    const permission = ['Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', 'Esc to cancel · Tab to amend'].join('\n');
    expect((await run({ screen: permission })).keys).toEqual([]);
    const left = await run({ answer: 'leave' });
    expect(left.keys).toEqual([]);
    expect(left.report.dropped).toContain('lead');
  });
});
