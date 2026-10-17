import { plainLine } from '../launch/plain.ts';
import { ttyStyle, type TtyStyle } from './tty.ts';

/** Who may run a difference's repair. */
export type DifferenceWho = 'owner' | 'lead' | 'owner or lead' | 'seat' | 'any';

export interface OutputDifference {
  what: string;
  repair: string;
  owner?: boolean;
  who?: DifferenceWho;
}

export interface TableSpec {
  headers: readonly string[];
  rows: readonly (readonly (string | null | undefined)[])[];
  /** Leading indent for every line of the table; defaults to two spaces (`'  '`). */
  indent?: string;
  /** Optional TTY style; column widths are always measured on uncoloured `plainLine` text. */
  style?: TtyStyle;
  /** Optional per-cell styler applied after width padding when `style.enabled` is true. */
  styleCell?: (padded: string, rawCleaned: string, rowIndex: number, colIndex: number, style: TtyStyle) => string;
}

/**
 * The opening context line for a team-scoped command:
 * `team <project>, session "<session>"`.
 */
export function contextLine(project: string, session: string): string {
  return `team ${plainLine(project)}, session "${plainLine(session)}"`;
}

/**
 * The opening context line for a project-scoped command (`team status --project <name>`):
 * `project <name>  <id>  [entity <entity>  ]lead <lead>`.
 */
export function projectContextLine(project: {
  name: string;
  id?: string | null;
  entity: string | null;
  lead?: string | null;
}): string {
  const parts = [`project ${plainLine(project.name)}  ${plainLine(project.id ?? '-')}`];
  if (project.entity !== null) parts.push(`entity ${plainLine(project.entity)}`);
  parts.push(`lead ${plainLine(project.lead ?? '-')}`);
  return parts.join('  ');
}

function cleanCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const cleaned = plainLine(value);
  return cleaned === '' ? '-' : cleaned;
}

/**
 * Renders a table with an uppercase header row, two-space column separation,
 * and width calculation performed strictly on cleaned (`plainLine`) text prior
 * to any TTY colour wrapping.
 */
export function renderTable(spec: TableSpec): string[] {
  const indent = spec.indent ?? '  ';
  const style = spec.style ?? ttyStyle(false);
  const headCells = spec.headers.map((header) => plainLine(header).toUpperCase());
  const bodyRows = spec.rows.map((row) => headCells.map((_, index) => cleanCell(row[index])));

  const widths = headCells.map((label, colIndex) =>
    Math.max(label.length, ...bodyRows.map((row) => row[colIndex]?.length ?? 0)),
  );

  const formatRow = (cells: string[], rowIndex: number | 'header'): string => {
    const rendered = cells.map((cell, colIndex) => {
      const isLast = colIndex === cells.length - 1;
      const padded = isLast ? cell : cell.padEnd(widths[colIndex] ?? 0);
      if (!style.enabled) return padded;
      if (rowIndex === 'header') return style.bold(padded);
      return spec.styleCell ? spec.styleCell(padded, cell, rowIndex, colIndex, style) : padded;
    });
    return `${indent}${rendered.join('  ').trimEnd()}`;
  };

  return [
    formatRow(headCells, 'header'),
    ...bodyRows.map((cells, rowIndex) => formatRow(cells, rowIndex)),
  ];
}

/** Joins `renderTable(spec)` with newlines and a trailing newline. */
export function formatTable(spec: TableSpec): string {
  return `${renderTable(spec).join('\n')}\n`;
}

const SEAT_NOTE_PREFIX = /^([a-zA-Z0-9][a-zA-Z0-9._-]*): (.+)$/;
const RESERVED_NOTE_PREFIXES = new Set(['watch', 'hold']);

/**
 * Collapses repeated notes while keeping first-seen order:
 * 1. Exact duplicate notes repeated $n > 1$ times become `<note> (x<n>)`.
 * 2. Per-seat notes `<seat>: <reason>` sharing the same `<reason>` across
 *    multiple distinct seats become `<seat1>, <seat2>: <reason> (<n> seats)`.
 */
export function collapseNotes(notes: readonly string[]): string[] {
  const cleaned = notes.map((note) => plainLine(note));

  // Step 1: collapse exact duplicates in first-seen order.
  const exactCounts = new Map<string, number>();
  const uniqueOrder: string[] = [];
  for (const note of cleaned) {
    const prev = exactCounts.get(note) ?? 0;
    if (prev === 0) uniqueOrder.push(note);
    exactCounts.set(note, prev + 1);
  }
  const deduplicated = uniqueOrder.map((note) => {
    const count = exactCounts.get(note) ?? 1;
    return count > 1 ? `${note} (x${count})` : note;
  });

  // Step 2: group per-seat `<seat>: <reason>` notes that share the same `<reason>`.
  const byReason = new Map<string, string[]>();
  for (const note of deduplicated) {
    const match = SEAT_NOTE_PREFIX.exec(note);
    if (!match) continue;
    const seat = match[1]!;
    const reason = match[2]!;
    if (RESERVED_NOTE_PREFIXES.has(seat) || seat.startsWith('proc ')) continue;
    const list = byReason.get(reason) ?? [];
    list.push(seat);
    byReason.set(reason, list);
  }

  const emittedReasons = new Set<string>();
  const out: string[] = [];
  for (const note of deduplicated) {
    const match = SEAT_NOTE_PREFIX.exec(note);
    if (match) {
      const seat = match[1]!;
      const reason = match[2]!;
      const seats = byReason.get(reason);
      if (seats && seats.length > 1 && !RESERVED_NOTE_PREFIXES.has(seat)) {
        if (emittedReasons.has(reason)) continue;
        emittedReasons.add(reason);
        out.push(`${seats.join(', ')}: ${reason} (${seats.length} seats)`);
        continue;
      }
    }
    out.push(note);
  }
  return out;
}

/** Formats notes as `note: <collapsed>` lines. */
export function renderNotes(notes: readonly string[]): string[] {
  return collapseNotes(notes).map((note) => `note: ${note}`);
}

/**
 * Resolves who may run a difference's repair:
 * - explicit `diff.who` when set
 * - `'owner'` when `diff.owner === true` or the repair names the owner
 * - `'owner or lead'` otherwise
 */
export function whoOfDifference(diff: OutputDifference): DifferenceWho {
  if (diff.who !== undefined) return diff.who;
  if (
    diff.owner === true
    || diff.repair.startsWith('the owner ')
    || diff.repair === 'the live file is what the commands read'
  ) {
    return 'owner';
  }
  return 'owner or lead';
}

/**
 * Renders one difference block:
 * ```
 * difference: <what>
 *   repair: <repair>
 *   who: <who>
 * ```
 */
export function renderDifference(diff: OutputDifference, style: TtyStyle = ttyStyle(false)): string[] {
  const what = plainLine(diff.what);
  const repair = plainLine(diff.repair);
  const who = plainLine(whoOfDifference(diff));
  const head = style.enabled ? `${style.red('difference:')} ${what}` : `difference: ${what}`;
  return [
    head,
    `  repair: ${repair}`,
    `  who: ${who}`,
  ];
}

/** Renders all differences in order. */
export function renderDifferences(diffs: readonly OutputDifference[], style: TtyStyle = ttyStyle(false)): string[] {
  return diffs.flatMap((diff) => renderDifference(diff, style));
}

export interface DifferenceSummaryCounts {
  differences: number;
  owner_differences: number;
}

/** Counts total differences and owner-only differences. */
export function summaryCounts(diffs: readonly OutputDifference[]): DifferenceSummaryCounts {
  const ownerCount = diffs.filter((diff) => whoOfDifference(diff) === 'owner').length;
  return {
    differences: diffs.length,
    owner_differences: ownerCount,
  };
}

/**
 * Renders the single closing summary line for a reading:
 * `0 difference(s)`, `<n> difference(s)`, or `<n> difference(s), <m> for the owner`.
 */
export function renderSummary(diffs: readonly OutputDifference[]): string {
  const { differences, owner_differences } = summaryCounts(diffs);
  if (owner_differences > 0) {
    return `${differences} difference(s), ${owner_differences} for the owner`;
  }
  return `${differences} difference(s)`;
}
