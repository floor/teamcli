// A Claude Code seat on the shipped launcher that names no cwd gets the team's seat folder, as a
// Grok seat does, not the shared lobby; the lead keeps its own placement, and a written cwd stands.
import { expect, test } from 'bun:test';
import { validateTeamFile } from '../src/file/validate.ts';

const TEAM = (worker: string) => `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
workspace:
  mode: shared
seats:
  - role: lead
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    launcher: claude-code
    mode: shared
  - role: builder
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    mode: shared
${worker}`;

function cwdOf(worker: string, name: string): string | undefined {
  const result = validateTeamFile(TEAM(worker));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team.seats.find((seat) => seat.name === name)?.cwd;
}

test('a builder on the claude-code launcher gets its own seat folder', () => {
  expect(cwdOf('    launcher: claude-code\n', 'worker')).toBe('worktrees/acme/acme/worker');
});

test('the lead on the same launcher keeps its placement', () => {
  expect(cwdOf('    launcher: claude-code\n', 'lead')).toBe('.');
});

test('a Claude Code seat with no launcher keeps today\'s placement', () => {
  expect(cwdOf('', 'worker')).toBe('.');
});

test('a written cwd stands', () => {
  expect(cwdOf('    launcher: claude-code\n    cwd: elsewhere\n', 'worker')).toBe('elsewhere');
});
