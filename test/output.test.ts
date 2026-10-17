import { describe, expect, test } from 'bun:test';
import {
  collapseNotes,
  contextLine,
  ERROR_OUTPUT_SCHEMA,
  formatTable,
  jsonEnvelope,
  jsonError,
  projectContextLine,
  renderDifference,
  renderDifferences,
  renderNotes,
  renderSummary,
  renderTable,
  STATUS_OUTPUT_SCHEMA,
  summaryCounts,
  toJsonDifference,
  ttyStyle,
  whoOfDifference,
} from '../src/output/index.ts';
import {
  assertGoldenOutput,
  assertJsonErrorShape,
  assertMatchesOutputSchema,
  assertNoAnsi,
  stripAnsi,
} from './helpers/output.ts';

describe('src/output/ — context line and tables', () => {
  test('contextLine and projectContextLine clean control bytes and format the header', () => {
    expect(contextLine('beacon\x1b[31m', 'beacon\nnext')).toBe('team beacon, session "beacon next"');
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: 'acme', lead: null })).toBe(
      'project Beacon  beacon  entity acme  lead -',
    );
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: null, lead: 'lead-1' })).toBe(
      'project Beacon  beacon  lead lead-1',
    );
  });

  test('renderTable prints uppercase headers, aligns on cleaned text, and uses "-" for empty cells', () => {
    const lines = renderTable({
      headers: ['seat', 'state', 'model', 'pane', 'reach'],
      rows: [
        ['claude-keeper', 'working', 'Claude Opus 5.5', 'w1:p1', 'socket'],
        ['codex-acme', 'missing', 'GPT Sol 6', null, 'typed'],
      ],
    });
    assertGoldenOutput(`${lines.join('\n')}\n`, [
      '  SEAT           STATE    MODEL            PANE   REACH',
      '  claude-keeper  working  Claude Opus 5.5  w1:p1  socket',
      '  codex-acme     missing  GPT Sol 6        -      typed',
    ]);
  });

  test('TTY styling colours headers and cells only on a TTY when NO_COLOR is unset, without shifting column widths', () => {
    const plain = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: false, env: {} }),
      styleCell: (padded, raw, _r, col, style) => (col === 1 ? style.styleState(padded || raw) : padded),
    });
    assertNoAnsi(plain);

    const noColor = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: true, env: { NO_COLOR: '1' } }),
      styleCell: (padded, raw, _r, col, style) => (col === 1 ? style.styleState(padded || raw) : padded),
    });
    assertNoAnsi(noColor);
    expect(noColor).toBe(plain);

    const coloured = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: true, env: {} }),
      styleCell: (padded, _raw, _r, col, style) => (col === 1 ? style.styleState(padded) : padded),
    });
    expect(coloured).toContain('\x1b[1m');
    expect(coloured).toContain('\x1b[32m');
    expect(coloured).toContain('\x1b[31m');
    expect(stripAnsi(coloured)).toBe(plain);
  });
});

describe('src/output/ — note collapsing, differences, and summary', () => {
  test('collapseNotes collapses exact duplicates and multi-seat shared reasons while keeping watch/hold/proc distinct', () => {
    const raw = [
      'hold until 2026-10-04T00:00:00.000Z: freeze deploys',
      'codex-acme: version unread',
      'deepseek-acme: version unread',
      'watch: pane w9:p1, pid 4242, last heartbeat 0s ago',
      'the herdr session "acme" is not running',
      'the herdr session "acme" is not running',
      'proc dev-server: builder-1 since 2026-10-17T10:00:00Z, pid 1234',
    ];
    expect(collapseNotes(raw)).toEqual([
      'hold until 2026-10-04T00:00:00.000Z: freeze deploys',
      'codex-acme, deepseek-acme: version unread (2 seats)',
      'watch: pane w9:p1, pid 4242, last heartbeat 0s ago',
      'the herdr session "acme" is not running (x2)',
      'proc dev-server: builder-1 since 2026-10-17T10:00:00Z, pid 1234',
    ]);
    expect(renderNotes(['codex-acme: version unread'])).toEqual(['note: codex-acme: version unread']);
  });

  test('renderDifference, whoOfDifference, and renderSummary format repair, who, and counts', () => {
    const diffs = [
      { what: 'claude-keeper is in the file and is not running', repair: 'team add claude-keeper' },
      { what: 'codex-acme waits at a permission prompt', repair: 'the owner answers it in the pane', owner: true },
    ];
    expect(whoOfDifference(diffs[0]!)).toBe('owner or lead');
    expect(whoOfDifference(diffs[1]!)).toBe('owner');
    expect(renderDifference(diffs[0]!)).toEqual([
      'difference: claude-keeper is in the file and is not running',
      '  repair: team add claude-keeper',
      '  who: owner or lead',
    ]);
    expect(renderDifferences(diffs)).toEqual([
      'difference: claude-keeper is in the file and is not running',
      '  repair: team add claude-keeper',
      '  who: owner or lead',
      'difference: codex-acme waits at a permission prompt',
      '  repair: the owner answers it in the pane',
      '  who: owner',
    ]);
    expect(summaryCounts(diffs)).toEqual({ differences: 2, owner_differences: 1 });
    expect(renderSummary(diffs)).toBe('2 difference(s), 1 for the owner');
    expect(renderSummary([diffs[0]!])).toBe('1 difference(s)');
    expect(renderSummary([])).toBe('0 difference(s)');
  });
});

describe('src/output/ — JSON envelope, error writer, and schema validation', () => {
  test('jsonEnvelope and STATUS_OUTPUT_SCHEMA validate a status document', () => {
    const doc = jsonEnvelope('team.status', {
      format: 1 as const,
      project: 'beacon',
      session: 'beacon',
      rows: [
        {
          name: 'claude-keeper',
          state: 'working',
          model: 'Claude Opus 5.5',
          pane: 'w1:p1',
          reach: 'socket' as const,
        },
      ],
      notes: [],
      differences: [
        toJsonDifference({
          what: 'claude-beacon is in the file and is not running',
          repair: 'team add claude-beacon',
        }),
      ],
      summary: { differences: 1, owner_differences: 0 },
      notice: null,
    });
    const parsed = assertMatchesOutputSchema(JSON.stringify(doc), STATUS_OUTPUT_SCHEMA);
    expect(parsed).toEqual(doc);
  });

  test('jsonError and ERROR_OUTPUT_SCHEMA validate an error document', () => {
    const raw = JSON.stringify(jsonError('status.herdr', "herdr doesn't answer; is it installed and running?", 'start herdr'));
    const checked = assertJsonErrorShape(raw, {
      id: 'status.herdr',
      messageContains: "herdr doesn't answer",
      repair: 'start herdr',
    });
    expect(checked.error.id).toBe('status.herdr');
    expect(() => assertMatchesOutputSchema(raw, ERROR_OUTPUT_SCHEMA)).not.toThrow();
  });
});
