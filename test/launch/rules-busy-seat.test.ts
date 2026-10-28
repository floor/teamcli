// `team up` on resumed Codex and Cursor seats (2026-10-28): the rules line was typed correctly
// into the composer, then the seat started a turn on its queued drops. The delivery read the
// seat as not free and stopped at once with "the read-back didn't match", leaving the line
// unsent. These scenes use the real screens captured from those panes: the box reads back as the
// line, a busy seat is waited out and then gets its Enter, a seat busy until the deadline is
// reported as busy with the line left in its box (no clearing key), and a later run finds its own
// line there and sends it without typing again.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { boxHoldsText, deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { readScreen } from '../../src/watch/screen.ts';

const fixture = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
const RULES = '/Users/jvial/.config/team/teamcli-5e46a02374b3/rules';
const lineFor = (seat: string, hash: string) =>
  `Read ${RULES}/${seat}.md (sha256 ${hash}): your standing rules for this session; reply ready and wait for your brief.`;

const SCREENS = [
  { cli: 'codex', file: 'codex/0.161.0/rules-unsent-orchestrator.txt', line: lineFor('orchestrator', '92ae1ae483d5') },
  { cli: 'codex', file: 'codex/0.161.0/rules-unsent-builder-3.txt', line: lineFor('builder-3', '8cf214db695d') },
  { cli: 'cursor', file: 'cursor/2026.10.22/rules-unsent-reviewer-cursor.txt', line: lineFor('reviewer-cursor', 'b18ac61a29b2') },
] as const;

/** A seat whose box already holds the captured line. `busyFor` ms of herdr `working` follow the
 *  first look; Enter is accepted (the seat starts its turn, the composer empties) when `takes`. */
function seat(cli: string, screen: string, opts: { busyFor?: number; startBusyAfterType?: boolean; takes?: boolean } = {}) {
  let clock = 0;
  let raw = screen;
  let status = 'idle';
  let busyUntil = -1;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  // Enter taken: the composer empties (the typed text leaves the box) and the turn starts.
  const idleOf = (text: string) => text.replace(/Read \/Users\/\S+ \(sha256 [0-9a-f]+\): [^\n\x1b]*/, '');
  const io: Delivery = {
    screen: () => raw,
    status: () => (clock < busyUntil ? 'working' : status),
    type(text) { calls.push(`type:${text}`); if (opts.startBusyAfterType) busyUntil = clock + (opts.busyFor ?? 0); return true; },
    enter() {
      calls.push('Enter');
      if (opts.takes !== false) { status = 'working'; raw = idleOf(raw); }
      return true;
    },
    key(name) { calls.push(`key:${name}`); return true; },
    file: () => true,
    foreground: () => (cli === 'cursor' ? ['cursor-agent'] : ['codex']),
    report: (why) => { refusals.push(why); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, busy: (ms: number) => { busyUntil = clock + ms; } };
}

describe('rules read-back on the real Codex 0.161 and Cursor screens', () => {
  for (const { cli, file, line } of SCREENS) {
    test(`${file}: the box reads back as the typed line`, () => {
      const screen = fixture(file);
      expect(readScreen(cli, screen).kind).toBe('unsent');
      expect(boxHoldsText(cli, line, screen)).toBe(true);
    });

    test(`${file}: a later run finds its own unsent line and sends it without typing again`, async () => {
      const s = seat(cli, fixture(file));
      expect(await deliverRules(cli, line, 30, s.io)).toBe(true);
      expect(s.calls).toEqual(['Enter']);
      expect(s.refusals).toEqual([]);
    });
  }
});

describe('a seat that turns busy under the typed line', () => {
  const { cli, file, line } = SCREENS[0];

  test('is waited out, then gets its Enter: no mismatch is declared', async () => {
    const s = seat(cli, fixture(file));
    // The seat is free at the first look and busy right after (a queued drop starts a turn).
    let looks = 0;
    const status = s.io.status;
    s.io.status = () => { looks += 1; if (looks === 2) s.busy(4000); return status(); };
    expect(await deliverRules(cli, line, 30, s.io)).toBe(true);
    expect(s.calls).toEqual(['Enter']);
    expect(s.refusals).toEqual([]);
  });

  test('still busy at the deadline: reported busy, the line left in its box, no clearing key', async () => {
    const s = seat(cli, fixture(file));
    let looks = 0;
    const status = s.io.status;
    s.io.status = () => { looks += 1; if (looks === 2) s.busy(10 * 60_000); return status(); };
    expect(await deliverRules(cli, line, 5, s.io)).toBe(false);
    expect(s.calls.filter((call) => call === 'Enter' || call.startsWith('key:'))).toEqual([]);
    const why = s.refusals.at(-1)!;
    expect(why).toMatchObject({ stop: 'working', typed: true, sent: false });
    expect(refusalReport(why)).toContain('busy with a turn');
    expect(refusalReport(why)).not.toContain("read-back didn't match");
  });
});
