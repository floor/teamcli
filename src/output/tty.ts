import type { Io } from '../io.ts';

/**
 * Semantic terminal styling for plain output. Every helper is a no-op when
 * `enabled` is false (non-TTY stdout or `NO_COLOR` set in the environment).
 */
export interface TtyStyle {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  /** Colour a seat or finding state word (`working`, `idle`, `done`, `missing`, `stopped`, etc.). */
  styleState(state: string): string;
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
    if (trimmed === 'stopped' || trimmed === '-') return ANSI_STYLE.dim(state);
    if (
      trimmed === 'missing'
      || trimmed === 'wrong name'
      || trimmed === 'miss'
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
 * Colour is emitted only on an interactive TTY when `NO_COLOR` is unset or empty.
 */
export function ttyStyle(source?: Pick<Io, 'stdoutIsTTY' | 'env'> | boolean): TtyStyle {
  if (typeof source === 'boolean') return source ? ANSI_STYLE : PLAIN_STYLE;
  if (!source) return PLAIN_STYLE;
  const noColor = source.env?.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return PLAIN_STYLE;
  return source.stdoutIsTTY === true ? ANSI_STYLE : PLAIN_STYLE;
}
