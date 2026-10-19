// The runtime reading of a seat's at-once settings: the signed chain's nickname,
// delivery_order and human, nearest level first. A chain that does not verify declares nothing
// here — routing decides how a message travels, never whether it may, so a send must not fail on
// a broken record; the read commands and `team check` are where it is reported.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatOverridesOf } from '../src/config/apply.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import type { ConfigKey, ConfigValue } from '../src/config/registry.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { DeliveryLeg } from '../src/settings/inherit.ts';
import { installKey } from '../src/store/keys.ts';

const NOW = new Date('2026-10-19T08:00:00.000Z');
const SEAT = 'builder-1';

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-apply-')));
  home = join(base, 'home');
  root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** One agent record reaching this root, as `up` would leave it. */
function registered(): string {
  return registerAgent(home, {
    name: 'Builder One',
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test-lab',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    reach: { team: teamIdOf(root), seat: SEAT, session: 'acme', pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
}

/** A signed seat setting, written through the store's own plan and write. */
function sign(agentId: string, settings: { key: ConfigKey; value: ConfigValue }[]): void {
  const plan = planConfigSet(home, { level: 'seat', target: agentId, settings });
  if (!plan.ok) throw new Error(`the plan was refused: ${plan.why}`);
  const written = writeConfigSet(home, plan, { now: NOW });
  if (!written.ok) throw new Error(`the write was refused: ${written.why}`);
}

describe('seatOverridesOf', () => {
  test('reads the three at-once words the signed records hold', () => {
    const agentId = registered();
    sign(agentId, [
      { key: 'nickname', value: 'wren' },
      { key: 'delivery_order', value: ['drop', 'typed'] as DeliveryLeg[] },
      { key: 'human', value: true },
    ]);
    expect(seatOverridesOf({ home, root, seat: SEAT })).toEqual({
      nickname: 'wren',
      deliveryOrder: ['drop', 'typed'],
      human: true,
    });
  });

  test('a record that does not verify declares nothing, and the send still routes', () => {
    const agentId = registered();
    sign(agentId, [{ key: 'nickname', value: 'wren' }]);
    const doc = join(agentsDir(home), `${agentId}.yaml`);
    writeFileSync(doc, readFileSync(doc, 'utf8').replace('wren', 'crow'));
    expect(seatOverridesOf({ home, root, seat: SEAT })).toEqual({});
  });

  test('no home, and a seat with no agent record, declare nothing', () => {
    registered();
    expect(seatOverridesOf({ home: null, root, seat: SEAT })).toEqual({});
    expect(seatOverridesOf({ home, root, seat: 'someone-else' })).toEqual({});
  });
});
