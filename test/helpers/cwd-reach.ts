// Cross-team admission fixtures keep their reach proof while making pane targeting unproven.
import { expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callerOf } from '../../src/caller.ts';
import type { Io } from '../../src/io.ts';
import { addressedTeam, placedCallerTeam } from '../../src/registry/binding.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { emptySession, updateState } from '../../src/state.ts';

export function cwdTargetForReach(home: string, target: string, io: Io, session: string): void {
  const caller = callerOf(io, session);
  expect(caller.kind).toBe('seat');
  if (caller.kind !== 'seat') throw new Error('the reach fixture needs its original seat caller');
  // A second recorded placement leaves the caller intact while cwd deliberately selects the target.
  const key = `${session}-${caller.name}-${caller.pane}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const root = join(home, 'pane-target-shadow', key);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: placement-shadow
entity: fixture-shadow
session: ${session}
coordinator: ${caller.name}
operator: ${caller.name}
trust:
  - ${root}
seats:
  - role: coordinator
    name: ${caller.name}
    cli: claude-code
    vendor: synthetic
    model: Synthetic
    version: "1"
    launch: claude
`);
  updateState(dir, (state) => {
    (state.sessions[session] ??= emptySession()).seats[caller.name] = { stage: 'ready', pane: caller.pane };
  });
  upsertTeam(home, teamIdOf(root), { root, project: 'placement-shadow', entity: 'fixture-shadow', session });
  expect(placedCallerTeam(home, io)).toBeNull();
  const aimed = addressedTeam(home, target, undefined, io);
  expect(aimed.kind === 'bound' ? aimed.team.root : null).toBe(target);
}
