import type { Io } from '../io.ts';

/**
 * Semantic terminal styling for plain output. Every helper is a no-op when
 * `enabled` is false (non-TTY stream, `NO_COLOR` set and non-empty, or `--json` active).
 */
export interface TtyStyle {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  /** Colour a seat or finding state/severity word (`working`, `idle`, `done`, `missing`, `stopped`, `ok`, `warn`, `MISS`, `--`, etc.). */
  styleState(state: string): string;
}

export type TtySource =
  | (Pick<Io, 'stdoutIsTTY' | 'stderrIsTTY' | 'env'> & { readonly json?: boolean })
  | boolean;

export interface TtyOptions {
  /** Which output stream to check for TTY status; defaults to `'stdout'`. */
  readonly stream?: 'stdout' | 'stderr';
  /** When `true`, forces `PLAIN_STYLE` (`--json` output never carries ANSI escapes). */
  readonly json?: boolean;
}

const PLAIN_STYLE: TtyStyle = {
  enabled: false,
  bold: (text) => text,
  dim: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  red: (text) => text,
  styleState: (text) => text,
};

function wrap(open: string, close: string, text: string): string {
  return text === '' ? '' : `${open}${text}${close}`;
}

const ANSI_STYLE: TtyStyle = {
  enabled: true,
  bold: (text) => wrap('\x1b[1m', '\x1b[22m', text),
  dim: (text) => wrap('\x1b[2m', '\x1b[22m', text),
  green: (text) => wrap('\x1b[32m', '\x1b[39m', text),
  yellow: (text) => wrap('\x1b[33m', '\x1b[39m', text),
  red: (text) => wrap('\x1b[31m', '\x1b[39m', text),
  styleState(state) {
    const trimmed = state.trim();
    if (trimmed === 'stopped' || trimmed === '-' || trimmed === '--' || trimmed === 'note') return ANSI_STYLE.dim(state);
    if (
      trimmed === 'missing'
      || trimmed === 'wrong name'
      || trimmed === 'miss'
      || trimmed === 'MISS'
      || trimmed.startsWith('restored, not launched by team')
      || trimmed.includes('(blind)')
    ) {
      return ANSI_STYLE.red(state);
    }
    if (
      trimmed === 'warn'
      || trimmed.startsWith('waiting')
      || trimmed.startsWith('trust sent')
      || trimmed.includes('(unsent text)')
      || trimmed.startsWith('blocked: quota')
      || trimmed.includes('(rate limit')
      || trimmed.includes('(screen not recognised)')
      || trimmed.endsWith(', parked')
    ) {
      return ANSI_STYLE.yellow(state);
    }
    if (
      trimmed === 'working'
      || trimmed === 'idle'
      || trimmed === 'done'
      || trimmed === 'ok'
      || trimmed === 'working, temporary'
      || trimmed === 'idle, temporary'
      || trimmed === 'done, temporary'
    ) {
      return ANSI_STYLE.green(state);
    }
    return state;
  },
};

/**
 * Whether ANSI colour is active for this `io` (or explicit boolean).
 * Colour is emitted only on an interactive TTY for the chosen stream (`stdout` by default,
 * or `stderr` when `opts?.stream === 'stderr'`) when `NO_COLOR` is unset or empty and
 * `--json` is not active.
 */
export function ttyStyle(source?: TtySource, opts?: TtyOptions): TtyStyle {
  if (opts?.json === true) return PLAIN_STYLE;
  if (typeof source === 'boolean') return source ? ANSI_STYLE : PLAIN_STYLE;
  if (!source) return PLAIN_STYLE;
  if (source.json === true) return PLAIN_STYLE;
  const noColor = source.env?.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return PLAIN_STYLE;
  const isTty = opts?.stream === 'stderr' ? source.stderrIsTTY === true : source.stdoutIsTTY === true;
  return isTty ? ANSI_STYLE : PLAIN_STYLE;
}
