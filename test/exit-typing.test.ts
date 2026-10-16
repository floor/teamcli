// `typeExit` over real screens: it types the exit text once into an idle box and presses the
// Enter on the second reading only — the box that reads back as exactly the typed text — never
// on the reading taken the instant after the send, which is still the idle screen because the
// pane has not drawn the text yet. The screens below are captures from a live pane (plain
// claude, codex and cursor-agent under herdr 0.7.1), except three constructed boundary screens
// named as constructed in test/fixtures/exit-typing/README.md, which says how each file was
// taken, built and what the box holds.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripSgr } from '../src/ansi.ts';
import { type ExitIo, typeExit } from '../src/commands/down.ts';
import { boxHoldsOther, boxHoldsText } from '../src/launch/deliver.ts';
import { exitConfirmKey, profileFor } from '../src/profiles/profile.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { readScreen, screenData } from '../src/watch/screen.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/exit-typing/${name}`, import.meta.url), 'utf8');
const exitText = (cli: string): string => profileFor(cli)?.exit ?? '';

/** An ordinary question of the same CLI — the agent's own, out of the fixtures the reader
 *  already reads — so the exit question's kind can be shown not to swallow it. */
const ordinaryQuestion = readFileSync(new URL('./fixtures/claude-code/2.1.289/question-ansi.txt', import.meta.url), 'utf8');

/** The three CLIs' captured pairs: the reading the instant after `/exit` is sent, and the
 *  reading about two seconds later with the box holding exactly the text. */
const CAPTURED = [
  { cli: 'claude-code', binary: 'claude', idle: 'claude-code-idle-ansi.txt', unsent: 'claude-code-unsent-ansi.txt' },
  { cli: 'codex', binary: 'codex', idle: 'codex-idle-ansi.txt', unsent: 'codex-unsent-ansi.txt' },
  { cli: 'cursor', binary: 'cursor-agent', idle: 'cursor-idle-ansi.txt', unsent: 'cursor-unsent-ansi.txt' },
] as const;

/** A Claude Code seat holding background work: the same pair, with the CLI's own `1 shell still
 *  running` (or a scheduled task) over the box. */
const BACKGROUND = [
  { idle: 'claude-code-shell-idle-ansi.txt', unsent: 'claude-code-shell-unsent-ansi.txt' },
  { idle: 'claude-code-scheduled-idle-ansi.txt', unsent: 'claude-code-scheduled-unsent-ansi.txt' },
] as const;

/** A key that was sent, with the reading that was on the screen at the moment it went out. */
type Sent = { key: string; kind: string; holds: boolean };

/** One pane whose screen follows its two captures: `before` until the exit text has been typed
 *  and the pane has drawn it — herdr's `send-text` returns before the pane renders, so the
 *  drawing is the sleep — and `after` from then on. `status()` is herdr's own reading and stays
 *  resting; `foreground()` is what `pane process-info` answers for a seat launched by name
 *  (`"argv0":"claude"`), which is the caller check every key waits for. `opts` lets a case move
 *  the seat while the pane is drawing — the window the caller check has to survive — and `types`
 *  records every typing that went out, so a case can show one did not. */
function paneOf(
  cli: string,
  binary: string,
  before: string,
  after: string,
  opts: { foreground?: (drawn: boolean) => string[]; status?: (drawn: boolean) => string } = {},
): { io: ExitIo; sent: Sent[]; types: string[] } {
  const text = exitText(cli);
  let typed = false;
  let drawn = false;
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const types: string[] = [];
  const screen = () => (typed && drawn ? after : before);
  const send = (key: string): boolean => {
    sent.push({
      key,
      kind: readScreen(cli, screen(), { cwd: io.foregroundCwd?.() ?? undefined, home: io.home }).kind,
      holds: boxHoldsText(cli, text, screen(), { cwd: io.foregroundCwd?.() ?? undefined, home: io.home }),
    });
    return true;
  };
  const io: ExitIo = {
    typeText: (line) => {
      types.push(line);
      typed = true;
      return true;
    },
    sendKey: send,
    pressEnter: () => send('enter'),
    screen,
    status: () => opts.status?.(drawn) ?? 'idle',
    foreground: () => opts.foreground?.(drawn) ?? [binary],
    sleep: async (ms) => {
      drawn = true;
      clock += ms;
    },
    now: () => clock,
  };
  return { io, sent, types };
}

/** One pane whose box already holds exactly the exit text when the run starts — the leftover of
 *  an earlier attempt: `leftover` until the profile's clearing key has gone out and the pane has
 *  drawn the cleared box, then `idle` until the text is typed and drawn, then `leftover` again.
 *  `opts.foreground` can move the seat while the sequence runs — per call and per draw — and
 *  `types` records every typing, as in `paneOf`. */
function leftoverPane(
  cli: string,
  binary: string,
  leftover: string,
  idle: string,
  opts: { foreground?: (drawn: boolean, calls: number) => string[] } = {},
): { io: ExitIo; sent: Sent[]; types: string[] } {
  const text = exitText(cli);
  const key = profileFor(cli)?.exitClear ?? '';
  let cleared = false;
  let typed = false;
  let drawn = false;
  let calls = 0;
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const types: string[] = [];
  const screen = () => {
    if (!cleared || !drawn) return leftover;
    return typed ? leftover : idle;
  };
  const send = (keySent: string): boolean => {
    sent.push({
      key: keySent,
      kind: readScreen(cli, screen(), { cwd: io.foregroundCwd?.() ?? undefined, home: io.home }).kind,
      holds: boxHoldsText(cli, text, screen(), { cwd: io.foregroundCwd?.() ?? undefined, home: io.home }),
    });
    if (keySent === key) cleared = true;
    return true;
  };
  const io: ExitIo = {
    typeText: (line) => {
      types.push(line);
      typed = true;
      return true;
    },
    sendKey: send,
    pressEnter: () => send('enter'),
    screen,
    status: () => 'idle',
    foreground: () => opts.foreground?.(drawn, calls++) ?? [binary],
    sleep: async (ms) => {
      drawn = true;
      clock += ms;
    },
    now: () => clock,
  };
  return { io, sent, types };
}

describe('the captured pairs', () => {
  test('the first reading is the idle screen and the second holds exactly the exit text', () => {
    for (const { cli, idle, unsent } of CAPTURED) {
      const text = exitText(cli);
      expect(readScreen(cli, fixture(idle)).kind).toBe('idle');
      expect(boxHoldsText(cli, text, fixture(idle))).toBe(false);
      expect(readScreen(cli, fixture(unsent)).kind).toBe('unsent');
      expect(boxHoldsText(cli, text, fixture(unsent))).toBe(true);
    }
  });

  for (const { cli, binary, idle, unsent } of CAPTURED) {
    test(`${cli}: the Enter goes out at the second reading and nowhere else`, async () => {
      const pane = paneOf(cli, binary, fixture(idle), fixture(unsent));
      expect(await typeExit(pane.io, cli, exitText(cli))).toBe(true);
      expect(pane.sent).toEqual([{ key: 'enter', kind: 'unsent', holds: true }]);
    });
  }

  for (const { idle, unsent } of BACKGROUND) {
    test(`claude-code with background work: ${unsent} still gets the Enter at its own reading`, async () => {
      const pane = paneOf('claude-code', 'claude', fixture(idle), fixture(unsent));
      expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(true);
      expect(pane.sent).toEqual([{ key: 'enter', kind: 'unsent', holds: true }]);
    });
  }
});

describe('never a key on anything but the exact read-back', () => {
  test('a box holding more than the exit text is reported, not sent into', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-other-text-ansi.txt'));
    expect(readScreen('claude-code', fixture('claude-code-other-text-ansi.txt')).kind).toBe('unsent');
    expect(boxHoldsOther('claude-code', '/exit', fixture('claude-code-other-text-ansi.txt'))).toBe('/exit now');
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: /exit now); nothing more was sent; left running',
    });
    expect(pane.sent).toEqual([]);
  });

  test('a pane that never draws the text is left running with the line that says so', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-idle-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; the pane never drew the typed text; its box is empty; left running',
    });
    expect(pane.sent).toEqual([]);
  });

  // C16: a dialog drawn during the post-typing settle. The text was typed and is in the box, so
  // "its exit was not typed" was the wrong report; the line says what the screen was reading.
  test('a dialog that covers the typed text is reported as typed, not as never typed', async () => {
    const permission = readFileSync(new URL('./fixtures/claude-code/2.1.289/permission-create-ansi.txt', import.meta.url), 'utf8');
    expect(readScreen('claude-code', permission).kind).toBe('permission');
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), permission);
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; the screen was reading permission before the Enter; left running',
    });
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual(['/exit']);
  });

  // The other side of that line: only a dialog the CLI drew over the composer gets it. A screen
  // the reader cannot name proves nothing about where the typed text went — there, the old
  // "not typed" report stands, as the live suite's fail-closed shapes pin.
  test('a screen the reader cannot name keeps the "not typed" report', async () => {
    const gibberish = 'a screen neither profile draws';
    expect(readScreen('claude-code', gibberish).kind).toBe('unknown');
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), gibberish);
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(false);
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual(['/exit']);
  });
});

describe("the CLI's own exit question", () => {
  test('every captured exit question reads as its own kind, and holds no exit text', () => {
    // Two forms, five captures: the two-choice dialog ("2. Stay") of a scheduled task and of a
    // shell; the three-choice dialog ("2. Move to background and exit" / "3. Stay") of the
    // release run's pane and of this profile's own scratch pane holding a shell and a scheduled
    // task at once; and the same dialog drawn clipped by a pane too short for the list.
    for (const name of [
      'claude-code-shell-question-ansi.txt',
      'claude-code-scheduled-question-ansi.txt',
      'claude-code-shell-move-question.txt',
      'claude-code-shell-scheduled-move-question-ansi.txt',
      'claude-code-shell-scheduled-move-question-clipped-ansi.txt',
    ]) {
      const screen = fixture(name);
      expect(readScreen('claude-code', screen).kind).toBe('exit question');
      expect(boxHoldsText('claude-code', '/exit', screen)).toBe(false);
      expect(boxHoldsOther('claude-code', '/exit', screen)).toBe(null);
    }
  });

  test('the three-choice form the release run captured reads as its own kind', () => {
    // The release blocker, from the proof run (briefs/032-proof-main-2.md, section e; copied
    // byte for byte): a seat with a background shell that the CLI can move to the background
    // draws "2. Move to background and exit" between the marked choice and "3. Stay", and the
    // frame rule read it as an ordinary question — no key was sent and the seat was left.
    const screen = fixture('claude-code-shell-move-question.txt');
    expect(screen).toContain('❯ 1. Exit and stop tasks');
    expect(screen).toContain('     2. Move to background and exit');
    expect(screen).toContain('     3. Stay');
    expect(readScreen('claude-code', screen).kind).toBe('exit question');
  });

  test('a seat holding a shell and a scheduled task at once draws the same three-choice question', () => {
    // This profile's own scratch capture (2.1.292): the dialog lists one row per background
    // item — the shell's, and the scheduled task's wrapped over two rows — over the same three
    // choices. Both kinds at once change the task rows, never the frame.
    const screen = fixture('claude-code-shell-scheduled-move-question-ansi.txt');
    // The capture's own bytes: the shell's row carries SGR between "shell" and its dot, so the
    // plain row is asserted by its argument text, which the sequence does not split.
    expect(screen).toContain('sleep 600');
    expect(screen).toContain('Move to background and exit');
    expect(readScreen('claude-code', screen).kind).toBe('exit question');
  });

  test('a pane too short for the list draws the same dialog clipped, and it still reads as its own kind', () => {
    // The same scratch pane under a row budget: the CLI clips the item list to one row and its
    // own `… +1 item` row and draws only the selected choice. The marked row is still the
    // preselected "Exit and stop tasks" — the row the one Enter confirms — so this is the first
    // form, not another dialog.
    const screen = fixture('claude-code-shell-scheduled-move-question-clipped-ansi.txt');
    expect(screen).toContain('… +1 item');
    expect(screen).not.toContain('2. Stay');
    expect(screen).not.toContain('Move to background');
    expect(readScreen('claude-code', screen).kind).toBe('exit question');
  });

  test('ordinary text that quotes the choice row gets the one Enter on the exit text and no second key', async () => {
    const quote = fixture('claude-code-exit-lines-quoted-question.txt');
    expect(readScreen('claude-code', quote).kind).toBe('question');
    expect(quote).toContain('❯ 1. Exit and stop tasks');
    const idle = fixture('claude-code-idle-ansi.txt');
    const unsent = fixture('claude-code-unsent-ansi.txt');
    let phase = 0;
    let clock = 1_000_000;
    const sent: string[] = [];
    const io: ExitIo = {
      typeText: () => {
        phase = 1;
        return true;
      },
      sendKey: (key) => {
        sent.push(key);
        return true;
      },
      pressEnter: () => {
        sent.push('enter');
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? unsent : quote),
      status: () => 'idle',
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    expect(await typeExit(io, 'claude-code', '/exit')).toBe(true);
    expect(sent).toEqual(['enter']);
  });

  // Both forms answer the one Enter the same way: the key is the profile's `exit_confirm`, it
  // lands on the marked first choice, and nothing navigates toward a second row. The exact sent
  // list is the pin — over the three-choice form a 'down' or any other key before the Enter
  // would show here, and the second choice would be confirmed instead of "Exit and stop tasks".
  for (const name of ['claude-code-shell-question-ansi.txt', 'claude-code-shell-move-question.txt']) {
    test(`${name}: the profile key is sent once when the screen reads as the exit question, and a question that stays is reported`, async () => {
      const question = fixture(name);
      expect(readScreen('claude-code', question).kind).toBe('exit question');
      const idle = fixture('claude-code-idle-ansi.txt');
      const unsent = fixture('claude-code-unsent-ansi.txt');
      let phase = 0;
      let clock = 1_000_000;
      const sent: string[] = [];
      const io: ExitIo = {
        typeText: () => {
          phase = 1;
          return true;
        },
        sendKey: (key) => {
          sent.push(key);
          return true;
        },
        pressEnter: () => {
          sent.push('enter');
          phase = 2;
          return true;
        },
        screen: () => (phase === 0 ? idle : phase === 1 ? unsent : question),
        status: () => 'idle',
        foreground: () => ['claude'],
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      };
      expect(profileFor('claude-code')?.exitConfirm).toBe('enter');
      const result = await typeExit(io, 'claude-code', '/exit');
      expect(sent).toEqual(['enter', 'enter']);
      expect(result).toEqual({ left: 'its exit was not confirmed; the exit question stayed open; left running' });
    });
  }

  // The reviewer's reproduction of the fix's fault, as a test: driving `typeExit` against the
  // altered frame sent `['enter', 'enter']` — the second key the confirming Enter, into a frame
  // that is not this dialog. The frame now reads as the ordinary question it is, so the one
  // Enter goes out (it sends the exit text) and no confirming key follows it.
  test('a suffixed tail the rule used to admit gets no confirming key', async () => {
    const frame = fixture('claude-code-exit-question-move-third-suffix.txt');
    expect(frame).toContain('3. Stay — but leave tasks running');
    expect(readScreen('claude-code', frame).kind).toBe('question');
    const idle = fixture('claude-code-idle-ansi.txt');
    const unsent = fixture('claude-code-unsent-ansi.txt');
    let phase = 0;
    let clock = 1_000_000;
    const sent: string[] = [];
    const io: ExitIo = {
      typeText: () => {
        phase = 1;
        return true;
      },
      sendKey: (key) => {
        sent.push(key);
        return true;
      },
      pressEnter: () => {
        sent.push('enter');
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? unsent : frame),
      status: () => 'idle',
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    expect(await typeExit(io, 'claude-code', '/exit')).toBe(true);
    expect(sent).toEqual(['enter']);
  });

  // The confirm key is the same caller check as every other key: the CLI as the pane's foreground
  // process and the question on screen are both read in the same unbroken stretch, right before
  // the key goes out — so a CLI that stopped being it at the question gets no key.
  test('a CLI that is not the foreground process at the question gets no confirm key', async () => {
    const question = fixture('claude-code-shell-question-ansi.txt');
    const idle = fixture('claude-code-idle-ansi.txt');
    const unsent = fixture('claude-code-unsent-ansi.txt');
    let phase = 0;
    let clock = 1_000_000;
    const sent: string[] = [];
    const io: ExitIo = {
      typeText: () => {
        phase = 1;
        return true;
      },
      sendKey: (key) => {
        sent.push(key);
        return true;
      },
      pressEnter: () => {
        sent.push('enter');
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? unsent : question),
      status: () => 'idle',
      foreground: () => (phase === 2 ? ['zsh'] : ['claude']),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    expect(await typeExit(io, 'claude-code', '/exit')).toBe(true);
    expect(sent).toEqual(['enter']);
  });

  test('a pane that draws that question after the typing gets no Enter', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-shell-question-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; the screen was reading exit question before the Enter; left running',
    });
    expect(pane.sent).toEqual([]);
  });
});

describe('the kind is kept apart from the ordinary question', () => {
  test('a question the agent asked still reads as the ordinary question', () => {
    expect(readScreen('claude-code', ordinaryQuestion).kind).toBe('question');
  });

  test('the exit question\'s lines quoted above an ordinary one are prose: it stays ordinary', () => {
    // Built from question-plain.txt with the two lines quoted in the transcript above the box,
    // which carries the common confirmation footer. The three phrases match transcript-wide;
    // only the dialog's own frame may read them, or a stop's Enter would go to this question.
    expect(readScreen('claude-code', fixture('claude-code-exit-lines-quoted-question.txt')).kind).toBe('question');
  });

  test('the quoted lines above a question whose own rule has scrolled out are prose as well', () => {
    // The boundary the first fix still let through: a quote is not enough to tell the kind,
    // because the ordinary question this reader supports with no rule drawn (the shape
    // test/screen-core.test.ts pins) has the shared footer too. Here the quote carries the
    // dialog's two lines and that footer, and the live question follows below; nothing under
    // the quoted choice row but the quote, so the block is not the live dialog and the
    // reading is the ordinary question — before `only_after`, the three phrases matched
    // anywhere and this read `exit question`, and a stop's Enter would have gone into it.
    expect(readScreen('claude-code', fixture('claude-code-exit-lines-quoted-no-rule-question.txt')).kind).toBe('question');
  });

  test('the real exit question below a transcript that quotes it still reads as its own kind', () => {
    // The capture's own dialog, its last 17 lines kept, under a three-line transcript quoting
    // the same two lines: the rule binds the bottom dialog, not the quote.
    expect(readScreen('claude-code', fixture('claude-code-exit-question-below-quote.txt')).kind).toBe('exit question');
  });

  test('a three-row tail whose second row is any other value is an ordinary question', () => {
    // Built from the release run's capture with the middle row renamed to a value no run has
    // drawn. The rule names the two real second rows and nothing else, so a tail it cannot
    // name is not this dialog: it stays the ordinary question it looks like, and a stop's
    // Enter has nowhere to go.
    expect(readScreen('claude-code', fixture('claude-code-exit-question-other-second-row.txt')).kind).toBe('question');
  });

  test('"Move to background and exit" without its "3. Stay" is an ordinary question', () => {
    // The second form is exact on both of its rows. The move row alone, with no last "Stay"
    // under it, is a tail neither form draws — and the one Enter of a stop lands on the marked
    // first choice, never on a "Move to background" row.
    expect(readScreen('claude-code', fixture('claude-code-exit-question-move-without-stay.txt')).kind).toBe('question');
  });

  test('a marked second choice is an ordinary question: the one Enter acts on the marked row alone', () => {
    // The reader takes the marker as the row the confirming key acts on. A dialog whose
    // selection sits on "Move to background and exit" — the value a stop must never confirm —
    // is not the screen this rule reads. It stays an ordinary question, so no key goes out.
    const screen = fixture('claude-code-exit-question-marker-on-move.txt');
    expect(screen).toContain('❯ 2. Move to background and exit');
    expect(readScreen('claude-code', screen).kind).toBe('question');
  });

  // The reviewer's MUST-FIX on 81ae276: every choice row was anchored at its start only, so a
  // row with a suffix still read as this dialog and a stop's confirming Enter went into a frame
  // the rule was meant to reject. Every row of a form is now the whole row — the marked first
  // row, the second row of each form, the third row and the footer — and a suffixed row is the
  // ordinary question it looks like. On the unfixed profile, five of these seven read `exit
  // question` (the two footers, whose comparison was already whole-row, are the exception).
  const SUFFIXED = [
    ['claude-code-exit-question-stay-marked-suffix.txt', '❯ 1. Exit and stop tasks and keep everything'],
    ['claude-code-exit-question-stay-second-suffix.txt', '     2. Stay and delete work'],
    ['claude-code-exit-question-stay-footer-suffix.txt', 'Enter to confirm · Esc to cancel now'],
    ['claude-code-exit-question-move-marked-suffix.txt', '❯ 1. Exit and stop tasks and keep everything'],
    ['claude-code-exit-question-move-second-suffix.txt', '     2. Move to background and exit and keep tasks'],
    ['claude-code-exit-question-move-third-suffix.txt', '     3. Stay — but leave tasks running'],
    ['claude-code-exit-question-move-footer-suffix.txt', 'Enter to confirm · Esc to cancel now'],
  ] as const;
  for (const [name, row] of SUFFIXED) {
    test(`${name}: a row with a suffix is an ordinary question`, () => {
      const screen = fixture(name);
      expect(screen).toContain(row);
      expect(readScreen('claude-code', screen).kind).toBe('question');
    });
  }

  test('the same rows in another order are an ordinary question: no form draws them shuffled', () => {
    // `only_after` reads the tail's rows in the order the form draws them, so the three-choice
    // tail with its last two rows swapped — the rows are the dialog's own, the order is not —
    // is not this dialog either. Before that order read, this frame read `exit question` and a
    // stop would have sent its confirming Enter into it.
    const screen = fixture('claude-code-exit-question-swapped-tail.txt');
    expect(screen.indexOf('     3. Stay')).toBeLessThan(screen.indexOf('     2. Move to background and exit'));
    expect(readScreen('claude-code', screen).kind).toBe('question');
  });

  test('"Move to background and exit" above the marked row is an ordinary question', () => {
    // Round three's hole, from the head it was found against: the tail's rows were matched each
    // on its own line, so the three-choice form's "2. Move to background and exit" lifted above
    // the marked first choice — only "3. Stay" left under it — still read as this dialog and a
    // stop's confirming Enter was sent into it. The block names the rows after its marked row:
    // exactly "2. Stay", or the move row with its "3. Stay", or none. This screen draws the move
    // row before the marked row, which no form does, so it reads `question`. Read on `f65b95b` —
    // the pushed head before the block — this same file reads `exit question`.
    const screen = fixture('claude-code-exit-question-move-above-marked.txt');
    expect(screen.indexOf('     2. Move to background and exit')).toBeLessThan(screen.indexOf('   ❯ 1. Exit and stop tasks'));
    expect(screen.indexOf('   ❯ 1. Exit and stop tasks')).toBeLessThan(screen.indexOf('     3. Stay'));
    expect(readScreen('claude-code', screen).kind).toBe('question');
  });

  // Round three's other half, generated rather than named one screen at a time: each real
  // capture's dialog is changed one row at a time — a row dropped, a row doubled, two rows under
  // each other swapped (the block's first row also with the row over it), a row given a suffix —
  // and what each change leaves must read as the ordinary question it looks like.
  //
  // Which changes may keep the reading is the whole of the block's design, and each is named
  // where it is expected:
  //   * a row the block draws — the title, the "will stop" row, the marked row, a choice row, the
  //     footer — or a blank it draws: a change to one is a screen no form draws;
  //   * a row of the CLI's own work list: its text is not the block's, so a row appended to, two
  //     of its rows swapped or one of several dropped leaves exactly this dialog — the marked row
  //     and the tail the block draws untouched, a stop's Enter still on the same row. A row of
  //     that list doubled is not: nothing in the block is read twice, and it reads `question`;
  //   * the only choice row dropped: what is left — marked row, blank, footer — is exactly the
  //     clipped form a short pane draws, its marked row the same row, so it stays this dialog;
  //   * the footer dropped: no line of the screen carries a footer at all, and it reads
  //     `unknown`, a screen matching no shape — nothing sends a key on it;
  //   * the first row doubled: the copy above the block is a transcript row and the dialog under
  //     it is whole, the reading `claude-code-exit-question-below-quote.txt` pins as well.
  // Every row above the block is swept too, and no change to it reaches the reading: the block is
  // the screen's bottom, and a transcript that quotes the dialog is not the dialog.
  const REAL_BLOCKS = [
    'claude-code-shell-question-ansi.txt',
    'claude-code-scheduled-question-ansi.txt',
    'claude-code-shell-move-question.txt',
    'claude-code-shell-scheduled-move-question-ansi.txt',
    'claude-code-shell-scheduled-move-question-clipped-ansi.txt',
  ] as const;

  /** The rows the block's three forms draw, the footer among them. A non-blank block row outside
   *  this set is a row of the CLI's work list; a blank one is a blank the block draws. */
  const DRAWN = new Set([
    'Background work is running',
    'The following will stop when you exit:',
    '❯ 1. Exit and stop tasks',
    '2. Stay',
    '2. Move to background and exit',
    '3. Stay',
    'Enter to confirm · Esc to cancel',
  ]);
  const CHOICES = new Set(['2. Stay', '2. Move to background and exit', '3. Stay']);
  const TITLE = 'Background work is running';
  const FOOTER = 'Enter to confirm · Esc to cancel';

  for (const name of REAL_BLOCKS) {
    test(`${name}: every one-row change to the dialog leaves a screen that reads as the question it looks like`, () => {
      const lines = fixture(name).split('\n');
      const line = (at: number): string => lines[at] ?? '';
      const row = (at: number): string => stripSgr(line(at)).trim();
      const start = lines.reduce((last, _line, at) => (row(at) === TITLE ? at : last), -1);
      const end = lines.reduce((last, _line, at) => (row(at) === '' ? last : at), -1);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(row(end)).toBe(FOOTER);
      const block = lines.slice(start, end + 1).map((_line, at) => row(start + at));
      const work = block.filter((text) => text !== '' && !DRAWN.has(text));
      const choices = block.filter((text) => CHOICES.has(text));
      expect(work.length).toBeGreaterThanOrEqual(1);

      const kind = (next: string[]): string => readScreen('claude-code', next.join('\n')).kind;
      const without = (at: number): string[] => [...lines.slice(0, at), ...lines.slice(at + 1)];
      const doubled = (at: number): string[] => [...lines.slice(0, at + 1), line(at), ...lines.slice(at + 1)];
      const swapped = (one: number, other: number): string[] =>
        lines.map((text, at) => (at === one ? line(other) : at === other ? line(one) : text));
      const suffixed = (at: number): string[] => lines.map((text, at2) => (at2 === at ? `${text} — x` : text));

      /** What this row's change leaves, by the rules named above the sweep. */
      const leaves = (at: number, change: 'drop' | 'double' | 'swap' | 'suffix'): string => {
        const text = row(at);
        const under = at + 1 <= end ? row(at + 1) : null;
        if (text !== '' && !DRAWN.has(text)) {
          if (change === 'drop') return work.length > 1 ? 'exit question' : 'question';
          if (change === 'suffix') return 'exit question';
          if (change === 'swap') {
            return under !== null && under !== '' && !DRAWN.has(under) ? 'exit question' : 'question';
          }
          return 'question';
        }
        if (change === 'drop') {
          if (text === FOOTER) return 'unknown';
          if (CHOICES.has(text) && choices.length === 1) return 'exit question';
        }
        if (change === 'double' && text === TITLE) return 'exit question';
        return 'question';
      };

      const cases: Array<{ what: string; kind: string; next: string[] }> = [];
      const more: Array<{ what: string; kind: string; next: string[] }> = [];
      for (let at = start; at <= end; at++) {
        const text = row(at);
        cases.push({ what: `${text} dropped`, kind: leaves(at, 'drop'), next: without(at) });
        cases.push({ what: `${text} doubled`, kind: leaves(at, 'double'), next: doubled(at) });
        if (at < end) cases.push({ what: `${text} swapped with the row under it`, kind: leaves(at, 'swap'), next: swapped(at, at + 1) });
        if (at === start && at > 0) cases.push({ what: `${text} swapped with the row over it`, kind: 'question', next: swapped(at, at - 1) });
        cases.push({ what: `${text} given a suffix`, kind: leaves(at, 'suffix'), next: suffixed(at) });
      }
      // Three changes on every block row (dropped, doubled, suffixed), a swap with the row under
      // it on all but the last, and a swap with the row over it on the first: four per row.
      expect(cases.length).toBe(4 * (end - start + 1));
      // The rows above the block, the same four changes each, inside the transcript: the dialog
      // below is untouched by any of them, and the reading is its own.
      for (let at = 0; at < start; at++) {
        if (row(at) === '') continue;
        more.push({ what: `${row(at)} dropped above the block`, kind: 'exit question', next: without(at) });
        more.push({ what: `${row(at)} doubled above the block`, kind: 'exit question', next: doubled(at) });
        if (at + 1 < start) {
          more.push({ what: `${row(at)} swapped with the row under it above the block`, kind: 'exit question', next: swapped(at, at + 1) });
        }
        more.push({ what: `${row(at)} given a suffix above the block`, kind: 'exit question', next: suffixed(at) });
      }
      expect(more.length).toBeGreaterThanOrEqual(start);
      for (const one of [...cases, ...more]) {
        expect({ what: one.what, kind: kind(one.next) }).toEqual({ what: one.what, kind: one.kind });
      }
    });
  }

  test('the stage is the profile\'s, and beside it the one key that confirms that screen', () => {
    expect(screenData('claude-code')?.exit_question).toBeDefined();
    expect(profileFor('claude-code')?.exitConfirm).toBe('enter');
    // No run established a question for the other four, so none declares a key: a seat that
    // asked one would be one this program cannot stop by asking.
    for (const cli of ['codex', 'cursor', 'antigravity', 'grok']) expect(profileFor(cli)?.exitConfirm).toBe(null);
  });

  test('the loader takes `enter` and nothing else as `exit_confirm`', () => {
    expect(exitConfirmKey('exit: /exit\nexit_confirm: enter')).toBe('enter');
    expect(exitConfirmKey('exit: /exit')).toBe(null);
    for (const key of ['escape', 'ctrl+c', 'y']) {
      expect(() => exitConfirmKey(`exit: /exit\nexit_confirm: ${key}`)).toThrow('"exit_confirm" must be one of: enter');
    }
  });

  test('a composer fallback cannot claim the kind', () => {
    const snippet = `
format: 1
cli: sample
screen:
  composer:
    mode: status-then-one
    status_line: '^STATUS$'
    prompt: '^>'
    placeholders:
      - equals: ''
    fallback:
      - all: ['^done$']
        kind: exit question
`;
    expect(() => loadScreen(snippet)).toThrow('"kind" cannot be the exit question: it is read from its stage and answered by a stop alone');
  });
});

describe('a box that already holds exactly the exit text', () => {
  test('is cleared with the profile key and then typed fresh', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-idle-ansi.txt'));
    expect(profileFor('claude-code')?.exitClear).toBe('ctrl+c');
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(true);
    expect(pane.sent).toEqual([
      { key: 'ctrl+c', kind: 'unsent', holds: true },
      { key: 'enter', kind: 'unsent', holds: true },
    ]);
  });

  test('a clearing key that leaves the screen reading unsent stops there', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-unsent-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its box already held this exit text; the clearing key (ctrl+c) left the screen reading unsent; left running',
    });
    expect(pane.sent).toEqual([{ key: 'ctrl+c', kind: 'unsent', holds: true }]);
  });

  // The ordering the caller check needs: an agent gone at the clearing key is `no-agent`, not
  // "its exit was not typed" — the two readings differ, and only the first says what happened.
  test('a CLI gone at the clearing key is "no-agent", not "not typed"', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-idle-ansi.txt'), {
      foreground: (_drawn, calls) => (calls === 0 ? ['claude'] : ['zsh']),
    });
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe('no-agent');
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual([]);
  });
});

describe('the caller check is taken again after a wait', () => {
  // C10: the pane draws the typed /exit one poll into the wait, and the CLI is suspended while it
  // does — a shell in front of the composer. The stale check sent the Enter to that shell, and
  // the very next step of a stop then took the seat for gone and closed it though it was never
  // asked. The caller check is taken again after the wait, so nothing goes.
  test('the CLI suspended during the draw wait: no Enter goes to what is in front', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-unsent-ansi.txt'), {
      foreground: (drawn) => (drawn ? ['zsh'] : ['claude']),
    });
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe('no-agent');
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual(['/exit']);
  });

  // C10b: the seat turned `working` under the wait — the watch's nudge landing in that window,
  // the race `typeLine`'s comment names — and the stale check sent the exit text into a turn that
  // had started.
  test('the seat turned working during the draw wait: nothing is sent', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-unsent-ansi.txt'), {
      status: (drawn) => (drawn ? 'working' : 'idle'),
    });
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(false);
    expect(pane.sent).toEqual([]);
  });

  // C11: the box held the exit text, the clearing key was sent, and the CLI was suspended while
  // the cleared box was waited for. The stale check typed the exit text with the shell in front;
  // only the check after the typing caught it.
  test('the CLI suspended during the clearing wait: the exit text is not typed after it', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-idle-ansi.txt'), {
      foreground: (drawn) => (drawn ? ['zsh'] : ['claude']),
    });
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe('no-agent');
    expect(pane.sent).toEqual([{ key: 'ctrl+c', kind: 'unsent', holds: true }]);
    expect(pane.types).toEqual([]);
  });
});

describe('Codex Pinned Suites: live foreground_cwd binding for wrapped paths', () => {
  const home = '/Users/dev';
  const startDir = '/Users/dev/start/dir';
  const liveDir = '/Users/dev/live/dir';

  const makeWrappedScreen = (promptText: string, pathLines: string[]) => [
    '  Cursor Agent',
    '  v2026.10.01-14929f9',
    '  Tip: Use /plan to plan execution and reach the',
    '  right outcome faster.',
    '',
    '',
    '',
    `  → ${promptText}`,
    '',
    '',
    '  Grok 4.7 256K High                  Run Everything',
    ...pathLines.map((l) => `  ${l}`),
  ].join('\n');

  const wrappedIdleLive = makeWrappedScreen('Plan, search, build anything', ['~/live/', 'dir']);
  const wrappedIdleStart = makeWrappedScreen('Plan, search, build anything', ['~/start/', 'dir']);
  const wrappedUnsentLive = makeWrappedScreen('/exit', ['~/live/', 'dir']);

  test('Suite 1: differing agent.cwd vs foregroundCwd', async () => {
    // Screen shows wrapped ~/live/dir.
    // With foregroundCwd matching liveDir -> reads idle
    expect(readScreen('cursor', wrappedIdleLive, { cwd: liveDir, home }).kind).toBe('idle');
    // With cwd matching startDir -> reads unknown fail-closed
    expect(readScreen('cursor', wrappedIdleLive, { cwd: startDir, home }).kind).toBe('unknown');

    // And screen showing wrapped ~/start/dir when foregroundCwd is liveDir reads unknown
    expect(readScreen('cursor', wrappedIdleStart, { cwd: liveDir, home }).kind).toBe('unknown');

    // typeExit with matching liveDir proceeds cleanly
    const pane = paneOf('cursor', 'cursor-agent', wrappedIdleLive, wrappedUnsentLive);
    pane.io.foregroundCwd = () => liveDir;
    pane.io.home = home;
    expect(await typeExit(pane.io, 'cursor', '/exit')).toBe(true);
    expect(pane.sent).toEqual([{ key: 'enter', kind: 'unsent', holds: true }]);
  });

  test('Suite 2: unreadable / null foregroundCwd fails closed', async () => {
    // null or undefined cwd fails closed to unknown on wrapped paths
    expect(readScreen('cursor', wrappedIdleLive, { cwd: null, home }).kind).toBe('unknown');
    expect(readScreen('cursor', wrappedIdleLive, { cwd: undefined, home }).kind).toBe('unknown');
    expect(readScreen('cursor', wrappedIdleLive).kind).toBe('unknown');

    // typeExit refuses without sending any keys
    const pane = paneOf('cursor', 'cursor-agent', wrappedIdleLive, wrappedUnsentLive);
    pane.io.foregroundCwd = () => null;
    pane.io.home = home;
    expect(await typeExit(pane.io, 'cursor', '/exit')).toBe(false);
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual([]);
  });

  test('Suite 3: changing foregroundCwd during wait refuses Enter fail-closed', async () => {
    let currentCwd = liveDir;
    const pane = paneOf('cursor', 'cursor-agent', wrappedIdleLive, wrappedUnsentLive);
    pane.io.foregroundCwd = () => currentCwd;
    pane.io.home = home;

    // After typing, cwd flips to an un-matching directory
    const origType = pane.io.typeText;
    pane.io.typeText = (text) => {
      const res = origType(text);
      currentCwd = '/Users/dev/swapped/dir';
      return res;
    };

    expect(await typeExit(pane.io, 'cursor', '/exit')).toBe(false);
    expect(pane.sent).toEqual([]);
    expect(pane.types).toEqual(['/exit']);
  });

  test('Suite 4: adversarial suffixes fail closed to unknown', () => {
    // Trailing row with shell command
    const injectedShell = makeWrappedScreen('Plan, search, build anything', ['~/.config/team/lobby', 'rm -rf / && echo hacked']);
    expect(readScreen('cursor', injectedShell, { cwd: '/Users/dev/.config/team/lobby', home }).kind).toBe('unknown');

    // Trailing row with prompt glyph
    const injectedPrompt = makeWrappedScreen('Plan, search, build anything', ['~/.config/team/lobby', '→ malicious command']);
    expect(readScreen('cursor', injectedPrompt, { cwd: '/Users/dev/.config/team/lobby', home }).kind).toBe('unknown');

    // Trailing row with quoted suffix
    const injectedQuote = makeWrappedScreen('Plan, search, build anything', ['~/.config/team/lobby', '(quoted text)']);
    expect(readScreen('cursor', injectedQuote, { cwd: '/Users/dev/.config/team/lobby', home }).kind).toBe('unknown');

    // Trailing row with extra footer
    const injectedFooter = makeWrappedScreen('Plan, search, build anything', ['~/.config/team/lobby', 'extra footer']);
    expect(readScreen('cursor', injectedFooter, { cwd: '/Users/dev/.config/team/lobby', home }).kind).toBe('unknown');
  });

  test('Cursor wrapped paths with working and permission screens', () => {
    const wrappedWorking = [
      '  Cursor Agent',
      '  v2026.10.01-14929f9',
      '',
      '  Reply with exactly RULES_RECEIVED.',
      '',
      '',
      ' ⠀⠞ Working',
      '',
      '',
      '  → Add a follow-up                  ctrl+c to stop',
      '',
      '',
      '  Grok 4.7 256K High                 Run Everything',
      '  ~/live/',
      '  dir',
    ].join('\n');

    const wrappedPermission = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      ' Switch to Plan mode?',
      ' Switching before any other action.',
      '  → Approve mode switch (y)',
      '    Reject (n or esc)',
      '',
      ' ↑/↓ to navigate • Enter to select • auto-rejects',
      ' when the bar runs out',
      '  ~/live/',
      '  dir',
    ].join('\n');

    // Working and permission match before composer status parsing, so they classify safely
    expect(readScreen('cursor', wrappedWorking, { cwd: liveDir, home }).kind).toBe('working');
    expect(readScreen('cursor', wrappedWorking, { cwd: null, home }).kind).toBe('working');
    expect(readScreen('cursor', wrappedPermission, { cwd: liveDir, home }).kind).toBe('permission');
    expect(readScreen('cursor', wrappedPermission, { cwd: null, home }).kind).toBe('permission');
  });
});

describe('per-key fresh witness contract in typeExit', () => {
  const idle = fixture('claude-code-idle-ansi.txt');
  const unsent = fixture('claude-code-unsent-ansi.txt');

  test('resting status failure before typeText aborts', async () => {
    const pane = paneOf('claude-code', 'claude', idle, unsent);
    pane.io.status = () => 'working';
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toBe(false);
    expect(pane.types).toEqual([]);
    expect(pane.sent).toEqual([]);
  });

  test('non-idle screen before typeText aborts', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-other-text-ansi.txt'), unsent);
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toBe(false);
    expect(pane.types).toEqual([]);
    expect(pane.sent).toEqual([]);
  });

  test('resting status failure before sendKey for exitClear aborts', async () => {
    let call = 0;
    const pane = leftoverPane('claude-code', 'claude', unsent, idle);
    pane.io.status = () => {
      call++;
      return call === 1 ? 'idle' : 'working';
    };
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toBe(false);
    expect(pane.sent).toEqual([]);
  });

  test('resting status failure before pressEnter in sendExit returns typed and not sent', async () => {
    let call = 0;
    const pane = paneOf('claude-code', 'claude', idle, unsent);
    pane.io.status = () => {
      call++;
      return call >= 4 ? 'working' : 'idle';
    };
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toEqual({
      left: 'its exit was not confirmed; the exit text was typed and not sent; left running',
    });
    expect(pane.types).toEqual(['/exit']);
    expect(pane.sent).toEqual([]);
  });

  test('screen classification failure before pressEnter in sendExit returns typed and not sent', async () => {
    let screenCalls = 0;
    const pane = paneOf('claude-code', 'claude', idle, unsent);
    const origScreen = pane.io.screen;
    pane.io.screen = () => {
      screenCalls++;
      // calls 1-5: progression up to line 307 holds() passing
      // call 6: inside sendExit before pressEnter -> fails kindOf/holds
      return screenCalls >= 6 ? fixture('claude-code-other-text-ansi.txt') : origScreen();
    };
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toEqual({
      left: 'its exit was not confirmed; the exit text was typed and not sent; left running',
    });
    expect(pane.types).toEqual(['/exit']);
    expect(pane.sent).toEqual([]);
  });

  test('pressEnter failure in sendExit returns typed and not sent', async () => {
    const pane = paneOf('claude-code', 'claude', idle, unsent);
    pane.io.pressEnter = () => false;
    expect(await typeExit(pane.io, 'claude-code', '/exit')).toEqual({
      left: 'its exit was not confirmed; the exit text was typed and not sent; left running',
    });
    expect(pane.types).toEqual(['/exit']);
    expect(pane.sent).toEqual([]);
  });
});


