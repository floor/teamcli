import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const example = readFileSync(new URL('../examples/team.yaml', import.meta.url), 'utf8');

const result = validateTeamFile(example);
if (!result.ok) throw new Error(`examples/team.yaml is refused: ${JSON.stringify(result.errors)}`);
const { team, warnings } = result;

// The notice examples/team.yaml carries for its legacy `coordinator:` key, on line 6.
const notice = { line: 6, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' };

describe('the fictional example file', () => {
  test('is accepted, carrying only the legacy key\'s notice', () => {
    // The shipped examples keep the old spelling until the rewrite release (P3.6): they load,
    // and the file says out loud that the spelling moved.
    expect(warnings).toEqual([notice]);
    expect(team.project).toBe('beacon');
    expect(team.session).toBe('beacon');
    expect(team.orchestrator).toBe('codex-keeper');
    expect(team.operator).toBe('codex-signal');
  });

  test('every seat is there, count expanded', () => {
    expect(team.seats.map((seat) => seat.name)).toEqual([
      'codex-keeper',
      'codex-signal',
      'codex-beacon',
      'cursor-beacon',
      'nimbus-beacon',
      'nimbus-beacon-2',
      'nimbus-beacon-3',
    ]);
  });

  test('a written label titles the workspace, and a count numbers the later instances', () => {
    // The example writes `label:` on every seat. That is line 1. A count past the first
    // appends `-<n>` so the three nimbus seats do not share a title.
    expect(team.seats.map((seat) => [seat.name, workspaceLabel(seat)])).toEqual([
      ['codex-keeper', 'coordinator'],
      ['codex-signal', 'operator'],
      ['codex-beacon', 'codex'],
      ['cursor-beacon', 'cursor'],
      ['nimbus-beacon', 'nimbus'],
      ['nimbus-beacon-2', 'nimbus-2'],
      ['nimbus-beacon-3', 'nimbus-3'],
    ]);
    expect(team.seats[0]).toMatchObject({ declared: 'codex-keeper', count: 1, instance: 1 });
  });

  test('the coordinator and the operator run the same CLI', () => {
    expect(team.seats.find((seat) => seat.name === team.orchestrator)).toMatchObject({
      cli: 'codex',
      vendor: 'openai',
      model: 'GPT Compass',
      version: '2',
      display: 'GPT-2 Compass',
      launch: 'codex -m gpt-compass-2',
    });
    expect(team.seats.find((seat) => seat.name === team.operator)?.cli).toBe('codex');
  });

  test('the machines gates and the useful shapes are the ones it shows', () => {
    expect(team.machine).toMatchObject({ loadStart: 2, loadMax: 8, memoryStart: 30, memoryMin: 10, diskMin: 20e9 });
    expect(team.seats.find((seat) => seat.name === 'codex-beacon')).toMatchObject({
      cli: 'codex',
      model: 'GPT Comet',
      version: '3',
      display: 'GPT-3 Comet',
      parked: true,
    });
    expect(team.seats.find((seat) => seat.name === 'cursor-beacon')).toMatchObject({
      cli: 'cursor',
      launch: 'cursor-agent',
    });
    expect(team.seats.find((seat) => seat.name === 'nimbus-beacon')).toMatchObject({
      cli: 'claude-code',
      vendor: 'nimbus',
      launch: 'nimbus-claude',
    });
  });
});
