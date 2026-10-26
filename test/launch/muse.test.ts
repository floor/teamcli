// The muse CLI's launch line and its captured screens (1.4.9). This pins what the profile
// (src/profiles/muse.yaml) makes of the captures under test/fixtures/muse/1.4.9 — how each reads,
// how status_model reads the footer, the quota patterns on the `/usage` box, and that process
// names cut to 15 bytes still name the CLI — and that `up` launches muse with --yolo and delivers
// its rules as the first message.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { walkCaller } from '../../src/caller.ts';
import { CLI_PROCESSES, processNameMatches } from '../../src/clis.ts';
import { reportedLiveAgent } from '../../src/launch/agent.ts';
import { paneStillRunning } from '../../src/commands/down.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { figuresOf } from '../../src/profiles/quota.ts';
import {
  launchCommand,
  quotaFor,
  resolveEffortOverride,
  resolveModelOverride,
  withLaunchOverrides,
} from '../../src/profiles/profile.ts';
import { boxHoldsText, deliverRules, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { rulesLine } from '../../src/launch/rules-file.ts';
import { classifyComposer, readBox, readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/muse/1.4.9/${name}.txt`, import.meta.url), 'utf8');
const fixture1411 = (name: string) => readFileSync(new URL(`../fixtures/muse/1.4.11/${name}.txt`, import.meta.url), 'utf8');

const muse = profileFor('muse');
if (!muse) throw new Error('muse has no profile');

describe('muse launch and captured screens', () => {
  test('--yolo rides the launch line, rules are the first message, and the seat reads its own shape', () => {
    expect(launchCommand(muse, 'muse --model muse-wonder-1.0 --effort high', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 muse --model muse-wonder-1.0 --effort high --yolo',
    );
    expect(launchCommand(muse, 'muse --yolo', 'Rules.')).toBe('AGENT_UNATTENDED=1 muse --yolo');
    expect(muse.rulesOption).toBeNull();
    expect(muse.loginCheck).toBeNull();
    expect(muse.loginHint).toBe('muse login');
    expect(muse.exit).toBe('/exit');
    expect(muse.exitClear).toBe('ctrl+u');
    expect(muse.exitConfirm).toBeNull();
    expect(muse.idleTimeout).toBe(90);
    expect(muse.exitTimeout).toBe(30);
    expect(muse.processNames).toEqual(['muse', 'muse-bin-*']);
    expect(muse.binary).toBe('muse');
  });

  test('model ids map to the model and version, with or without the contributor route', () => {
    expect(muse.modelOf('muse --model muse-wonder-1.0')).toEqual({ model: 'Muse Wonder', version: '1.0' });
    expect(muse.modelOf('muse --model muse-wonder-full-1.0')).toEqual({ model: 'Muse Wonder Full', version: '1.0' });
    expect(muse.modelOf('muse --model muse-spark-1.3')).toEqual({ model: 'Muse Spark', version: '1.3' });
    expect(muse.modelOf('muse --model muse-spark-1.2')).toEqual({ model: 'Muse Spark', version: '1.2' });
    expect(muse.modelOf('muse --model muse-wonder-1.0-contributor')).toEqual({ model: 'Muse Wonder', version: '1.0' });
    expect(muse.modelOf('muse --model=muse-spark-1.3')).toEqual({ model: 'Muse Spark', version: '1.3' });
    expect(muse.modelOf('muse')).toBeNull();
    expect(muse.modelOf('muse --model echo')).toBeNull();
    // muse has no short model flag: `-m` names nothing.
    expect(muse.modelOf('muse -m muse-wonder-1.0')).toBeNull();

    expect(resolveModelOverride(muse, 'Muse Wonder 1.0')).toEqual({ id: 'muse-wonder-1.0', model: 'Muse Wonder', version: '1.0' });
    expect(resolveModelOverride(muse, 'Muse Wonder Full 1.0')).toEqual({
      id: 'muse-wonder-full-1.0',
      model: 'Muse Wonder Full',
      version: '1.0',
    });
    expect(resolveModelOverride(muse, 'Muse Spark 1.3')).toEqual({ id: 'muse-spark-1.3', model: 'Muse Spark', version: '1.3' });
    expect(withLaunchOverrides(muse, 'muse --yolo', { modelId: 'muse-spark-1.3' })).toBe('muse --yolo --model muse-spark-1.3');
    expect(withLaunchOverrides(muse, 'muse --model muse-wonder-1.0', { modelId: 'muse-spark-1.3' })).toBe(
      'muse --model muse-spark-1.3',
    );
    expect(withLaunchOverrides(muse, 'muse --model muse-wonder-1.0', { effort: 'max' })).toBe(
      'muse --model muse-wonder-1.0 --effort max',
    );
    expect(withLaunchOverrides(muse, 'muse --effort high', { effort: 'xhigh' })).toBe('muse --effort xhigh');
  });

  test("the meta lab's effort words are checked for a muse seat", () => {
    for (const word of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(resolveEffortOverride('muse', 'meta', word)).toEqual({ effort: word });
    }
    expect(resolveEffortOverride('muse', 'meta', 'turbo')).toEqual({
      error: "effort \"turbo\" is not one of meta's: minimal, low, medium, high, xhigh, max",
    });
  });

  test.each([
    ['idle', 'idle', 'idle'],
    ['idle-footer', 'idle', 'idle'],
    ['unsent', 'unsent', 'unsent'],
    ['working', 'working', 'idle'],
    ['permission', 'permission', 'unknown'],
    ['model-picker', 'question', 'unknown'],
    ['trust', 'trust', 'unknown'],
    ['usage', 'idle', 'idle'],
    ['usage-unavailable', 'idle', 'idle'],
  ] as const)('%s reads %s, its composer %s', (file, kind, composer) => {
    const text = fixture(file);
    expect(readScreen('muse', text).kind).toBe(kind);
    expect(classifyComposer('muse', text.split('\n')).kind).toBe(composer);
  });

  test.each([
    ['idle', 'idle', 'idle'],
    ['working-synthetic', 'working', 'idle'],
    ['unsent-synthetic', 'unsent', 'unsent'],
    ['ambiguous-synthetic', 'unknown', 'unknown'],
    ['rules-line-unsent', 'unsent', 'unsent'],
    ['placeholder-synthetic', 'idle', 'idle'],
  ] as const)('1.4.11 %s reads %s, its composer %s', (file, kind, composer) => {
    const text = fixture1411(file);
    expect(readScreen('muse', text).kind).toBe(kind);
    expect(classifyComposer('muse', text.split('\n')).kind).toBe(composer);
  });

  test('the 1.4.11 ready footer names Wonder Full, and the tested range carries it', () => {
    expect(muse.tested).toEqual({ from: '1.4.9', to: '1.4.11' });
    expect(runningModel('muse', fixture1411('idle'))).toEqual({ model: 'Muse Wonder Full', version: '1.0' });
    expect(boxHoldsText('muse', 'anything', fixture1411('idle'))).toBe(false);
  });

  test('status_model reads the model off the footer row, and nothing off a screen without one', () => {
    for (const file of ['idle', 'idle-footer', 'unsent', 'permission', 'usage', 'usage-unavailable'] as const) {
      expect(runningModel('muse', fixture(file)), file).toEqual({ model: 'Muse Wonder', version: '1.0' });
    }
    // The echo-provider run's footer names `echo`, not a model.
    expect(runningModel('muse', fixture('working'))).toBeNull();
    for (const file of ['trust', 'model-picker'] as const) {
      expect(runningModel('muse', fixture(file)), file).toBeNull();
    }
    const footer = (id: string) => `${'─'.repeat(53)}\n❯\n${'─'.repeat(53)}\n  ${id} · high · …/muse-ws · Auto-review\n`;
    expect(runningModel('muse', footer('muse-wonder-full-1.0'))).toEqual({ model: 'Muse Wonder Full', version: '1.0' });
    expect(runningModel('muse', footer('muse-spark-1.3'))).toEqual({ model: 'Muse Spark', version: '1.3' });
    expect(runningModel('muse', footer('muse-spark-1.2'))).toEqual({ model: 'Muse Spark', version: '1.2' });
  });

  test('Wonder Full 1.0 and Wonder 1.0 each read as themselves, on the launch line and on the footer', () => {
    expect(muse.modelOf('muse --model muse-wonder-full-1.0 --effort high --yolo')).toEqual({ model: 'Muse Wonder Full', version: '1.0' });
    expect(runningModel('muse', fixture('wonder-full-constructed'))).toEqual({ model: 'Muse Wonder Full', version: '1.0' });
    expect(muse.modelOf('muse --model muse-wonder-1.0 --effort high --yolo')).toEqual({ model: 'Muse Wonder', version: '1.0' });
    expect(runningModel('muse', fixture('idle'))).toEqual({ model: 'Muse Wonder', version: '1.0' });
    // Wonder is never read off a Wonder Full footer, nor the reverse.
    expect(runningModel('muse', fixture('wonder-full-constructed'))?.model).not.toBe('Muse Wonder');
    expect(runningModel('muse', fixture('idle'))?.model).not.toBe('Muse Wonder Full');
  });

  test('a wrapped text reads back from the box, and a different one does not', () => {
    const wrapped = 'Team watch: reports are waiting in .agents/team.log';
    expect(boxHoldsText('muse', wrapped, fixture('unsent'))).toBe(true);
    expect(boxHoldsText('muse', `${wrapped}!`, fixture('unsent'))).toBe(false);
    expect(boxHoldsText('muse', 'anything', fixture('idle'))).toBe(false);
  });

  test('the captured 1.4.11 post-Enter frame is a line not submitted: its trailing empty row is a typed newline, never an exact read-back', () => {
    const line = rulesLine('/Users/example/.config/team/demo-3f9c2a8e1d7b/rules/builder-6.md', '68952ad875fc');
    const text = fixture1411('rules-line-unsent');
    // The authorized capture is the box after Enter on a 1.4.11 pane: the key inserted a typed
    // newline instead of submitting, and the line is still there. The trailing empty row is a
    // row of the text, not the box's frame, so the box is not the line alone.
    expect(readBox('muse', text)).toMatchObject({ first: line, indent: 2, rows: [''] });
    expect(boxHoldsText('muse', line, text)).toBe(false);
  });

  test('the captured 1.4.11 pre-Enter frame reads back its wrapped line, and altered text does not', () => {
    // A scratch 1.4.11 session (echo provider) with a rules line typed into its own box and no
    // key yet pressed: the box draws the line's wrapped rows, and nothing under them.
    const line = 'Read /home/owner/.config/team/demo-3f9c2a8e1d7b/ rules/builder-5.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.';
    const text = fixture1411('typed-before-enter');
    expect(readScreen('muse', text).kind).toBe('unsent');
    expect(boxHoldsText('muse', line, text)).toBe(true);
    expect(boxHoldsText('muse', `${line}!`, text)).toBe(false);
    expect(boxHoldsText('muse', line.replace('reply ready', 'reply now'), text)).toBe(false);
  });

  test('the captured 1.4.11 placeholder is the empty box, never a draft to send', () => {
    const text = fixture1411('placeholder-synthetic');
    expect(readScreen('muse', text).kind).toBe('idle');
    expect(classifyComposer('muse', text.split('\n')).kind).toBe('idle');
    expect(readBox('muse', text)).toBeNull();
    expect(boxHoldsText('muse', 'Tab queues or steers while a run is active', text)).toBe(false);
  });

  test('the quota patterns read the 5-hour and weekly windows off the /usage box lines', () => {
    const patterns = quotaFor('muse');
    expect(patterns.map((pattern) => [pattern.account, pattern.window])).toEqual([
      ['meta', 'session'],
      ['meta', 'weekly'],
    ]);
    const rows = fixture('usage')
      .split('\n')
      .filter((line) => /(Current|Weekly)\s+[0-9]+% used/.test(line));
    expect(rows).toHaveLength(2);
    expect(figuresOf(patterns, rows[0] as string)).toEqual([{ account: 'meta', window: 'session', left: 100, used: 0, resets: null }]);
    expect(figuresOf(patterns, rows[1] as string)).toEqual([{ account: 'meta', window: 'weekly', left: 100, used: 0, resets: null }]);
    expect(figuresOf(patterns, '    Current        42% used · Resets at 8:16 PM')).toEqual([
      { account: 'meta', window: 'session', left: 58, used: 42, resets: null },
    ]);
    expect(figuresOf(patterns, '    Currently unavailable')).toEqual([]);
  });
});

describe('the process name a muse pane shows', () => {
  test('the cut name and any later release match, and a lookalike does not', () => {
    const names = muse.processNames;
    expect(processNameMatches('muse', names)).toBe(true);
    // `muse-bin-1.4.9-R6297.1` cut to 15 bytes, as `herdr pane process-info` named it.
    expect(processNameMatches('muse-bin-1.4.9-', names)).toBe(true);
    expect(processNameMatches('muse-bin-1.4.10', names)).toBe(true);
    expect(processNameMatches('muse-binary', names)).toBe(false);
    expect(processNameMatches('amuse', names)).toBe(false);
    expect(processNameMatches('musebin', names)).toBe(false);
    expect(processNameMatches('node', names)).toBe(false);
    expect(processNameMatches('claude', ['claude'])).toBe(true);
    expect(processNameMatches('claude-code', ['claude'])).toBe(false);
  });

  test('a live seat, a pane that left, and an agent run outside herdr are read by the cut name', () => {
    expect(reportedLiveAgent(['muse-bin-1.4.9-'], muse.processNames)).toBe(true);
    expect(reportedLiveAgent(['zsh'], muse.processNames)).toBe(false);
    expect(reportedLiveAgent(null, muse.processNames)).toBe(false);
    expect(paneStillRunning(['muse-bin-1.4.9-'], muse.processNames)).toBe(true);
    expect(paneStillRunning(['zsh'], muse.processNames)).toBe(false);
    expect(CLI_PROCESSES).toContain('muse-bin-*');
    const caller = walkCaller({
      env: {},
      stdinIsTTY: true,
      callerSources: () => ({
        ancestors: () => [
          { pid: 30, name: 'zsh' },
          { pid: 20, name: 'muse-bin-1.4.9-' },
          { pid: 10, name: 'launchd' },
        ],
        agents: () => null,
        paneRootPid: () => null,
        env: {},
        stdinIsTTY: true,
      }),
    });
    expect(caller).toEqual({ kind: 'unplaced', reason: 'it is run by an agent (muse-bin-1.4.9-) outside herdr' });
  });
});

describe('the plan launches muse and delivers its rules as the first message', () => {
  test('the launch command carries --yolo and the plan delivers and waits for ready', () => {
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'Watch · scratch',
      seats: [
        {
          name: 'muse',
          cli: 'muse',
          launch: 'muse --model muse-wonder-1.0',
          cwd: '.',
          label: 'muse',
          stopped: false,
          rules: 'Rules.',
          rulesFile: { path: '/home/owner/.config/team/demo/rules/muse.md', line: 'Read /home/owner/.config/team/demo/rules/muse.md' },
          repairLine: '`team remove muse --keep` then `team add muse`',
        },
      ],
    });
    expect(plan.find((step) => step.do?.do === 'launch')?.do).toMatchObject({
      do: 'launch',
      seat: 'muse',
      command: 'AGENT_UNATTENDED=1 muse --model muse-wonder-1.0 --yolo',
    });
    expect(plan.find((step) => step.do?.do === 'idle')?.do).toMatchObject({ do: 'idle', cli: 'muse', seconds: 90 });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({
      do: 'deliver',
      seat: 'muse',
      cli: 'muse',
      line: 'Read /home/owner/.config/team/demo/rules/muse.md',
    });
  });
});

// The rules delivery on the 1.4.11 ready frame. herdr 0.7.1 lists a muse pane with no agent type
// and `agent_status: "unknown"` while Muse sits at its ready box, so the seat's own screen is the
// reading: this capture is the positive, and the derived rows are the negatives.
const LINE = 'Read rules/implementer.md (sha256 5e1d0a).';

/** The ready frame with `text` typed into its input row, as Muse draws a draft. */
const typed = (text: string) => fixture1411('idle').replace('\n❯\n', `\n❯ ${text}\n`);

function scene() {
  let raw = fixture1411('idle');
  let status: string | null = 'unknown';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // these scenes prove the reading, not the file
    type(text) { calls.push(text); raw = typed(text); return true; },
    enter() {
      calls.push('Enter');
      raw = fixture1411('working-synthetic');
      return true;
    },
    foreground: () => ['muse-bin-1.4.11'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return {
    io, calls, refusals,
    show: (name: string) => { raw = fixture1411(name); },
    setStatus: (value: string | null) => { status = value; },
  };
}

describe('the rules delivery on the 1.4.11 ready box, with herdr unable to report the seat', () => {
  test.each(['unknown', null] as const)('herdr reading %s: the ready box carries the rules and its working screen confirms them', async (word) => {
    const d = scene();
    d.setStatus(word);
    expect(await deliverRules('muse', LINE, 30, d.io)).toBe(true);
    expect(d.calls).toEqual([LINE, 'Enter']);
    expect(d.refusals).toEqual([]);
  });

  test('a working screen is refused and nothing is typed into it', async () => {
    const d = scene();
    d.show('working-synthetic');
    expect(await deliverRules('muse', LINE, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toMatchObject([{ stop: 'working', typed: false, sent: false }]);
  });

  test('an idle-looking screen with no box is not the ready box: refused, nothing typed', async () => {
    const d = scene();
    d.show('ambiguous-synthetic');
    expect(await deliverRules('muse', LINE, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toMatchObject([{ stop: 'screen', typed: false, sent: false, kind: 'unknown' }]);
  });

  test("a status herdr can give is still its word: `blocked` waits and refuses", async () => {
    const d = scene();
    d.setStatus('blocked');
    expect(await deliverRules('muse', LINE, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toMatchObject([{ stop: 'screen', typed: false, sent: false, kind: 'idle' }]);
  });
});

// The captured 1.4.11 typing shapes. The pre-Enter frame (`typed-before-enter.txt`) draws the
// line's wrapped rows and nothing under them; the authorized post-Enter capture
// (`rules-line-unsent.txt`) draws the line and then one empty row, the typed newline Enter left
// when it did not submit. Read-back never takes the trailing empty row as the line's own.
const CAPTURED_LINE = rulesLine('/Users/example/.config/team/demo-3f9c2a8e1d7b/rules/builder-6.md', '68952ad875fc');

/** The idle box with `text` typed into it and one more Enter taken as a newline: the line, the
 *  empty row the newline draws, then the closing rule. */
const typedNewline = (text: string) => fixture1411('idle').replace('\n❯\n', `\n❯ ${text}\n\n`);

/** A scene whose Enters draw the next frame in `frames`, then the working screen; `draw` is how
 *  the typing paints the box. */
function captureScene(start: string, frames: string[], draw: (text: string) => string = typed) {
  let raw = start;
  let status: string | null = 'unknown';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const queue = [...frames];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // these scenes prove the reading, not the file
    type(text) { calls.push(text); raw = draw(text); return true; },
    enter() {
      calls.push('Enter');
      raw = queue.shift() ?? fixture1411('working-synthetic');
      return true;
    },
    key(name) { calls.push(name); return true; },
    foreground: () => ['muse-bin-1.4.11'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals };
}

describe('the rules delivery on the captured 1.4.11 typing shapes', () => {
  test('the pre-Enter frame reads the line back and Enter sends it', async () => {
    const d = captureScene(fixture1411('placeholder-synthetic'), []);
    expect(await deliverRules('muse', CAPTURED_LINE, 30, d.io)).toBe(true);
    expect(d.calls).toEqual([CAPTURED_LINE, 'Enter']);
    expect(d.refusals).toEqual([]);
  });

  test('a frame that draws altered text never reads back, so Enter is not pressed on it', async () => {
    const d = captureScene(fixture1411('idle'), [], (text) => typed(`${text}!`));
    expect(await deliverRules('muse', CAPTURED_LINE, 30, d.io)).toBe(false);
    // The line was typed, the altered frame did not read it back, and the one key cleared it.
    expect(d.calls).toEqual([CAPTURED_LINE, 'ctrl+u']);
    expect(d.refusals).toMatchObject([{ stop: 'read-back', typed: true, sent: false }]);
  });

  test('a pane already holding the captured post-Enter frame is leftover: nothing is typed or pressed', async () => {
    // The trailing empty row says Enter did not submit; the box is still today's line, not a
    // submission, and never a second line typed onto the first.
    const d = captureScene(fixture1411('rules-line-unsent'), []);
    expect(await deliverRules('muse', CAPTURED_LINE, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toMatchObject([{ stop: 'leftover', typed: false, sent: false }]);
  });

  test('a post-Enter frame with a typed newline gets no second Enter, and the report says the box still holds the line', async () => {
    // Enter was taken as a newline, not a submit: the line and its empty row are still in the box.
    // A trailing empty row is a row of the text, so it is never entered on; the report keeps the
    // line where it sits and names the row that says so.
    const d = captureScene(fixture1411('placeholder-synthetic'), [typedNewline(CAPTURED_LINE)]);
    expect(await deliverRules('muse', CAPTURED_LINE, 30, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_LINE, 'Enter']);
    expect(d.refusals).toMatchObject([{ stop: 'ack', typed: true, sent: true, row: '', kind: 'unsent' }]);
  });
});
