import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { TEMPOS, type Tempo } from '../file/sections/tempo.ts';
import { writeTeamFile } from '../file/write.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = 'Usage: team tempo <word>\n';

const WORDS = 'relaxed, normal or urgent';

export const tempo: Command = (argv, io) => runTempo(argv, io);
export default tempo;

/**
 * `team tempo <word>`: write the team's tempo. The five watch waits stay as written; the
 * word scales them as soon as the watch reads the live file. `normal` is that file with the key
 * omitted, so writing it changes no approval.
 */
export async function runTempo(argv: string[], io: Io, sources: { home?: string } = {}): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length !== 1) {
    const extra = args.rest[1];
    const message = args.error ?? (extra !== undefined ? `unexpected "${extra}"` : 'a word is required');
    io.stderr(`team tempo: ${message}\n${USAGE}`);
    // exit: tempo.invocation
    return 2;
  }
  const word = args.rest[0] ?? '';
  if (!isTempo(word)) {
    io.stderr(`team tempo: "${word}" must be ${WORDS}\n${USAGE}`);
    // exit: tempo.word
    return 2;
  }
  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    io.stderr(`team tempo: ${detached}\n`);
    // exit: tempo.detached
    return 1;
  }
  const placement = `only the owner runs tempo, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
  const owner = isOwner(caller);
  if (!owner) {
    // Set to exactly `1`. Dev mode says the owner-only line once, as a warning, and the write
    // continues. The orchestrator's and the operator's own seats stay refused in every mode:
    // the peek reads the file for those two names and nothing else.
    const dev = io.env.TEAMCLI_DEV_MODE === '1';
    const peeked = dev ? loadTeamFile(io.cwd, { home: sources.home ?? homedir() }) : null;
    const held = !dev
      || (peeked !== null && peeked.ok && caller.kind === 'seat'
        && (caller.name === peeked.team.orchestrator || caller.name === peeked.team.operator));
    if (held) {
      io.stderr(`team tempo: ${placement}\n`);
      // exit: tempo.not-owner
      return 1;
    }
    io.stderr(`team tempo: warning: ${placement}; dev mode continues\n`);
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home ?? homedir() });
  let failed: string | undefined;
  if (!loaded.ok) {
    failed = loaded.errors[0]?.message ?? 'the team file can\'t be read';
  } else {
    const next = setTempo(loaded.text, word);
    if (next === loaded.text) {
      io.stdout(`tempo: ${word}\n`);
      // exit: tempo.unchanged
      return 0;
    }
    const wrote = writeTeamFile(loaded.path, next);
    if (wrote.ok) {
      io.stdout(`tempo: ${word}\n`);
      // exit: tempo.set
      return 0;
    }
    failed = wrote.errors[0]?.message ?? 'the team file can\'t be read';
  }
  io.stderr(`team tempo: ${failed}\n`);
  // exit: tempo.not-a-repo
  // exit: tempo.file
  return 2;
}

function isTempo(word: string): word is Tempo {
  return (TEMPOS as readonly string[]).includes(word);
}

/**
 * Put `tempo: <word>` on its own line. A line that already says that word, quotes and a
 * trailing comment included, is left as it is. A missing key is inserted on the line after
 * `format:`. The rest of the file is not rewritten.
 */
export function setTempo(text: string, word: Tempo): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => /^tempo:/.test(line));
  if (index >= 0) {
    const current = lines[index]?.match(/^tempo:\s*(?:"([^"]*)"|'([^']*)'|(\S+))/) ?? [];
    const written = current[1] ?? current[2] ?? current[3];
    if (written === word) return text;
    const comment = lines[index]?.match(/(\s+#.*)$/)?.[1] ?? '';
    lines[index] = `tempo: ${word}${comment}`;
    return lines.join('\n');
  }
  const format = lines.findIndex((line) => /^format:/.test(line));
  lines.splice(format >= 0 ? format + 1 : 0, 0, `tempo: ${word}`);
  return lines.join('\n');
}
