// The attribution census: a command that registers a launch or writes a ready seat record is an
// attribution path, and every attribution path must call the one boundary that claims and
// delivers the general seat brief (`deliverBriefForAttribution`). The scan is keyed by function,
// not by line, so a new such command fails here with its file name. It is a tripwire, not a
// proof: the per-command tests are the behavioural evidence.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'src', 'commands');

// Commands that end seats attribute nobody, so they have no brief to deliver. The registry-only
// helpers live outside `src/commands/`, which is all this scan reads.
const ALLOWED = new Set(['down.ts', 'remove.ts']);

const ATTRIBUTES = /registerLaunch\(|stage: 'ready'/;
const BOUNDARY = 'deliverBriefForAttribution(';

type Source = { name: string; source: string };

/** The files that look like attribution paths and never call the boundary. */
function missingBoundary(sources: readonly Source[], allowed: ReadonlySet<string> = ALLOWED): string[] {
  return sources
    .filter(({ name, source }) => name.endsWith('.ts') && !allowed.has(name) && ATTRIBUTES.test(source) && !source.includes(BOUNDARY))
    .map(({ name }) => name);
}

function tree(): Source[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(DIR, name), 'utf8') }));
}

describe('the general seat brief follows every attribution path', () => {
  test('every command that launches or adopts a seat calls the boundary', () => {
    expect(missingBoundary(tree())).toEqual([]);
  });

  test('the census fires on a command that writes a ready seat record and calls nothing else', () => {
    // A small command, written here rather than on disk, that writes the record an attribution
    // path writes and delivers nothing: the scan must name it.
    const planted = [
      "import { updateState } from '../state.ts';",
      '',
      'export function planted(dir: string): void {',
      '  updateState(dir, (state) => {',
      '    const session = (state.sessions.planted ??= { seats: {}, worktrees: {} });',
      "    session.seats.worker = { stage: 'ready', pane: 'w1:p1' };",
      '  });',
      '}',
    ].join('\n');
    expect(missingBoundary([{ name: 'planted.ts', source: planted }])).toEqual(['planted.ts']);
    // The same command with the boundary call passes, and an allowlisted command is not named.
    expect(missingBoundary([{ name: 'planted.ts', source: `${planted}\ndeliverBriefForAttribution(` }])).toEqual([]);
    expect(missingBoundary([{ name: 'remove.ts', source: planted }])).toEqual([]);
  });

  test('the scan reads a tree that really holds attribution paths', () => {
    // The empty result above is a pass over the commands, not a scan over nothing: the tree the
    // scan ships with already holds these paths.
    const paths = tree()
      .filter(({ name, source }) => !ALLOWED.has(name) && ATTRIBUTES.test(source))
      .map(({ name }) => name);
    expect(paths).toEqual(expect.arrayContaining(['add.ts', 'register.ts', 'reload.ts', 'restart.ts', 'up.ts']));
  });
});
