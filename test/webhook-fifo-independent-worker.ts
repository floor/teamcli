// A separate process bounds a special-file regression and starts with only its synthetic HOME.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const input = JSON.parse(process.argv[2]!) as { root: string; home: string; webhook: { urlFile: string; secretFile: string } };
assert.equal(homedir(), realpathSync(input.home)); assert.equal(process.env.HOME, input.home);
const { webhookRouteOf } = await import('../src/send/webhook.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { startBus, publishToBus } = await import('../src/bus/server.ts');
const route = webhookRouteOf(input.webhook);
const loaded = validateTeamFile(readFileSync(join(input.root, '.agents', 'team.yaml'), 'utf8'));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const reports: string[] = [];
const started = await startBus({ root: input.root, home: input.home, team: loaded.team, stderr: text => reports.push(text), reconcileIntervalMs: 0 });
if (started.kind !== 'serving') throw new Error('synthetic FIFO bus did not start');
try {
  const published = await publishToBus(input.root, { kind: 'message.arrived', ts: new Date().toISOString(), session: 'hooks', record_id: 'fifo-probe', from: 'lead', to: 'routine' });
  console.log(JSON.stringify({ refused: route !== null && !route.ok, reason: route && !route.ok ? route.reason : '', publish: published.kind, reports }));
} finally { await started.handle.close(); }
