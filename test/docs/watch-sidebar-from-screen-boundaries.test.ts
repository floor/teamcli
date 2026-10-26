// The sidebar passages at their boundaries. Two pages now say the watch paints a running seat's
// sidebar from the file and the pane's screen — line 1 the file's title, line 2 the file's
// display replaced by a model or effort the screen shows. The sidebar suite holds the first
// paint, the model change and the effort sources; nothing held the pages' own sentences, nor the
// edges they name that no scene reads: a screen herdr cannot give, one that shows no running
// model, the effort word's full once-seen-stays-until-changed arc, and a repaint the title alone
// triggers. These pins read both pages and drive the pass's label work at those edges.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TeamFile } from '../../src/file/types.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { newMemory, pass } from '../../src/watch/pass.ts';

const example = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');

// The write summary's sentence and the team configuration page's paragraph, as written. Whitespace runs
// collapse before the match, so the sentences survive line wrapping but not rewording.
const WATCH_PAGE = '../../docs/commands/watch.md';
const FILE_PAGE = '../../docs/team-file.md';
const WRITE_SUMMARY =
  "the seats' sidebar lines — the workspace title from the file, and the display line from the file and the pane's screen; it paints them on its first cycle and again when the title, the model or the effort changes";
const FILE_PARAGRAPH =
  "While the seat runs, the watch paints both lines. Line 1 is the record's title. Line 2 takes the running model and version the pane's screen shows when they differ from the record's, and the effort word the screen shows; a screen this version cannot read, or one that shows no running model, keeps the record's display — never the CLI's name. An effort word, once seen, stays until a later screen shows a different one.";

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function team(): TeamFile {
  const result = validateTeamFile(example);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const NAME = 'claude-coordinator-acme';
const DISPLAY = 'Claude Opus 5.5';

// The coordinator running on w1, with the screens map the scene names. A pane key left out of
// the map is a screen herdr cannot give; the workspaces label is herdr's own, which the sidebar
// must not take the title from.
function scene(screens: Record<string, string>, without: string[] = []): Live {
  const map: Record<string, string> = { ...screens };
  for (const pane of without) delete map[pane];
  const agent: HerdrAgent = { name: NAME, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };
  return { running: true, agents: [agent], workspaces: [{ id: 'w1', label: 'herdr own label' }], screens: map };
}

function labels(live: Live, file: TeamFile, memory = newMemory()) {
  return pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 0, memory }).labels
    .find((label) => label.name === NAME);
}

function commit(label: ReturnType<typeof labels>, memory: ReturnType<typeof newMemory>) {
  const slot = (memory.seatLabels[NAME] ??= {});
  slot.line = label?.displayAgent;
  slot.title = label?.title;
}

describe('the sidebar passages on the watch and team-file pages', () => {
  test('both passages stand as written', () => {
    expect(prose(WATCH_PAGE).includes(WRITE_SUMMARY), 'watch.md lost the sidebar write summary').toBe(true);
    expect(prose(FILE_PAGE).includes(FILE_PARAGRAPH), 'team-file.md lost the line-2 paragraph').toBe(true);
  });

  test('a screen herdr cannot give, or one that shows no running model, keeps the file’s display — never the CLI’s name', () => {
    const file = team();
    // A pane herdr cannot read: the key is absent, and the label falls back to the file's.
    const unreadable = labels(scene({ 'w1:p1': '  main · Opus 5.5\n' }, ['w1:p1']), file);
    expect(unreadable?.displayAgent, 'an unreadable screen moved the display line').toBe(`${DISPLAY} default`);
    expect(unreadable?.displayAgent?.includes('claude-code'), 'the unreadable pane printed the CLI name').toBe(false);
    // An empty reading is the same unreadable pane.
    expect(labels(scene({ 'w1:p1': '' }), file)?.displayAgent).toBe(`${DISPLAY} default`);
    // A screen this version can read but that shows no running model: the file's display stays.
    const noModel = labels(scene({ 'w1:p1': 'Welcome back!\n\nUpdate available: run claude update\n' }), file);
    expect(noModel?.displayAgent, 'a screen with no running model moved the display line').toBe(`${DISPLAY} default`);
    expect(noModel?.displayAgent?.includes('claude-code'), 'the CLI name reached line 2').toBe(false);
  });

  test('an effort word, once seen, stays until a later screen shows a different one', () => {
    const file = team();
    const memory = newMemory();
    const banner = (effort: string) => `Opus 4.8 with ${effort} effort\na\nb\nc\nd\ne\n  main · Opus 5.5\n`;
    const seen = labels(scene({ 'w1:p1': banner('high') }), file, memory);
    expect(seen?.displayAgent, 'the first screen did not take the effort word').toBe(`${DISPLAY} high`);
    expect(memory.seatLabels[NAME]?.effort).toBe('high');
    commit(seen, memory);

    // A later viewport with no effort phrase keeps the word: no push at all.
    expect(labels(scene({ 'w1:p1': '  main · Opus 5.5\n' }), file, memory), 'a wordless screen repainted the line').toBeUndefined();
    expect(memory.seatLabels[NAME]?.effort, 'the wordless screen forgot the word').toBe('high');

    // A screen that shows a different word takes it, and remembers that one instead.
    const changed = labels(scene({ 'w1:p1': banner('low') }), file, memory);
    expect(changed?.displayAgent, 'a new effort word did not replace the kept one').toBe(`${DISPLAY} low`);
    expect(memory.seatLabels[NAME]?.effort).toBe('low');
  });

  test('line 1 is the file’s title: it is not herdr’s label, and a title change alone repaints it', () => {
    const file = team();
    const memory = newMemory();
    const first = labels(scene({ 'w1:p1': '  main · Opus 5.5\n' }), file, memory);
    expect(first?.title, 'the title came from somewhere but the file').toBe('claude-coordinator-acme · project coordinator');
    commit(first, memory);

    // The file's title changes — the display line does not: only the title is pushed again.
    const seat = file.seats.find((one) => one.name === NAME);
    if (!seat) throw new Error('no coordinator seat');
    seat.labelWritten = true;
    seat.label = 'lead seat';
    const repainted = labels(scene({ 'w1:p1': '  main · Opus 5.5\n' }), file, memory);
    expect(repainted?.title, 'a title change did not repaint the title').toBe('lead seat');
    expect(repainted?.displayAgent, 'a title change repainted the display line too').toBeUndefined();
  });
});
