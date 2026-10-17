import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import { TEMPOS, type Tempo } from '../file/sections/tempo.ts';
import { writeTeamFile } from '../file/write.ts';
import type { Command, Io } from '../io.ts';
import { contextLine, hasJsonFlag, refuse, writeJson } from '../output/index.ts';

export const USAGE = `Usage: team tempo <word> [--json]

Exits 0 when the tempo is set or already matches, 1 when the caller is not the owner, 2 when the invocation, tempo word, or team file can't be read.
`;

const WORDS = 'relaxed, normal or urgent';

export const tempo: Command = (argv, io) => runTempo(argv, io);
export default tempo;

/**
 * `team tempo <word>`: write the team's tempo. The five watch waits stay as written; the
 * word scales them as soon as the watch reads the live file. `normal` is that file with the key
 * omitted, so writing it changes no approval.
 */
export async function runTempo(argv: string[], io: Io, sources: { home?: string } = {}): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  // Read from the raw argv before the parser runs: a bad option before `--json`, or a
  // malformed `--json=<value>`, still asks for the structured refusal.
  const json = hasJsonFlag(argv);
  if (args.error || args.rest.length !== 1) {
    const extra = args.rest[1];
    const message = args.error ?? (extra !== undefined ? `unexpected "${extra}"` : 'a word is required');
    refuse(io, json, 'tempo', { id: 'tempo.invocation', message, repair: null, usage: USAGE, code: 2 });
    // exit: tempo.invocation
    return 2;
  }
  const word = args.rest[0] ?? '';
  if (!isTempo(word)) {
    refuse(io, json, 'tempo', {
      id: 'tempo.word',
      message: `"${word}" must be ${WORDS}`,
      repair: null,
      code: 2,
      usage: USAGE,
    });
    // exit: tempo.word
    return 2;
  }
  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    refuse(io, json, 'tempo', { id: 'tempo.detached', message: detached, repair: null, code: 1 });
    // exit: tempo.detached
    return 1;
  }
  const placement = `only the owner runs tempo, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
  const owner = isOwner(caller);
  if (!owner) {
    // Dev mode does not reach this gate: setting the tempo is never a dev-mode command
    // (`dev_mode.ts`), so every non-owner call is refused, the orchestrator's and the
    // operator's included.
    refuse(io, json, 'tempo', { id: 'tempo.not-owner', message: placement, repair: null, rule: 'owner-only', code: 1 });
    // exit: tempo.not-owner
    return 1;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home ?? homedir() });
  let failed: string | undefined;
  if (!loaded.ok) {
    failed = loaded.errors[0]?.message ?? 'the team file can\'t be read';
  } else {
    const team = { project: loaded.team.project, session: loaded.team.session };
    const next = setTempo(loaded.text, word);
    if (next === loaded.text) {
      summary(io, json, team, word, 'same');
      // exit: tempo.unchanged
      return 0;
    }
    const wrote = writeTeamFile(loaded.path, next);
    if (wrote.ok) {
      summary(io, json, team, word, 'set');
      // exit: tempo.set
      return 0;
    }
    failed = wrote.errors[0]?.message ?? 'the team file can\'t be read';
  }
  refuse(io, json, 'tempo', {
    id: failed === NOT_A_REPO ? 'tempo.not-a-repo' : 'tempo.file',
    message: failed,
    repair: null,
    code: 2,
  });
  // exit: tempo.not-a-repo
  // exit: tempo.file
  return 2;
}

/** The one outcome: the context line and the word in plain text, the action envelope under
 *  `--json`. The word line is the closing summary in both. */
function summary(
  io: Io,
  json: boolean,
  team: { project: string; session: string },
  word: Tempo,
  status: 'set' | 'same',
): void {
  const line = `tempo: ${word}`;
  if (json) {
    writeJson(io, 'team.tempo', {
      format: 1 as const,
      dry_run: false,
      status,
      action_summary: line,
      project: team.project,
      session: team.session,
      value: word,
    });
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n${line}\n`);
  }
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
