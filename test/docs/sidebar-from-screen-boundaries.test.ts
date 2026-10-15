// The sidebar-lines sentences — watch.md's one and team-file.md's paragraph — held to the two
// places that do what they say. Line 2's law lives in `src/watch/seat-label.ts`: a screen this
// version cannot read, or one with no running model, keeps the file's display; a model the
// screen shows replaces the file's when it differs; the effort word, once seen, is remembered.
// The paint rule lives in `src/watch/pass.ts`: first cycle paints both lines, a later cycle
// only a line that changed. Each sentence is pinned verbatim and each claim pinned to the line
// that carries it — comment fragments stay within one line, where the collapse keeps no ` * `.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const WATCH_PAGE = '../../docs/commands/watch.md';
const TEAM_FILE_PAGE = '../../docs/team-file.md';
const LABEL_SRC = '../../src/watch/seat-label.ts';
const PASS_SRC = '../../src/watch/pass.ts';

describe('the sidebar lines come from the screen too', () => {
  test('both pages say it, verbatim', () => {
    expect(prose(WATCH_PAGE)).toContain(
      "the seats' sidebar lines — the workspace title from the file, and the display line from the file and the pane's screen; it paints them on its first cycle and again when the title, the model or the effort changes.",
    );
    expect(prose(TEAM_FILE_PAGE)).toContain(
      "While the seat runs, the watch paints both lines. Line 1 is the file's title. Line 2 takes the running model and version the pane's screen shows when they differ from the file's, and the effort word the screen shows; a screen this version cannot read, or one that shows no running model, keeps the file's display — never the CLI's name. An effort word, once seen, stays until a later screen shows a different one.",
    );
  });

  test("line 2's law: the screen's model replaces only a differing one, and a mute screen keeps the file's", () => {
    const src = prose(LABEL_SRC);
    // The file's own words for the paragraph's two keeps.
    expect(src).toContain('A screen this version cannot read keeps the file\'s display — never');
    expect(src).toContain('The effort word, once seen, stays until a later screen shows a different one.');
    // And the three guards that do it: no screen at all, no running model on it, or the same
    // model and version the file already names — each keeps the file's display.
    expect(src).toContain("if (screen === undefined || screen === '') return seat.display;");
    expect(src).toContain('if (!running) return seat.display;');
    expect(src).toContain('if (running.model === seat.model && running.version === seat.version) return seat.display;');
    // The replacement: the running model and version, as line 2's new text.
    expect(src).toContain('return `${running.model} ${running.version}`;');
  });

  test('the effort word is remembered, and absence is not a value', () => {
    const src = prose(LABEL_SRC);
    // "Once seen, stays until a later screen shows a different one": the word this screen
    // showed, else the one remembered, else the file's — and only a seen word is remembered.
    expect(src).toContain("const seen = screen === undefined || screen === '' ? undefined : effortOnScreen(seat.cli, screen);");
    expect(src).toContain("const effort = seen ?? rememberedEffort ?? (seat.effort || 'default');");
    expect(src).toContain('return { line: `${displayOf(seat, screen)} ${effort}`, ...(seen ? { effort: seen } : {}) };');
  });

  test('the paint rule: first cycle both, later cycles only what changed', () => {
    const src = prose(PASS_SRC);
    expect(src).toContain('from the file, with a live model or effort in place of the file\'s when the screen shows');
    expect(src).toContain('one. A later cycle paints only a line that changed. A temporary seat has no file seat and');
    // And the two guards that do it: a line is pushed only when it differs from the one this
    // process pushed last — absent on the first cycle, so both paint then.
    expect(src).toContain('const live = liveDisplayAgent(seat, screen, prior?.effort);');
    expect(src).toContain("if (prior?.title !== title) push.title = title;");
    expect(src).toContain('if (prior?.line !== live.line) push.displayAgent = live.line;');
  });
});
