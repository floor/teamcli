// Independent coverage of the packaged-delivery boundary around a finished turn's frame. The
// retained frame is Atlas's RC2 observation (sanitized fixture; the pane carries no CLI version
// marker): a connection-lost sentence, a blank margin, the completion row, a right-aligned update
// notice, the labelled composer rule and an empty prompt. Delivery reads that frame idle and
// types the rules line once — the one scenario where input is owed.
//
// A milestone review measured the counterexample: the same retained layout with only the
// completion row removed, its blank margin and update notice left in place. No completion has
// ended the turn there, so the provider-error sentence is still live; the screen must read
// provider error and delivery must type nothing, press no Enter, and report that reading.
// Removing the update notice as well must refuse the same way. The remaining controls are the
// shapes a delivery refuses without input: an error contiguous with the box, a permission dialog,
// a running turn, a draft in the box, an error after a completion, a working status and an
// unrecognized screen.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deliverRules, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { dialogKind } from '../../src/send/deliver.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { claudeBox } from '../helpers.ts';

const FIXTURE = readFileSync(
  new URL('../fixtures/claude-code/completed-error-empty-box-atlas.txt', import.meta.url),
  'utf8',
);
const PERMISSION = readFileSync(
  new URL('../fixtures/claude-code/2.1.289/permission-create-plain.txt', import.meta.url),
  'utf8',
);
const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Cooked for 5m 51s · done 4:49 AM';
const NOTICE = '✔ Update installed · Restart to update';
const RULES = 'Synthetic rules.';

/** The frame without exactly one row: how the counterexample removes the completion row. */
function withoutRow(screen: string, row: string): string {
  const rows = screen.split('\n');
  const at = rows.indexOf(row);
  if (at < 0) throw new Error(`the screen carries no row ${JSON.stringify(row)}`);
  rows.splice(at, 1);
  return rows.join('\n');
}

/** The frame without its right-aligned update notice. */
function withoutNotice(screen: string): string {
  const rows = screen.split('\n');
  const kept = rows.filter((row) => !row.includes(NOTICE));
  if (kept.length === rows.length) throw new Error('the screen carries no update notice');
  return kept.join('\n');
}

/** The frame with text in its input row, spelled with the prompt's own separator: the fixture
 *  draws a bare `❯`, the captured composer slice draws `❯` then a non-breaking space. */
function withDraft(screen: string, text: string): string {
  const rows = screen.split('\n');
  const at = rows.findIndex((row) => row === '❯' || row === '❯ ');
  if (at < 0) throw new Error('the screen has no empty input row');
  rows[at] = rows[at] === '❯' ? `❯ ${text}` : `❯ ${text}`;
  return rows.join('\n');
}

type Ran = {
  read: Screen['kind'];
  result: boolean | 'no-agent';
  typed: string[];
  entered: number;
  refusals: Refusal[];
  clock: number;
};

/** Rules delivery against a pane that stands at `screen`: a pane that would take the input draws
 *  the typed draft, and Enter submits it into a running turn. A refusal must reach none of that,
 *  which the `typed`/`entered` readings make visible. */
async function deliver(screen: string, status = 'idle'): Promise<Ran> {
  let current = screen;
  let word = status;
  let clock = 0;
  const typed: string[] = [];
  let entered = 0;
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => current,
    status: () => word,
    foreground: () => ['claude'],
    file: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    report: (why) => { refusals.push(why); },
    type: (text) => { typed.push(text); current = withDraft(screen, text); return true; },
    enter: () => { entered += 1; current = FIXTURE; word = 'working'; return true; },
  };
  const result = await deliverRules('claude-code', RULES, 1, io);
  return { read: readScreen('claude-code', screen).kind, result, typed, entered, refusals, clock };
}

describe('the completed frame and the retained layout around it', () => {
  test('the fixture keeps the margin and notice the counterexample is about', () => {
    const rows = FIXTURE.split('\n');
    const done = rows.indexOf(DONE);
    expect(done).toBeGreaterThan(0);
    expect(rows[done - 1]).toBe('');
    expect(rows[done + 1]).toContain(NOTICE);
    expect(rows).toContain(`⏺ ${LOST}`);
  });

  test('the completed frame delivers once: an ended turn is history above a ready box', async () => {
    const ran = await deliver(FIXTURE);
    expect(ran.read).toBe('idle');
    expect(dialogKind('claude-code', FIXTURE)).toBeNull();
    expect(ran.result).toBe(true);
    expect(ran.typed).toEqual([RULES]);
    expect(ran.entered).toBe(1);
    expect(ran.refusals).toEqual([]);
  });

  test('the retained layout without its completion row is a provider error and takes no input', async () => {
    const screen = withoutRow(FIXTURE, DONE);
    expect(screen).not.toContain(DONE);
    // The counterexample is this exact remainder: the blank margin stays beside the notice.
    const rows = screen.split('\n');
    const notice = rows.findIndex((row) => row.includes(NOTICE));
    expect(notice).toBeGreaterThan(0);
    expect(rows[notice - 1]).toBe('');
    const ran = await deliver(screen);
    expect(ran.read).toBe('provider error');
    expect(dialogKind('claude-code', screen)).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals).toHaveLength(1);
    expect(ran.refusals[0]).toMatchObject({
      stop: 'screen', typed: false, sent: false, kind: 'provider error', row: null,
    });
  });

  test('the same layout without its update notice refuses the same way', async () => {
    const screen = withoutNotice(withoutRow(FIXTURE, DONE));
    expect(screen).not.toContain(NOTICE);
    const ran = await deliver(screen);
    expect(ran.read).toBe('provider error');
    expect(dialogKind('claude-code', screen)).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals).toHaveLength(1);
    expect(ran.refusals[0]).toMatchObject({
      stop: 'screen', typed: false, sent: false, kind: 'provider error', row: null,
    });
  });
});

describe('the caution controls around that frame', () => {
  test('an error contiguous with the box refuses the whole window', async () => {
    const screen = [LOST, '─'.repeat(40), '❯', '─'.repeat(40)].join('\n');
    const ran = await deliver(screen);
    expect(ran.read).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'provider error' });
  });

  test('a permission dialog is its owner\'s, never the delivery\'s', async () => {
    const ran = await deliver(PERMISSION);
    expect(ran.read).toBe('permission');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'permission' });
  });

  test('a running turn refuses at once and types nothing', async () => {
    const ran = await deliver(FIXTURE.replace(DONE, `${DONE}\n  esc to interrupt`));
    expect(ran.read).toBe('working');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'working', kind: 'working', typed: false, sent: false });
  });

  test('a draft in the box is left alone, never typed over', async () => {
    const ran = await deliver(withDraft(FIXTURE, 'owner draft'));
    expect(ran.read).toBe('unsent');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'leftover', kind: 'unsent', typed: false, sent: false });
  });

  test('an error after the completion is fresh, not history', async () => {
    const ran = await deliver(FIXTURE.replace(DONE, `${DONE}\n${LOST}`));
    expect(ran.read).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'provider error' });
  });

  test('a completion quoted in prose does not end the turn', async () => {
    const screen = [LOST, `⏺ The log said "${DONE}"`, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    const ran = await deliver(screen);
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'provider error' });
  });

  test('an indented completion row does not end the turn', async () => {
    const screen = [LOST, `  ${DONE}`, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    const ran = await deliver(screen);
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'provider error' });
  });

  test('a malformed completion row does not end the turn', async () => {
    const screen = [LOST, '✻ Cooked for 5m 51s · done soon', claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    const ran = await deliver(screen);
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'provider error' });
  });

  test('an old error above its own completion stays history', async () => {
    const screen = [LOST, DONE, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', screen)).toBeNull();
    const ran = await deliver(screen);
    expect(ran.result).toBe(true);
    expect(ran.typed).toEqual([RULES]);
    expect(ran.entered).toBe(1);
    expect(ran.refusals).toEqual([]);
  });

  test('a blank margin over its own completion does not make the old error live', async () => {
    const screen = [LOST, '', DONE, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
    const ran = await deliver(screen);
    expect(ran.result).toBe(true);
    expect(ran.typed).toEqual([RULES]);
    expect(ran.entered).toBe(1);
    expect(ran.refusals).toEqual([]);
  });

  test('a working status refuses even over an idle-looking frame', async () => {
    const ran = await deliver(FIXTURE, 'working');
    expect(ran.read).toBe('idle');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals[0]).toMatchObject({ stop: 'working', kind: 'working' });
  });

  test('an unrecognized screen waits its deadline out and refuses with nothing typed', async () => {
    const ran = await deliver('unrecognized screen');
    expect(ran.read).toBe('unknown');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.clock).toBeGreaterThanOrEqual(1000);
    expect(ran.refusals[0]).toMatchObject({ stop: 'screen', kind: 'unknown' });
  });
});
