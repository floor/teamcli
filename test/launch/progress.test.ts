// The progress records: one line per seat, rewritten in place on a terminal and written whole,
// alone, to a redirected stdout. The writer's bytes are the contract here; the three-seat run
// proves the run's stdout is the records and nothing else, whatever the seats do.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { progressWriter, recordText, recordWhat, type Classification, type ProgressSink, type ProgressState } from '../../src/launch/progress.ts';

function sink(isTTY: boolean): { out: string[]; err: string[]; sink: ProgressSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY } };
}

describe('the record, as a line', () => {
  test('ready, left out with its reason, and the waiting record the next slice prints', () => {
    expect(recordText('alpha', { kind: 'ready' })).toBe('alpha: ready');
    expect(recordText('alpha', { kind: 'left out', reason: 'timeout' })).toBe('alpha: left out: timeout');
    expect(recordText('alpha', { kind: 'left out', reason: 'trust' })).toBe('alpha: left out: trust');
    expect(recordText('alpha', { kind: 'waiting for owner', classification: 'login' }))
      .toBe('alpha: waiting for owner (login)');
    expect(recordText('alpha', { kind: 'waiting for owner', classification: 'vendor notice' }))
      .toBe('alpha: waiting for owner (vendor notice)');
  });

  test('the log keeps the record without the seat name', () => {
    expect(recordWhat({ kind: 'ready' })).toBe('ready');
    expect(recordWhat({ kind: 'left out', reason: 'permission' })).toBe('left out: permission');
    expect(recordWhat({ kind: 'waiting for owner', classification: 'unsent' })).toBe('waiting for owner (unsent)');
  });
});

describe('the writer', () => {
  test('a terminal line is rewritten with a carriage return and a clear, and ends in one newline', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('alpha', 'launching');
    records.progress('alpha', 'waiting for its prompt');
    records.progress('alpha', 'naming');
    records.progress('alpha', 'sending its rules');
    records.final('alpha', { kind: 'ready' });
    expect(out.join('')).toBe(
      '\r\x1b[Kalpha: launching'
        + '\r\x1b[Kalpha: waiting for its prompt'
        + '\r\x1b[Kalpha: naming'
        + '\r\x1b[Kalpha: sending its rules'
        + '\r\x1b[Kalpha: ready\n',
    );
    expect(err).toEqual([]);
  });

  test('a terminal detail follows the record it belongs to', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('beta', 'waiting for its prompt');
    records.final('beta', { kind: 'left out', reason: 'vendor notice' });
    records.detail('  its workspace was closed without input and the seat left out');
    expect(out.join('')).toBe('\r\x1b[Kbeta: waiting for its prompt\r\x1b[Kbeta: left out: vendor notice\n');
    expect(err.join('')).toBe('  its workspace was closed without input and the seat left out\n');
  });

  test('the waiting record takes the seat\'s line, and the prompt starts the next one on stderr', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('alpha', 'waiting for its prompt');
    records.waiting('alpha', 'trust');
    records.prompt('alpha is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly');
    records.waiting('alpha', 'timeout');
    records.final('alpha', { kind: 'left out', reason: 'skipped by owner' });
    expect(out.join('')).toBe(
      '\r\x1b[Kalpha: waiting for its prompt'
        + '\r\x1b[Kalpha: waiting for owner (trust)'
        + '\r\x1b[Kalpha: waiting for owner (timeout)'
        + '\r\x1b[Kalpha: left out: skipped by owner\n',
    );
    expect(err.join('')).toBe('\nalpha is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly\n');
  });

  test('a redirected stdout gets only the final record, prompts or not', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.waiting('alpha', 'trust');
    records.prompt('alpha is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly');
    records.final('alpha', { kind: 'left out', reason: 'trust' });
    expect(out.join('')).toBe('alpha: left out: trust\n');
    expect(err.join('')).toBe('alpha is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly\n');
  });

  test('a redirected stdout gets the final records alone, whatever is provisional', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.progress('alpha', 'launching');
    records.progress('alpha', 'waiting for its prompt');
    records.progress('alpha', 'naming');
    records.progress('alpha', 'sending its rules');
    records.final('alpha', { kind: 'ready' });
    records.progress('beta', 'launching');
    records.final('beta', { kind: 'left out', reason: 'trust' });
    records.detail('  its workspace was closed without an answer and the seat left out');
    expect(out.join('')).toBe('alpha: ready\nbeta: left out: trust\n');
    expect(out.join('').includes('\x0d')).toBe(false);
    expect(out.join('').includes('\x1b')).toBe(false);
    expect(err.join('')).toBe('  its workspace was closed without an answer and the seat left out\n');
  });

  // A seat, a stage word, a reason and a detail line each carrying a carriage return, `ESC[2J`,
  // `ESC[31m` and a bell: what the writer is between — a caller that built a string — and the
  // terminal. The raw bytes of one unfixed call were
  // `610d1b5b324a623a206c656674206f75743a20726561736f6e0d1b5b33316d580a`: seat and reason as
  // given. The same call writes the cleaned bytes below, and the only 0d and 1b bytes left in a
  // terminal stream are the writer's own in-place rewrite, `\r\x1b[K` (a carriage return and a
  // clear-to-end, one per draw) — asserted exactly, byte for byte.
  const dirtySeat = 'a\r\x1b[2Jb';
  const dirtyReason = 'reason\r\x1b[31mX';
  const dirtyDetail = '  d\r\x1b[2Jet\x1b[31mail\x07';

  test('a terminal writes the cleaned bytes: the caller’s carriage returns, escapes and bell are gone', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress(dirtySeat, 'launch\x1b[31ming' as ProgressState);
    records.final(dirtySeat, { kind: 'left out', reason: dirtyReason });
    records.detail(dirtyDetail);
    expect(out.join('')).toBe('\r\x1b[Kab: launching\r\x1b[Kab: left out: reasonX\n');
    expect(err.join('')).toBe('  detail\n');
    const mine = out.join('').replaceAll('\r\x1b[K', '');
    expect(mine.includes('\x0d')).toBe(false);
    expect(mine.includes('\x1b')).toBe(false);
    expect(out.join('').includes('\x07')).toBe(false);
    expect(err.join('').includes('\x07')).toBe(false);
  });

  test('a redirected stdout writes the cleaned record alone: no carriage return, no escape, no bell', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.progress(dirtySeat, 'launching');
    records.final(dirtySeat, { kind: 'left out', reason: dirtyReason });
    records.detail(dirtyDetail);
    expect(out.join('')).toBe('ab: left out: reasonX\n');
    expect(out.join('').includes('\x0d')).toBe(false);
    expect(out.join('').includes('\x1b')).toBe(false);
    expect(out.join('').includes('\x07')).toBe(false);
    expect(err.join('')).toBe('  detail\n');
    expect(err.join('').includes('\x07')).toBe(false);
  });

  test('a C1 CSI written as its introducer plus the 7-bit tail goes whole: the tail is not left behind', () => {
    // `\x9b` is the 8-bit CSI introducer; a mangled writing puts the 7-bit `[` after it. The
    // introducer, the bracket and the sequence's own tail are one sequence, and the whole of it
    // goes — before this, seat `a\x9b[2Jb` printed `a2Jb`, the tail left as if it were text.
    const seat = 'a\x9b[2Jb';
    const reason = 'r\x9b[31mX';
    const detail = '  d\x9b[2Je';
    const pipe = sink(false);
    const redirected = progressWriter(pipe.sink);
    redirected.final(seat, { kind: 'left out', reason });
    redirected.detail(detail);
    expect(pipe.out.join('')).toBe('ab: left out: rX\n');
    expect(pipe.err.join('')).toBe('  de\n');

    const drawn = sink(true);
    const terminal = progressWriter(drawn.sink);
    terminal.final(seat, { kind: 'left out', reason });
    expect(drawn.out.join('')).toBe('\r\x1b[Kab: left out: rX\n');

    // A lone introducer, with no sequence tail after it, is removed and its neighbours stay.
    const lone = sink(false);
    progressWriter(lone.sink).final('x\x9b\u202ey', { kind: 'ready' });
    expect(lone.out.join('')).toBe('xy: ready\n');
    // The TTY stream's only 1b bytes are the writer's own in-place rewrite, `\r\x1b[K`.
    const written = pipe.out.join('') + pipe.err.join('') + lone.out.join('') + drawn.out.join('').replaceAll('\r\x1b[K', '');
    expect(written.includes('\x9b')).toBe(false);
    expect(written.includes('\x1b')).toBe(false);
  });

  test('a reason, a seat or a detail the cleaning leaves empty is said as unknown, or not said', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    // The reason cleans to nothing: the record keeps its grammar and says the one word these
    // records use for a reading this version cannot make.
    records.final('alpha', { kind: 'left out', reason: '\r\x1b[2J\x07' });
    // The seat cleans to nothing: the same word stands where the seat would.
    records.final('\x1b[2J\r', { kind: 'ready' });
    // A detail that cleans to nothing is not written at all.
    records.final('beta', { kind: 'ready' });
    records.detail('\x1b[2J');
    expect(out.join('')).toBe('alpha: left out: unknown\nunknown: ready\nbeta: ready\n');
    expect(err).toEqual([]);
  });

  test('the waiting record’s classification is the reason slot too: cleaned, and unknown when empty', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    // The classification is where the next slice prints a screen reading from: it is cleaned at
    // the writer like the stage word, whatever a caller cast into it.
    records.final('alpha', { kind: 'waiting for owner', classification: 'question\r\x1b[2J\x07' as Classification });
    records.final('beta', { kind: 'waiting for owner', classification: '\r\x1b[2J' as Classification });
    expect(out.join('')).toBe('alpha: waiting for owner (question)\nbeta: waiting for owner (unknown)\n');
    expect(out.join('').includes('\x0d')).toBe(false);
    expect(out.join('').includes('\x1b')).toBe(false);
    expect(out.join('').includes('\x07')).toBe(false);
    expect(err).toEqual([]);
  });

  test('a line feed in any field is folded to one space: one record is one physical line, on a pipe', () => {
    // Two lines out of one field would put a record nobody produced on stdout (`reason` /
    // `forged`). A field is one physical line: a run of line feeds becomes a single space — every
    // word stays, the field is never cut — and a detail line is one writer call, cleaned as one.
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.final('a\nb', { kind: 'left out', reason: 'reason\nforged' });
    records.final('c', { kind: 'waiting for owner', classification: 'log\nin' as Classification });
    records.final('d', { kind: 'left out', reason: 'one\n\ntwo' });
    records.detail('  first\nsecond');
    records.detail('\n   ');
    expect(out.join('')).toBe(
      'a b: left out: reason forged\n'
        + 'c: waiting for owner (log in)\n'
        + 'd: left out: one two\n',
    );
    expect(err.join('')).toBe('  first second\n');
    expect(out.join('').split('\n')).toHaveLength(4);
    // The bytes are the ASCII they look like: no 0a inside a record.
    expect(Buffer.from(out.join(''), 'utf8').toString('hex')).toBe(
      Buffer.from('a b: left out: reason forged\nc: waiting for owner (log in)\nd: left out: one two\n', 'utf8').toString('hex'),
    );
  });

  test('a line feed in any field is folded to one space on a terminal too: no line moves down', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('a\nb', 'launch\ning' as ProgressState);
    records.final('a\nb', { kind: 'left out', reason: 'reason\nforged' });
    records.detail('  first\nsecond');
    expect(out.join('')).toBe('\r\x1b[Ka b: launch ing\r\x1b[Ka b: left out: reason forged\n');
    expect(err.join('')).toBe('  first second\n');
  });

  // Every character of Unicode category Cf whose effect is on the display: the bidi embeddings,
  // overrides and isolates, the direction marks, the zero-width characters, the byte-order mark.
  const INVISIBLE = '‪‫‬‭\u202e⁦⁧⁨⁩‎‏؜​‌‍⁠﻿';

  test('the invisible format characters are removed from every field, on a pipe and on a terminal', () => {
    // U+202E (bytes `e2 80 ae`) reverses what follows it: a record would display other words than
    // it holds. Every field — the seat, the stage word, the reason, a detail line and the
    // classification — is cleaned of them, whatever a caller built.
    const pipe = sink(false);
    const redirected = progressWriter(pipe.sink);
    redirected.progress(`a${INVISIBLE}b`, `launching${INVISIBLE}` as ProgressState);
    redirected.final(`a${INVISIBLE}b`, { kind: 'left out', reason: `reason${INVISIBLE}X` });
    redirected.detail(`  d${INVISIBLE}etail`);
    redirected.final(`c${INVISIBLE}d`, { kind: 'waiting for owner', classification: `login${INVISIBLE}` as Classification });
    expect(pipe.out.join('')).toBe('ab: left out: reasonX\ncd: waiting for owner (login)\n');
    expect(pipe.err.join('')).toBe('  detail\n');

    const drawn = sink(true);
    const terminal = progressWriter(drawn.sink);
    terminal.progress(`a${INVISIBLE}b`, 'launching');
    terminal.final(`a${INVISIBLE}b`, { kind: 'left out', reason: `reason${INVISIBLE}X` });
    expect(drawn.out.join('')).toBe('\r\x1b[Kab: launching\r\x1b[Kab: left out: reasonX\n');

    const written = (pipe.out.join('') + pipe.err.join('') + drawn.out.join('')).replaceAll('\r\x1b[K', '');
    for (const character of INVISIBLE) expect(written.includes(character)).toBe(false);
    // The whole stream is ASCII: no `e2 80 ae`, no other multi-byte format character.
    expect(Buffer.from(written, 'utf8').every((byte) => byte < 0x80)).toBe(true);
  });

  // The rule's newer classes, on purpose: the soft hyphen, U+180E, the whole tag block (its
  // edges U+E0000 and U+E001F are unassigned, not Cf), and U+2028/U+2029, folded like a line
  // feed. The variation selectors stay: they only choose how the character before them is drawn.
  const RULE_CLASSES = '\u00ad\u180e\u{e0000}\u{e0001}\u{e001f}\u{e0020}\u{e007f}';

  test('the rule’s newer classes are removed from every field, on a pipe and on a terminal', () => {
    const pipe = sink(false);
    const redirected = progressWriter(pipe.sink);
    redirected.progress(`a${RULE_CLASSES}b`, `launching${RULE_CLASSES}` as ProgressState);
    redirected.final(`a${RULE_CLASSES}b`, { kind: 'left out', reason: `reason${RULE_CLASSES}X` });
    redirected.detail(`  d${RULE_CLASSES}etail`);
    redirected.final(`c${RULE_CLASSES}d`, { kind: 'waiting for owner', classification: `login${RULE_CLASSES}` as Classification });
    expect(pipe.out.join('')).toBe('ab: left out: reasonX\ncd: waiting for owner (login)\n');
    expect(pipe.err.join('')).toBe('  detail\n');

    const drawn = sink(true);
    const terminal = progressWriter(drawn.sink);
    terminal.progress(`a${RULE_CLASSES}b`, 'launching');
    terminal.final(`a${RULE_CLASSES}b`, { kind: 'left out', reason: `reason${RULE_CLASSES}X` });
    expect(drawn.out.join('')).toBe('\r\x1b[Kab: launching\r\x1b[Kab: left out: reasonX\n');

    const written = (pipe.out.join('') + pipe.err.join('') + drawn.out.join('')).replaceAll('\r\x1b[K', '');
    for (const character of RULE_CLASSES) expect(written.includes(character)).toBe(false);
  });

  test('the line separators fold like a line feed in every field, and the variation selectors stay', () => {
    // U+2028 and U+2029 are line breaks to Unicode and to the log's own whitespace collapse:
    // they become LF on the spot, and a field's run of line breaks becomes one space exactly as
    // a line feed's does — the record's bytes are one line, the same on the log and the screen.
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.final('a\u2028b', { kind: 'left out', reason: 'reason\u2029forged' });
    records.final('c', { kind: 'waiting for owner', classification: 'log\u2028in' as Classification });
    records.detail('  one\u2029two');
    expect(out.join('')).toBe('a b: left out: reason forged\nc: waiting for owner (log in)\n');
    expect(err.join('')).toBe('  one two\n');

    const pipe = sink(false);
    progressWriter(pipe.sink).final('a\u{fe0e}b\u{fe0f}c\u{e0100}d', { kind: 'ready' });
    expect(pipe.out.join('')).toBe('a\u{fe0e}b\u{fe0f}c\u{e0100}d: ready\n');
    const drawn = sink(true);
    progressWriter(drawn.sink).final('a\u{fe0e}b\u{fe0f}c\u{e0100}d', { kind: 'ready' });
    expect(drawn.out.join('')).toBe('\r\x1b[Ka\u{fe0e}b\u{fe0f}c\u{e0100}d: ready\n');
  });

  test('a joiner-joined emoji prints as its parts: U+200D goes with the Cf class, accepted', () => {
    const { out, sink: s } = sink(false);
    progressWriter(s).final('👩\u200d💻', { kind: 'ready' });
    expect(out.join('')).toBe('👩💻: ready\n');
  });

  test('a reason in Arabic prints as written', () => {
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);
    const reason = 'رفض: لا صلاحية للكتابة';
    records.final('مراجعة', { kind: 'left out', reason });
    expect(out.join('')).toBe(`مراجعة: left out: ${reason}\n`);
    expect(Buffer.from(out.join(''), 'utf8').toString('hex')).toBe(
      Buffer.from(`مراجعة: left out: ${reason}\n`, 'utf8').toString('hex'),
    );
  });

  test('a reason in Hebrew prints as written', () => {
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);
    const reason = 'הסיבה: לא אושר';
    records.final('ביקורת', { kind: 'left out', reason });
    expect(out.join('')).toBe(`ביקורת: left out: ${reason}\n`);
    expect(Buffer.from(out.join(''), 'utf8').toString('hex')).toBe(
      Buffer.from(`ביקורת: left out: ${reason}\n`, 'utf8').toString('hex'),
    );
  });
});

describe('a three-seat launch', () => {
  // Three seats in a row: alpha reaches its prompt, beta stops at the vendor notice, gamma
  // never gets one and times out. The panes are named by the seat's label.
  const DETAILS = '  untested on 0.160.0\n'
    + '  its workspace was closed without input and the seat left out\n'
    + '  timed out after 1 s waiting for its idle prompt; the screen last read unknown; left at launched\n'
    + '  run `team up` again to resume it\n';

  function steps(): Step[] {
    const seat = (name: string, cli: string, seconds: number): Step[] => [
      { kind: 'run', argv: [], do: { do: 'create', seat: name, label: name, cwd: '.', repairLine: `\`team remove ${name} --keep\` then \`team add ${name}\`` } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: name, label: name, command: cli } },
      {
        kind: 'wait',
        text: `until ${name} shows its idle prompt`,
        do: { do: 'idle', seat: name, label: name, cli, seconds, command: cli, pane: `${name}-pane`, repairLine: `\`team remove ${name} --keep\` then \`team add ${name}\`` },
      },
    ];
    return [
      ...seat('alpha', 'claude', 5),
      {
        kind: 'run',
        argv: [],
        do: { do: 'rename', seat: 'alpha', label: 'alpha', seconds: 5, rules: 'message', pane: 'alpha-pane' },
      },
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'deliver', seat: 'alpha', label: 'alpha', cli: 'claude-code', rules: 'Rules.',
          path: '/x/rules/alpha.md', line: 'Read /x/rules/alpha.md (sha256 000000000000): your standing rules.',
          seconds: 5, pane: 'alpha-pane',
        },
      },
      ...seat('beta', 'codex', 5),
      ...seat('gamma', 'claude', 1),
    ];
  }

  function world(): { host: Host; out: string[]; err: string[]; slept: number[]; logged: { who: string; what: string }[] } {
    const out: string[] = [];
    const err: string[] = [];
    const slept: number[] = [];
    const logged: { who: string; what: string }[] = [];
    let t = 0;
    const records = progressWriter({ stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY: false });
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      deliverRules: async () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['alpha-pane'],
      classify: (_session, pane): ScreenKind =>
        pane === 'beta-pane' ? 'vendor notice' : pane === 'alpha-pane' ? 'idle' : 'unknown',
      sleep: async () => { slept.push(t); t += 1000; },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { err.push(line); },
      log: (who, what) => { logged.push({ who, what }); },
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
      cliVersion: (cli) => (cli === 'codex' ? '0.160.0' : null),
    };
    return { host, out, err, slept, logged };
  }

  test('a refuse step cleans the reason once, before the log and the writer: one line, the same words', async () => {
    // A refusal reason holding a carriage return and escape sequences: the record is cleaned in
    // one place (`final`) before both the log line and the writer take it, so the log holds the
    // cleaned words — no 0d, no 1b — and says exactly what the record says.
    const { host, out, err, logged } = world();
    await executePlan(
      [{ kind: 'skip', text: 'alpha: would refuse', do: { do: 'refuse', seat: 'alpha', why: 'reason\r\x1b[2J\x1b[31mX' } }],
      'acme',
      host,
    );
    expect(out.join('')).toBe('alpha: left out: refused: reasonX\n');
    expect(err.join('')).toBe('');
    expect(logged).toEqual([{ who: 'alpha', what: 'left out: refused: reasonX' }]);
    const bytes = Buffer.from(logged.map((entry) => entry.what).join('\n'), 'utf8');
    for (const byte of bytes) expect(byte >= 0x20).toBe(true);
  });

  test('a redirected stdout is exactly the three records, in file order', async () => {
    const { host, out, err, slept, logged } = world();
    await executePlan(steps(), 'acme', host);
    expect(out.join('')).toBe('alpha: ready\nbeta: left out: vendor notice\ngamma: left out: timeout\n');
    expect(err.join('')).toBe(DETAILS);
    // The polling happened — gamma slept once waiting for a prompt that never came — and the
    // redirected stream saw nothing of it.
    expect(slept).toEqual([0]);
    expect(out.join('')).not.toContain('\r');
    expect(out.join('')).not.toContain('\x1b');
    // One log line per final record, in order, and none while polling.
    expect(logged).toEqual([
      { who: 'alpha', what: 'ready' },
      { who: 'beta', what: 'left out: vendor notice' },
      { who: 'gamma', what: 'left out: timeout' },
    ]);
  });

  test('a terminal rewrites each seat’s line in place, and the final record ends it', async () => {
    const { host, logged } = world();
    // The same run with a terminal: the writer's own flag is what changes, so the fake host
    // swaps the writer for one drawn as a terminal does.
    const tty: string[] = [];
    const ttyErr: string[] = [];
    const records = progressWriter({ stdout: (text) => tty.push(text), stderr: (text) => ttyErr.push(text), isTTY: true });
    const terminal: Host = {
      ...host,
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };
    await executePlan(steps(), 'acme', terminal);
    expect(tty.join('')).toBe(
      '\r\x1b[K' + 'alpha: launching'
        + '\r\x1b[K' + 'alpha: launching'
        + '\r\x1b[K' + 'alpha: waiting for its prompt'
        + '\r\x1b[K' + 'alpha: naming'
        + '\r\x1b[K' + 'alpha: sending its rules'
        + '\r\x1b[K' + 'alpha: ready\n'
        + '\r\x1b[K' + 'beta: launching'
        + '\r\x1b[K' + 'beta: launching'
        + '\r\x1b[K' + 'beta: waiting for its prompt'
        + '\r\x1b[K' + 'beta: left out: vendor notice\n'
        + '\r\x1b[K' + 'gamma: launching'
        + '\r\x1b[K' + 'gamma: launching'
        + '\r\x1b[K' + 'gamma: waiting for its prompt'
        + '\r\x1b[K' + 'gamma: left out: timeout\n',
    );
    // The details are the terminal's second stream, after each record; the record stream holds
    // nothing but records.
    expect(ttyErr.join('')).toBe(DETAILS);
    expect(tty.every((chunk) => chunk.startsWith('\r\x1b[K'))).toBe(true);
    expect(logged.map((entry) => entry.who)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('a screen the profile cannot read', () => {
  // Herdr's own status is the last word on a screen no profile reads, exactly as `reload` and
  // `restart` already read it before a close that types nothing. The shell in front of the pane
  // is not a prompt, whatever herdr says: that pane shows no CLI.
  function steps(seconds: number): Step[] {
    return [
      { kind: 'run', argv: [], do: { do: 'create', seat: 'alpha', label: 'alpha', cwd: '.', repairLine: 'repair' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: 'alpha', label: 'alpha', command: 'agy' } },
      {
        kind: 'wait',
        text: 'until alpha shows its idle prompt',
        do: { do: 'idle', seat: 'alpha', label: 'alpha', cli: 'antigravity', seconds, command: 'agy', pane: 'alpha-pane', repairLine: 'repair' },
      },
      // The rename is what tells a reached prompt from one still being waited out: an option
      // seat gets its ready record there, as `up`'s plan always does.
      {
        kind: 'run',
        argv: [],
        do: { do: 'rename', seat: 'alpha', label: 'alpha', seconds: 5, rules: 'option', pane: 'alpha-pane' },
      },
    ];
  }

  function world(status: string | null, back: boolean | null): { host: Host; out: string[]; err: string[]; slept: number[] } {
    const out: string[] = [];
    const err: string[] = [];
    const slept: number[] = [];
    let t = 0;
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['alpha-pane'],
      classify: () => 'unknown',
      shellBack: () => back,
      agentStatus: () => status,
      sleep: async () => { slept.push(t); t += 1000; },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { err.push(line); },
      log: () => {},
      final: (seat, record) => { out.push(`${recordText(seat, record)}\n`); },
      detail: (line) => { err.push(line); },
    };
    return { host, out, err, slept };
  }

  test('herdr reports the seat idle: the launch is ready though no profile read the screen', async () => {
    const { host, out, slept } = world('idle', null);
    await executePlan(steps(1), 'acme', host);
    expect(out.join('')).toBe('alpha: ready\n');
    // The first poll is enough: the status, not a second screen, is the last word.
    expect(slept).toEqual([]);
  });

  test('herdr reports the seat done: the launch is ready there too', async () => {
    const { host, out } = world('done', null);
    await executePlan(steps(1), 'acme', host);
    expect(out.join('')).toBe('alpha: ready\n');
  });

  test('the shell is back in front of the pane: herdr idle does not make it ready', async () => {
    const { host, out, err } = world('idle', true);
    await executePlan(steps(1), 'acme', host);
    expect(out.join('')).toBe('alpha: left out: timeout\n');
    expect(err.join('')).toContain('timed out after 1 s waiting for its idle prompt; the screen last read unknown');
  });

  test('herdr reports the seat working: the launch waits it out', async () => {
    const { host, out } = world('working', false);
    await executePlan(steps(1), 'acme', host);
    expect(out.join('')).toBe('alpha: left out: timeout\n');
  });
});
