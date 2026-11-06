// C7.8: a Codex pane scrolled back over its transcript hides the composer and draws its footer
// on the pane's last row; the wake reads it as idle-but-scrolled, sends the profile's own
// return-to-prompt key once, re-reads, and only then applies every guard it always applies. An
// unrecognised screen behind a due message tells the lead within 2N — past 2N too, and whatever
// the terminal host's status word says. The scroll-back frame is synthetic
// (`fixtures/codex/0.161.0/scroll-back.txt`): the footer row was reported from a live seat, no
// pane was captured. No CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { readRecord, signRecord } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost, type TypedWakeResult } from '../src/send/typed-wake.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import type { Live } from '../src/status/compare.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { classifyComposer, readScreen, screenWord } from '../src/watch/screen.ts';
import { reportUnreadDrops, reportedPath, wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const SCROLL_BACK = readFileSync(join(FIXTURES, 'scroll-back.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const EXIT = readFileSync(join(FIXTURES, 'exit.txt'), 'utf8');
const FOOTER = 'New activity · ↓ Back to bottom · esc';
// The same pane without the footer: no composer, no footer, no shape this profile reads.
const NO_FOOTER = SCROLL_BACK.split('\n').filter((line) => !line.startsWith('New activity')).join('\n');
// The second reported layout: the composer stays drawn, its marker above it, and codex's own
// status footer on the last row.
const SCROLL_BACK_MARKER = readFileSync(join(FIXTURES, 'scroll-back-marker.txt'), 'utf8');
const MARKER = '↓ Back to bottom · esc';
// The third screen: the return key has left scroll-back, the composer is drawn with its empty
// placeholder, and the hint codex draws until the next keypress is the last non-blank row.
const ESC_HINT_SCREEN = readFileSync(join(FIXTURES, 'esc-hint.txt'), 'utf8');
const ESC_HINT = 'esc again to edit previous message';
// The fourth screen: with a line in the box codex hides the shortcuts row and draws the
// account's warning on its own last row, under the status row. The bottom region is the
// reported one; the transcript above it is the fixture's own.
const WARNING_SCREEN = readFileSync(join(FIXTURES, 'warning-row.txt'), 'utf8');
const WARNING_LINE = 'Message from the lead. Read it with: team drops --read.';
const WARNING_ROW = '⚠ 1 warning · f2 to view';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const N = 600;
const MIN = 60_000;
const UNREAD = '019a4f61-4000-7000-8000-000000000001';
const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const DELIVERED: TypedWakeResult = {
  delivered: true,
  typed: true,
  tries: 1,
  reason: 'the working screen showed after 1 Enter',
};

/** The idle frame with `text` drawn in place of the grey suggestion. */
function holding(text: string): string {
  return IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

/** The marker frame with its marker row replaced by `row`: the transcript above and the bottom
 *  region below stay the fixture's own, and one row is changed. */
function markerReplaced(row: string): string {
  return SCROLL_BACK_MARKER.split('\n')
    .map((line) => (line.trim() === MARKER ? row : line))
    .join('\n');
}

/** The esc-hint frame with `text` drawn in place of the grey suggestion. */
function hintHolding(text: string): string {
  return ESC_HINT_SCREEN.replace('› Ask Codex to do anything', `› ${text}`);
}

/** The warning-row frame with its line removed from the box: the empty prompt, same bottom. */
function warningIdle(): string {
  return WARNING_SCREEN.replace(`› ${WARNING_LINE}`, '› Ask Codex to do anything');
}

/** The warning-row frame with `row` drawn in place of the warning row. */
function warningReplaced(row: string): string {
  return WARNING_SCREEN.split('\n')
    .map((line) => (line.trim() === WARNING_ROW ? row : line))
    .join('\n');
}

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it.
 *  `key` is bound unless the scene asks for a host without it; a key the host is handed is
 *  recorded before the bookkeeping answers. */
function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
  options: { typeOk?: boolean; enterOk?: boolean; keyOk?: boolean; key?: boolean } = {},
): { host: TypedWakeHost; typed: string[]; keys: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const keys: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return options.typeOk ?? true;
    },
    enter: () => {
      state.enters += 1;
      return options.enterOk ?? true;
    },
    wait: async () => {},
  };
  if (options.key !== false) {
    host.key = (_pane: string, key: string) => {
      keys.push(key);
      return options.keyOk ?? true;
    };
  }
  return {
    host,
    typed,
    keys,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

let base = '';

afterEach(() => {
  if (base !== '') discardFixtures([base], { roots: [tmpdir()] });
  base = '';
});

function teamText(root: string, lobby: string, helperExtra = ''): string {
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
    cli: codex
    vendor: openai
    model: GPT Terra
    version: "0.161.0"
    launch: codex
${helperExtra}`;
}

type World = { root: string; dir: string; home: string };

function world(helperExtra = ''): { made: World; team: ReturnType<typeof validateTeamFile> & { ok: true } } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-scrollback-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(root, lobbyDir(home), helperExtra);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return { made: { root, dir: join(root, '.agents'), home }, team: validated };
}

type Pane = { screen: string | null; status: string | null; typed: string[]; enters: number; keys: string[] };

function pane(screen: string, status: string | null): Pane {
  return { screen, status, typed: [], enters: 0, keys: [] };
}

function typedSources(one: Pane, calls: { pane: string; line: string }[]): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    typedWake: async (paneId, line) => {
      calls.push({ pane: paneId, line });
      return DELIVERED;
    },
  };
}

function live(status: string): Live {
  const agents: HerdrAgent[] = [
    { name: 'helper', agent: 'codex', pane: 'pane-helper', workspace: 'first', status, cwd: null },
    { name: null, agent: 'claude', pane: 'pane-lead', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function seed(made: World, ageMin: number): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', 'helper');
  const at = new Date(NOW.getTime() - ageMin * MIN);
  const record = signRecord({
    kind: 'message',
    id: UNREAD,
    to: 'helper',
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at: at.toISOString(),
    body: 'from the owner\n\nwake me',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: UNREAD,
  }, made.home);
  dropMessage(dropDir, UNREAD, `${JSON.stringify(record, null, 2)}\n`);
  return dropDir;
}

function scene(
  made: World,
  team: { ok: true; team: import('../src/file/types.ts').TeamFile },
  said: string[],
  sources: RetrySources,
  now: Date,
  status: string,
) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: team.team,
    live: live(status),
    ownPane: null,
    sources,
    now,
    say: (text: string) => said.push(text),
  };
}

function leadDrops(dir: string): string[] {
  const dropDir = join(dir, 'send-drops', 'acme', 'lead');
  if (!existsSync(dropDir)) return [];
  return readdirSync(dropDir).filter((name) => MESSAGE_ID.test(name));
}

function leadBody(dir: string): string {
  const ids = leadDrops(dir);
  expect(ids).toHaveLength(1);
  const id = ids[0];
  if (id === undefined) throw new Error('the lead report is missing');
  const read = readRecord(join(dir, 'send-drops', 'acme', 'lead', id), id);
  if (!read.ok || read.record === null) throw new Error('the lead report did not verify');
  return read.record.payload.body;
}

describe('the Codex scroll-back screen reads idle-but-scrolled', () => {
  test('the reported footer on the last row is scroll back, and the word is idle', () => {
    expect(readScreen('codex', SCROLL_BACK).kind).toBe('scroll back');
    expect(screenWord(readScreen('codex', SCROLL_BACK))).toBe('idle');
    // The composer alone still reads nothing: no composer is visible in a scrolled view.
    expect(classifyComposer('codex', SCROLL_BACK.split('\n')).kind).toBe('unknown');
    expect(readScreen('codex', IDLE).kind).toBe('idle');
  });

  test('only the exact footer in the pane’s own footer place reads as scroll back', () => {
    // A near-miss row is not the footer this profile declared.
    expect(readScreen('codex', `${NO_FOOTER}\nNew activity · ↓ Back to bottom\n`).kind).toBe('unknown');
    // A footer-shaped row above the last row is transcript, not the footer.
    const moved = [FOOTER, ...NO_FOOTER.split('\n')].join('\n');
    expect(readScreen('codex', moved).kind).toBe('unknown');
    // Trailing blank rows are dropped before the footer is looked for.
    expect(readScreen('codex', `${SCROLL_BACK}\n\n\n`).kind).toBe('scroll back');
  });
});

describe('the second reported scroll-back layout reads from its bottom region', () => {
  test('the marker above the composer and the status footer on the last row read scroll back', () => {
    expect(readScreen('codex', SCROLL_BACK_MARKER).kind).toBe('scroll back');
    expect(screenWord(readScreen('codex', SCROLL_BACK_MARKER))).toBe('idle');
    // The C7.8 layout still reads the same way: two reported layouts, one reading.
    expect(readScreen('codex', SCROLL_BACK).kind).toBe('scroll back');
    // The composer alone still reads nothing here: the status footer takes the row's place.
    expect(classifyComposer('codex', SCROLL_BACK_MARKER.split('\n')).kind).toBe('unknown');
  });

  test('only the bottom region reads it: a transcript row is never the marker or the footer', () => {
    // A transcript line that merely contains the marker's words is not the marker row.
    expect(readScreen('codex', markerReplaced('  The log printed ↓ Back to bottom · esc before the merge.')).kind).toBe('unknown');
    // An exact marker row is the marker only directly above the composer: one printed row
    // between it and the box, with the same row higher up, is transcript.
    const displaced = markerReplaced('• a row the seat printed').replace(
      '• Merged into the release branch.',
      `• Merged into the release branch.\n\n                                                    ${MARKER}`,
    );
    expect(readScreen('codex', displaced).kind).toBe('unknown');
    // A footer-shaped row is the footer only on the last non-blank row.
    expect(readScreen('codex', `${SCROLL_BACK_MARKER}\n• a row the seat printed\n`).kind).toBe('unknown');
    // ...and only as the whole row: a near miss is no reading.
    expect(readScreen('codex', SCROLL_BACK_MARKER.replace('Earlier messages available.', 'Earlier messages are available.')).kind).toBe('unknown');
    expect(readScreen('codex', SCROLL_BACK_MARKER.replace('? shortcuts', '? shortcuts now')).kind).toBe('unknown');
  });

  test('a working turn above the marker keeps its caution reading', () => {
    // The turn's own row sits in the pane's last rows, where the window reads it: the caution
    // stage wins before the bottom region is asked.
    const working = markerReplaced(`• Working (0s • esc to interrupt)\n\n                                                    ${MARKER}`);
    expect(readScreen('codex', working).kind).toBe('working');
  });
});

describe('the esc hint under an empty composer reads idle', () => {
  test('the reported hint on the last row, under the drawn empty prompt, reads idle', () => {
    expect(readScreen('codex', ESC_HINT_SCREEN).kind).toBe('idle');
    expect(screenWord(readScreen('codex', ESC_HINT_SCREEN))).toBe('idle');
    // The composer alone reads the idle prompt: the hint is the pane's own row under the status
    // row, not text in the box.
    expect(classifyComposer('codex', ESC_HINT_SCREEN.split('\n')).kind).toBe('idle');
  });

  test('only the exact hint on the last non-blank row, under an empty composer, is the hint', () => {
    // A near miss is no chrome row: the composer read stays unknown.
    expect(readScreen('codex', ESC_HINT_SCREEN.replace(ESC_HINT, 'esc again to edit the previous message')).kind).toBe('unknown');
    expect(readScreen('codex', ESC_HINT_SCREEN.replace(ESC_HINT, `${ESC_HINT} now`)).kind).toBe('unknown');
    // A row under the hint means the hint is not the last non-blank row.
    expect(readScreen('codex', `${ESC_HINT_SCREEN}\n• a row the seat printed\n`).kind).toBe('unknown');
    // Trailing blank rows are dropped; the hint stays the last non-blank row.
    expect(readScreen('codex', `${ESC_HINT_SCREEN}\n\n\n`).kind).toBe('idle');
    // The hint as the last row with no composer and no status row is no prompt at all.
    expect(readScreen('codex', `• a row the seat printed\n  ${ESC_HINT}\n`).kind).toBe('unknown');
  });

  test('a composer holding text is not the empty prompt, hint or no hint', () => {
    const draft = hintHolding('a draft I did not write');
    expect(readScreen('codex', draft).kind).toBe('unsent');
    expect(readScreen('codex', draft).kind).not.toBe('idle');
  });

  test('a transcript line quoting the hint is never the hint row', () => {
    // The phrase in the transcript does not turn a scrolled-back pane into an idle prompt.
    const quoted = SCROLL_BACK_MARKER.replace(
      '• Merged into the release branch.',
      `• the pane printed “${ESC_HINT}”`,
    );
    expect(readScreen('codex', quoted).kind).toBe('scroll back');
    // The same quote above the prompt leaves the ordinary idle prompt idle: the hint is not
    // read from the transcript.
    const idleWithQuote = IDLE.replace(
      '› Ask Codex to do anything',
      `• the pane printed “${ESC_HINT}”\n\n› Ask Codex to do anything`,
    );
    expect(readScreen('codex', idleWithQuote).kind).toBe('idle');
  });
});

describe('the account warning on its own row under the status line reads the composer', () => {
  test('the reported line above the warning row reads unsent', () => {
    expect(readScreen('codex', WARNING_SCREEN).kind).toBe('unsent');
    expect(classifyComposer('codex', WARNING_SCREEN.split('\n')).kind).toBe('unsent');
    // The box holds exactly the line the wake typed: the trailing warning is chrome, not text.
    expect(boxHoldsText('codex', WARNING_LINE, WARNING_SCREEN)).toBe(true);
  });

  test('the empty prompt above the warning row reads idle', () => {
    const frame = warningIdle();
    expect(readScreen('codex', frame).kind).toBe('idle');
    expect(classifyComposer('codex', frame.split('\n')).kind).toBe('idle');
  });

  test('only the exact warning row, as the last non-blank row under the status row, is chrome', () => {
    // A near miss is no chrome row, and the layout is not the composer's.
    expect(readScreen('codex', warningReplaced('⚠ 1 warning · f2 to close view')).kind).toBe('unknown');
    expect(readScreen('codex', warningReplaced('notice: ⚠ 1 warning · f2 to view')).kind).toBe('unknown');
    // A row under the warning row means it is not the one trailing chrome row.
    expect(readScreen('codex', `${WARNING_SCREEN}• a row the seat printed\n`).kind).toBe('unknown');
    // Trailing blank rows are dropped; the warning row stays the last non-blank row.
    expect(readScreen('codex', `${WARNING_SCREEN}\n\n\n`).kind).toBe('unsent');
    // The warning row with no status row above it is no composer at all.
    expect(readScreen('codex', `• a row the seat printed\n  ${WARNING_ROW}\n`).kind).toBe('unknown');
  });

  test('a transcript row quoting the warning is never the chrome row', () => {
    // The exact row higher up the transcript does not stand in for the trailing row: with the
    // trailing row the seat's own, the screen is not the composer's layout.
    const quotedHigher = warningReplaced('• a row the seat printed').replace(
      '• The changelog matches the notes; no other change is listed.',
      `• The changelog matches the notes; no other change is listed.\n\n                                ${WARNING_ROW}`,
    );
    expect(readScreen('codex', quotedHigher).kind).toBe('unknown');
    // A sentence quoting the row leaves the reading as it was: the phrase is transcript, and the
    // warning row under the status row is still the one chrome row.
    const idleWithQuote = warningIdle().replace(
      '› Ask Codex to do anything',
      `• the pane printed “${WARNING_ROW}”\n\n› Ask Codex to do anything`,
    );
    expect(readScreen('codex', idleWithQuote).kind).toBe('idle');
  });

  test('the typed wake presses Enter into the line under the warning row, and no other key', async () => {
    // The opening reads are the same bottom region over the empty prompt; after the typing the
    // box holds the line and codex draws the warning under the status row.
    const screens = [warningIdle(), warningIdle(), WARNING_SCREEN, WARNING_SCREEN, WORKING];
    const wake = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
    const out = await deliverTypedWake(wake.host, 'pane-1', WARNING_LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.keys).toEqual([]);
    expect(wake.typed).toEqual([WARNING_LINE]);
    expect(wake.enters).toBe(1);
  });
});

describe('the typed wake returns to the prompt, then keeps every guard', () => {
  test('the scroll-back footer is escaped once, then two idle reads and the guarded Enter deliver', async () => {
    const screens = [SCROLL_BACK, IDLE, IDLE, holding(LINE), holding(LINE), WORKING];
    const wake = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters).toBe(1);
  });

  test('the marker layout is escaped once, then two idle reads and the guarded Enter deliver', async () => {
    const screens = [SCROLL_BACK_MARKER, IDLE, IDLE, holding(LINE), holding(LINE), WORKING];
    const wake = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters).toBe(1);
  });

  test('a working turn under the footer reads working, and the wake sends no key', async () => {
    const frame = `${WORKING}\n${FOOTER}\n`;
    expect(readScreen('codex', frame).kind).toBe('working');
    const wake = wakeFake(() => frame);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the first read showed working, not an empty idle prompt; nothing was typed',
    });
    expect(wake.keys).toEqual([]);
    expect(wake.typed).toEqual([]);
  });

  test('a draft shown after the return refuses with the key sent and no wake line', async () => {
    const draft = holding('a draft I did not write');
    const wake = wakeFake((read) => (read === 0 ? SCROLL_BACK : draft));
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read unsent after the return key, not an empty idle prompt; no wake line was typed',
    });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });

  test('a host with no return key refuses without a key', async () => {
    const wake = wakeFake(() => SCROLL_BACK, { key: false });
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the screen is scrolled back and no return key is bound; nothing was typed',
    });
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });

  test('a return key the pane does not take refuses, and no wake line is typed', async () => {
    const wake = wakeFake(() => SCROLL_BACK, { keyOk: false });
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the pane did not take the return key; nothing was typed',
    });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });
});

describe('the wake returns through the esc hint with exactly one key', () => {
  test('the hint screen after the return is idle: two idle reads and the guarded Enter deliver, one esc', async () => {
    // The live shape: the marker layout, one esc, the third screen on both idle reads (the hint
    // stands until the next keypress, which is the line the wake types).
    const screens = [SCROLL_BACK_MARKER, ESC_HINT_SCREEN, ESC_HINT_SCREEN, holding(LINE), holding(LINE), WORKING];
    const wake = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters).toBe(1);
  });

  test('the footer layout returns through the same hint screen, one esc', async () => {
    const screens = [SCROLL_BACK, ESC_HINT_SCREEN, ESC_HINT_SCREEN, holding(LINE), holding(LINE), WORKING];
    const wake = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters).toBe(1);
  });

  test('a return that does not reveal the prompt never presses the key a second time', async () => {
    // The pane still reads scroll back after the one return: a second esc would open codex's
    // edit-previous-message, so the wake refuses with the one key sent.
    const wake = wakeFake(() => SCROLL_BACK_MARKER);
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read scroll back after the return key, not an empty idle prompt; no wake line was typed',
    });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });

  test('an unrecognised screen after the return refuses with the one key sent', async () => {
    // The pre-C7.8e third screen: nothing is typed into a screen the profile cannot read, and
    // the wake never answers an unknown screen with esc.
    const wake = wakeFake((read) => (read === 0 ? SCROLL_BACK_MARKER : NO_FOOTER));
    const out = await deliverTypedWake(wake.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read unknown after the return key, not an empty idle prompt; no wake line was typed',
    });
    expect(wake.keys).toEqual(['escape']);
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });
});

describe('an unrecognised screen for a due message tells the lead', () => {
  test('past 2N: the notice still fires, and the 2N report does not speak a second time', async () => {
    // N=60: 2N is two minutes, and the message is eleven minutes old.
    expect(readScreen('codex', NO_FOOTER).kind).toBe('unknown');
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(NO_FOOTER, 'idle');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'idle'), { unreadAfter: 60 });
    expect(calls).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('delivered-but-blocked');
    expect(leadBody(made.dir)).toContain('unknown');
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);

    const reported: string[] = [];
    reportUnreadDrops(scene(made, team, reported, typedSources(one, calls), NOW, 'idle'), { unreadAfter: 60 });
    expect(reported).toEqual([]);
    expect(leadDrops(made.dir)).toHaveLength(1);
    expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(false);
  });

  test('whatever the terminal host’s word says', async () => {
    const { made, team } = world();
    seed(made, 11);
    expect(readScreen('codex', EXIT).kind).toBe('unknown');
    const one = pane(EXIT, 'unknown');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'unknown'), { unreadAfter: N });
    expect(calls).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('delivered-but-blocked');
    expect(leadBody(made.dir)).toContain('unknown');
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ outcome: 'delivered-but-blocked', via: 'lead-report' });
    }
  });

  test('a scrolled-back seat behind a due message is woken, not reported', async () => {
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK, 'idle');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'idle'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]?.outcome).toBe('delivered (typed wake)');
    }
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('a scrolled-back seat whose host word is unknown is woken, not dropped', async () => {
    // herdr does not read the scroll-back footer as an idle prompt, so a pane sitting at its own
    // prompt behind the scroll can carry `unknown`. The screen reading decides for the typed
    // retry: the wake sends the return key itself and reads the box again before typing.
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK, 'unknown');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'unknown'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('a scrolled-back seat whose host word is null is woken, not dropped', async () => {
    // The status source answers null when it cannot name the pane's state at all, even though
    // the pane was listed a moment earlier. Null is neither working nor blocked, so the
    // scrolled-back reading reaches the typed retry and the retry's own reads decide.
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK, null);
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'unknown'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('the marker layout behind a due message is woken, not reported', async () => {
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK_MARKER, 'idle');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'idle'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('the marker layout whose host word is unknown is woken, not dropped', async () => {
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK_MARKER, 'unknown');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'unknown'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('the marker layout whose host word is null is woken, not dropped', async () => {
    const { made, team } = world();
    const dropDir = seed(made, 11);
    const one = pane(SCROLL_BACK_MARKER, null);
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'unknown'), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    expect(leadDrops(made.dir)).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
  });

  test('a scrolled-back screen under a working host word is not woken', async () => {
    // A word of working keeps its veto: the typing waits rather than pressing into a turn.
    const { made, team } = world();
    seed(made, 11);
    const one = pane(SCROLL_BACK, 'working');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'working'), { unreadAfter: N });
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });

  test('with the typed retry off, a scrolled-back pane types nothing and reports no dialog', async () => {
    const { made, team } = world('    watch_wake: off\n');
    seed(made, 11);
    const one = pane(SCROLL_BACK, 'idle');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(one, calls), NOW, 'idle'), { unreadAfter: N });
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
    expect(leadDrops(made.dir)).toEqual([]);
  });
});
