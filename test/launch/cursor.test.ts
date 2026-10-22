import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, statusOnLine, versionVerdict } from '../../src/profiles/profile.ts';
import { classify, classifyComposer, readBox, readFold, readScreen, screenData, statusRow } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { rulesLine } from '../../src/launch/rules-file.ts';
import { NUDGE_TEXT } from '../../src/watch/pass.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { SAMPLE_RULES, wordWrap } from '../helpers.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/cursor/2026.10.01/${name}.txt`, import.meta.url), 'utf8');

const cursor = profileFor('cursor');
if (!cursor) throw new Error('cursor has no profile');

describe('Cursor launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(profileFor('cursor')).toBe(cursor);
    expect(launchCommand(cursor, 'cursor-agent', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled',
    );
    expect(launchCommand(cursor, 'cursor-agent --model grok-4.7-high', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled',
    );
    // The launch approves the inbox server team registers in the seat's `.cursor/mcp.json`.
    expect(launchCommand(cursor, 'cursor-agent', 'Rules.', undefined, { seat: 'helper', session: 'acme-web', command: '/opt/bun', entry: '/src/cli.ts' })).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled --approve-mcps',
    );
    expect(cursor.rulesOption).toBeNull();
    expect(cursor.loginCheck).toEqual(['status']);
    expect(cursor.loginHint).toBe('cursor-agent login');
    expect(cursor.exit).toBe('/exit');
    expect(cursor.unattended).not.toContain('--trust');
    expect(versionVerdict('2026.10.01-14929f9', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.02', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.14-0f9edde', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.16-e3cb207', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.19-6bbf2c4', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.20', cursor.tested)).toBe('newer');
    expect(versionVerdict('2026.09.30', cursor.tested)).toBe('older');
  });

  test('2026.10.14 captures: a shell approval is permission, and the question box is a question', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/cursor/2026.10.14/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('cursor', current('trust')).kind).toBe('trust');
    expect(readScreen('cursor', current('idle')).kind).toBe('idle');
    expect(readScreen('cursor', current('working')).kind).toBe('working');
    expect(readScreen('cursor', current('question')).kind).toBe('question');
    expect(readScreen('cursor', current('permission')).kind).toBe('permission');
    expect(readScreen('cursor', current('exit')).kind).toBe('unknown');
  });

  test('2026.10.16 captures keep the same kinds, and the status row names its model', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/cursor/2026.10.16/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('cursor', current('trust')).kind).toBe('trust');
    expect(readScreen('cursor', current('idle')).kind).toBe('idle');
    expect(readScreen('cursor', current('unsent')).kind).toBe('unsent');
    expect(readScreen('cursor', current('working')).kind).toBe('working');
    expect(readScreen('cursor', current('question')).kind).toBe('question');
    expect(readScreen('cursor', current('permission')).kind).toBe('permission');
    expect(readScreen('cursor', current('exit')).kind).toBe('unknown');
    // The folder is the profile's ceiling, and the composer's status row is its model.
    expect(profileFor('cursor')?.tested.to).toBe('2026.10.19');
    expect(runningModel('cursor', current('idle'))).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('the 2026.10.19 ready frame reads idle, and its row names Gemini Argon 4', () => {
    const ready = readFileSync(new URL('../fixtures/cursor/2026.10.19/idle.txt', import.meta.url), 'utf8');
    const row = '  Gemini 4 Argon High' + ' '.repeat(188 - 21 - 14) + 'Run Everything';
    // The frame is the composer's ready screen: the status row in its captured place, the
    // workspace line under it, the prompt row inside the box's two border rows.
    expect(ready.split('\n')[10]).toBe(row);
    expect(readScreen('cursor', ready).kind).toBe('idle');
    expect(classifyComposer('cursor', ready.split('\n')).kind).toBe('idle');
    // The status row is the one line a quota figure may come from, and it names the model the
    // launch line's `gemini-4-argon-high` selects: the canonical split is Gemini Argon, version 4.
    expect(statusRow('cursor', ready)).toBe(row);
    expect(runningModel('cursor', ready)).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(statusOnLine('cursor', row)).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(cursor.modelOf('cursor-agent --model gemini-4-argon-high')).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(cursor.modelFlag('Gemini Argon', '4')).toEqual({ option: '--model', id: 'gemini-4-argon-high' });
    // The captured row carries the effort token; the same closed tokens the other families take
    // are read on this family too, and a row nothing on the pane draws is not the row.
    expect(statusOnLine('cursor', '  Gemini 4 Argon High · 93.8% · 15 files edited  Run Everything')).toEqual(
      { model: 'Gemini Argon', version: '4' },
    );
    for (const spoof of [
      '  Gemini 4 Argon Turbo             Run Everything',
      '  Gemini 4 Argon High  Run Everything and more',
      ' Gemini 4 Argon High              Run Everything',
      '  Gemini 4 Argon High',
    ]) {
      expect(statusOnLine('cursor', spoof)).toBeNull();
    }
  });

  test('the 2026.10.19 row is a position, not just a grammar line', () => {
    const lines = readFileSync(new URL('../fixtures/cursor/2026.10.19/idle.txt', import.meta.url), 'utf8')
      .replace(/\n+$/, '')
      .split('\n');
    const screen = (rows: string[]) => rows.join('\n');
    // The captured frame itself.
    expect(readScreen('cursor', screen(lines)).kind).toBe('idle');
    // No workspace line under the row: it is not in the position, so nothing is read.
    expect(readScreen('cursor', screen(lines.slice(0, -1))).kind).toBe('unknown');
    expect(runningModel('cursor', screen(lines.slice(0, -1)))).toBeNull();
    // A blank between the row and the workspace line: same.
    const gapped = [...lines];
    gapped.splice(gapped.length - 1, 0, '');
    expect(readScreen('cursor', screen(gapped)).kind).toBe('unknown');
    // A non-workspace line under the row: same.
    const wrong = [...lines];
    wrong[wrong.length - 1] = '  something else';
    expect(readScreen('cursor', screen(wrong)).kind).toBe('unknown');
    // A spoofed Argon row in the transcript, above the real frame: the real row below still
    // sits in its place and wins, exactly as the capture reads.
    const above = [...lines];
    above.splice(above.findIndex((line) => /^ {2}→/.test(line)) - 2, 0, lines[10] ?? '');
    expect(readScreen('cursor', screen(above)).kind).toBe('idle');
    expect(runningModel('cursor', screen(above))).toEqual({ model: 'Gemini Argon', version: '4' });
  });

  test('the working queue and a live dialog keep their readings with the Argon row', () => {
    // The quiet follow-up queue, from the transcribed 2026.10.01 capture: with the spinner row
    // removed, only the queue rule can read it working, and it carries the Argon status row
    // the composer draws. The row is chrome the queue's exception must name, or the screen
    // would fall to the composer and read idle.
    const queue = readFileSync(new URL('../fixtures/cursor/2026.10.01/follow-up-queue-hint.txt', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line));
    const at = queue.findIndex((line) => /^ {2}Grok /.test(line));
    queue[at] = '  Gemini 4 Argon High · 93.8% · 15 files edited    Run Everything';
    expect(readScreen('cursor', queue.join('\n')).kind).toBe('working');
    // The same queue with a row the grammar refuses: not chrome, so the queue already ended;
    // the composer reads no row either, and the screen is unknown — never idle.
    queue[at] = '  Gemini 4 Argon Turbo             Run Everything';
    expect(readScreen('cursor', queue.join('\n')).kind).toBe('unknown');
    // A live trust dialog below the ready frame is still the dialog: the core reads dialogs
    // before the composer, and the ready frame above it cannot hide it.
    const ready = readFileSync(new URL('../fixtures/cursor/2026.10.19/idle.txt', import.meta.url), 'utf8');
    const argonRow = ready.split('\n')[10] ?? '';
    const trust = readFileSync(new URL('../fixtures/cursor/2026.10.16/trust.txt', import.meta.url), 'utf8');
    expect(readScreen('cursor', ready + '\n' + trust).kind).toBe('trust');
    // The Argon grammar is also the composer's placed row pattern, so out of place it is
    // ordinary text and cannot close a live trust dialog: caution wins over a grammar line.
    const dialog = trust.replace(/\n+$/, '').split('\n');
    expect(readScreen('cursor', dialog.join('\n') + '\n' + argonRow + '\n  <workspace>').kind).toBe('trust');
    // The same dialog over the full ready frame reads idle: the status row is in its place,
    // the trust rule's none_after sees the composer, and the dialog is answered, not live.
    expect(readScreen('cursor', dialog.join('\n') + '\n' + ready).kind).toBe('idle');
  });

  test.each([
    ['startup', 'idle'],
    ['idle', 'idle'],
    ['unsent', 'unsent'],
    ['working', 'working'],
    ['thinking', 'working'],
    ['rules-accepted', 'idle'],
    ['trust', 'trust'],
    ['exit-typed', 'unsent'],
    ['exit', 'unknown'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('cursor', fixture(file)).kind).toBe(kind);
  });

  test('a trust dialog with a running turn beside it is still trust, not working', () => {
    const screen = fixture('trust').replace(
      '│  ▶ [a] Trust this workspace',
      ' ⠀⠞ Working\n\n│  ▶ [a] Trust this workspace',
    );
    expect(readScreen('cursor', screen).kind).toBe('trust');
  });

  test('dialog phrases in a transcript or a typed box are not the dialog', () => {
    const idle = fixture('idle');
    const unsent = fixture('unsent');
    const question = fixture('question');
    const plan = 'Approve mode switch (y)\nReject (n or esc)\n';
    const choice = 'Space select\nEsc to skip\n';
    const typed = (screen: string, words: string) => {
      const [first, ...rest] = words.trimEnd().split('\n');
      return screen.replace('  → Plan, search, build anything', `  → ${first}\n    ${rest.join('\n    ')}`);
    };
    expect(readScreen('cursor', plan + idle).kind).toBe('idle');
    expect(readScreen('cursor', plan + unsent).kind).toBe('unsent');
    expect(readScreen('cursor', typed(idle, plan)).kind).toBe('unsent');
    expect(readScreen('cursor', question.replace(
      '│ Choose a filename',
      '│ Approve mode switch (y)\n│ Reject (n or esc)\n│ Choose a filename',
    )).kind).toBe('question');
    expect(readScreen('cursor', choice + idle).kind).toBe('idle');
    expect(readScreen('cursor', choice + unsent).kind).toBe('unsent');
    expect(readScreen('cursor', typed(idle, choice)).kind).toBe('unsent');
    expect(readScreen('cursor', fixture('permission-plan')).kind).toBe('permission');
    expect(readScreen('cursor', question).kind).toBe('question');
  });

  test('a finished turn reads idle', () => {
    expect(readScreen('cursor', fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('idle')).kind).toBe('idle');
  });

  test('the composer alone reads a resume line as unknown', async () => {
    const lines = fixture('exit').split('\n');
    expect(readScreen('cursor', fixture('exit')).kind).toBe('unknown');
    expect(classifyComposer('cursor', lines).kind).toBe('unknown');
    const exit = delivery('exit');
    expect(await deliverRules('cursor', 'Rules.', 1, exit.io)).toBe(false);
    expect(exit.calls).toEqual([]);
    expect(readScreen('cursor', fixture('trust')).kind).toBe('trust');
    const trust = delivery('trust');
    expect(await deliverRules('cursor', 'Rules.', 1, trust.io)).toBe(false);
    expect(trust.calls).toEqual([]);
  });

  test('a floor phrase above the composer leaves a typed exit unsent', () => {
    const lines = fixture('exit-typed').split('\n');
    const prompt = lines.findIndex((line) => /^\s*→\s+\S/.test(line));
    const above = [...lines.slice(0, prompt), 'Do you want to proceed?', ...lines.slice(prompt)].join('\n');
    const inside = [...lines.slice(0, prompt + 1), 'Do you want to proceed?', ...lines.slice(prompt + 1)].join('\n');
    expect(readScreen('cursor', fixture('exit-typed')).kind).toBe('unsent');
    expect(readScreen('cursor', above).kind).toBe('unsent');
    expect(classifyComposer('cursor', above.split('\n')).kind).toBe('unsent');
    expect(readScreen('cursor', inside).kind).toBe('unknown');
  });

  test('a working turn still has an empty composer, which is what delivery waits for', () => {
    const lines = fixture('working').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(readScreen('cursor', fixture('working')).kind).toBe('working');
    expect(classifyComposer('cursor', lines).kind).toBe('idle');
    const thinking = fixture('thinking').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(classifyComposer('cursor', thinking).kind).toBe('idle');
  });

  test.each([
    ['follow-up-queue-two', 'working'],
    ['follow-up-queue-hint', 'working'],
    ['follow-up-queue-one', 'working'],
  ] as const)('%s: a follow-up queue under a running turn reads %s', (file, kind) => {
    // Nobody typed: the queue's rows are not input text, and the composer's own
    // row is the placeholder — an empty box — so the turn's reading stands.
    expect(readScreen('cursor', fixture(file)).kind).toBe(kind);
    const lines = fixture(file).split('\n');
    expect(classify('cursor', lines).kind).toBe(kind);
    expect(classifyComposer('cursor', lines).kind).toBe('idle');
  });

  test('typed text still reads unsent, with and without a queue box above it', () => {
    expect(readScreen('cursor', fixture('unsent')).kind).toBe('unsent');
    // With a queue box above it the text is still the composer's own, not the
    // queue's: the composer read says unsent, and the painted spinner — the
    // running turn — is what makes the whole screen working.
    const withQueue = fixture('follow-up-queue-typed').split('\n');
    expect(classifyComposer('cursor', withQueue).kind).toBe('unsent');
    expect(readScreen('cursor', fixture('follow-up-queue-typed')).kind).toBe('working');
    // Take the turn's paint away and the text decides, exactly as without the box.
    const quiet = withQueue.filter((line) => !/^\s*[⠀-⣿]/.test(line)).join('\n');
    expect(readScreen('cursor', quiet).kind).toBe('unsent');
    expect(classifyComposer('cursor', quiet.split('\n')).kind).toBe('unsent');
  });

  test('a queue box with no running turn under it is working, never idle', () => {
    // No spinner row and no `ctrl+c to stop`: the box is what is left of the
    // turn, and its messages are still waiting on one. Working means nothing is
    // typed into it and `down --wait` waits; idle would end the seat.
    const quiet = fixture('follow-up-queue-two')
      .split('\n')
      .map((line) => line.replace(/\s{2,}ctrl\+c to stop\s*$/, ''))
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .join('\n');
    expect(readScreen('cursor', quiet).kind).toBe('working');
    expect(classifyComposer('cursor', quiet.split('\n')).kind).toBe('idle');
  });

  test('a typed row below a queue box is unknown, never a running turn and never typed into', () => {
    // No spinner and no `ctrl+c to stop`, an empty composer row and the
    // placeholder row, then a typed row below both: only the box's row above the
    // composer is what says a queue frame, so a typed row under the box must
    // defeat the rule. The earlier rule took the rows in either order and
    // dropped every `→` row from the after-check, so this read working.
    //
    // Three rows at the prompt column in one box is a shape no capture draws:
    // Cursor indents every row of a person's text to the content column. Since
    // 0.2.1 the box fails closed on it — the input row is the box's first prompt
    // row, and a later row still at the prompt column is neither text nor frame —
    // so it reads unknown, never working, and nothing is typed into it or sent.
    const frame = fixture('follow-up-queue-one')
      .split('\n')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .map((line) => line.replace(/^(\s*)→\s*Add a follow-up\s*$/, '$1→\n$1→ Add a follow-up\n$1→ Reply with exactly RULES_RECEIVED. Do not use'))
      .join('\n');
    expect(readScreen('cursor', frame).kind).toBe('unknown');
    expect(classifyComposer('cursor', frame.split('\n')).kind).toBe('unknown');
  });

  test('prose that looks like the queue box leaves an idle prompt idle', () => {
    const idleLines = fixture('idle').split('\n');
    const at = idleLines.findIndex((line) => /^\s*→/.test(line));
    expect(at).toBeGreaterThan(0);
    const boxTop = '  ┌─ follow-ups ────────────────────────┐';
    const boxRow = '  │ ○ First queued message.              │';
    const boxEnd = '  └──────────────────────────────────────┘';
    const hintRow = '  │ enter steer · ↑ select/edit · esc cancel │';
    // The lookalike sits in the transcript, above the blank frame rows every capture draws
    // against the input row (idle.txt's rows 5-8): it is then read as nothing.
    const quoted = [...idleLines.slice(0, at), boxTop, boxRow, boxEnd, '  the box lists the messages already sent.', '', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', quoted).kind).toBe('idle');
    // Even a paste that reproduces the overlay's own hint line leaves idle when
    // more prose follows it: the box is then not directly above the prompt area.
    const pasted = [...idleLines.slice(0, at), boxTop, boxRow, hintRow, boxEnd, '  and nothing had been typed.', '', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', pasted).kind).toBe('idle');
    expect(classifyComposer('cursor', pasted.split('\n')).kind).toBe('idle');
    // Pressed against the prompt with no frame row between, the same prose is a shape no
    // capture draws — the transcript's last row sits above the gap, never against the
    // prompt — so the read fails closed rather than take the prompt for an input row.
    const against = [...idleLines.slice(0, at), boxTop, boxRow, boxEnd, '  the box lists the messages already sent.', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', against).kind).toBe('unknown');
  });

  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [
      undefined,
      '❯\n',
      '→\n',
      'Welcome to Cursor\nSign in to continue',
      'Do you allow this command?\n→ 1. Yes\nEnter to confirm',
      'Do you trust the contents of this directory?\n',
    ]) {
      expect(readScreen('cursor', screen).kind).toBe('unknown');
    }
    expect(readScreen('cursor', fixture('idle').replace('Grok 4.7 256K High', 'new footer')).kind).toBe('unknown');
  });

  test('a quoted trust dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('cursor', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    const wrapped = fixture('idle').replace('→ Plan, search, build anything', '→\n  unsent second line');
    expect(readScreen('cursor', wrapped).kind).toBe('unsent');
  });

  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(cursor.modelOf('cursor-agent --model grok-4.7-high')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model=grok-4.7-xhigh-fast')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model cursor-grok-4.5-high')).toEqual({ model: 'Grok', version: '4.5' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7-high[context=256k]')).toBeNull();
    expect(cursor.modelOf('cursor-agent --model gpt-5')).toBeNull();
    expect(cursor.modelOf('cursor-agent')).toBeNull();
    expect(cursor.modelOf('cursor-agent --model cursor-grok-4.6-high-fast')).toEqual({ model: 'Grok', version: '4.6' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7 --model grok-4.5')).toEqual({ model: 'Grok', version: '4.5' });
    expect(runningModel('cursor', fixture('idle'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('cursor', fixture('rules-accepted'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('cursor', fixture('trust'))).toBeNull();
    expect(runningModel('cursor', fixture('exit'))).toBeNull();
    expect(cursor.modelOf('cursor-agent --model gpt-5.6-sol-high')).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(cursor.modelOf('cursor-agent --model gemini-3.8-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(cursor.modelOf('cursor-agent --model composer-2.5')).toEqual({ model: 'Composer', version: '2.5' });
    expect(cursor.modelOf('cursor-agent --model gpt-5.2')).toBeNull();
    expect(cursor.modelFlag('Grok', '4.7')).toEqual({ option: '--model', id: 'grok-4.7-high' });
    expect(cursor.modelFlag('GPT Sol', '5.6')).toEqual({ option: '--model', id: 'gpt-5.6-sol-high' });
    expect(cursor.modelFlag('Gemini Flash', '3.8')).toEqual({ option: '--model', id: 'gemini-3.8-flash-high' });
    expect(cursor.modelFlag('Composer', '2.5')).toEqual({ option: '--model', id: 'composer-2.5' });
    expect(cursor.modelFlag('Grok', '4.5')).toEqual({ option: '--model', id: null });
    expect(cursor.startsOnLastModel).toBe(true);
  });

  test('the home and a typed line are read under other model families', () => {
    expect(readScreen('cursor', fixture('gpt-sol-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('gpt-sol-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('gpt-sol-idle'))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(runningModel('cursor', fixture('gpt-sol-unsent'))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(readScreen('cursor', fixture('gemini-flash-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('gemini-flash-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('gemini-flash-idle'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('cursor', fixture('gemini-flash-unsent'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(readScreen('cursor', fixture('composer-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('composer-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('composer-idle'))).toEqual({ model: 'Composer', version: '2.5' });
    expect(runningModel('cursor', fixture('composer-unsent'))).toEqual({ model: 'Composer', version: '2.5' });
    const swapped = fixture('idle').replace('Grok 4.7 256K High', 'GPT-5.6 Sol 272K High');
    expect(readScreen('cursor', swapped).kind).toBe('idle');
    expect(runningModel('cursor', swapped)).toEqual({ model: 'GPT Sol', version: '5.6' });
  });

  test('a line of output that names a model is not a status row', () => {
    const prose = fixture('idle').replace(
      '  Grok 4.7 256K High                 Run Everything',
      '  the agent wrote that GPT-5.6 Sol is ready',
    );
    expect(readScreen('cursor', prose).kind).toBe('unknown');
    expect(runningModel('cursor', prose)).toBeNull();
  });

  test('the plan delivers the one line through the guarded path, never a config file', () => {
    const line = rulesLine('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/grok.md', '5e1d0a9c4b2f');
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'Watch · scratch',
      seats: [{
        name: 'grok',
        cli: 'cursor',
        launch: 'cursor-agent',
        cwd: '.',
        label: 'grok',
        stopped: false,
        repairLine: '`team remove grok --keep` then `team add grok`',
        rules: 'Rules.',
        rulesFile: { path: '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/grok.md', line },
      }],
    });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({
      do: 'deliver',
      cli: 'cursor',
      rules: 'Rules.',
      line,
      seconds: 90,
    });
    const deliverStep = plan.find((step) => step.do?.do === 'deliver');
    expect(deliverStep?.kind === 'run' ? deliverStep.argv.at(-1) : undefined).toBe(line);
    const launched = plan.find((step) => step.kind === 'run' && step.do?.do === 'launch');
    const command = launched?.kind === 'run' ? launched.argv.join(' ') : '';
    expect(command).toContain('cursor-agent --force --sandbox disabled');
    expect(command).not.toContain('--trust');
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
});

/** The captured idle frame once `lines` sit in the box: the placeholder row replaced, the first
 *  line after the prompt, every later line at the column the captured wrap draws continuation
 *  rows in — four columns, the prompt row's own width (see the fixtures README). */
function box(lines: string[]): string {
  const [first = '', ...rest] = lines;
  const body = [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
  return fixture('idle').replace('  → Plan, search, build anything', body);
}

function boxed(text: string): string {
  return box(text.split('\n'));
}

/** The bordered idle frame once `lines` sit in the box: the placeholder row replaced, the first
 *  line after the prompt, every later line at the captured continuation column — the bordered
 *  captures' own shape (bordered-typed-three.txt) — with the border rows left where the capture
 *  draws them. */
function borderedBox(lines: string[]): string {
  const [first = '', ...rest] = lines;
  const body = [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
  return fixture('bordered-idle').replace('  → Plan, search, build anything', body);
}

/** The pane's own wrap, as the captured `unsent.txt` shows it: a line wider than the pane's
 *  content column breaks at a space, the words that fit on the row and the rest continued at the
 *  text column (the pane is the prompt row's four columns plus its content). */
function wrapped(text: string, pane: number): string {
  return box(wordWrap(text, pane - 4));
}

// The rules message the real capture holds, as team composed it: the 80-character sentence
// Cursor wrapped over two rows on its 51-column pane (see the fixtures README).
const CAPTURED_WRAP = 'Reply with exactly RULES_RECEIVED. Do not use tools. Do not read or write files.';

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' || initial === 'thinking' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['cursor-agent'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Cursor rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('the captured wrapped paste reads back through the profile\'s wrap and is entered', async () => {
    // unsent.txt is this sentence word-wrapped on the pane's 51 columns: the words that fit on
    // the first row (45 characters; the next word would not), the rest continued at the text
    // column. The profile's wrap rule joins the rows back into the typed line, so the box is
    // observed to hold the paste and its Enter is sent.
    const message = CAPTURED_WRAP;
    const capture = fixture('unsent');
    expect(readFold('cursor', capture)).toBeNull();
    expect(readScreen('cursor', capture).kind).toBe('unsent');
    // The capture is this very wrap: its box rows are the model's, joined back to the sentence.
    const box = readBox('cursor', capture);
    if (!box) throw new Error('the capture has no box');
    const rows = wordWrap(message, 51 - 4);
    expect([box.first, ...box.rows.map((row) => row.trim())]).toEqual(rows);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('cursor', message, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([message, 'Enter']);
  });

  test.each([40, 51, 80])('the rules sentence wrapped on a %s-column pane still gets its Enter', async (pane) => {
    // Wider and narrower panes wrap the same sentence over more or fewer rows; the wrap rule
    // joins them all, and every pane that shows the whole sentence gets the Enter.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(text, pane)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([CAPTURED_WRAP, 'Enter']);
  });

  test('the nudge, wrapped on the same pane, reads back and is entered', async () => {
    // The watch's nudge and the exit typing share this gate (`boxHoldsText`). On the 51-column
    // pane Cursor wraps the nudge exactly as it wrapped the rules sentence; a box holding
    // something else is still refused.
    expect(boxHoldsText('cursor', NUDGE_TEXT, wrapped(NUDGE_TEXT, 51))).toBe(true);
    const person = 'Someone else wrote this line and it is not the nudge';
    expect(boxHoldsText('cursor', NUDGE_TEXT, wrapped(person, 51))).toBe(false);
  });

  test('a wrapped box holding a person\'s own text gets no Enter', async () => {
    // The same wrap, a different sentence: joined it is not the typed text.
    const d = delivery();
    const person = 'Someone else wrote this sentence on the pane and its words are not ours.';
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(person, 51)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with one character changed gets no Enter', async () => {
    const d = delivery();
    const changed = CAPTURED_WRAP.replace('RULES_RECEIVED', 'RULES_RECEIVFD');
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(changed, 51)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with an extra row below it gets no Enter', async () => {
    const d = delivery();
    const extra = [...wordWrap(CAPTURED_WRAP, 51 - 4), 'and a line of their own'];
    d.io.type = (text) => { d.calls.push(text); d.showText(box(extra)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of a wrapped text: the pane draws one only where
    // the text itself has a blank line, and this sentence has none.
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box([firstRow, '', ...rest])); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('the nudge wrapped with a blank row gets no Enter', async () => {
    // The nudge and the exit gate on the same read: a blank row the nudge does not have.
    const rows = wordWrap(NUDGE_TEXT, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    expect(boxHoldsText('cursor', NUDGE_TEXT, box([firstRow, '', ...rest]))).toBe(false);
  });

  test('a blank row the typed text itself has is refused: a blank row is never the text\'s', async () => {
    // A blank row was the pane's drawing of a blank line the text had, when texts could hold
    // newlines. A row break may stand for at most one space, never a newline, so the blank row
    // never reads back and there is no Enter.
    const typed = 'alpha beta\n\ngamma delta';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('two spaces typed, one shown, gets no Enter — the delivery path and the gate', async () => {
    // The typed text has a run of two spaces; the box shows one. The wrap did not add or drop
    // that space, so the box is not the typed text, and nothing presses Enter on it. The watch's
    // nudge and the typed exit gate on the same read.
    const typed = 'alpha  beta';
    expect(boxHoldsText('cursor', typed, box(['alpha beta']))).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box(['alpha beta'])); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('the same collapse inside a wrapped row gets no Enter', async () => {
    // Only a row break may stand for whitespace at a wrap boundary; inside a row the characters
    // must match the typed text exactly, runs of spaces included.
    const typed = 'alpha  beta gamma delta epsilon';
    const collapsed = wordWrap(typed, 20).map((row) => row.replace('  ', ' '));
    expect(boxHoldsText('cursor', typed, box(collapsed))).toBe(false);
  });

  test('two spaces shown as two are the text and are entered', async () => {
    const typed = 'alpha  beta';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box(['alpha  beta'])); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });

  test('a trailing blank row after the wrapped text gets no Enter', async () => {
    // The probe: the correctly wrapped text, then one more empty row inside the box. Cursor
    // draws two empty rows of its own under the text — idle.txt and unsent.txt show them, the
    // drop before the status line — and those rows are the box's frame, not its content. A row
    // beyond them is a row the text does not have: someone pressed a newline after it.
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const body = [`  → ${firstRow}`, ...rest.map((row) => `    ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('  → Plan, search, build anything', body);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a typed text whose own last line is empty: no Enter, with the row or without it', async () => {
    // The text ends with a newline, so its last line is empty and the pane once drew a row for
    // it. A row break may stand for at most one space, never a newline, and a blank row is
    // never the text's own: the trailing newline is unaccounted for either way, and the box
    // never verifies.
    const typed = CAPTURED_WRAP + '\n';
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const body = [`  → ${firstRow}`, ...rest.map((row) => `    ${row}`)];
    const withRow = fixture('idle').replace('  → Plan, search, build anything', [...body, ''].join('\n'));
    const withoutRow = fixture('idle').replace('  → Plan, search, build anything', body.join('\n'));
    expect(boxHoldsText('cursor', typed, withRow)).toBe(false);
    expect(boxHoldsText('cursor', typed, withoutRow)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(withoutRow); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a shorter first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a boxed multi-line paste no longer reads back: typed, not sent', async () => {
    // A row break may stand for at most one space, never the newline between the lines, so a
    // multi-line text never verifies and the Enter is never the delivery's to send.
    const d = delivery();
    expect(await deliverRules('cursor', 'Rules.\nOne more line.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.\nOne more line.']);
  });

  test('the typed exit read back from the captured completion frame is entered', async () => {
    // exit-typed.txt: `/exit` in the box with the suggestion menu below it. The box's own row
    // is the typed text, so the exit's Enter may be sent.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('exit-typed'); return true; };
    expect(await deliverRules('cursor', '/exit', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['/exit', 'Enter']);
  });

  test.each(['trust', 'unsent', 'exit', 'working', 'thinking'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working');
    d.status('idle');
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a trust question appearing after paste gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('trust'); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a dialog arriving at the final re-read gets no Enter', async () => {
    const d = delivery();
    let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'trust' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    }
  });

  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery();
    let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
  });
});

describe('the prompt-glyph continuation row (Cursor)', () => {
  // The person's box holds their own text, then a continuation row at the text column carrying
  // only the prompt glyph. The input row is the row carrying the prompt at the captures' own
  // column — unsent.txt draws `→` at the pane's second column and continuations at the fourth
  // — never the last row whose content begins with a glyph.
  const GLYPH = '→';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('cursor', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `→ Rules.`.
    expect(boxHoldsText('cursor', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    expect(boxHoldsText('cursor', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    expect(readScreen('cursor', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('cursor', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a second glyph row at the prompt column fails closed: never idle, never entered', async () => {
    // The Cursor twin of the Codex boundary: the person's text on the input row and a second
    // row carrying `→` at that same column (the pane's second, where the captures draw the
    // input). The captures show the CLI continuing a person's line at the fourth column in
    // every case — including a second line that itself begins with `→`
    // (typed-glyph-second.txt) — so a person's glyph at the prompt column is a shape no
    // capture explains, and the read is `unknown`: nothing is typed into it and no Enter is
    // sent. Read by its lowest row the box was idle, the paste went after the second glyph,
    // the read-back held only the typed text, and the Enter submitted both.
    const at = (typed = '') => fixture('idle')
      .replace('  → Plan, search, build anything', `  → person text\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('the box\'s top frame (Cursor)', () => {
  // The Cursor twin of the Codex frame: every capture draws blank rows directly above the
  // input row — four in idle.txt (rows 5-8 above the input at 9), unsent.txt and the typed
  // captures alike — and above them the transcript's or the pane's last row
  // (idle.txt's `  hints.`, rules-accepted.txt's `  RULES_RECEIVED`, the queue fixtures'
  // spinner). typed-blank-middle.txt draws a blank row inside a person's box as its third
  // line at the content column (four), never at the prompt column (two): a second glyph at
  // the prompt column after a blank is the transcript's echo of a sent message — working.txt
  // and rules-accepted.txt draw sent text at the content column without the glyph,
  // follow-up-queue-typed.txt shows the glyph only on queued text — not a row of a person's
  // box, so the empty input row under the frame reads `idle`, exactly as main reads it. No
  // shipped capture shows the direct echo layout; the constructed screens below stand in.
  const shaped = (body: string) => fixture('idle').replace('  → Plan, search, build anything', body);

  test('the transcript\'s echo over the gap leaves the empty box idle, and the typed text reads back exactly', async () => {
    // The routine post-send layout, settled by typed-blank-middle.txt: the person's sent
    // message echoed at the prompt column, the captured blank frame, the empty input row. It
    // reads `idle` on every reader and rules delivery types and enters; the read-back holds
    // exactly the typed text.
    const at = (typed = '') => shaped(`  → person text\n\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('idle');
    expect(classify('cursor', at().split('\n')).kind).toBe('idle');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('idle');
    expect(readScreen('cursor', at('Rules.')).kind).toBe('unsent');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(true);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('two and three blank rows above the input read the same', () => {
    for (const gap of ['\n\n\n', '\n\n\n\n']) {
      expect(readScreen('cursor', shaped(`  → person text${gap}  →`)).kind).toBe('idle');
    }
  });

  test('agent output between the echo and the frame reads idle', () => {
    // rules-accepted.txt in full: the sent text at the content column, `  RULES_RECEIVED` and
    // the timestamp between it and the frame, the empty input row last. The real capture, read
    // as it always was, with the new rule taking nothing from it.
    expect(readScreen('cursor', fixture('rules-accepted')).kind).toBe('idle');
  });

  test('a second prompt row pressed against the one above it fails closed', async () => {
    // Cursor's twin of the pressed-row rule, unchanged: no blank row separates the person's
    // row from the later prompt, so the row above the lowest prompt is not the frame and the
    // input row cannot be shown to be the box's top. Nothing is typed and Enter is not sent.
    const at = (typed = '') => shaped(`  → person text\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a blank row, a continuation row, then a prompt fails closed', () => {
    const at = shaped('  → person text\n\n    more of theirs\n  →');
    expect(readScreen('cursor', at).kind).toBe('unknown');
    expect(classifyComposer('cursor', at.split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', shaped('  → person text\n\n    more of theirs\n  → Rules.'))).toBe(false);
  });

  test('a window starting inside the box fails closed', async () => {
    const at = (typed = '') => shaped(`    person-owned visible continuation\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a window whose top frame scrolled off reads unknown', () => {
    const lines = fixture('idle').split('\n');
    const at = lines.findIndex((line) => line === '  → Plan, search, build anything');
    const only = lines.slice(at).join('\n');
    expect(readScreen('cursor', only).kind).toBe('unknown');
    const held = only.replace('  → Plan, search, build anything', '  → Rules.');
    expect(readScreen('cursor', held).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', held)).toBe(false);
  });
});

describe('the person\'s own box, captured (Cursor)', () => {
  // The typed fixtures (see the fixtures README): a person's text typed into Cursor's own box
  // and never sent. Each box reads back as exactly its own text, and as nothing else.
  const CAPTURES: [string, string][] = [
    ['typed-two-line', 'alpha typed line one\nbeta typed line two'],
    ['pasted-two-line', 'gamma pasted first\ndelta pasted second'],
    ['typed-glyph-second', 'epsilon first line\n→ zeta glyph second'],
    ['typed-gt-second', 'eta first line\n> theta gt second'],
    ['typed-wrap', 'iota long line that wraps at the pane width through several words to show the continuation column of a wrapped row on this screen'],
    ['typed-blank-middle', 'kappa first line\n\nlambda third line'],
  ];

  test.each(CAPTURES.filter(([name]) => name !== 'typed-wrap'))('%s reads unsent; its multi-line text no longer reads back', (name, text) => {
    // These captures stay as documentation of the continuation column; a row break may stand
    // for at most one space, never a newline, so no multi-line text reads back.
    const screen = fixture(name);
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unsent');
    expect(boxHoldsText('cursor', text, screen)).toBe(false);
  });

  test('typed-wrap reads unsent and holds exactly its one line', () => {
    const text = 'iota long line that wraps at the pane width through several words to show the continuation column of a wrapped row on this screen';
    const screen = fixture('typed-wrap');
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(boxHoldsText('cursor', text, screen)).toBe(true);
  });

  test.each(CAPTURES)('%s is refused for any other text', (name, text) => {
    const screen = fixture(name);
    expect(boxHoldsText('cursor', `${text}.`, screen)).toBe(false);
    expect(boxHoldsText('cursor', `${text}\nand one more`, screen)).toBe(false);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, screen)).toBe(false);
    expect(boxHoldsText('cursor', NUDGE_TEXT, screen)).toBe(false);
  });

  test('no capture holds another capture\'s text', () => {
    for (const [name, text] of CAPTURES) {
      for (const [other] of CAPTURES) {
        if (other !== name) expect(boxHoldsText('cursor', text, fixture(other))).toBe(false);
      }
    }
  });

  test('the glyph second line is drawn at the content column, never at the prompt column', () => {
    // The capture's own proof, tied to the twin test above: the person's second line begins
    // with `→` and the CLI draws it at the fourth column — the continuation indent — not at
    // the prompt's second.
    expect(readBox('cursor', fixture('typed-glyph-second'))).toEqual({
      first: 'epsilon first line',
      indent: 4,
      rows: ['    → zeta glyph second'],
      wrap: { continuation: 'text-column', kind: 'word' },
    });
  });
});

// The captures taken on 2026-10-05 at 54 by 23, the pane `up` creates (cursor-agent
// 2026.10.01, the flags the fixtures README names). The captures of the whole message stay as
// documentation of the box's six-row limit and the paste marker; the delivery itself is the
// one line of rules-line.txt.

/** The fitted texts these captures were typed with: numbered rows of a sample line. */
const fitted = (rows: number) => Array.from({ length: rows }, (_, i) => `probe line ${i + 1} of this sample`).join('\n');

/** A box Cursor draws for `text` at the pane's 47 content columns: the line word-wrapped, the
 *  first row after the prompt, the rest at the four-column continuation column. */
function drawnAt(text: string): string {
  const [first = '', ...rest] = wordWrap(text, 47);
  return [`  → ${first}`, ...rest.map((row) => `    ${row}`)].join('\n');
}

test('the box limits and the paste marker, as the captures show them', () => {
  // rules-fit-6.txt draws six typed rows whole; rules-fit-7.txt has scrolled the first typed row
  // out of the box. The fitted texts are multi-line, and no multi-line text reads back at
  // any height — the captures stay as documentation of the box's own edge.
  expect(readScreen('cursor', fixture('rules-fit-6')).kind).toBe('unsent');
  expect(readScreen('cursor', fixture('rules-fit-7')).kind).toBe('unsent');
  expect(boxHoldsText('cursor', fitted(6), fixture('rules-fit-6'))).toBe(false);
  expect(boxHoldsText('cursor', fitted(7), fixture('rules-fit-7'))).toBe(false);
  // A paste over 800 characters is hidden behind the marker; nothing of it reads back.
  expect(readBox('cursor', fixture('rules-pasted-short'))?.first).toBe('[Pasted text #1 +10 lines]');
  expect(readBox('cursor', fixture('rules-pasted-medium'))?.first).toBe('[Pasted text #1 +14 lines]');
  expect(readBox('cursor', fixture('rules-pasted'))?.first).toBe('[Pasted text #1 +17 lines]');
  for (const file of ['rules-pasted-short', 'rules-pasted-medium', 'rules-pasted']) {
    expect(readScreen('cursor', fixture(file)).kind).toBe('unsent');
  }
  expect(boxHoldsText('cursor', SAMPLE_RULES, fixture('rules-pasted'))).toBe(false);
  // 800 characters are drawn as words, 801 are the marker (rules-threshold-800/801.txt).
  const words = `${'word '.repeat(159)}wordx`;
  expect(words.length).toBe(800);
  expect(readBox('cursor', fixture('rules-threshold-800'))?.first.startsWith('word ')).toBe(true);
  expect(boxHoldsText('cursor', words, fixture('rules-threshold-800'))).toBe(false);
  const over = `${'word '.repeat(160)}w`;
  expect(over.length).toBe(801);
  expect(readBox('cursor', fixture('rules-threshold-801'))?.first).toBe('[Pasted text #1 +1 lines]');
  expect(boxHoldsText('cursor', over, fixture('rules-threshold-801'))).toBe(false);
});

// The line the 2026-10-05 capture holds, as `team` composes it: the same path and hash the
// fixtures README names, through the function that builds it. The box draws it as four rows on
// the six it has: the break after the hash's `):` and the break after `reply` each hide the
// line's own single space, and the break after the project hash hides nothing (the path simply
// continues on the next row).
const CAPTURED_PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md';
const capturedLine = rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f');

/** A Cursor pane 54 by 23 that answers the typed line with the real capture and a submitted
 *  line like the captured turn: the turn paints the pane while it runs. */
function lineDelivery() {
  let raw = fixture('idle');
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
      raw = text === capturedLine ? fixture('rules-line') : drawnAt(text);
      return true;
    },
    enter() {
      calls.push('Enter');
      raw = fixture('working');
      status = 'working';
      return true;
    },
    foreground: () => ['cursor-agent'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Cursor rules delivery of the one line (2026.10.01 capture)', () => {
  test('the captured line reads unsent and holds exactly the line', () => {
    const screen = fixture('rules-line');
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(boxHoldsText('cursor', capturedLine, screen)).toBe(true);
    // Anything the seat might hold instead: one character more, the line without its final
    // full stop, another seat's path, an older hash of the same rules.
    expect(boxHoldsText('cursor', `${capturedLine} again`, screen)).toBe(false);
    expect(boxHoldsText('cursor', capturedLine.slice(0, -1), screen)).toBe(false);
    expect(boxHoldsText('cursor', rulesLine(CAPTURED_PATH.replace('implementer', 'scribe'), '5e1d0a9c4b2f'), screen)).toBe(false);
    expect(boxHoldsText('cursor', rulesLine(CAPTURED_PATH, '4d0c9f8b3a2e'), screen)).toBe(false);
  });

  test('the line is typed once at an empty prompt, read back row by row, and entered once', async () => {
    const d = lineDelivery();
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test.each([
    ['in the path', ['3f9c2a8e1d7b', '3f9c2a8e1d7c']],
    ['in the hash', ['5e1d0a9c4b2f', '5e1d0a9c4b2e']],
    ['in a word of the line', ['standing rules', 'stunding rules']],
    ['in the final full stop', ['wait for your brief.', 'wait for your brief!']],
  ] as const)('one character changed %s gets no Enter', async (what, [from, to]) => {
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(fixture('rules-line').replace(from, to)); return true; };
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
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
    d.io.type = (text) => { d.calls.push(text); d.show(fixture('rules-line').replace('wait for your brief.', 'wait for your brief. x')); return true; };
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
  });

  test('the line with one character more than the box shows gets no Enter', async () => {
    // The other way round: the box draws the line's own four rows, and the text claims a
    // fifth the pane never drew.
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(fixture('rules-line')); return true; };
    expect(await deliverRules('cursor', `${capturedLine} x`, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([`${capturedLine} x`]);
  });

  test('two spaces in the line where the row break hides one get no Enter', async () => {
    // The captured break after `):` hides the line's single space before `your`. A line with
    // two spaces there draws the same rows — the read-back refuses it: a break may stand for
    // exactly one space, never a run of them.
    const doubled = capturedLine.replace('): your', '):  your');
    expect(boxHoldsText('cursor', doubled, fixture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(fixture('rules-line')); return true; };
    expect(await deliverRules('cursor', doubled, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([doubled]);
  });

  test('a tab in the line gets no Enter', async () => {
    const tabbed = capturedLine.replace('Read ', 'Read\t');
    expect(boxHoldsText('cursor', tabbed, fixture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(fixture('rules-line')); return true; };
    expect(await deliverRules('cursor', tabbed, 1, d.io)).toBe(false);
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
      d.io.screen = () => (++reads <= 1 ? fixture('rules-line') : fixture('trust'));
      return true;
    };
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
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
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('file-changed');
    expect(why?.sent).toBe(false);
    expect(refusalReport(why!)).toBe('rules typed, not sent: the rules file changed after it was written');
  });

  test('a seat mid-turn is reported as working; nothing is typed', async () => {
    const d = lineDelivery();
    d.status('working');
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('working');
    expect(refusalReport(why!)).toBe('rules not confirmed: the seat is working; run up again when it is idle');
  });

  test('a box already holding the person\'s own text is left alone', async () => {
    const d = lineDelivery();
    d.show(fixture('idle').replace('  → Plan, search, build anything', drawnAt('the person\'s own message')));
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('leftover');
    expect(refusalReport(why!)).toContain('its box already holds text that is not the rules line');
  });

  test('a resumed seat whose box already holds the line is verified and entered, never typed onto', async () => {
    const d = lineDelivery();
    d.show(fixture('rules-line'));
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Enter']);
  });

  test('a resumed seat whose box holds another seat\'s line is refused, nothing typed', async () => {
    const d = lineDelivery();
    d.show(fixture('rules-line').replace('implementer', 'scribe'));
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('leftover');
  });

  test('a resumed seat with an empty box is typed once, verified and sent', async () => {
    const d = lineDelivery();
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });
});

describe('the closed Cursor status row', () => {
  // A line carrying the closed grammar outside the status position is ordinary text: these
  // screens are the false rows a transcript, a dialog or a box could paint — a grammar line
  // with no workspace line under it, a full row below a real footer, a row after a trust
  // anchor — and each must read what the same screen without that row reads, never idle or
  // unsent the pane does not show. A row that keeps every closed token and sits in the
  // footer's place is a real row: it is accepted, and the model it names is the model read.
  // The six captured panes (see the fixtures README) are the only shipped fixtures whose
  // reading differs from what main read: a constructed screen below moves only where this
  // block pins it — a complete frame reproduced in place, a model narrowed to unread when
  // the real footer is out of place, or a row the closed grammar refuses.
  const GROK = '  Grok 4.7 256K High                 Run Everything';
  const GPT_ROW = '  GPT-5.6 Sol 272K High              Run Everything';
  const COMPOSER_ROW = '  Composer 2.5                       Run Everything';
  const rows = (name: string) => fixture(name).replace(/\n+$/, '').split('\n');
  const text = (lines: string[]) => lines.join('\n');
  const read = (screen: string) => {
    const lines = screen.split('\n');
    return `${classify('cursor', lines).kind} / ${classifyComposer('cursor', lines).kind}`;
  };
  const model = (screen: string) => runningModel('cursor', screen);
  const put = (name: string, n: number, line: string) => {
    const lines = rows(name);
    lines[n - 1] = line;
    return text(lines);
  };
  const footer = (name: string, line: string) =>
    put(name, rows(name).findIndex((row) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(row)) + 1, line);

  test('ordinary output where the footer was reads unknown, as main read it', () => {
    const lines = [
      '  Step 2',
      '  Version 1.2 Released',
      '  HTTP 200 OK',
      '  Added 2 Files',
      '  Item 2',
      '  Release 2',
      '  NODE22.log',
      '  Python 3.12 · 45%',
      '  Node 22',
      '  3 files edited',
      '  A1',
      '  Run Everything',
      '  Report 2 Run Everything',
    ];
    for (const line of lines) {
      const screen = footer('idle', line);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
  });

  test('a model-shaped line missing its closed tokens is not a status row', () => {
    const gpt = footer('idle', '  GPT-5.6 Sol 272K High'); // output text, no `Run Everything`
    expect(read(gpt)).toBe('unknown / unknown');
    expect(model(gpt)).toBeNull();
    const composer = footer('gpt-sol-idle', '  Composer 2.5');
    expect(read(composer)).toBe('unknown / unknown');
    expect(model(composer)).toBeNull();
    const muse = footer('idle', '  Muse Spark 1.3                    Run Everything'); // family unknown
    expect(read(muse)).toBe('unknown / unknown');
    expect(model(muse)).toBeNull();
    const big = footer('idle', '  GPT-5.6 Sol 1M High                Run Everything'); // context unknown
    expect(read(big)).toBe('unknown / unknown');
    expect(model(big)).toBeNull();
  });

  test('the version, the quota and the file count are digits in closed runs', () => {
    // The probes: `[\d.]+` read `5..6`, a bare `.` and `4..2%` as tokens — a version,
    // a quota or a file count that no pane draws. The closed runs cannot, on either side: the
    // status line's grammar and the status_model rule.
    const row = (text: string) => `  ${text}${' '.repeat(24)}Run Everything`;
    for (const line of [
      row('GPT-5..6 Sol 272K High'),
      row('Composer .'),
      row('Composer 2.5 · 4..2%'),
      row('Gemini 3.8 Flash · .%'),
      row('Gemini 4..2 Argon High'),
      row('Gemini 4 Argon · .%'),
      row('Composer 2.5 · 12. files edited'),
      row('Composer 2.5.1. High'),
    ]) {
      const screen = footer('idle', line);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
    expect(model(row('GPT-5..6 Sol 272K High'))).toBeNull();
    // A multi-part version and a fractional quota are still closed runs that match.
    const good = footer('idle', row('Composer 2.5.1 · 12.5%'));
    expect(read(good)).toBe('idle / idle');
    expect(model(good)).toEqual({ model: 'Composer', version: '2.5.1' });
  });

  test('a painted running screen stays working, and gains no status row', () => {
    const screen = footer('working', '  Step 2');
    expect(read(screen)).toBe('working / unknown');
    expect(model(screen)).toBeNull();
  });

  test('a running frame with its spinner and ctrl+c removed is unknown, never idle', () => {
    const lines = rows('working')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .map((line) => line.replace(/\s*ctrl\+c to stop\s*$/, ''));
    lines[lines.findIndex((row) => row === GROK)] = '  Step 2';
    const screen = text(lines);
    expect(read(screen)).toBe('unknown / unknown');
    expect(model(screen)).toBeNull();
  });

  test('a finished turn and an exited shell with the footer replaced are unknown', () => {
    expect(read(footer('rules-accepted', '  Step 2'))).toBe('unknown / unknown');
    const exited = put('idle', 12, '  Step 2').split('\n');
    exited[12] = '❯';
    expect(read(text(exited))).toBe('unknown / unknown');
  });

  test('a false footer with no input row above it is unknown', () => {
    const lines = rows('idle').filter((_, i) => i !== 8);
    lines[lines.findIndex((row) => row === GROK)] = '  Step 2';
    expect(read(text(lines))).toBe('unknown / unknown');
  });

  test('the trust dialog closes as trust with output below its anchor', () => {
    expect(read(`${text(rows('trust'))}\n  Step 2`)).toBe('trust / unknown');
    const inside = rows('trust');
    inside.splice(inside.findIndex((row) => /Use arrow keys to navigate, Enter to/.test(row)), 0, '  Step 2');
    expect(read(text(inside))).toBe('trust / unknown');
  });

  test('a quiet follow-up queue reads idle exactly as main read it', () => {
    const lines = rows('follow-up-queue-hint').filter((line) => !/^\s*[⠀-⣿]/.test(line));
    lines.splice(lines.findIndex((row) => /enter interrupt and send/.test(row)) + 1, 0, '  Step 2');
    const screen = text(lines);
    expect(read(screen)).toBe('idle / idle');
    expect(model(screen)).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('prose below the footer leaves the model unread: the row is out of place', () => {
    const prose = `${text(rows('idle'))}\n  GPT-5.6 Sol completed the task`;
    expect(read(prose)).toBe('unknown / unknown');
    // The workspace line is no longer the pane's last non-blank one, so its footer is not the
    // status row and names no model. Main read Grok 4.7 off that footer; a line the pane does
    // not draw as the row is not where the model comes from.
    expect(model(prose)).toBeNull();
  });

  test('a working screen with a line appended stays working and unknown', () => {
    const screen = `${text(rows('working'))}\n  Step 2`;
    expect(read(screen)).toBe('working / unknown');
    // The appended line sits under the workspace line, so the footer above it is not the row:
    // no row, no model.
    expect(model(screen)).toBeNull();
  });

  test('a Grok row the closed grammar does not spell is not a row, whatever main read', () => {
    // Main accepted any leading whitespace before the family (`^\s+Grok\s+[0-9]`). The
    // captures draw exactly two spaces, and the closed grammar keeps only that: a row with
    // one space, three spaces or a tab is ordinary text — no row, no model. The narrowing
    // can only take a reading away, never invent one.
    for (const lead of [' ', '   ', '\t']) {
      const screen = footer('idle', `${lead}Grok 4.7 256K High                 Run Everything`);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
  });

  test('a spoofed row names no model, and the same rows in place still name theirs', () => {
    // A full row below a real footer: the spoof has no workspace line under it, and the real
    // footer's own workspace line is no longer the pane's last — neither is the row.
    expect(model(`${text(rows('gpt-sol-idle'))}\n${GPT_ROW}`)).toBeNull();
    // A full row after the trust dialog's anchor: no workspace line under it.
    expect(model(`${text(rows('trust'))}\n${GPT_ROW}`)).toBeNull();
    // A row in the footer's place with the workspace line removed: not the row.
    expect(model(text(rows('gpt-sol-idle').slice(0, -1)))).toBeNull();
    // A Composer-shaped spoof below a real Grok footer names no model either: a seat running
    // Grok is not renamed by it.
    expect(model(`${text(rows('idle'))}\n${COMPOSER_ROW}`)).toBeNull();
    // The rows that are in place still name their models.
    expect(model(text(rows('gpt-sol-idle')))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(model(`${text(rows('idle'))}\n${GROK}`)).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('a full status row is taken by its position: the lowest one wins', () => {
    const above = rows('idle');
    above.splice(above.findIndex((row) => /^ {2}→/.test(row)) - 2, 0, GROK); // a full row in the transcript
    expect(read(text(above))).toBe('idle / idle'); // the real footer below it wins
    expect(model(text(above))).toEqual({ model: 'Grok', version: '4.7' });
    // Below the real footer the appended row is the status row, and the footer above it reads
    // as text left in the box — main reads it the same way, and it is a position gap, not a row gap.
    const below = `${text(rows('idle'))}\n${GROK}`;
    expect(read(below)).toBe('unsent / unsent');
    expect(model(below)).toEqual({ model: 'Grok', version: '4.7' });
    // The status row needs no workspace line under it, and tolerates exactly one.
    expect(read(text(rows('idle').slice(0, -1)))).toBe('idle / idle');
    expect(read(`${text(rows('idle'))}\n  extra`)).toBe('unknown / unknown');
  });

  test('a full row in the status position is a real row; the model it names is read', () => {
    const gpt = footer('idle', GPT_ROW);
    expect(read(gpt)).toBe('idle / idle');
    expect(model(gpt)).toEqual({ model: 'GPT Sol', version: '5.6' });
    const typed = put('gpt-sol-idle', 9, `  → ${GPT_ROW.slice(2)}`);
    expect(read(typed)).toBe('unsent / unsent');
    expect(model(typed)).toEqual({ model: 'GPT Sol', version: '5.6' });
  });

  test('a new-family row outside the status position is ordinary text, not the row', () => {
    const base = text(rows('gpt-sol-idle'));
    expect(read(base)).toBe('idle / idle'); // the captured frame: the row sits above its workspace line
    // A row in the transcript, above the input row: the footer in place below stays the row,
    // and the screen reads exactly as the capture does.
    const above = rows('gpt-sol-idle');
    above.splice(above.findIndex((row) => /^ {2}→/.test(row)) - 2, 0, GPT_ROW);
    expect(read(text(above))).toBe('idle / idle');
    // No workspace line under the row: it is not in the position, and it reads no row.
    expect(read(text(rows('gpt-sol-idle').slice(0, -1)))).toBe('unknown / unknown');
    // A non-workspace line under the row: same.
    expect(read(put('gpt-sol-idle', rows('gpt-sol-idle').length, '  something else'))).toBe('unknown / unknown');
    // A blank line between the row and the workspace line: the workspace line is not directly
    // below the row, so the row is out of place and the screen reads no row and no model.
    const gapped = rows('gpt-sol-idle');
    gapped.splice(gapped.findIndex((row) => /^ {2}GPT-/.test(row)) + 1, 0, '');
    expect(read(text(gapped))).toBe('unknown / unknown');
    expect(model(text(gapped))).toBeNull();
    // A non-blank line under the workspace line: it is not the pane's last, so neither the
    // footer nor the appended row is in the position.
    expect(read(`${base}\n${GPT_ROW}`)).toBe('unknown / unknown');
    // No input row above the row: the frame is not the capture's, and no row is read.
    const input = rows('gpt-sol-idle').findIndex((row) => /^ {2}→/.test(row));
    expect(read(text(rows('gpt-sol-idle').filter((_, i) => i !== input)))).toBe('unknown / unknown');
  });

  test('the input row sits above the status row within the captured distance', () => {
    // Every composer capture draws the input row three to five rows above the status row
    // (measured over the idle, startup, unsent, working, thinking, queue and typed frames).
    // Five holds, six does not: a row further above is not the input row the frame draws.
    const box = (extra: number) => {
      const lines = rows('gpt-sol-idle');
      const at = lines.findIndex((row) => /^ {2}→/.test(row));
      lines.splice(at + 1, 0, ...Array.from({ length: extra }, () => ''));
      return text(lines);
    };
    expect(read(box(2))).toBe('idle / idle'); // distance five
    expect(read(box(3))).toBe('unknown / unknown'); // distance six
  });

  test('a grammar line that is not the row counts for neither the trust rules nor the working queue', () => {
    // The trust dialog with a full row after its anchor: the row has no workspace line under
    // it, so it is ordinary text — the dialog still closes as trust, as main read it, and the
    // composer reads no row.
    expect(read(`${text(rows('trust'))}\n${GPT_ROW}`)).toBe('trust / unknown');
    // A running screen with the row appended: still working, and the composer reads no row.
    expect(read(`${text(rows('working'))}\n${GPT_ROW}`)).toBe('working / unknown');
  });

  test("a new family's model rule is anchored to the row's own line, both ends", () => {
    // The rule itself, applied to a line, so the anchors are pinned at the rule and not only
    // through a screen: one that lost its start anchor would read a family named mid-sentence
    // as the model, and one that lost its end anchor would read a line that runs on past
    // `Run Everything`. The revealing line is one character and then the row exactly as a
    // capture draws it — the two leading spaces included — so a rule that lost only its `^`
    // still begins with those spaces and matches at the second character.
    const captured = [
      '  GPT-5.6 Sol 272K High              Run Everything',
      '  Gemini 3.8 Flash High              Run Everything',
      '  Gemini 4 Argon High                Run Everything',
      '  Composer 2.5                       Run Everything',
    ];
    for (const row of captured) expect(statusOnLine('cursor', `x${row}`)).toBeNull();
    for (const row of captured) expect(statusOnLine('cursor', `${row} and more`)).toBeNull();
    // And on a screen: those lines in the footer's place are not the row at all, so the
    // composer's own read names no model either.
    expect(model(footer('idle', 'x  GPT-5.6 Sol 272K High              Run Everything'))).toBeNull();
    expect(model(footer('idle', '  GPT-5.6 Sol 272K High              Run Everything and more'))).toBeNull();
  });

  test('the Grok model rule is anchored to the status row', () => {
    // Main's rule was `(?:^|\s)Grok\s+…`: it read a family name wherever a space or a line
    // start preceded it — mid-sentence as readily as in the row's own place. The anchored rule
    // keeps the rows the captures draw and drops prose that is not a row. It also narrows
    // main's leading whitespace: every Grok row the fixtures hold — the thirteen the captures
    // draw and the four the queue fixtures transcribe — carries exactly the two spaces `^  `
    // spells, and one space, three spaces or a tab is refused where main read a model — a
    // fail-closed narrowing, pinned above.
    expect(statusOnLine('cursor', 'x  Grok 4.7 256K High                 Run Everything')).toBeNull();
    expect(model('x Grok 4.7 wrote it')).toBeNull();
    expect(model('  Grok 4.7 wrote this answer in the transcript')).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('one set of expressions, used in the three places', () => {
    const data = screenData('cursor');
    if (!data || data.composer.mode !== 'status-then-one' || !data.trust || !data.working) {
      throw new Error('cursor profile shape changed');
    }
    // The composer's status_line, the trust dialog's none_after and the working queue's
    // exception must hold the same expressions, character for character: the three places
    // that decide whether a line is the status row cannot disagree about which lines those
    // are.
    const status = data.composer.statusLine.map((re) => re.source);
    const trustRows = (data.trust.rules[0]?.noneAfter?.patterns.slice(1) ?? []).map((p) => p.match.source);
    const workingRows = data.working.rules[1]?.noneAfter?.patterns[0]?.except.map((re) => re.source) ?? [];
    expect(trustRows).toEqual(status);
    for (const source of status) expect(workingRows).toContain(source);
    expect(status.some((source) => source.includes('Run Everything'))).toBe(true);
    expect(status.some((source) => source.includes('GPT-'))).toBe(true);
  });
});

describe('the box\'s own border (Cursor)', () => {
  // The 2026-10-05 captures (see the fixtures README): this installed build draws the box
  // between two border rows — one leading space then only the block character, the ` ▄` row
  // directly above the input row and the ` ▀` row directly below the input rows and directly
  // above the status row — where the 2026-10-01 captures draw up to four empty rows above the
  // input row and two under the text. Each frame is read by its own complete shape; the
  // readings below are the captures' own. The bordered box never reads `idle` or `unsent`
  // from anything but these frames.
  const CAPTURES: [string, ReturnType<typeof readScreen>['kind'], ReturnType<typeof readScreen>['kind']][] = [
    ['bordered-idle', 'idle', 'idle'],
    ['bordered-typed-one', 'unsent', 'unsent'],
    ['bordered-typed-three', 'unsent', 'unsent'],
    ['bordered-after-round', 'idle', 'idle'],
    ['bordered-working', 'working', 'unsent'],
    ['bordered-working-typed', 'working', 'unsent'],
    ['bordered-after-exit', 'unknown', 'unknown'],
  ];

  test.each(CAPTURES)('%s reads %s, its composer %s', (name, whole, composer) => {
    const lines = fixture(name).split('\n');
    expect(readScreen('cursor', fixture(name)).kind).toBe(whole);
    expect(classify('cursor', lines).kind).toBe(whole);
    expect(classifyComposer('cursor', lines).kind).toBe(composer);
  });

  test('the frame rows sit directly against the input row and the status row, nowhere else', () => {
    // The captures' own geometry, tied to the readings above: the ` ▄` row is the row directly
    // above the input row, the ` ▀` row the row directly above the status row, both whole rows
    // at one width, and no other row of the screen is border-shaped.
    const lines = fixture('bordered-typed-three').split('\n');
    const input = lines.findIndex((line) => /^ {2}→/.test(line));
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    expect(lines[input - 1]).toMatch(/^ ▄+$/);
    expect(lines[status - 1]).toMatch(/^ ▀+$/);
    expect(lines[status - 1]?.length).toBe(lines[input - 1]?.length);
    const elsewhere = lines.filter((line, i) => /^ [▄▀]+$/.test(line) && i !== input - 1 && i !== status - 1);
    expect(elsewhere).toEqual([]);
  });
});

describe('a border anywhere else stays unknown (Cursor)', () => {
  // Constructed from the registered captures: each screen below keeps a bordered box's own
  // rows and breaks the frame's shape or place, or plants the pair where the captures draw
  // none. Every one fails closed — never `idle`, never `unsent` — so nothing is typed into
  // these screens and no Enter is sent. The 2026-10-01 captures read the same: they hold no
  // border-shaped row at all (the manifest below), so none of these screens is a frame those
  // captures explain either.
  const source = fixture('bordered-typed-one').replace(/\n+$/, '').split('\n');
  const TOP = source.find((line) => /^ ▄+$/.test(line)) ?? '';
  const BOTTOM = source.find((line) => /^ ▀+$/.test(line)) ?? '';
  const top = source.findIndex((line) => /^ ▄+$/.test(line));
  const input = source.findIndex((line) => /^ {2}→/.test(line));
  const bottom = source.findIndex((line) => /^ ▀+$/.test(line));
  const status = source.findIndex((line) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(line));
  const statusLen = (source[status] ?? '').length;
  const text = (lines: string[]) => lines.join('\n');
  const unknown = (screen: string) => {
    expect(readScreen('cursor', screen).kind).toBe('unknown');
    expect(classify('cursor', screen.split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unknown');
  };

  test('one border row missing', () => {
    unknown(text(source.filter((_, i) => i !== input - 1))); // the top row gone
    unknown(text(source.filter((_, i) => i !== bottom))); // the bottom row gone
  });

  test('the rows swapped: ` ▀` above the input, ` ▄` below it', () => {
    const swapped = [...source];
    swapped[input - 1] = BOTTOM;
    swapped[bottom] = TOP;
    unknown(text(swapped));
  });

  test('a border row with another character in it or with text after it', () => {
    const junk = [...source];
    junk[top] = `${TOP.slice(0, 10)}X${TOP.slice(11)}`;
    unknown(text(junk));
    const after = [...source];
    after[bottom] = `${BOTTOM} ok`;
    unknown(text(after));
  });

  test('a border one row away from the input, an empty row between', () => {
    const underTop = [...source];
    underTop.splice(input, 0, '');
    unknown(text(underTop));
    const overBottom = [...source];
    overBottom.splice(bottom, 0, '');
    unknown(text(overBottom));
  });

  test('a border pair in the transcript above an ordinary box', () => {
    // The blank-framed captures with the pair planted in their transcript, well above the box
    // and pressed against it: a border row anywhere but its place is a shape no capture
    // draws, and the read fails closed rather than take the rows under it for a box. Nothing
    // is typed and no Enter is sent.
    const lines = fixture('idle').replace(/\n+$/, '').split('\n');
    const planted = [...lines.slice(0, 4), TOP, BOTTOM, ...lines.slice(4)];
    unknown(text(planted));
    const pressed = [...lines.slice(0, 8), TOP, BOTTOM, ...lines.slice(8)];
    unknown(text(pressed));
    expect(boxHoldsText('cursor', 'Rules.', text(planted))).toBe(false);
    expect(boxHoldsText('cursor', 'Rules.', text(pressed))).toBe(false);
  });

  test('the bordered box with no status row', async () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    const screen = text(lines.filter((_, i) => i !== status));
    unknown(screen);
    const d = delivery('bordered-idle');
    d.showText(screen);
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('the bordered box with a status row of a family the grammar does not know', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    lines[status] = '  Muse Spark 1.3                    Run Everything';
    unknown(text(lines));
  });

  test('a one-character border and short Grok line reads unknown', () => {
    const screen = [' ▄', '  → ', ' ▀', '  Grok 4', '  ~/x'].join('\n');
    unknown(screen);
  });

  test('a four-character border pair around the real placeholder and status row reads unknown', () => {
    const screen = [
      ' ▄▄▄▄',
      '  → Plan, search, build anything',
      ' ▀▀▀▀',
      '  Grok 4.7 256K High                 Run Everything',
      '  <workspace>',
    ].join('\n');
    unknown(screen);
  });

  test('a shell transcript ending in a border pair, prompt line, and Grok-shaped sentence reads unknown', () => {
    const screen = [
      '❯ echo done',
      'done',
      TOP,
      '  → next step is to build',
      BOTTOM,
      '  Grok 4.7 mentioned in the log',
      '  ~/some/path',
    ].join('\n');
    unknown(screen);
  });

  test('a bordered frame with its workspace line removed reads unknown', () => {
    const typedNoWs = source.filter((line) => !line.includes('<workspace>')).join('\n');
    unknown(typedNoWs);
    const idleLines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const idleNoWs = idleLines.filter((line) => !line.includes('<workspace>')).join('\n');
    unknown(idleNoWs);
  });

  test('a bordered frame with its workspace line replaced with non-path reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const ws = lines.findIndex((line) => line.includes('<workspace>'));
    lines[ws] = '  not-a-path';
    unknown(lines.join('\n'));
  });

  test('a bordered frame with its status row cut to Grok 4.7 reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    lines[status] = '  Grok 4.7';
    unknown(lines.join('\n'));
  });

  test('a bordered frame with an extra non-blank line after the workspace reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    lines.push('❯');
    unknown(lines.join('\n'));
  });

  test('border rows of unequal width fail the equal-width check', () => {
    // Both rows match ^ ▄+$ and ^ ▀+$, but differ in length
    const unequalBottom = [...source];
    unequalBottom[bottom] = ' ' + '▀'.repeat(50); // length 51 !== TOP.length (52)
    expect(unequalBottom[bottom].length).toBe(51);
    expect(TOP.length).toBe(52);
    unknown(text(unequalBottom));

    const unequalTop = [...source];
    unequalTop[top] = ' ' + '▄'.repeat(50); // length 51 !== BOTTOM.length (52)
    expect(unequalTop[top].length).toBe(51);
    expect(BOTTOM.length).toBe(52);
    unknown(text(unequalTop));
  });

  test('a border the same length as the status row reads unknown', () => {
    // In every real frame the border row is exactly one character longer than the status row;
    // here both border rows are 51 characters, equal to the 51-character status row.
    const sameLen = [...source];
    sameLen[top] = ' ' + '▄'.repeat(50);
    sameLen[bottom] = ' ' + '▀'.repeat(50);
    expect((sameLen[top] ?? '').length).toBe(statusLen);
    expect((sameLen[bottom] ?? '').length).toBe(statusLen);
    unknown(text(sameLen));
  });

  test('a border two characters longer than the status row reads unknown', () => {
    // Both border rows are 53 characters, two characters longer than the 51-character status row.
    const twoLonger = [...source];
    twoLonger[top] = ' ' + '▄'.repeat(52);
    twoLonger[bottom] = ' ' + '▀'.repeat(52);
    expect((twoLonger[top] ?? '').length).toBe(statusLen + 2);
    expect((twoLonger[bottom] ?? '').length).toBe(statusLen + 2);
    unknown(text(twoLonger));
  });

  test('a border shorter than the status row reads unknown', () => {
    // Both border rows are 50 characters, shorter than the 51-character status row.
    const shorter = [...source];
    shorter[top] = ' ' + '▄'.repeat(49);
    shorter[bottom] = ' ' + '▀'.repeat(49);
    expect((shorter[top] ?? '').length).toBeLessThan(statusLen);
    expect((shorter[bottom] ?? '').length).toBeLessThan(statusLen);
    unknown(text(shorter));
  });

  test('a bottom border with trailing text at the same width', () => {
    // Bottom border carries trailing text matching TOP.length (52 chars):
    // ^ ▀+$ must reject the trailing characters even though the length is identical
    const sameWidth = [...source];
    sameWidth[bottom] = `${BOTTOM.slice(0, 49)} ok`; // 49 block chars + ' ok' = 52 chars
    expect(sameWidth[bottom].length).toBe(TOP.length);
    unknown(text(sameWidth));
  });

  test('border rows with two leading spaces read unknown', () => {
    const twoLeadingTop = [...source];
    twoLeadingTop[top] = '  ' + '▄'.repeat(50);
    unknown(text(twoLeadingTop));

    const twoLeadingBottom = [...source];
    twoLeadingBottom[bottom] = '  ' + '▀'.repeat(50);
    unknown(text(twoLeadingBottom));

    const twoLeadingBoth = [...source];
    twoLeadingBoth[top] = '  ' + '▄'.repeat(50);
    twoLeadingBoth[bottom] = '  ' + '▀'.repeat(50);
    unknown(text(twoLeadingBoth));
  });

  test('a shell transcript catting the complete idle frame with no shell prompt after it reads idle as an accepted boundary', async () => {
    const idleLines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const screen = [
      '❯ cat frame.txt',
      ...idleLines,
    ].join('\n');
    expect(readScreen('cursor', screen).kind).toBe('idle');
    expect(classify('cursor', screen.split('\n')).kind).toBe('idle');

    const withPrompt = `${screen}\n❯`;
    unknown(withPrompt);

    // A shell holding the pane over that screen is never the CLI: the delivery waits it out to
    // the deadline, types nothing into the shell, and gives up naming the reading it saw (the
    // `no-agent` the old whole-paste delivery returned at once is gone with it).
    let clock = 0;
    const typed: string[] = [];
    const refusals: Refusal[] = [];
    const shellIo: Delivery = {
      screen: () => screen,
      status: () => 'idle',
      file: () => true, // never reached: the delivery gives up before anything is typed
      type: (text) => { typed.push(text); return true; },
      enter: () => { typed.push('Enter'); return true; },
      foreground: () => ['zsh'],
      report: (why) => { refusals.push(why); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    };
    expect(await deliverRules('cursor', 'Rules.', 1, shellIo)).toBe(false);
    expect(refusals).toEqual([{ stop: 'launch', typed: false, sent: false, kind: 'idle', row: null, clearKey: 'ctrl+u' }]);
    expect(typed).toEqual([]);
    expect(clock).toBe(1000);
  });
});

describe('a border around a dialog (Cursor)', () => {
  // Each registered dialog with the captures' border rows wrapped around its box rows: the
  // pair is not a dialog's frame, and the composer must not read the dialog's rows under it
  // as an input box. Each still reads exactly what it read before — never `idle`, never
  // `unsent`.
  const WRAPS: [string, RegExp, RegExp][] = [
    ['trust', /^  ╭─+╮$/, /^  ╰─+╯$/],
    ['trust-54', /^  ╭─+╮$/, /^  ╰─+╯$/],
    ['question', /^ ┌─+┐$/, /^ └─+┘$/],
    ['permission-plan', /^━{8,}$/, /^    Reject \(n or esc\)$/],
  ];
  const bordered = fixture('bordered-typed-one').replace(/\n+$/, '').split('\n');
  const TOP = bordered.find((line) => /^ ▄+$/.test(line)) ?? '';
  const BOTTOM = bordered.find((line) => /^ ▀+$/.test(line)) ?? '';
  const wrapped = (name: string, first: RegExp, last: RegExp) => {
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const a = lines.findIndex((line) => first.test(line));
    const b = lines.findIndex((line) => last.test(line));
    if (a < 0 || b < 0) throw new Error(`${name} has no box rows`);
    return [...lines.slice(0, a), TOP, ...lines.slice(a, b + 1), BOTTOM, ...lines.slice(b + 1)].join('\n');
  };

  test.each(WRAPS)('%s with its box rows wrapped reads what it read before', (name, first, last) => {
    const original = fixture(name).split('\n');
    const screen = wrapped(name, first, last);
    const before = `${classify('cursor', original).kind} / ${classifyComposer('cursor', original).kind}`;
    const after = `${classify('cursor', screen.split('\n')).kind} / ${classifyComposer('cursor', screen.split('\n')).kind}`;
    expect(after).toBe(before);
    expect(before).not.toBe('idle / idle');
    expect(before).not.toBe('unsent / unsent');
  });
});

describe('the border inserted around every other capture (Cursor)', () => {
  // The generated set: every Cursor fixture that draws no border — the registered captures of
  // 2026-10-01 through 2026-10-05, the `bordered-` captures excluded because they already
  // draw the frame and are read above — with the captures' border rows inserted around its
  // input rows: the ` ▄` row directly above the input row and the ` ▀` row directly above the
  // status row (directly under the input row where the screen shows no status row), the
  // empty rows they displace being the frame's. Each reads exactly what its original reads —
  // an `idle` original stays `idle`, `working` stays `working`, a dialog stays that dialog —
  // so the border never changes a reading by itself. The dialogs take the item above's wrap;
  // count and result are in the result document.
  const DIR = new URL('../fixtures/cursor/2026.10.01/', import.meta.url);
  const NAMES = readdirSync(DIR)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -'.txt'.length))
    .filter((name) => !name.startsWith('bordered'))
    .sort();
  const bordered = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
  const TOP = bordered.find((line) => /^ ▄+$/.test(line)) ?? '';
  const DIALOGS: Record<string, [RegExp, RegExp]> = {
    trust: [/^  ╭─+╮$/, /^  ╰─+╯$/],
    'trust-54': [/^  ╭─+╮$/, /^  ╰─+╯$/],
    question: [/^ ┌─+┐$/, /^ └─+┘$/],
    'permission-plan': [/^━{8,}$/, /^    Reject \(n or esc\)$/],
  };

  const framed = (name: string, delta = 0) => {
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const input = lines.findLastIndex((line) => /^ {2}→/.test(line));
    const status = lines.findLastIndex((line) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(line));
    // The frame rows sit at the capture's own width: the reader pins the border to the status
    // row beside it, and the registry holds captures of two pane widths (the 53-column bordered
    // day, the 54-column rules day), so one fixed pair cannot fit them all. `delta` moves both
    // rows off that width by the same count, for the wrong-width variants below.
    const width = (status > input ? (lines[status] ?? '').length : TOP.length - 1) + delta;
    const TOP_HERE = ` ${'▄'.repeat(width)}`;
    const BOTTOM_HERE = ` ${'▀'.repeat(width)}`;
    const out = [...lines];
    out[input - 1] = TOP_HERE; // the row above every capture's input row is one of its frame's empty rows
    if (status > input) {
      let last = status - 1;
      while (last > input && (out[last] ?? '').trim() === '') last--;
      out.splice(last + 1, status - 1 - last, BOTTOM_HERE); // the frame's empty rows give way to the row
    } else {
      out.splice(input + 1, 1, BOTTOM_HERE); // no status row: the row sits directly under the input row
    }
    return out.join('\n');
  };

  const withDialogWrap = (name: string, delta = 0) => {
    const [first, last] = DIALOGS[name] ?? [];
    if (!first || !last) return framed(name, delta);
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const a = lines.findIndex((line) => first.test(line));
    const b = lines.findIndex((line) => last.test(line));
    const blocks = TOP.length - 1 + delta; // the wrap rows sit at the bordered day's own width
    return [
      ...lines.slice(0, a),
      ` ${'▄'.repeat(blocks)}`,
      ...lines.slice(a, b + 1),
      ` ${'▀'.repeat(blocks)}`,
      ...lines.slice(b + 1),
    ].join('\n');
  };

  test('every fixture of the set reads what its original reads', () => {
    const differed: string[] = [];
    for (const name of NAMES) {
      const original = fixture(name).split('\n');
      const inserted = withDialogWrap(name).split('\n');
      const before = classify('cursor', original).kind;
      const after = classify('cursor', inserted).kind;
      if (after !== before) differed.push(`${name}: ${before} -> ${after}`);
    }
    expect(differed).toEqual([]);
    expect(NAMES.length).toBe(41);
    expect(NAMES).toContain('idle');
    expect(NAMES).toContain('working');
    expect(NAMES).toContain('trust');
    expect(NAMES).toContain('question');
    expect(NAMES).toContain('permission-plan');
  });

  test('a border one wider or one narrower than the rule allows never widens a reading', () => {
    // The exact-width frames above cannot fail a permissive width rule: every border the
    // helper draws is the status row's own width plus one, so a rule that accepts more
    // accepts them too. The two variants here — the same frame with both border rows one
    // character wider, and one narrower, than the rule allows — are what fails it. Where
    // the reading comes from the frame (an `idle` original, a typed capture whose border
    // sits against a status row) a wrong-width border is not the frame the captures draw
    // and the screen fails closed to `unknown`; where the reading comes from elsewhere —
    // the working rule, a dialog's own rule, a capture that draws no status row — the
    // wrong-width border is inert and the capture's own reading stands. The expectation
    // per capture was established from a run over all 41 and is pinned by the tally.
    const pinned = (name: string) => {
      const lines = fixture(name).replace(/\n+$/, '').split('\n');
      const input = lines.findLastIndex((line) => /^ {2}→/.test(line));
      return lines.findLastIndex((line) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(line)) > input;
    };
    const off: string[] = [];
    const tally: Record<string, number> = {};
    for (const name of NAMES) {
      const original = classify('cursor', fixture(name).split('\n')).kind;
      const expected = original === 'idle' || (original === 'unsent' && pinned(name)) ? 'unknown' : original;
      for (const delta of [1, -1]) {
        const after = classify('cursor', withDialogWrap(name, delta).split('\n')).kind;
        if (after !== expected) off.push(`${name} ${delta > 0 ? 'wider' : 'narrower'}: ${expected} -> ${after}`);
        const key = `${original} -> ${after}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
    }
    expect(off).toEqual([]);
    // The 8 idle and the 19 status-pinned typed captures fail closed both ways; exit-typed
    // draws no status row, so its border is inert and `unsent` stands; the 7 working and
    // the 4 dialog captures read their own reading through a wrong-width border; the 2
    // `unknown` originals stay `unknown`.
    expect(tally).toEqual({
      'idle -> unknown': 16,
      'unsent -> unknown': 38,
      'unsent -> unsent': 2,
      'working -> working': 14,
      'permission -> permission': 2,
      'question -> question': 2,
      'trust -> trust': 4,
      'unknown -> unknown': 4,
    });
  });
});

// The two detectors of the corpus test below, as named helpers so the planted tests can
// run them on built screens. The structural one reads the profile's own patterns through
// `screenData`, so it follows the profile the reader follows: a complete frame is its
// parts in order, found at any position of the screen —
// - the unbordered frame: an empty row, the input row below it, the status row below the
//   input row matching a closed status-row pattern of the profile whole, the workspace
//   line directly below that (the row above the input row must be empty, never a border:
//   a border there hands the frame to the bordered rule, exactly as the reader reads it);
// - the bordered frame: the top border, the input row directly below, the bottom border
//   below the input rows, one character longer than the status row, the status row
//   directly below the border, the workspace line directly below that.
const composerData = screenData('cursor');
if (!composerData || composerData.composer.mode !== 'status-then-one') {
  throw new Error('cursor profile shape changed');
}
const composerFrame = composerData.composer;
const framePrompt = composerFrame.prompt;
const frameWorkspace = composerFrame.statusBelow?.line ?? /$.^/;
const frameTop = composerFrame.border?.top ?? /$.^/;
const frameBottom = composerFrame.border?.bottom ?? /$.^/;
const frameStatusRow = (line: string) =>
  composerFrame.statusLine.some((re) => re.source.startsWith('^') && re.source.endsWith('$') && re.test(line));

const holdsUnborderedFrame = (lines: string[]) => {
  for (let i = 1; i < lines.length; i++) {
    if (!framePrompt.test(lines[i] ?? '') || (lines[i - 1] ?? '').trim() !== '') continue;
    for (let s = i + 1; s < lines.length; s++) {
      const row = lines[s] ?? '';
      if (framePrompt.test(row) || frameTop.test(row) || frameBottom.test(row)) break;
      if (frameStatusRow(row)) {
        if (frameWorkspace.test(lines[s + 1] ?? '')) return true;
        break;
      }
    }
  }
  return false;
};
const holdsBorderedFrame = (lines: string[]) => {
  for (let t = 0; t < lines.length; t++) {
    const top = lines[t] ?? '';
    if (!frameTop.test(top)) continue;
    if (!framePrompt.test(lines[t + 1] ?? '')) continue;
    for (let b = t + 2; b < lines.length; b++) {
      const bottom = lines[b] ?? '';
      if (frameTop.test(bottom)) break;
      if (!frameBottom.test(bottom)) continue;
      const status = lines[b + 1] ?? '';
      if (!frameStatusRow(status)) continue;
      if (bottom.length !== top.length) continue;
      if (bottom.length !== status.length + 1) continue;
      if (frameWorkspace.test(lines[b + 2] ?? '')) return true;
      break;
    }
  }
  return false;
};
const holdsCompleteFrame = (lines: string[]) => holdsUnborderedFrame(lines) || holdsBorderedFrame(lines);

// the reading detector: the reader's own window slid over every tail of the screen,
// reporting the first reading that is neither `unknown` nor the screen's own
const windowReadsOther = (lines: string[], own: string) => {
  for (let tail = 0; tail < lines.length; tail++) {
    const kind = classify('cursor', lines.slice(Math.max(0, tail - 19), tail + 1)).kind;
    if (kind !== own && kind !== 'unknown') return kind;
  }
  return null;
};

const manifestScreens = JSON.parse(readFileSync(new URL('../fixtures/conformance.json', import.meta.url), 'utf8'))
  .screens as Array<{ cli: string; classify: string; file: string }>;
const dialogCaptures = manifestScreens
  .filter((entry) => entry.cli === 'cursor' && ['permission', 'trust', 'question'].includes(entry.classify))
  .map((entry) => ({ ...entry, name: entry.file }));
// A dialog capture is the manifest path (`cursor/<version>/<file>.txt`), every version folder.
// A planted frame is a basename in the 2026-10-01 set.
const captureLines = (name: string) =>
  (name.includes('/')
    ? readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    : fixture(name)
  ).split('\n');
const plantAt = (lines: string[], at: number, part: string[]) => [...lines.slice(0, at), ...part, ...lines.slice(at)];
const plantPositions = (lines: string[]) =>
  [
    ['top', 0],
    ['middle', Math.floor(lines.length / 2)],
    ['end', lines.length],
  ] as const;

describe('a live dialog and a complete idle frame never share a screen (Cursor)', () => {
  // The corpus evidence for the composite reading below: over every registered Cursor
  // capture whose reading is a dialog — permission, trust or question, every version
  // folder, bordered or not — no window reads idle or unsent, and no complete idle frame
  // is present anywhere in the capture. The reading pass is the stronger net: it slides
  // the reader's own window over every tail of the screen (classify sees only the pane's
  // last 20 rows, and a complete frame — bordered or unbordered — is the last structure
  // of exactly the window that ends at the frame's own last row, the grammar allowing
  // nothing after the workspace line but empty rows, so testing every tail position
  // cannot miss a frame any window could read), and it fails for any screen a window
  // could read idle or unsent, complete frame or not — it can only over-report, never
  // pass a capture that holds a frame. The structural pass detects a complete frame, and
  // only that: the frame's parts in order at any position, so an incomplete frame is not
  // reported. While a dialog is live the box is not on the screen.

  test('no window reads idle or unsent (the reading)', () => {
    expect(dialogCaptures.length).toBeGreaterThanOrEqual(4);
    const found: string[] = [];
    for (const entry of dialogCaptures) {
      const lines = captureLines(entry.name);
      const kind = windowReadsOther(lines, entry.classify);
      if (kind !== null) found.push(`${entry.name}: a window reads ${kind}`);
    }
    expect(found).toEqual([]);
  });

  test('no complete frame is present (the structure)', () => {
    const found: string[] = [];
    for (const entry of dialogCaptures) {
      if (holdsCompleteFrame(captureLines(entry.name))) found.push(entry.name);
    }
    expect(found).toEqual([]);
  });
});

describe('the two detectors on a planted frame (Cursor)', () => {
  // The detectors of the corpus test above, run on built screens. A planted frame is the
  // idle capture's own bytes, raw, with the capture's trailing blank row kept: the
  // captures draw the frame with its transcript above it, and a bare frame planted at a
  // dialog capture's end can leave the dialog's own rows in the same 20-row window, where
  // the dialog reading wins — a different screen, not a missed frame.
  test('a complete frame of either kind, planted at the top, the middle or the end of a dialog capture, is reported by both detectors', () => {
    const missed: string[] = [];
    for (const entry of dialogCaptures) {
      const lines = captureLines(entry.name);
      for (const frame of ['bordered-idle', 'idle']) {
        const part = captureLines(frame);
        for (const [pos, at] of plantPositions(lines)) {
          const screen = plantAt(lines, at, part);
          const kind = windowReadsOther(screen, entry.classify);
          if (kind !== 'idle' || !holdsCompleteFrame(screen)) {
            missed.push(`${entry.name} ${frame} @${pos}: reading=${kind} structure=${holdsCompleteFrame(screen)}`);
          }
        }
      }
    }
    expect(missed).toEqual([]);
  });

  // The one incomplete frame the reading pass reports: the unbordered frame without its
  // workspace line still reads idle in a window because the empty-framed reading accepts
  // the Grok status row with no workspace line below it — the reading main already gives.
  // The structural pass reports nothing: the frame is not complete.
  const incompleteRows: Array<[string, string, (row: string) => boolean, string]> = [
    ['idle', 'workspace line', (row) => frameWorkspace.test(row), 'idle'],
    ['idle', 'status row', (row) => frameStatusRow(row), 'none'],
    ['bordered-idle', 'workspace line', (row) => frameWorkspace.test(row), 'none'],
    ['bordered-idle', 'status row', (row) => frameStatusRow(row), 'none'],
    ['bordered-idle', 'top border', (row) => frameTop.test(row), 'none'],
    ['bordered-idle', 'bottom border', (row) => frameBottom.test(row), 'none'],
  ];

  test.each(incompleteRows)('%s with its %s removed holds no complete frame; a window reads %s', (frame, dropped, drop, reading) => {
    const part = captureLines(frame).filter((row) => !drop(row));
    const missed: string[] = [];
    for (const entry of dialogCaptures) {
      const lines = captureLines(entry.name);
      for (const [pos, at] of plantPositions(lines)) {
        const screen = plantAt(lines, at, part);
        const kind = windowReadsOther(screen, entry.classify);
        if (holdsCompleteFrame(screen) || kind !== (reading === 'none' ? null : reading)) {
          missed.push(`${entry.name} @${pos}: structure=${holdsCompleteFrame(screen)} reading=${kind}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe('dialog text and a complete idle frame on one screen (Cursor)', () => {
  // The composites the corpus above never draws, pinned from the run in the result
  // document (raw fixture bytes, the captures' own trailing blank row kept: the working
  // screen's spinner row sits at its window's first row, so one blank row more or less is
  // the difference between its `working` and the frame's `idle`). Old dialog text above a
  // complete frame in place reads what the frame reads — `idle` for the dialog screens:
  // the answer was given and the box was redrawn — and the unbordered column is the
  // reading main already gives, so the bordered frame extends it, nothing more. A frame
  // scrolled above a live dialog never hides the dialog. The live-agent check stays the
  // second layer over both.
  const read = (screen: string) =>
    `${classify('cursor', screen.split('\n')).kind} / ${classifyComposer('cursor', screen.split('\n')).kind}`;

  test.each([
    ['permission-plan', 'bordered-idle', 'idle / idle'],
    ['trust', 'bordered-idle', 'idle / idle'],
    ['question', 'bordered-idle', 'idle / idle'],
    ['working', 'bordered-idle', 'idle / idle'],
    ['permission-plan', 'idle', 'idle / idle'],
    ['trust', 'idle', 'idle / idle'],
    ['question', 'idle', 'idle / idle'],
    ['working', 'idle', 'working / idle'],
  ])('%s above the complete %s frame reads %s', (dialog, frame, expected) => {
    expect(read(fixture(dialog) + fixture(frame))).toBe(expected);
    expect(read(`${fixture(dialog)}\n${fixture(frame)}`)).toBe(expected);
  });

  test.each([
    ['bordered-idle', 'permission-plan', 'permission / unknown'],
    ['bordered-idle', 'trust', 'trust / unknown'],
    ['bordered-idle', 'question', 'question / unknown'],
    ['bordered-idle', 'working', 'working / idle'],
    ['idle', 'permission-plan', 'permission / unknown'],
    ['idle', 'trust', 'trust / unknown'],
    ['idle', 'question', 'question / unknown'],
    ['idle', 'working', 'working / idle'],
  ])('the complete %s frame above the %s dialog reads %s', (frame, dialog, expected) => {
    expect(read(fixture(frame) + fixture(dialog))).toBe(expected);
  });
});

describe('the bordered box read back (Cursor)', () => {
  // The read-back over the three-row capture: the box the reader takes must be the rows
  // between the frame's own rows — the typed text, not the border — so `deliver.ts` reads a
  // bordered box unchanged. The delivery holds one line, exactly as typed (a row break
  // standing for the line's own single space); a multi-row paste is refused, not read.
  const TYPED = ['alpha bordered line one', 'beta bordered line two', 'gamma bordered line three'];
  const TEXT = TYPED.join('\n');

  test('the three-row capture reads unsent and its box is exactly the typed text', () => {
    const screen = fixture('bordered-typed-three');
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unsent');
    expect(readBox('cursor', screen)).toEqual({
      first: 'alpha bordered line one',
      indent: 4,
      rows: ['    beta bordered line two', '    gamma bordered line three'],
      wrap: { continuation: 'text-column', kind: 'word' },
    });
    // The one-line read-back holds single lines: a multi-row paste is not a delivery target,
    // so the three rows together no longer read back as one held text — the frame's box still
    // reads them row for row (readBox above), and one row still holds (below).
    expect(boxHoldsText('cursor', TEXT, screen)).toBe(false);
    expect(boxHoldsText('cursor', 'alpha bordered line one', fixture('bordered-typed-one'))).toBe(true);
  });

  test('another text is refused', () => {
    expect(boxHoldsText('cursor', `${TEXT}\nand one more`, fixture('bordered-typed-three'))).toBe(false);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, fixture('bordered-typed-three'))).toBe(false);
    expect(boxHoldsText('cursor', NUDGE_TEXT, fixture('bordered-typed-three'))).toBe(false);
  });

  test('rules delivery types the one line into the bordered box, reads it back and enters', async () => {
    const d = delivery('bordered-idle');
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(borderedBox(wordWrap(text, 47)));
      return true;
    };
    expect(await deliverRules('cursor', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test('a multi-row paste is refused at the read-back, typed and not sent', async () => {
    const d = delivery('bordered-idle');
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(borderedBox(text.split('\n')));
      return true;
    };
    expect(await deliverRules('cursor', TEXT, 1, d.io)).toBe(false);
    expect(d.refusals).toEqual([{ stop: 'read-back', typed: true, sent: false, kind: 'unsent', row: 'beta bordered line two', clearKey: 'ctrl+u' }]);
    expect(d.calls).toEqual([TEXT]);
  });
});
