// A child runtime for the registry binding verifier: its default home is synthetic before any
// module loads. The authority belongs to this child process; no live daemon or pane is read.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchAuthority, type WatchSenderFactoryInput } from '../src/daemon/watch-authority.ts';
import { readState, updateState } from '../src/state.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../src/watch/authority.ts';
import { underRegistry } from './helpers/registry-team.ts';

const [root, home, foreign] = process.argv.slice(2) as [string, string, string];
assert(root && home && foreign);
assert.equal(homedir(), home);
assert.equal(process.env.HOME, home);
const dir = join(root, '.agents');
const teamFile = join(dir, 'team.yaml');
assert.equal(existsSync(teamFile), false);
assert.equal(existsSync(foreign), false);
const now = () => new Date('2026-11-01T14:00:00Z');
let paneWrites = 0;
const never = () => { paneWrites += 1; return false; };
const base: WatchSources = {
  home, now, pid: process.pid, alive: pid => pid === process.pid,
  live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
  machine: () => ({ loadPerCore: 0.1, memoryFree: 75, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
  standing: () => ({ kind: 'none' }), readChecks: () => [],
  screen: () => null, status: () => null, foreground: () => null, processes: () => null,
  typeText: never, pressEnter: never, sendKey: never, notify: () => { paneWrites += 1; },
  sleep: async () => {}, wait: async () => false,
};
await underRegistry(async () => {
  const route = routeOf(root, 'orchard', 'harvest', ['lead', 'picker']);
  let captured: WatchSenderFactoryInput | undefined;
  let sends = 0;
  const build = hostedWatchAuthority({ route, teamFile, base, now, alive: pid => pid === process.pid, log: () => {},
    verifyAuthority: check => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: now() }),
    sender: input => { captured = input; return async () => { sends += 1; return { ok: true, outcome: 'synthetic delivered' }; }; },
  });
  const host = createHostedWatch({ route, ...build, onTick: build.tick, now });
  try {
    for (let n = 0; n < 8; n += 1) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(host.state().cycles, 1);
    const admitted = captured?.verify();
    assert.equal(admitted, true);
    updateState(dir, state => { state.sessions.harvest!.watchdog = { file: foreign }; });
    const afterRepoint = captured?.verify();
    assert.equal(afterRepoint, false);
    assert.equal(readState(dir).sessions.harvest?.watchdog?.file, foreign);
    console.log(JSON.stringify({ cycles: host.state().cycles, admitted, afterRepoint, effects: host.state().effects, sends, paneWrites }));
  } finally { await host.stop('registry worker complete'); }
});
