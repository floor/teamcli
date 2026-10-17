// The README's "By example" file is a shipped example like examples/team.yaml, but no docs page
// runs it — test/docs.test.ts covers docs/commands only — so it is loaded here: every CLI it
// names must ship a profile, and its lead must not be the CLI the other examples lead with.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';
import { profileFor } from '../src/profiles/index.ts';

/** The file under `By example:` in README.md: the first yaml fence after that line. */
function byExample(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'By example:');
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = lines.findIndex((line, index) => index > start && line.trim() === '```yaml');
  expect(fence).toBeGreaterThan(start);
  const body: string[] = [];
  for (const line of lines.slice(fence + 1)) {
    if (line.trim() === '```') break;
    body.push(line);
  }
  return `${body.join('\n')}\n`;
}

const readme = validateTeamFile(byExample(readFileSync(new URL('../README.md', import.meta.url), 'utf8')));
if (!readme.ok) throw new Error(`the README's by-example file is refused: ${JSON.stringify(readme.errors)}`);
const { team, warnings } = readme;

const example = validateTeamFile(readFileSync(new URL('../examples/team.yaml', import.meta.url), 'utf8'));
if (!example.ok) throw new Error(`examples/team.yaml is refused: ${JSON.stringify(example.errors)}`);
const exampleTeam = example.team;

const leadOf = (source: typeof team) => source.seats.find((seat) => seat.name === source.orchestrator);

describe("the README's by-example file", () => {
  test('is accepted, carrying only the legacy key\'s notice', () => {
    // The fence keeps the old spelling until the rewrite release (P3.6): it loads, and says
    // out loud that the spelling moved.
    expect(warnings).toEqual([{ line: 3, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' }]);
    expect(team.project).toBe('hello');
  });

  test('every seat runs a CLI the package ships a profile for', () => {
    expect(team.seats.filter((seat) => profileFor(seat.cli) === null).map((seat) => seat.name)).toEqual([]);
  });

  test('its lead is not the CLI the other examples lead with', () => {
    expect(leadOf(team)?.cli).not.toBe('claude-code');
  });

  test('the two shipped examples lead on different CLIs', () => {
    expect(leadOf(team)?.cli).not.toBe(leadOf(exampleTeam)?.cli);
  });
});
