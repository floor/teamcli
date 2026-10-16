// Line 2 of a running seat: the file's display and effort, replaced by a model or an effort
// the pane actually shows. A screen this version cannot read keeps the file's display — never
// the CLI's name. The effort word, once seen, stays until a later screen shows a different one.
import { stripSgr } from '../ansi.ts';
import { runningModel } from '../status/statusline.ts';
import { statusRow } from './screen.ts';

export type LabelSeat = {
  cli: string;
  model: string;
  version: string;
  display: string;
  effort?: string;
};

/** The display_agent line for one seat this pass, and the effort word the screen showed, when
 *  it showed one. Absence of that word is not a value: the caller keeps the last word it saw. */
export function liveDisplayAgent(
  seat: LabelSeat,
  screen: string | undefined,
  rememberedEffort?: string,
): { line: string; effort?: string } {
  const seen = screen === undefined || screen === '' ? undefined : effortOnScreen(seat.cli, screen);
  const effort = seen ?? rememberedEffort ?? (seat.effort || 'default');
  return { line: `${displayOf(seat, screen)} ${effort}`, ...(seen ? { effort: seen } : {}) };
}

function displayOf(seat: LabelSeat, screen: string | undefined): string {
  if (screen === undefined || screen === '') return seat.display;
  const running = runningModel(seat.cli, screen);
  if (!running) return seat.display;
  if (running.model === seat.model && running.version === seat.version) return seat.display;
  return `${running.model} ${running.version}`;
}

/** The effort word on this pane, or none. Codex and Cursor read only the status row the model
 *  read already uses, so a dialog that hides the row does not invent a word. The others are
 *  read from the whole pane. Claude's banner leaves the last rows. Antigravity's word and
 *  Grok's paren sit on the same footer the model rule reads; the word is not part of the model. */
function effortOnScreen(cli: string, screen: string): string | undefined {
  const plain = stripSgr(screen);
  if (cli === 'codex' || cli === 'cursor') {
    const row = statusRow(cli, plain);
    if (row === null) return undefined;
    return cli === 'codex' ? codexEffort(row) : cursorEffort(row);
  }
  if (cli === 'claude-code') return last(plain, /\bwith (low|medium|high|xhigh|max) effort\b/gi);
  if (cli === 'antigravity') {
    return last(plain, /·\s*(low|medium|high|xhigh|max)\b/gi)
      ?? last(plain, /\((low|medium|high|xhigh|max)\)/gi);
  }
  if (cli === 'grok') return last(plain, /Grok\s+\d+(?:\.\d+)*(?:\s+Fast)?\s+\(([A-Za-z]+)\)/g);
  return undefined;
}

function codexEffort(row: string): string | undefined {
  const hit = /GPT-[\d.]+-[A-Za-z]+\s+([A-Za-z]+)\s*·/.exec(row);
  return hit?.[1]?.toLowerCase();
}

// `Extra High` is the label Cursor prints for the id suffix `xhigh`. `None` and `Minimal` are
// not in the effort list the file checks; they are still the word the row showed.
function cursorEffort(row: string): string | undefined {
  const hit = /\b(Extra High|None|Minimal|Low|Medium|High|Max)\b/.exec(row);
  if (!hit?.[1]) return undefined;
  return hit[1] === 'Extra High' ? 'xhigh' : hit[1].toLowerCase();
}

function last(text: string, pattern: RegExp): string | undefined {
  let found: string | undefined;
  for (const hit of text.matchAll(pattern)) found = hit[1];
  return found?.toLowerCase();
}
