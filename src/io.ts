import type { Caller, CallerSources } from './caller.ts';
import { plainLine } from './launch/plain.ts';

// What a command gets from the process, so tests can run one without a process.
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  /** Whether stdout is a terminal: only then does `up` or `add` draw a seat's provisional line.
   *  Absent counts as false — a caller that never reads it may leave it out. */
  stdoutIsTTY?: boolean;
  /** Whether stderr is a terminal: used by `ttyStyle` when colouring stderr diagnostics.
   *  Absent counts as false. */
  stderrIsTTY?: boolean;
  // Set by tests only. A command asks `callerOf(io)`, which otherwise reads the processes.
  caller?: Caller;
  // Set by tests only. A command asks `callerOf(io, session)`, which otherwise reads the
  // processes: these sources stand in for them, asked about the same session, so the placement
  // a test sees is the one the command itself made.
  callerSources?: (session: string | undefined) => CallerSources;
};

// `argv` is what follows the command's name. The result is the exit code.
export type Command = (argv: string[], io: Io) => Promise<number>;

/** The same `io` with both of its writers cleaning what they are given, before the raw writer
 *  writes it: every line the text holds is cleaned with the one cleaning (`plainLine`) and the
 *  text's own line structure — its line breaks and its trailing newline — is kept. A command
 *  takes it once at its entry and writes everything else through it, so nothing that command
 *  writes reaches a terminal uncleaned, whoever built the text.
 *
 *  The one writer that keeps the raw sinks is the progress writer: it draws its own control
 *  bytes (on a TTY a `\r\x1b[K` before each in-place rewrite), and cleaning would strip them;
 *  its text it cleans itself, field by field, before it composes those bytes. The record's
 *  fields are cleaned through `plainLine` either way, so the two never disagree about text.
 *
 *  The cleaning is idempotent — a line already cleaned comes back unchanged — so a value
 *  cleaned at a call site and again here is, in effect, cleaned once. */
export function cleanedIo(io: Io): Io {
  const clean = (text: string): string => text.split('\n').map((line) => plainLine(line)).join('\n');
  return {
    ...io,
    stdout: (text) => io.stdout(clean(text)),
    stderr: (text) => io.stderr(clean(text)),
  };
}
