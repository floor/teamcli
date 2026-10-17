import { GRANT_SCOPES } from '../file/types.ts';
import { plainLine } from '../launch/plain.ts';
import { COMMAND_GATES } from '../permissions/map.ts';
import { ttyStyle, type TtyStyle } from './tty.ts';

/**
 * Closed vocabulary for `who: <who>` on every difference repair:
 * derived from the permission map (`src/permissions/map.ts`) and grant scopes (`src/file/types.ts`).
 */
export const DIFFERENCE_WHO_VALUES = [
  'the owner',
  "the team's lead",
  'a grant holder',
  'any seat',
] as const;

export type DifferenceWho = (typeof DIFFERENCE_WHO_VALUES)[number];

export interface OutputDifference {
  what: string;
  repair: string;
  needs?: 'approve';
  owner?: boolean;
  approval?: boolean;
  who?: DifferenceWho;
}

export interface TableSpec {
  headers: readonly string[];
  rows: readonly (readonly (string | null | undefined)[])[];
  /** Leading indent for every line of the table; defaults to two spaces (`'  '`). Pass `''` for a top-level table at column 0. */
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
 * `project <name>  <id>  [entity <entity>  ]lead <lead>` (where a missing `id` or `lead` renders as `-`).
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
 *
 * `spec.indent` defaults to `'  '` (two spaces, for tables under a context line or section heading);
 * pass `indent: ''` for a top-level table with no context line so it starts at column 0.
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
/** Singleton note prefixes that are never grouped as seat names under `groupSeats: true`. */
export const RESERVED_NOTE_PREFIXES: ReadonlySet<string> = new Set(['watch', 'hold']);

export interface CollapseNotesOptions {
  readonly groupSeats?: boolean;
}

function isGroupableSeatPrefix(prefix: string): boolean {
  return !RESERVED_NOTE_PREFIXES.has(prefix) && !prefix.startsWith('proc ');
}

/**
 * Collapses repeated notes while keeping first-seen order:
 * 1. Exact duplicate notes repeated $n > 1$ times become `<note> (x<n>)`.
 * 2. When `opts?.groupSeats` is true, per-seat notes `<seat>: <reason>` sharing
 *    the same `<reason>` across multiple distinct seats become
 *    `<seat1>, <seat2>: <reason> (<n> seats)` (with duplicate `(seat, reason)` pairs
 *    collapsed before grouping so a repeated seat note never prevents multi-seat grouping).
 */
export function collapseNotes(notes: readonly string[], opts?: CollapseNotesOptions): string[] {
  const cleaned = notes.map((note) => plainLine(note));

  const exactCounts = new Map<string, number>();
  const uniqueOrder: string[] = [];
  for (const note of cleaned) {
    const prev = exactCounts.get(note) ?? 0;
    if (prev === 0) uniqueOrder.push(note);
    exactCounts.set(note, prev + 1);
  }

  if (!opts?.groupSeats) {
    return uniqueOrder.map((note) => {
      const count = exactCounts.get(note) ?? 1;
      return count > 1 ? `${note} (x${count})` : note;
    });
  }

  // Group per-seat `<seat>: <reason>` notes on the un-suffixed reason first so duplicate
  // notes for one seat still group with other seats sharing the same reason.
  const byReason = new Map<string, string[]>();
  for (const note of uniqueOrder) {
    const match = SEAT_NOTE_PREFIX.exec(note);
    if (!match) continue;
    const seat = match[1]!;
    const reason = match[2]!;
    if (!isGroupableSeatPrefix(seat)) continue;
    const list = byReason.get(reason) ?? [];
    if (!list.includes(seat)) list.push(seat);
    byReason.set(reason, list);
  }

  const emittedReasons = new Set<string>();
  const out: string[] = [];
  for (const note of uniqueOrder) {
    const match = SEAT_NOTE_PREFIX.exec(note);
    if (match) {
      const seat = match[1]!;
      const reason = match[2]!;
      const seats = byReason.get(reason);
      if (seats && seats.length > 1 && isGroupableSeatPrefix(seat)) {
        if (emittedReasons.has(reason)) continue;
        emittedReasons.add(reason);
        out.push(`${seats.join(', ')}: ${reason} (${seats.length} seats)`);
        continue;
      }
    }
    const count = exactCounts.get(note) ?? 1;
    out.push(count > 1 ? `${note} (x${count})` : note);
  }
  return out;
}

/** Formats notes as `note: <collapsed>` lines. */
export function renderNotes(notes: readonly string[], opts?: CollapseNotesOptions): string[] {
  return collapseNotes(notes, opts).map((note) => `note: ${note}`);
}

const REPAIR_TEAM_COMMAND = /\bteam\s+([a-z][a-z0-9-]*)\b/;

/**
 * Maps a `team <command>` name to the first `DifferenceWho` that applies from
 * the permission map (`src/permissions/map.ts`) and grant scopes (`src/file/types.ts`):
 * - `owner-only` → `'the owner'`
 * - `owner-or-leads` / `pane-authority` → `"the team's lead"`
 * - `capability` / `GRANT_SCOPES` (`reload`, `swap`, `approve`) → `'a grant holder'`
 * - `seat-record` / `owner-or-own-team` / `admission` → `'any seat'`
 */
export function whoFromCommand(command: string): DifferenceWho {
  const gate = COMMAND_GATES[command];
  if (gate) {
    if (gate.kind === 'owner-only') return 'the owner';
    if (gate.kind === 'owner-or-leads' || gate.kind === 'pane-authority') return "the team's lead";
    if (gate.kind === 'capability') return 'a grant holder';
    if (gate.kind === 'seat-record' || gate.kind === 'owner-or-own-team' || gate.kind === 'admission') {
      return 'any seat';
    }
  }
  if ((GRANT_SCOPES as readonly string[]).includes(command)) {
    return 'a grant holder';
  }
  return "the team's lead";
}

/**
 * Resolves who may run a difference's repair:
 * 1. Explicit `diff.who` when set.
 * 2. `'the owner'` when `diff.owner === true`, `diff.approval === true`,
 *    `diff.repair` starts with `'the owner '`, or `diff.repair` is the approval
 *    precondition (`'the live file is what the commands read'`).
 * 3. Otherwise, strips any trailing ` (after: …)` annotation (added when `diff.needs === 'approve'`)
 *    and maps the first `team <command>` in `diff.repair` through `whoFromCommand(command)`
 *    (falling back to `"the team's lead"` when the repair names no `team` subcommand).
 */
export function whoOfDifference(diff: OutputDifference): DifferenceWho {
  if (diff.who !== undefined) return diff.who;
  if (
    diff.owner === true
    || diff.approval === true
    || diff.repair.startsWith('the owner ')
    || diff.repair === 'the live file is what the commands read'
  ) {
    return 'the owner';
  }
  const coreRepair = diff.repair.replace(/\s+\(after:\s+.*\)$/, '');
  const match = REPAIR_TEAM_COMMAND.exec(coreRepair);
  if (match && match[1]) {
    return whoFromCommand(match[1]);
  }
  return "the team's lead";
}

/**
 * Renders one difference block:
 * ```
 * difference: <what>
 *   repair: <repair>
 *   who: <who>
 * ```
 * When `style.enabled` is true, only the `difference:` prefix is coloured red (`style.red('difference:')`);
 * `<what>`, `repair:`, and `who:` remain uncoloured plain text.
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

function isOwnerSummaryDifference(diff: OutputDifference): boolean {
  if (diff.owner === true || diff.approval === true) return true;
  if (diff.who !== undefined) return diff.who === 'the owner';
  return (
    diff.repair.startsWith('the owner ')
    || diff.repair === 'the live file is what the commands read'
  );
}

/** Counts total differences and owner-only differences for the closing summary line. */
export function summaryCounts(diffs: readonly OutputDifference[]): DifferenceSummaryCounts {
  const ownerCount = diffs.filter(isOwnerSummaryDifference).length;
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

/**
 * Single severity vocabulary for diagnostic/prerequisite rows (`team doctor`, `team mcp doctor`):
 * `ok` (`ok  `), `warn` (`warn`), `miss` (`MISS`), and `note` (`--  `).
 */
export const SEVERITY_LEVELS = ['ok', 'warn', 'miss', 'note'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_LABELS: Readonly<Record<SeverityLevel, string>> = {
  ok: 'ok  ',
  warn: 'warn',
  miss: 'MISS',
  note: '--  ',
};

export interface OutputFinding {
  readonly level: SeverityLevel;
  readonly text: string;
}

/** Renders a diagnostic finding line (`<label>  <text>`) with optional TTY state colouring on the label. */
export function renderFinding(finding: OutputFinding, style: TtyStyle = ttyStyle(false)): string {
  const rawLabel = SEVERITY_LABELS[finding.level];
  const label = style.enabled ? style.styleState(rawLabel) : rawLabel;
  return `${label}  ${plainLine(finding.text)}`;
}

/**
 * Deprecation warning helper: emitted only in `team check` (and `team doctor`),
 * never on routine read commands (`status`, `seats`, `list`, `usage`).
 */
export interface DeprecationWarning {
  readonly line?: number;
  readonly message: string;
  readonly repair?: string;
}

export function formatDeprecationWarning(warning: DeprecationWarning): string {
  const loc = warning.line !== undefined ? `the file, line ${warning.line}: ` : 'the file: ';
  const tail = warning.repair ? `; repair: ${plainLine(warning.repair)}` : '';
  return `warning: ${loc}${plainLine(warning.message)}${tail}`;
}

export function renderDeprecationWarnings(warnings: readonly DeprecationWarning[]): string[] {
  return collapseNotes(warnings.map(formatDeprecationWarning));
}

/**
 * Shared action and `--dry-run` plan surface (`up`, `down`, `add`, `remove`, `restart`, `reload`, `register`, `grant`, `delegate`, `revoke`, `worktree`, etc.).
 */
export type PlanPrefix = '+' | '!' | 'skip';

export interface PlanStep {
  readonly step: string;
  readonly detail: string;
  readonly seat?: string | null;
  readonly prefix?: PlanPrefix;
}

export function renderPlanStep(item: PlanStep): string {
  const prefix = item.prefix ?? '+';
  const lead = prefix === 'skip' ? '  skip' : `${prefix}`;
  const target = item.seat ? `${plainLine(item.seat)}: ` : '';
  return `${lead} ${plainLine(item.step)}: ${target}${plainLine(item.detail)}`;
}

export function renderDryRunPlan(header: string | null, steps: readonly PlanStep[]): string[] {
  const lines: string[] = [];
  if (header !== null && header !== '') lines.push(plainLine(header));
  for (const step of steps) lines.push(renderPlanStep(step));
  lines.push('dry run: nothing was run');
  return lines;
}

export interface ActionSummarySpec {
  readonly command?: string;
  readonly summary: string;
  readonly dryRun?: boolean;
}

export function renderActionSummary(spec: ActionSummarySpec | string): string {
  if (typeof spec === 'string') return plainLine(spec);
  if (spec.dryRun) return 'dry run: nothing was run';
  const prefix = spec.command ? `team ${plainLine(spec.command)}: ` : '';
  return `${prefix}${plainLine(spec.summary)}`;
}

/**
 * Helper for formatting the standard `Exits ...` footer sentence in `--help` (`USAGE`).
 * Note: `export const USAGE` in `src/commands/<cmd>.ts` must remain a static string literal
 * so `scripts/contract.ts` can extract it from the AST.
 */
export interface HelpExitSpec {
  readonly code: number;
  readonly when: string;
}

export function formatHelpExits(exits: readonly HelpExitSpec[]): string {
  const clauses = exits.map((entry) => `${entry.code} ${plainLine(entry.when)}`);
  return `Exits ${clauses.join(', ')}.`;
}
