import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { entitiesPath } from '../../src/entities.ts';
import { grantsDir } from '../../src/grant.ts';
import { boxHoldsText, deliverRules, refusalReport, RULES_ENTER_TRIES, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { rulesLine } from '../../src/launch/rules-file.ts';
import { resolveCodexDaemonPolicy } from '../../src/policy/codex-daemon.ts';
import { policySignaturePayload } from '../../src/policy/sources.ts';
import { POLICY_DOMAIN, type PolicyLevel } from '../../src/policy/types.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { registerAgent, updateAgent } from '../../src/registry/agents.ts';
import { upsertProject } from '../../src/registry/projects.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { bumpGeneration, keyOf, signDomain } from '../../src/store/keys.ts';
import { classify, classifyComposer, readScreen } from '../../src/watch/screen.ts';
import type { YamlValue } from '../../src/yaml.ts';
import { SAMPLE_RULES, wordWrap } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

const codex = profileFor('codex');
if (!codex) throw new Error('codex has no profile');

describe('Codex launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.')).toBe('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen');
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.', undefined, undefined, undefined, { codexDaemon: 'on' })).toBe('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen');
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.', undefined, undefined, undefined, { codexDaemon: 'off' })).toBe('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-daemon --no-alt-screen');
    expect(codex.rulesOption).toBeNull();
    expect(codex.loginCheck).toEqual(['login', 'status']);
    expect(codex.exit).toBe('/exit');
    expect(versionVerdict('codex-cli 0.157.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.160.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.161.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.162.0', codex.tested)).toBe('newer');
  });
  test('the team inbox rides the launch as two -c values, and no file is written', () => {
    expect(codex.mcpInbox).toEqual({
      launchArgs: [
        '-c',
        'mcp_servers.team_inbox.command="{command_json}"',
        '-c',
        'mcp_servers.team_inbox.args=["{entry_json}","mcp","serve","--seat","{seat_json}"{file_args}{epoch_args}]',
      ],
      add: null,
      target: null,
      file: null,
    });
    expect(
      launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.', undefined, {
        seat: 'helper',
        session: 'acme',
        command: '/opt/bun',
        entry: '/src/cli.ts',
      }),
    ).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen'
      + ' -c \'mcp_servers.team_inbox.command="/opt/bun"\''
      + ' -c \'mcp_servers.team_inbox.args=["/src/cli.ts","mcp","serve","--seat","helper"]\'',
    );
  });
  test('a quote or backslash in a structured value is escaped inside the TOML string', () => {
    expect(
      launchCommand(codex, 'codex', 'Rules.', undefined, {
        seat: 'helper',
        session: 'acme',
        command: '/opt/my "bun"',
        entry: '/src/with \\ backslash/cli.ts',
      }),
    ).toBe(
      'AGENT_UNATTENDED=1 codex -a never -s danger-full-access --no-alt-screen'
      + ' -c \'mcp_servers.team_inbox.command="/opt/my \\"bun\\""\''
      + ' -c \'mcp_servers.team_inbox.args=["/src/with \\\\ backslash/cli.ts","mcp","serve","--seat","helper"]\'',
    );
  });
  test('a launch that read a team file names it to the server, inside the -c array', () => {
    expect(
      launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.', undefined, {
        seat: 'helper',
        session: 'acme',
        command: '/opt/bun',
        entry: '/src/cli.ts',
        file: '/tmp/my project/.agents/team.yaml',
      }),
    ).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen'
      + ' -c \'mcp_servers.team_inbox.command="/opt/bun"\''
      + ' -c \'mcp_servers.team_inbox.args=["/src/cli.ts","mcp","serve","--seat","helper","--file","/tmp/my project/.agents/team.yaml"]\'',
    );
  });
  test('a plan for a seat in a lobby carries the team file onto the codex launch line', () => {
    const plan = upPlan({
      root: '/tmp/acme', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      teamFile: '/tmp/acme/.agents/team.yaml',
      seats: [{
        name: 'coder',
        cli: 'codex',
        launch: 'codex',
        cwd: '/tmp/team-lobbies/teamcli',
        label: 'coder',
        stopped: false,
        rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
      }],
    });
    const launch = plan.find((step) => step.do?.do === 'launch');
    expect(launch?.do).toMatchObject({ do: 'launch', seat: 'coder', teamFile: '/tmp/acme/.agents/team.yaml' });
    const command = launch?.kind === 'run' ? launch.argv.at(-1) ?? '' : '';
    expect(command).toContain('"--file","/tmp/acme/.agents/team.yaml"');
  });
  test.each([
    ['idle', 'idle'], ['unsent', 'unsent'], ['working', 'working'],
    ['typed-two-lines', 'unsent'], ['pasted-two-lines', 'unsent'], ['second-line-glyph', 'unsent'],
    ['second-line-gt', 'unsent'], ['wrapped-line', 'unsent'], ['blank-middle', 'unsent'],
    ['rules-accepted', 'idle'], ['startup', 'vendor notice'], ['startup-loading', 'unknown'], ['trust', 'trust'],
    ['exit-typed', 'unsent'], ['exit', 'unknown'], ['permission', 'permission'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('codex', fixture(file)).kind).toBe(kind);
  });
  test('every 0.161.0 capture reads its state, one chrome row under the status line and all', () => {
    // The 0.161.0 captures (see that folder's README). A plain launch draws one chrome row
    // under the status row — `← for agents · ? for shortcuts` — on idle, working and the
    // post-turn empty box. Read as `status-last`, every one of those frames came back
    // `unknown`, so `up` left the seat out: "rules not typed: the screen read unknown".
    const latest = (name: string) => readFileSync(new URL(`../fixtures/codex/0.161.0/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('codex', latest('idle-hint')).kind).toBe('idle');
    expect(classifyComposer('codex', latest('idle-hint').split('\n')).kind).toBe('idle');
    // Typing hides the chrome row; the status row is the last line again.
    expect(readScreen('codex', latest('unsent')).kind).toBe('unsent');
    expect(classifyComposer('codex', latest('unsent').split('\n')).kind).toBe('unsent');
    expect(readScreen('codex', latest('working')).kind).toBe('working');
    expect(classifyComposer('codex', latest('working').split('\n')).kind).toBe('idle');
    // The three-choice approval dialog and the renamed trust way-out are 0.161.0's own.
    expect(readScreen('codex', latest('permission')).kind).toBe('permission');
    expect(readScreen('codex', latest('trust')).kind).toBe('trust');
    expect(readScreen('codex', latest('exit-typed')).kind).toBe('unsent');
    expect(readScreen('codex', latest('exit')).kind).toBe('unknown');
  });
  test('a ready screen drawn with » is the same composer as one drawn with ›', () => {
    // Two Codex distributions draw the same ready screen with a different prompt glyph: the
    // captured `›` and the observed build's `»` (GPT-6.1-Sol ultra). Before the prompt accepted
    // both, the `»` screen read unknown and `up` skipped the seat's rules. The empty box and
    // the typed box read exactly as the `›` capture does; a running turn, a dialog and the
    // exit menu keep their classification, so the wider prompt opens no other screen.
    const latest = (name: string) => readFileSync(new URL(`../fixtures/codex/0.161.0/${name}.txt`, import.meta.url), 'utf8');
    const wideGlyph = (screen: string) => screen.replace(/^›/gm, '»');
    const empty = wideGlyph(latest('idle-hint'));
    expect(empty).not.toBe(latest('idle-hint'));
    expect(readScreen('codex', empty).kind).toBe('idle');
    expect(classifyComposer('codex', empty.split('\n')).kind).toBe('idle');
    const typed = wideGlyph(latest('unsent'));
    expect(typed).not.toBe(latest('unsent'));
    expect(readScreen('codex', typed).kind).toBe('unsent');
    expect(classifyComposer('codex', typed.split('\n')).kind).toBe('unsent');
    // The working turn's sent-message echo now carries `»` too; it is still the turn, and its
    // composer is read the way the `›` capture reads it.
    expect(readScreen('codex', wideGlyph(latest('working'))).kind).toBe('working');
    expect(classifyComposer('codex', wideGlyph(latest('working')).split('\n')).kind).toBe('idle');
    // A dialog whose choice row is `»` is not a composer: the trust and permission stages keep
    // their own `›` rows, and an unread dialog reads unknown — never idle or unsent.
    expect(readScreen('codex', wideGlyph(latest('trust'))).kind).toBe('unknown');
    expect(readScreen('codex', wideGlyph(latest('permission'))).kind).toBe('unknown');
    expect(classifyComposer('codex', wideGlyph(latest('permission')).split('\n')).kind).toBe('unknown');
  });
  test('the idle hint with its context shown used reads idle; near-matches stay non-ready', () => {
    // `restart`'s ready detector classifies a pane with `readScreen`. A seat was up at
    // `› Ask Codex to do anything` with 100% context and six restarts still said it did not
    // reach a ready prompt. 0.161.0 draws the context either way — the installed binary's own
    // strings pair `Context ` `% left` and `Context ` `% used`, beside the status-surface ids
    // `context-remaining` and `context-used` — and the used row read `unknown`. The fixtures
    // are constructed from idle-hint.txt (see that folder's README); each near-match below
    // must stay one the launch does not type into.
    const latest = (name: string) => readFileSync(new URL(`../fixtures/codex/0.161.0/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('codex', latest('ready-context-used')).kind).toBe('idle');
    expect(classifyComposer('codex', latest('ready-context-used').split('\n')).kind).toBe('idle');
    // A launch that draws no chrome row leaves the status row last.
    expect(readScreen('codex', latest('ready-context-used-bare')).kind).toBe('idle');
    // Text after the prompt is not ready, and the seat's own row under a status-shaped row
    // means that row is not the composer's.
    expect(readScreen('codex', latest('near-context-used-typed')).kind).toBe('unsent');
    expect(readScreen('codex', latest('near-context-used-follower')).kind).toBe('unknown');
    expect(readScreen('codex', latest('near-context-used-nostatus')).kind).toBe('unknown');
  });

  test('the wide frame with the warning on the status row reads idle', () => {
    // Floor's supplied sanitized 8-line capture of an observed build on a wide pane: the account's
    // warning is right-aligned on the status row itself and no chrome row sits under it. Read
    // before the fix: `unknown` — status-then-one read the row's place by the ellipsis row the
    // narrow captures draw under a wrapped row, and this frame draws none.
    const latest = (name: string) => readFileSync(new URL(`../fixtures/codex/0.161.0/${name}.txt`, import.meta.url), 'utf8');
    const captured = latest('idle-wide-warning');
    const row = captured.trimEnd().split('\n').at(-1) ?? '';
    expect(row.startsWith('  GPT-6.1-Sol ultra · Context 100% left · weekly 94% left')).toBe(true);
    expect(row.endsWith('⚠ 1 warning · f2 to view')).toBe(true);
    expect(readScreen('codex', captured).kind).toBe('idle');
    expect(classifyComposer('codex', captured.split('\n')).kind).toBe('idle');
    expect(runningModel('codex', captured)).toEqual({ model: 'GPT Sol', version: '6.1' });
    // The report's own drawing of the row: ASCII dots stand in for the alignment gap.
    const dotted = captured.replace(/(% left) +⚠/, '$1 ... ⚠');
    expect(dotted).not.toBe(captured);
    expect(readScreen('codex', dotted).kind).toBe('idle');
    expect(classifyComposer('codex', dotted.split('\n')).kind).toBe('idle');
    // The narrow captures keep the chrome row under the status line; the wide allowance takes
    // nothing from them.
    expect(readScreen('codex', latest('idle-hint')).kind).toBe('idle');
    expect(readScreen('codex', latest('unsent')).kind).toBe('unsent');
  });
  test('a dialog above the status row and its chrome row is still the dialog', () => {
    // Constructed from the captures: permission.txt's dialog with idle-hint.txt's last two
    // lines (the status row and its chrome row) under it. Read before the mode changed:
    // `unknown` — the footer was no longer the pane's last non-blank line.
    const latest = (name: string) => readFileSync(new URL(`../fixtures/codex/0.161.0/${name}.txt`, import.meta.url), 'utf8');
    const chrome = latest('idle-hint').trimEnd().split('\n').slice(-2);
    const pinned = [latest('permission').trimEnd(), '', ...chrome, ''].join('\n');
    expect(classify('codex', pinned.split('\n')).kind).toBe('permission');
    expect(classifyComposer('codex', pinned.split('\n')).kind).toBe('unknown');
  });
  test('a permission dialog above the pinned status line is the dialog, not unsent text', () => {
    // `permission-pinned` is constructed, not captured: the captured dialog with the captured
    // status line below it (see the fixtures README). Read before the fix: `unsent` — the
    // composer took the choice line for an input prompt, and the floor's markers missed the
    // dialog's lower-case `esc to cancel` below it.
    const pinned = fixture('permission-pinned');
    expect(classify('codex', pinned.split('\n')).kind).toBe('permission');
    expect(readScreen('codex', pinned).kind).toBe('permission');
    // The composer alone never says idle or unsent on the dialog either: `deliverRules` waits
    // on that reading after the paste.
    expect(classifyComposer('codex', pinned.split('\n')).kind).toBe('unknown');
  });
  test('a trust dialog with a running turn beside it is still trust, not working', () => {
    // The turn's own status line stays on the pane while the dialog is up: the dialog shape is
    // read first, as for claude-code.
    const screen = fixture('trust').replace(
      '› 1. Trust and continue',
      '• Working (0s • esc to interrupt)\n\n› 1. Trust and continue',
    );
    expect(readScreen('codex', screen).kind).toBe('trust');
  });
  test('permission takes precedence over a running turn and requires an active footer', () => {
    const captured = fixture('permission');
    const working = captured.replace('› 1. Yes', '• Working (0s • esc to interrupt)\n\n› 1. Yes');
    expect(readScreen('codex', working).kind).toBe('permission');
    expect(readScreen('codex', captured + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', captured.replace('Press enter to confirm or esc to cancel', '')).kind).toBe('unknown');
  });
  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [undefined, '❯\n', '›\n', 'Welcome to Codex\nSign in to continue', 'Do you allow this command?\n› 1. Yes\nEnter to confirm']) {
      expect(readScreen('codex', screen).kind).toBe('unknown');
    }
    expect(readScreen('codex', fixture('idle').replace('GPT-5.6-Terra medium ·', 'new footer')).kind).toBe('unknown');
  });
  test('a quoted trust dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('codex', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', fixture('idle').replace('› Ask Codex to do anything', '›\n  unsent second line')).kind).toBe('unsent');
  });
  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(codex.modelOf('codex -m gpt-6-sol -c model_reasoning_effort=high')).toEqual({ model: 'GPT Sol', version: '6' });
    expect(codex.modelOf('codex --model=gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m gpt-6-sol -m gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m unknown')).toBeNull();
    expect(codex.modelOf('launcher')).toBeNull();
    expect(runningModel('codex', fixture('idle'))).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(runningModel('codex', fixture('trust'))).toBeNull();
  });
  test('the plan delivers the one line through the guarded path, never a config file', () => {
    const line = rulesLine('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/coder.md', '5e1d0a9c4b2f');
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesFile: { path: '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/coder.md', line } }] });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({ do: 'deliver', cli: 'codex', rules: 'Rules.', line, seconds: 90 });
    const deliverStep = plan.find((step) => step.do?.do === 'deliver');
    expect(deliverStep?.kind === 'run' ? deliverStep.argv.at(-1) : undefined).toBe(line);
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
  test('a message seat whose rules file has no typeable path is refused before anything is typed', () => {
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesRefusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" }] });
    expect(plan.some((step) => step.do?.do === 'deliver')).toBe(false);
    expect(plan.find((step) => step.kind === 'skip')?.text).toBe(
      "coder: would refuse: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
    );
  });

  test('a recorded conversation resumes with the codex resume subcommand on the seat launch line', () => {
    // Flags the seat already names stay in front of `resume`. A wrapper that forwards its
    // arguments, and a quoted script that itself runs codex, both keep that order.
    const id = 'ses_codex';
    const flagged = 'codex -m gpt-6-sol -c model_reasoning_effort=high';
    const seat = {
      name: 'coder', cli: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
      repairLine: '`team remove coder --keep` then `team add coder`',
    };
    const commandOf = (launch: string, resume: { resume?: string; registry?: { launch: string; model: string; version: string; sessionId?: string } }): string => {
      const planned = upPlan({
        root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
        seats: [{ ...seat, launch, ...resume }],
      });
      const step = planned.find((item) => item.do?.do === 'launch');
      return step?.do?.do === 'launch' ? step.do.command : '';
    };
    const tail = '-a never -s danger-full-access --no-alt-screen';
    // The inbox `-c` arguments follow the profile's own flags, and their paths are this
    // machine's. The resume word stays with the flags the seat already named.
    const expectResume = (launch: string, head: string): void => {
      const command = commandOf(launch, launch === flagged
        ? { registry: { launch: flagged, model: 'GPT Sol', version: '6', sessionId: id } }
        : { resume: id });
      expect(command.startsWith(head)).toBe(true);
      expect(command.slice(head.length) === '' || command.slice(head.length).startsWith(' ')).toBe(true);
      expect(command.indexOf(`resume ${id}`)).toBeLessThan(command.indexOf(tail));
    };
    expectResume(flagged, `AGENT_UNATTENDED=1 ${flagged} resume ${id} ${tail}`);
    expectResume(
      `zsh /Users/owner/as-floor.sh ${flagged}`,
      `AGENT_UNATTENDED=1 zsh /Users/owner/as-floor.sh ${flagged} resume ${id} ${tail}`,
    );
    expectResume(
      `zsh -lc "${flagged}"`,
      `AGENT_UNATTENDED=1 zsh -lc "${flagged} resume ${id}" ${tail}`,
    );
  });
});

describe('the typed-newline captures (Codex)', () => {
  // Real captures (see the fixtures README): 2026-10-04, plain `codex --no-daemon`,
  // 163 by 47 — a two-line text typed with the CLI's newline key (Ctrl+J), a two-line text
  // in one write, a second line beginning with the prompt glyph and one with `>`, a long
  // line that wraps, and three lines with a blank middle. Every later line of the person's
  // text is drawn at the continuation column, two; none at the prompt column. They stay as
  // documentation of the continuation column; a row break may stand for at most one space,
  // never a newline, so no multi-line text reads back — the delivery is one line, and
  // nothing types a multi-line text.
  test.each([
    ['typed-two-lines', 'first typed line of the sample\nsecond typed line of the sample'],
    ['pasted-two-lines', 'first pasted line of the sample\nsecond pasted line of the sample'],
    ['second-line-glyph', 'the reply follows\n› quoted line beginning with the prompt glyph'],
    ['second-line-gt', 'a plain reply follows\n> line beginning with a greater-than sign'],
    ['blank-middle', 'first line above the blank\n\nthird line below the blank'],
  ] as const)('%s reads unsent, and its multi-line text no longer reads back', (file, text) => {
    expect(readScreen('codex', fixture(file)).kind).toBe('unsent');
    expect(boxHoldsText('codex', text, fixture(file))).toBe(false);
  });
  test('wrapped-line reads unsent and holds exactly its one line', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
    expect(readScreen('codex', fixture('wrapped-line')).kind).toBe('unsent');
    expect(boxHoldsText('codex', text, fixture('wrapped-line'))).toBe(true);
    expect(boxHoldsText('codex', `${text} more`, fixture('wrapped-line'))).toBe(false);
  });
});

/** The captured idle frame once `text` sits in the box: the placeholder row replaced, the text's
 *  first line after the prompt, every later line at the column the captures draw continuation
 *  rows in — two columns, the prompt's own width (see the fixtures README). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('› Ask Codex to do anything', body);
}

// The rules message the real capture holds, as team composed it: its lines sat at column zero,
// and Codex drew each later line through its own prompt column (see the fixtures README).
const CAPTURED_MESSAGE = [
  'Rules for this session, from the team file:',
  '- Do not use tools or edit files.',
  '- Do not change trust or configuration.',
  '- Reply only RULES_RECEIVED, then wait.',
].join('\n');

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw, status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['codex'],
    now: () => clock, sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });
  test('a ready box drawn with » takes the line and the Enter', async () => {
    // The observed build's prompt glyph: the capture with `»` in place of `›`. The start, the
    // paste's read-back and the re-read before Enter all read the same composer, so the rules
    // are typed once and sent once, exactly as on the `›` screen.
    const d = delivery();
    const wideGlyph = (screen: string) => screen.replace(/^›/gm, '»');
    d.showText(wideGlyph(fixture('idle')));
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(wideGlyph(fixture('idle')).replace('» Ask Codex to do anything', `» ${text}`));
      return true;
    };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });
  test('a »-headed dialog is waited out and never typed into', async () => {
    // A dialog drawn with `»` rows matches none of the dialog stages, so it reads unknown and
    // `deliverRules` waits the deadline out and refuses: the wider prompt does not make a
    // dialog a ready box, and nothing is typed into it.
    const d = delivery();
    d.showText(fixture('permission-pinned').replace(/^›/gm, '»'));
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('screen');
  });
  test('the captured multi-line box is not the text any more: typed, not sent', async () => {
    // The real capture, with the message as team once composed it. A row break may stand for at
    // most one space, never the newline between the lines, so the box never verifies and the
    // Enter is never the delivery's to send.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', CAPTURED_MESSAGE, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_MESSAGE]);
    expect(d.refusals.at(-1)?.stop).toBe('read-back');
  });
  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a different first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a box whose rows are the typed line word-wrapped on the pane is entered', async () => {
    // No Codex capture shows its composer wrapping a line, so no wrap is modelled for it: the
    // box rows must read back as the typed line laid out in order — the words that fit, the rest
    // continued at the prompt row's two columns — and then the Enter is the paste's.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    expect(rows.length).toBeGreaterThan(1);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(rows.join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([line, 'Enter']);
  });
  test('a word-wrapped box with one character changed gets no Enter', async () => {
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const changed = line.replace('signature', 'signatvre');
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(wordWrap(changed, 53 - 2).join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a word-wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of the wrapped line: the pane draws one only where
    // the text itself has a blank line, and this line has none.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed([firstRow, '', ...rest].join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a blank line the typed text itself has is refused: a blank row is never the text\'s', async () => {
    // A blank row was the pane's drawing of a blank line the text had, when texts could hold
    // newlines. A row break may stand for at most one space, never a newline, so the blank row
    // never reads back and there is no Enter.
    const typed = 'Rules.\n\nMore rules.';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('codex', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });
  test('a trailing blank row after the word-wrapped line gets no Enter', async () => {
    // One empty row of the pane's own sits under the text — idle.txt and unsent.txt show it
    // between the text and the status line, and it is the box's frame, not content. A second
    // empty row is a row the text does not have: someone pressed a newline after it.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const body = [`› ${firstRow}`, ...rest.map((row) => `  ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('› Ask Codex to do anything', body);
    expect(boxHoldsText('codex', line, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('two spaces typed, one shown, gets no Enter', async () => {
    // The shared read refuses a box that shows a single space where the typed text has two: the
    // wrap did not add or drop it. Every profile without a captured wrap reads the same way.
    expect(boxHoldsText('codex', 'alpha  beta', boxed('alpha beta'))).toBe(false);
  });
  test.each(['permission', 'trust', 'startup', 'unsent', 'exit', 'working'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test('a vendor notice at the first frame is refused at once, not waited out', async () => {
    // The reading is the first read's, and the refusal follows it before any wait: without the
    // vendor-notice branch the loop would poll the same screen to the deadline and report the
    // same reading from there. No sleep, no text, no key.
    const d = delivery('startup');
    let naps = 0;
    const napping = d.io.sleep;
    d.io.sleep = async (ms) => { naps++; return napping(ms); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(naps).toBe(0);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.kind).toBe('vendor notice');
  });
  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working'); d.status('idle');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test.each(['trust', 'permission'])('a %s dialog appearing after paste gets no Enter', async (dialog) => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show(dialog); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test.each(['trust', 'permission'])('a %s dialog arriving at the final re-read gets no Enter', async (dialog) => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? dialog : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line appearing after paste gets no Enter', async () => {
    // Read before the fix: the dialog was `unsent` to both re-reads below, so the paste looked
    // submitted and the Enter went to the dialog's first choice.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('permission-pinned'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line arriving at the final re-read gets no Enter', async () => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'permission-pinned' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    }
  });
  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery(); let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
  });
});

describe('the prompt-glyph continuation row (Codex)', () => {
  // The person's box holds their own text, then a continuation row at the content column
  // carrying only the prompt glyph. The input row is the row carrying the prompt at the
  // captures' own column — unsent.txt draws `›` at the pane's first column and content at the
  // second — never the last row whose content begins with a glyph.
  const GLYPH = '›';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('codex', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `› Rules.`.
    expect(boxHoldsText('codex', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    // `› quoted` at the content column is one content row, not a second prompt row.
    expect(boxHoldsText('codex', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    // Two glyph rows: the person's text is above both, and the box stays unsent.
    expect(readScreen('codex', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('codex', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a second glyph row at the prompt column fails closed: never idle, never entered', async () => {
    // The 0.2.1 boundary: the person's text on the input row and a second row carrying the
    // prompt at that same column (column 0, where unsent.txt draws the input and exit-typed.txt
    // keeps its menu row). The input row is the first prompt row after the frame boundary above
    // the box; continuations are drawn indented — two columns — and the transcript's `› …` rows
    // keep a blank row above the input, so a prompt row after the input is a shape no capture
    // explains, and the read is `unknown`: nothing is typed into it and no Enter is sent. Read
    // by its lowest row the box was idle; the paste went after the second glyph, the read-back
    // held only the typed text, and the Enter submitted both.
    const at = (typed = '') => fixture('idle')
      .replace('› Ask Codex to do anything', `› person text\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('the box\'s top frame (Codex)', () => {
  // What every capture draws directly above the input row: blank rows of the pane's own — one
  // in exit-typed.txt (row 20 above `› /exit`), two in idle.txt and unsent.txt (rows 13-14) —
  // and above that gap the transcript's last row, whatever it is (idle.txt's `  limit left.`
  // prose, exit-typed.txt's own `/exit` menu row). No capture draws a prompt row against a
  // non-blank row, so the top frame is the gap itself: the input row is the lowest prompt row
  // above the status line, and the row above it must be blank.
  //
  // A prompt row on the far side of the gap is the transcript's echo of the person's own sent
  // message, not a row of the box: working.txt (row 12) and rules-accepted.txt (rows 10-13)
  // draw the echo `› Rules for this session…` at column zero with the spinner or the response
  // between it and the frame, and every row of a person's box is drawn indented — unsent.txt's
  // wrapped continuations at column two, exit-typed.txt's alike — so no row of a box carries
  // the glyph at the prompt column across the gap. Reading the echo as a live row made every
  // post-send idle seat `unknown`, a seat that could then never be dispatched to or nudged;
  // the empty input row under the frame reads `idle`, exactly as main reads it. Codex's
  // typed-newline captures (typed-two-lines.txt, pasted-two-lines.txt, second-line-glyph.txt,
  // second-line-gt.txt, wrapped-line.txt, blank-middle.txt — see the fixtures README)
  // prove the continuation column, two: every later row of the person's box is drawn indented,
  // even one that begins with the prompt glyph; none is drawn at the prompt column. No shipped
  // capture shows the direct echo layout — something always sits between the echo and the
  // frame — so the constructed screens below stand in for it.
  const shaped = (body: string) => fixture('idle').replace('› Ask Codex to do anything', body);

  test('the transcript\'s echo over the gap leaves the empty box idle, and the typed text reads back exactly', async () => {
    // The routine post-send layout: the person's sent message echoed at the prompt column, the
    // captured blank frame, the empty input row. It reads `idle` on every reader and rules
    // delivery types and enters; the read-back holds exactly the typed text.
    const at = (typed = '') => shaped(`› person text\n\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('idle');
    expect(classify('codex', at().split('\n')).kind).toBe('idle');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('idle');
    expect(readScreen('codex', at('Rules.')).kind).toBe('unsent');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(true);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('two and three blank rows above the input read the same', () => {
    for (const gap of ['\n\n\n', '\n\n\n\n']) {
      expect(readScreen('codex', shaped(`› person text${gap}›`)).kind).toBe('idle');
    }
  });

  test('agent output between the echo and the frame reads idle', () => {
    // rules-accepted.txt in full: the echo at rows 10-13, `• RULES_RECEIVED` and the timestamp
    // between it and the frame, the empty input row last. The real capture, read as it always
    // was, with the new rule taking nothing from it.
    expect(readScreen('codex', fixture('rules-accepted')).kind).toBe('idle');
  });

  test('a second prompt row pressed against the one above it fails closed', async () => {
    // Round 1's must-fix, unchanged: no blank row separates the person's row from the later
    // prompt, so the row above the lowest prompt is not the frame and the input row cannot be
    // shown to be the box's top. Nothing is typed and Enter is not sent.
    const at = (typed = '') => shaped(`› person text\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a blank row, a continuation row, then a prompt fails closed', () => {
    // Nothing between the person's first row and the later prompt explains it: the row the
    // captures draw directly above an input row is blank, and this one carries content.
    const at = shaped('› person text\n\n  more of theirs\n›');
    expect(readScreen('codex', at).kind).toBe('unknown');
    expect(classifyComposer('codex', at.split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', shaped('› person text\n\n  more of theirs\n› Rules.'))).toBe(false);
  });

  test('a window starting inside the box fails closed', async () => {
    // The reviewer's second must-fix: the input row scrolled out, a visible indented
    // continuation, then `›`. Read from the lowest prompt row the box was idle; the rows
    // above it — a continuation the captures only draw inside a box — were discarded. The
    // row directly above the prompt is not blank here, so it is not an input row.
    const at = (typed = '') => shaped(`  person-owned visible continuation\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a window whose top frame scrolled off reads unknown', () => {
    // Only the prompt and the status line visible: the gap every capture draws above the
    // input row is not in the window, so the row cannot be shown to be the box's top — it
    // may be a caret line of a box whose first rows scrolled off. No real idle/unsent
    // capture is this shape: every one keeps the status line last with the box under its
    // transcript, so the crop never starts at the prompt.
    const lines = fixture('idle').split('\n');
    const at = lines.findIndex((line) => line === '› Ask Codex to do anything');
    const only = lines.slice(at).join('\n');
    expect(readScreen('codex', only).kind).toBe('unknown');
    const held = only.replace('› Ask Codex to do anything', '› Rules.');
    expect(readScreen('codex', held).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', held)).toBe(false);
  });

  test('the real exit-typed capture keeps its box: its menu row sits above the frame, not in the box', () => {
    // The guard the two must-fixes must not break: exit-typed.txt draws `› /exit  exit Codex`
    // (the menu), a blank row, then `› /exit` — the same prompt-blank-prompt shape the
    // constructed must-fixes use, but the lowest prompt row holds the person's text, so it is
    // the input row and the menu row above the frame is read as nothing.
    const screen = fixture('exit-typed');
    expect(readScreen('codex', screen).kind).toBe('unsent');
    expect(boxHoldsText('codex', '/exit', screen)).toBe(true);
    expect(boxHoldsText('codex', 'Rules.', screen)).toBe(false);
  });
});

// The captures taken on 2026-10-05 at 54 by 23, the pane `up` creates (codex-cli 0.160.0, the
// flags the fixtures README names). The captures of the whole message stay as documentation
// of the box's own limits; the delivery itself is the one line of rules-line.txt.
const capture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.160.0/${name}.txt`, import.meta.url), 'utf8');

/** The fitted texts these captures were typed with: numbered rows of a sample line, one row
 *  per drawn row at the pane's 50 content columns. */
const fitted = (rows: number) => Array.from({ length: rows }, (_, i) => `row ${i + 1} of the fitted sample text`).join('\n');

/** A box Codex draws for `text` at those 50 columns: the line word-wrapped, the first row after
 *  the prompt, the rest at the two-column continuation column (the typed-newline captures). */
function drawn(text: string): string {
  const [first = '', ...rest] = wordWrap(text, 50);
  return [`› ${first}`, ...rest.map((row) => `  ${row}`)].join('\n');
}

test('the box limits: 16 rows read back, 17 and more read unknown', () => {
  // rules-fit-16.txt is the tallest box whose input row, frame and status row all fit the
  // reading window; from 17 rows the window starts at the input row itself and the core reads
  // unknown, however complete the screen looks (rules-fit-17.txt) — and at 19 the pane's own
  // scroll begins (rules-fit-19.txt is complete but unknown, rules-fit-20.txt has dropped its
  // first typed row). The whole rules message drew 30 rows at 50 columns (rules-scrolled.txt),
  // which is why the rules now travel as a file and one line.
  for (const rows of [5, 12, 16]) {
    expect(readScreen('codex', capture(`rules-fit-${rows}`)).kind).toBe('unsent');
  }
  for (const rows of [17, 19, 20]) {
    expect(readScreen('codex', capture(`rules-fit-${rows}`)).kind).toBe('unknown');
  }
  expect(readScreen('codex', capture('rules-scrolled')).kind).toBe('unknown');
  // The fitted texts are multi-line, and a row break may stand for at most one space, never
  // a newline: no multi-line text reads back at any height, and nothing types one. The
  // captures stay as documentation of the window's edge.
  for (const rows of [5, 12, 16, 17, 19, 20]) {
    expect(boxHoldsText('codex', fitted(rows), capture(`rules-fit-${rows}`))).toBe(false);
  }
  expect(boxHoldsText('codex', SAMPLE_RULES, capture('rules-scrolled'))).toBe(false);
  // A pane after a sent and answered turn reads the same (rules-part-16-after-reply.txt).
  expect(readScreen('codex', capture('rules-part-16-after-reply')).kind).toBe('unsent');
  expect(boxHoldsText('codex', fitted(16), capture('rules-part-16-after-reply'))).toBe(false);
});

// The line the 2026-10-05 capture holds, as `team` composes it: the same path and hash the
// fixtures README names, through the function that builds it. The box draws it as four rows,
// word-wrapped; the breaks after `your` and `and` each hide the line's own single space.
const CAPTURED_PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md';
const capturedLine = rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f');

/** A Codex pane 54 by 23 that answers the typed line with the real capture and a submitted line
 *  like the captured turn: the turn paints the pane while it runs. */
function lineDelivery() {
  let raw = capture('idle');
  let status = 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    type(text) {
      calls.push(text);
      raw = text === capturedLine ? capture('rules-line') : drawn(text);
      return true;
    },
    enter() {
      calls.push('Enter');
      raw = fixture('working');
      status = 'working';
      return true;
    },
    foreground: () => ['codex'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery of the one line (0.160.0 capture)', () => {
  test('the captured line reads unsent and holds exactly the line', () => {
    const screen = capture('rules-line');
    expect(readScreen('codex', screen).kind).toBe('unsent');
    expect(boxHoldsText('codex', capturedLine, screen)).toBe(true);
    // Anything the seat might hold instead: one character more, the line without its final
    // full stop, another seat's path, an older hash of the same rules.
    expect(boxHoldsText('codex', `${capturedLine} again`, screen)).toBe(false);
    expect(boxHoldsText('codex', capturedLine.slice(0, -1), screen)).toBe(false);
    expect(boxHoldsText('codex', rulesLine(CAPTURED_PATH.replace('implementer', 'scribe'), '5e1d0a9c4b2f'), screen)).toBe(false);
    expect(boxHoldsText('codex', rulesLine(CAPTURED_PATH, '4d0c9f8b3a2e'), screen)).toBe(false);
  });

  test('the line is typed once at an empty prompt, read back row by row, and entered once', async () => {
    const d = lineDelivery();
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test.each([
    ['in the path', ['3f9c2a8e1d7b', '3f9c2a8e1d7c']],
    ['in the hash', ['5e1d0a9c4b2f', '5e1d0a9c4b2e']],
    ['in a word of the line', ['standing rules', 'stunding rules']],
    ['in the final full stop', ['wait for your brief.', 'wait for your brief!']],
  ] as const)('one character changed %s gets no Enter', async (what, [from, to]) => {
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line').replace(from, to)); return true; };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.typed).toBe(true);
    expect(why?.sent).toBe(false);
    expect(why?.row).not.toBeNull();
    expect(refusalReport(why!)).toContain("the read-back didn't match");
  });

  test('a row of the line with one character more than the line has gets no Enter', async () => {
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line').replace('wait for your brief.', 'wait for your brief. x')); return true; };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
  });

  test('the line with one character more than the box shows gets no Enter', async () => {
    // The other way round: the box draws the line's own four rows, and the text claims a
    // fifth the pane never drew.
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', `${capturedLine} x`, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([`${capturedLine} x`]);
  });

  test('two spaces in the line where the row break hides one get no Enter', async () => {
    // The captured break after `your` hides the line's single space. A line with two spaces
    // there draws the same rows — the read-back refuses it: a break may stand for exactly one
    // space, never a run of them.
    const doubled = capturedLine.replace('your standing', 'your  standing');
    expect(boxHoldsText('codex', doubled, capture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', doubled, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([doubled]);
  });

  test('a tab in the line gets no Enter', async () => {
    const tabbed = capturedLine.replace('Read ', 'Read\t');
    expect(boxHoldsText('codex', tabbed, capture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', tabbed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([tabbed]);
  });

  test('a trust dialog at the final re-read gets no Enter', async () => {
    // The other way round: the line reads back in the loop, and the re-read that immediately
    // precedes the Enter sees the dialog. Without that re-read the Enter goes to the dialog's
    // first choice.
    const d = lineDelivery();
    d.io.type = (text) => {
      d.calls.push(text);
      let reads = 0;
      d.io.screen = () => (++reads <= 1 ? capture('rules-line') : fixture('trust'));
      return true;
    };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.sent).toBe(false);
    expect(why?.kind).toBe('trust');
  });

  test('the file changing after it was written gets no Enter', async () => {
    // The line read back as its own rows; between that and the key, the file at its path no
    // longer holds the text whose hash the line names. Nothing is sent, and the report says
    // the file changed — the seat is never pointed at a file team cannot vouch for.
    const d = lineDelivery();
    d.io.file = () => false;
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('file-changed');
    expect(why?.sent).toBe(false);
    expect(refusalReport(why!)).toBe('rules typed, not sent: the rules file changed after it was written');
  });

  test('a seat mid-turn is reported as working; nothing is typed', async () => {
    const d = lineDelivery();
    d.status('working');
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('working');
    expect(refusalReport(why!)).toBe('rules not confirmed: the seat is working; run up again when it is idle');
  });

  test('a box already holding the person\'s own text is left alone', async () => {
    const d = lineDelivery();
    d.show(capture('idle').replace('› Ask Codex to do anything', drawn('the person\'s own message')));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('leftover');
    expect(refusalReport(why!)).toContain('its box already holds text that is not the rules line');
  });

  test('a resumed seat whose box already holds the line is verified and entered, never typed onto', async () => {
    const d = lineDelivery();
    d.show(capture('rules-line'));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Enter']);
  });

  test('a resumed seat whose box holds another seat\'s line is refused, nothing typed', async () => {
    const d = lineDelivery();
    d.show(capture('rules-line').replace('implementer', 'scribe'));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('leftover');
  });

  test('a resumed seat with an empty box is typed once, verified and sent', async () => {
    const d = lineDelivery();
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });
});

const tempPolicyDirs: string[] = [];
afterEach(() => {
  for (const dir of tempPolicyDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type PolicyLaunchScene = {
  base: string;
  root: string;
  home: string;
  teamFile: string;
  agentId: string;
};

function makePolicyLaunchScene(): PolicyLaunchScene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-policy-launch-')));
  tempPolicyDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const agentsFolder = join(root, '.agents');
  mkdirSync(agentsFolder, { recursive: true });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(
    entitiesPath(home),
    `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const teamFile = join(agentsFolder, 'team.yaml');
  writeFileSync(
    teamFile,
    `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus 4.7
    version: "4.7"
    launch: claude
  - role: implementer
    name: coder
    cli: codex
    vendor: openai
    model: GPT 6 Sol
    version: "6"
    launch: codex -m gpt-6-sol
`,
  );
  const agent = registerAgent(home, {
    name: 'coder',
    signing: { model: 'GPT 6 Sol', version: '6', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    reach: {
      team: teamIdOf(root),
      seat: 'coder',
      session: 'acme',
      agent_session: '019a0000-1111-7222-8333-444455556666',
      pane: 'w1:p2',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  return { base, root, home, teamFile, agentId: agent.id };
}

function signedPolicyDiskEntry(
  home: string,
  level: PolicyLevel,
  target: string,
  name: string,
  value: YamlValue,
  tamperSignature = false,
): Record<string, YamlValue> {
  const key = keyOf(home);
  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const now = new Date('2026-10-19T12:00:00.000Z');
  const generation = bumpGeneration(folder, home, now);
  const date = now.toISOString();
  const payload = policySignaturePayload({
    name,
    value: value as string,
    level,
    target,
    setter: 'owner',
    date,
    expiry: null,
    kind: 'enforced',
    generation,
  });
  const sig = signDomain(POLICY_DOMAIN, payload, key);
  return {
    value,
    setter: 'owner',
    date,
    expiry: null,
    kind: 'enforced',
    target,
    generation,
    signature: tamperSignature ? `${sig.slice(0, -4)}AAAA` : sig,
  };
}

function writeEntityCodexDaemon(
  scene: PolicyLaunchScene,
  value: YamlValue,
  options: { name?: string; tamperSignature?: boolean } = {},
): void {
  const name = options.name ?? 'codex-daemon';
  const entry = signedPolicyDiskEntry(scene.home, 'entity', 'floor', name, value, options.tamperSignature);
  const path = entitiesPath(scene.home);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    'floor:',
    '  roots:',
    `    - ${JSON.stringify(scene.base)}`,
    '  policies:',
    `    ${JSON.stringify(name)}:`,
    ...Object.entries(entry).map(([k, v]) => `      ${k}: ${v === null ? 'null' : JSON.stringify(v)}`),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function writeProjectCodexDaemon(
  scene: PolicyLaunchScene,
  value: YamlValue,
  options: { name?: string; tamperSignature?: boolean } = {},
): void {
  const name = options.name ?? 'codex-daemon';
  const entry = signedPolicyDiskEntry(scene.home, 'project', 'acme', name, value, options.tamperSignature);
  upsertProject(scene.home, 'acme', {
    name: 'acme',
    entity: 'floor',
    policies: { [name]: entry },
    by: 'owner',
  });
}

function writeTeamCodexDaemon(
  scene: PolicyLaunchScene,
  value: YamlValue,
  options: { name?: string; tamperSignature?: boolean } = {},
): void {
  const name = options.name ?? 'codex-daemon';
  const entry = signedPolicyDiskEntry(scene.home, 'team', teamIdOf(scene.root), name, value, options.tamperSignature);
  const current = readFileSync(scene.teamFile, 'utf8').replace(/\npolicies:\n[\s\S]*$/, '\n');
  const policyLines = [
    'policies:',
    `  ${JSON.stringify(name)}:`,
    ...Object.entries(entry).map(([k, v]) => `    ${k}: ${v === null ? 'null' : JSON.stringify(v)}`),
  ];
  writeFileSync(scene.teamFile, `${current}${policyLines.join('\n')}\n`);
}

function writeSeatCodexDaemon(
  scene: PolicyLaunchScene,
  value: YamlValue,
  options: { name?: string; tamperSignature?: boolean } = {},
): void {
  const name = options.name ?? 'codex-daemon';
  const entry = signedPolicyDiskEntry(scene.home, 'seat', scene.agentId, name, value, options.tamperSignature);
  updateAgent(scene.home, scene.agentId, {
    policies: { [name]: entry },
  });
}

function plannedCodexLaunchLine(scene: PolicyLaunchScene): string {
  const plan = upPlan({
    root: scene.root,
    home: scene.home,
    session: 'acme',
    sessionRunning: true,
    watchAlive: true,
    watchLabel: 'Watch · acme',
    teamFile: scene.teamFile,
    seats: [
      {
        name: 'coder',
        cli: 'codex',
        launch: 'codex -m gpt-6-sol',
        cwd: scene.root,
        label: 'coder',
        stopped: false,
        rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
      },
    ],
  });
  const launch = plan.find((step) => step.do?.do === 'launch');
  return launch?.kind === 'run' ? launch.argv.at(-1) ?? '' : '';
}

describe('Codex launch policy (codex-daemon on | off across 4 signed levels in upPlan)', () => {
  test('default (on) launches codex without --no-daemon when no signed policy overrides it', () => {
    const scene = makePolicyLaunchScene();
    const resolved = resolveCodexDaemonPolicy({
      home: scene.home,
      root: scene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: 'on',
      level: 'default',
      refusals: [],
    });
    const command = plannedCodexLaunchLine(scene);
    expect(command).toContain('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-alt-screen');
    expect(command).not.toContain('--no-daemon');
  });

  test.each(['entity', 'project', 'team', 'seat'] as const)(
    'signed codex-daemon: off at %s level reinjects --no-daemon in upPlan without manual option injection',
    (level) => {
      const scene = makePolicyLaunchScene();
      if (level === 'entity') writeEntityCodexDaemon(scene, 'off');
      if (level === 'project') writeProjectCodexDaemon(scene, 'off');
      if (level === 'team') writeTeamCodexDaemon(scene, 'off');
      if (level === 'seat') writeSeatCodexDaemon(scene, 'off');

      const resolved = resolveCodexDaemonPolicy({
        home: scene.home,
        root: scene.root,
        seat: 'coder',
        session: 'acme',
      });
      expect(resolved.ok).toBe(true);
      expect(resolved.value).toBe('off');
      if (resolved.ok) {
        expect(resolved.level).toBe(level);
      }

      const command = plannedCodexLaunchLine(scene);
      expect(command).toContain(
        'AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-daemon --no-alt-screen',
      );
    },
  );

  test('accepts snake_case codex_daemon alias and blocks lower-level on when higher level is off', () => {
    const aliasScene = makePolicyLaunchScene();
    writeTeamCodexDaemon(aliasScene, 'off', { name: 'codex_daemon' });
    expect(plannedCodexLaunchLine(aliasScene)).toContain('--no-daemon');

    const tightenScene = makePolicyLaunchScene();
    writeEntityCodexDaemon(tightenScene, 'on');
    writeSeatCodexDaemon(tightenScene, 'off');
    const tightened = resolveCodexDaemonPolicy({
      home: tightenScene.home,
      root: tightenScene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(tightened.ok).toBe(true);
    expect(tightened.value).toBe('off');
    if (tightened.ok) {
      expect(tightened.level).toBe('seat');
    }
    expect(plannedCodexLaunchLine(tightenScene)).toContain('--no-daemon');

    const reopenScene = makePolicyLaunchScene();
    writeEntityCodexDaemon(reopenScene, 'off');
    writeTeamCodexDaemon(reopenScene, 'on');
    const reopened = resolveCodexDaemonPolicy({
      home: reopenScene.home,
      root: reopenScene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(reopened.ok).toBe(false);
    expect(reopened.value).toBe('off');
    if (!reopened.ok) {
      expect(reopened.why).toContain('loosens level');
    }
    expect(plannedCodexLaunchLine(reopenScene)).toContain('--no-daemon');
  });

  test('invalid signature, invalid policy value, missing context, or unreadable policy YAML fails closed with --no-daemon on launch', () => {
    const tamperedScene = makePolicyLaunchScene();
    writeTeamCodexDaemon(tamperedScene, 'on', { tamperSignature: true });
    const tampered = resolveCodexDaemonPolicy({
      home: tamperedScene.home,
      root: tamperedScene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.value).toBe('off');
    if (!tampered.ok) {
      expect(tampered.why).toContain('signature verification failed');
    }
    expect(plannedCodexLaunchLine(tamperedScene)).toContain('--no-daemon');

    const badValueScene = makePolicyLaunchScene();
    writeSeatCodexDaemon(badValueScene, 'maybe');
    const badValue = resolveCodexDaemonPolicy({
      home: badValueScene.home,
      root: badValueScene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(badValue.ok).toBe(false);
    expect(badValue.value).toBe('off');
    expect(plannedCodexLaunchLine(badValueScene)).toContain('--no-daemon');

    const corruptScene = makePolicyLaunchScene();
    const entitiesFile = entitiesPath(corruptScene.home);
    mkdirSync(dirname(entitiesFile), { recursive: true });
    writeFileSync(entitiesFile, 'floor:\n  policies: "not-a-map"\n');
    const corrupt = resolveCodexDaemonPolicy({
      home: corruptScene.home,
      root: corruptScene.root,
      seat: 'coder',
      session: 'acme',
    });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.value).toBe('off');
    expect(plannedCodexLaunchLine(corruptScene)).toContain('--no-daemon');

    const missingContext = resolveCodexDaemonPolicy({
      home: tamperedScene.home,
    });
    expect(missingContext.ok).toBe(false);
    expect(missingContext.value).toBe('off');
  });
});

/** A Codex pane 54 by 23 that answers Enter as a submit the CLI may not take: `takes(enters)`
 *  says which press it accepts; until then the line stays in the box, as an unsent submit. */
function submitRetryDelivery(takes: (enters: number) => boolean) {
  let raw = capture('idle');
  let status = 'idle';
  let clock = 0;
  let presses = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true,
    type(text) {
      calls.push(text);
      raw = capture('rules-line');
      return true;
    },
    enter() {
      calls.push('Enter');
      presses += 1;
      if (takes(presses)) {
        raw = fixture('working');
        status = 'working';
      }
      return true;
    },
    foreground: () => ['codex'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return {
    io, calls, refusals,
    presses: () => presses,
    show: (screen: string) => { raw = screen; },
    status: (value: string) => { status = value; },
  };
}

describe('Codex rules delivery retries a submit the CLI did not take', () => {
  test('the second Enter is accepted; the line is typed once and every retry still waits for the acknowledgement', async () => {
    const d = submitRetryDelivery((enters) => enters >= 2);
    expect(await deliverRules('codex', capturedLine, 30, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter', 'Enter']);
  });

  test('the third Enter is the last try, and it can be the one accepted', async () => {
    const d = submitRetryDelivery((enters) => enters >= RULES_ENTER_TRIES);
    expect(await deliverRules('codex', capturedLine, 30, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, ...Array<string>(RULES_ENTER_TRIES).fill('Enter')]);
    expect(d.presses()).toBe(RULES_ENTER_TRIES);
  });

  test('three Enters the CLI does not take end the delivery: the line sits unsent, and the report says so', async () => {
    const d = submitRetryDelivery(() => false);
    expect(await deliverRules('codex', capturedLine, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine, ...Array<string>(RULES_ENTER_TRIES).fill('Enter')]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('ack');
    expect(why?.typed).toBe(true);
    expect(why?.sent).toBe(true);
    expect(why?.kind).toBe('unsent');
    expect(refusalReport(why!)).toBe(
      'rules typed, not sent: its box still holds the line after Enter; '
      + 'press Enter in its pane to send it, or clear the box (Ctrl+U), then run up again',
    );
  });

  test('no retry ever types the line again', async () => {
    const d = submitRetryDelivery(() => false);
    await deliverRules('codex', capturedLine, 30, d.io);
    expect(d.calls.filter((call) => call !== 'Enter')).toEqual([capturedLine]);
  });

  // Each of these changes the world after the first Enter did not take: the retry's gates read
  // the change, and the next key is never pressed.
  test.each([
    ['the box text changed', (d: ReturnType<typeof submitRetryDelivery>) => d.show(capture('rules-line').replace('wait for your brief.', 'wait for your brief!')), 'unsent', false],
    ['a dialog appeared', (d: ReturnType<typeof submitRetryDelivery>) => d.show(fixture('trust')), 'trust', false],
    ['the seat went busy', (d: ReturnType<typeof submitRetryDelivery>) => d.status('working'), 'unsent', false],
    ['the rules file moved', (d: ReturnType<typeof submitRetryDelivery>) => { d.io.file = () => false; }, 'unsent', false],
    ['the launched CLI lost the foreground', (d: ReturnType<typeof submitRetryDelivery>) => { d.io.foreground = () => ['zsh']; }, 'none', 'no-agent'],
  ] as const)('after a failed Enter, %s: no second Enter', async (_what, change, kind, outcome) => {
    const d = submitRetryDelivery(() => false);
    const plain = d.io.enter;
    d.io.enter = () => { const taken = plain(); change(d); return taken; };
    const delivered = await deliverRules('codex', capturedLine, 30, d.io);
    if (outcome === 'no-agent') {
      expect(delivered).toBe('no-agent');
      expect(d.refusals).toEqual([]);
    } else {
      expect(delivered).toBe(false);
      const why = d.refusals.at(-1);
      expect(why?.stop).toBe('ack');
      if (kind !== 'none') expect(why?.kind).toBe(kind);
    }
    expect(d.calls).toEqual([capturedLine, 'Enter']);
    expect(d.presses()).toBe(1);
  });

  test('a box that changed reads as its own reading, not as the line still sitting in it', async () => {
    const d = submitRetryDelivery(() => false);
    const plain = d.io.enter;
    d.io.enter = () => { const taken = plain(); d.show(capture('rules-line').replace('wait for your brief.', 'wait for your brief!')); return taken; };
    await deliverRules('codex', capturedLine, 30, d.io);
    expect(refusalReport(d.refusals.at(-1)!)).toBe(
      'the seat did not come back to its idle prompt (unsent); read its box, then run up again',
    );
  });

  test('the caller\'s check before the key is asked before each retry, and a refusal presses nothing', async () => {
    const d = submitRetryDelivery(() => false);
    const asked: string[] = [];
    d.io.beforeInput = (action) => {
      asked.push(action);
      return asked.filter((entry) => entry === 'enter').length < 2;
    };
    expect(await deliverRules('codex', capturedLine, 30, d.io)).toBe(false);
    expect(asked).toEqual(['type', 'enter', 'enter']);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });
});
