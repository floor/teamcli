// `team send` composes the rules a `rules: prepend` seat reads with every brief: the launch's own
// text, built by `rulesOf`, which reads the owner's entity rules (and the home project's) from a
// home. The home is the receiving host's — the one every other read of this run uses — never the
// machine the command happens to run on. Only a seat whose profile keeps its rules in every brief
// reaches the branch, and the registry record's CLI (what herdr reports on the pane) may differ
// from the file's declaration, which is what keeps the seat out of the public-only guard.
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { recordBody } from './helpers.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const ENTITY_RULE = 'A prepend seat reads its entity rules on every brief.';

let made: World | null = null;

afterEach(() => {
  made?.cleanup();
  made = null;
});

/** The agent record `up` writes for a launched seat, with the CLI herdr reports on its pane: the
 *  file still declares the seat `jules`, so the send's prepend decision reads the jules profile
 *  while the public-only guard reads the record's Claude Code. The team record carries the roster
 *  `resolveTarget` asks; the pane is the record's, so no live read is needed to address it. */
function registerSeat(seat: string, cli: string): void {
  const home = made!.home;
  const id = teamIdOf(made!.root);
  const agent = `agt_${Buffer.from(seat).toString('hex').slice(0, 12)}`;
  const file = join(home, '.config', 'team', 'agents', `${agent}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${agent}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      '  role: "implementer"',
      'lab: "test"',
      `cli: "${cli}"`,
      'launcher: null',
      'launch: "jules"',
      'reach:',
      `  team: "${id}"`,
      `  seat: "${seat}"`,
      '  session: "acme"',
      '  pane: "pane1"',
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-05T04:00:00.000Z"',
      '  updated_at: "2026-10-05T04:00:00.000Z"',
      '',
    ].join('\n'),
  );
  upsertTeam(home, id, {
    project: 'acme',
    entity: 'ent-a',
    session: 'acme',
    root: made!.root,
    lobby: lobbyDir(home),
    roster: [{ agent, seat, role: 'implementer', leads: false }],
    lifecycle: 'running',
    by: 'test',
  });
}

describe('team send: a prepend seat composes the receiving home’s rules', () => {
  test('the brief carries the entity rules declared under the host home', async () => {
    made = world(['mcp-inbox', 'typed'], [
      { name: 'prepend-seat', role: 'implementer', cli: 'jules', launch: 'jules' },
    ]);
    // The file names the entity whose rules the composed text carries.
    appendFileSync(join(made.root, '.agents', 'team.yaml'), 'entity: ent-a\n');
    mkdirSync(join(made.home, '.config', 'team'), { recursive: true });
    writeFileSync(
      join(made.home, '.config', 'team', 'entities.yaml'),
      [
        'entities:',
        '  ent-a:',
        '    name: Ent A',
        '    rules:',
        `      - ${JSON.stringify(ENTITY_RULE)}`,
        '',
      ].join('\n'),
    );
    registerSeat('prepend-seat', 'claude-code');
    const io = owner(made.root);

    const code = await runSend(['prepend-seat', 'hello'], io, fake(made));

    expect(code).toBe(0);
    const drops = join(made.dir, 'send-drops', 'acme', 'prepend-seat');
    const path = join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string);
    const body = recordBody(path);
    expect(body).toContain('Entity rules (ent-a):');
    expect(body).toContain(`- ${ENTITY_RULE}`);
    expect(body).toContain('hello');
  });
});
