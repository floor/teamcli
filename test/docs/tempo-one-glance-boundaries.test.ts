// The one-glance cut of the team tempo page at its boundaries.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const COMMAND_PAGE = '../../docs/commands/tempo.md';
const INTERNAL_PAGE = '../../docs/internal/tempo.md';
const TEMPO_SRC = '../../src/commands/tempo.ts';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the tempo page', () => {
  test('closing pointer and internal structure sentences and headings', () => {
    const cmdProse = prose(COMMAND_PAGE);
    expect(cmdProse).toContain('Rationale, behaviour, refusals and known limits: [docs/internal/tempo.md](../internal/tempo.md).');

    const internalRaw = raw(INTERNAL_PAGE);
    const internalProse = prose(INTERNAL_PAGE);

    expect(internalRaw).toContain('# `team tempo`: rationale and known limits');
    expect(internalRaw).toContain('## What it reads and writes');
    expect(internalRaw).toContain('## The runs the page no longer carries');

    expect(internalProse).toContain(
      'What moved off [the `team tempo` page](../commands/tempo.md): what the run reads and writes, and the runs the page no longer carries.',
    );
    expect(internalProse).toContain(
      'The synopsis, the flags, the caller table, the output and exit codes table and the one example stay on the page.',
    );
    expect(internalProse).toContain(
      'None is executed by any test — `test/docs.test.ts` runs the console fences of `docs/commands/` alone — and each runs against the page\'s own team file.',
    );
  });

  test('what stayed on docs/commands/tempo.md', () => {
    const cmdRaw = raw(COMMAND_PAGE);
    const cmdProse = prose(COMMAND_PAGE);

    // synopsis
    expect(cmdRaw).toContain('team tempo <word>');

    // flag rows
    expect(cmdRaw).toContain('| `<word>` | `relaxed`, `normal` or `urgent` |');
    expect(cmdRaw).toContain('| `--help`, `-h` | the usage, and exit 0 |');

    // caller rows
    expect(cmdProse).toContain('| the owner, from a terminal outside herdr | set the word |');
    expect(cmdProse).toContain('| a run with no terminal | nothing: `team tempo: only the owner runs this, from a terminal outside herdr` |');
    expect(cmdProse).toContain('| a seat, or an agent-run CLI | nothing: `team tempo: only the owner runs tempo, from a terminal outside herdr; this call is <caller>` |');

    // output rows
    expect(cmdProse).toContain('| the word was written, or it was already that word | `tempo: <word>` | 0 |');
    expect(cmdProse).toContain('| `team tempo: <problem>`, with the usage for a bad word | 2');

    // remaining example
    expect(cmdRaw).toContain('The owner sets it:');
    expect(cmdRaw).toContain('$ team tempo urgent ; echo "exit $?"\ntempo: urgent\nexit 0');
  });

  test('the three moved runs verbatim in docs/internal/tempo.md and absent from docs/commands/tempo.md, matched against src/commands/tempo.ts', () => {
    const cmdRaw = raw(COMMAND_PAGE);
    const internalRaw = raw(INTERNAL_PAGE);
    const srcRaw = raw(TEMPO_SRC);

    const run1 = 'The same word again leaves the line:\n\n```console\n$ team tempo urgent ; echo "exit $?"\ntempo: urgent\nexit 0\n```';
    const run2 = 'A word the file does not know is the usage:\n\n```console\n$ team tempo faster ; echo "exit $?"\nteam tempo: "faster" must be relaxed, normal or urgent\nUsage: team tempo <word>\nexit 2\n```';
    const run3 = "A seat can't run it:\n\n```console caller=agent\n$ team tempo urgent ; echo \"exit $?\"\nteam tempo: only the owner runs tempo, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)\nexit 1\n```";

    expect(internalRaw).toContain(run1);
    expect(internalRaw).toContain(run2);
    expect(internalRaw).toContain(run3);

    expect(cmdRaw).not.toContain(run1);
    expect(cmdRaw).not.toContain(run2);
    expect(cmdRaw).not.toContain(run3);

    // match messages against src/commands/tempo.ts
    expect(srcRaw).toContain("const WORDS = 'relaxed, normal or urgent';");
    expect(srcRaw).toContain('team tempo: "${word}" must be ${WORDS}');
    expect(srcRaw).toContain('const placement = `only the owner runs tempo, from a terminal outside herdr; this call is ${describeCaller(caller)}`;');
    expect(srcRaw).toContain('io.stderr(`team tempo: ${placement}\\n`);');
    expect(srcRaw).toContain('tempo: ${word}\\n');
    expect(srcRaw).toContain('Usage: team tempo <word>\\n');
  });

  test('the moved read-and-write rules in docs/internal/tempo.md and absent from docs/commands/tempo.md, matched against setTempo in src/commands/tempo.ts', () => {
    const cmdProse = prose(COMMAND_PAGE);
    const internalProse = prose(INTERNAL_PAGE);
    const srcRaw = raw(TEMPO_SRC);

    const readWriteRule = 'Reads the team file in the current folder. Writes one line, `tempo: <word>`, after `format:` when the key is missing, or on the line that already names it. The rest of the file is left as it is. A line that already says that word is not rewritten.';

    expect(internalProse).toContain(readWriteRule);
    expect(cmdProse).not.toContain(readWriteRule);

    // Match logic against setTempo in src/commands/tempo.ts
    expect(srcRaw).toContain('export function setTempo(text: string, word: Tempo): string {');
    expect(srcRaw).toContain("const index = lines.findIndex((line) => /^tempo:/.test(line));");
    expect(srcRaw).toContain('if (written === word) return text;');
    expect(srcRaw).toContain("const format = lines.findIndex((line) => /^format:/.test(line));");
    expect(srcRaw).toContain('lines.splice(format >= 0 ? format + 1 : 0, 0, `tempo: ${word}`);');
  });
});
