// Independent scene for documented first-run skips. Codex's own server skips the
// feature-settings class. Survey, telemetry, and tips stay waiting, and no verdict is a key.
import { expect, test } from 'bun:test';
import { codexOwnServerArgv, firstRunLine, firstRunVerdicts } from '../src/launchers/first-run.ts';

test('the seat starts its own server, and the other first-run classes stay waiting', () => {
  const argv = codexOwnServerArgv('127.0.0.1:9');
  expect(argv).toEqual(['codex', 'app-server', '--listen', '127.0.0.1:9']);
  const verdicts = firstRunVerdicts('codex', '0.160.0', argv);
  const feature = verdicts.find((row) => row.class === 'feature-settings');
  expect(feature?.state).toBe('skipped');
  if (feature?.state === 'skipped') {
    expect(firstRunLine('codex', feature)).toContain('first-run feature-settings skipped');
    const refusal = 'not a shared server';
    const used = feature.mechanism.includes(refusal)
      ? feature.mechanism.slice(0, feature.mechanism.indexOf(refusal))
      : feature.mechanism;
    expect(used).not.toContain('--remote');
    expect(feature.mechanism).toContain('--listen');
  }
  for (const cls of ['survey', 'telemetry', 'tips'] as const) {
    const row = verdicts.find((item) => item.class === cls);
    expect(row?.state).toBe('waiting');
    if (row?.state === 'waiting') expect(row.why).toContain('no key is sent');
  }
  const shared = firstRunVerdicts('codex', '0.160.0', ['codex', 'app-server', '--remote', 'shared']);
  expect(shared.find((row) => row.class === 'feature-settings')?.state).toBe('waiting');
  const other = firstRunVerdicts('grok', '1.0.70', argv);
  expect(other.every((row) => row.state === 'waiting')).toBe(true);
});
