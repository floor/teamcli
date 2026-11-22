// Deterministic pipe barriers around synthetic registry I/O. No timing, PATH or environment changes.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import type { clearModelDrift } from '../../src/send/model-drift.ts';

type Request = {
  home: string; id: string; conversation: string; agentFile: string; registryLock: string;
  clear: Parameters<typeof clearModelDrift>[0];
};
const mode = process.argv[2];
const request = JSON.parse(process.argv[3] ?? '') as Request;
const real = { ...fs };
function barrier(event: string): void {
  real.writeSync(1, `${event}\n`);
  if (real.readFileSync(0, 'utf8') !== 'go') throw new Error('synthetic barrier was not released');
}

if (mode === 'writer') {
  const { recordAgentSessionWhen } = await import('../../src/registry/agents.ts');
  const result = recordAgentSessionWhen(request.home, request.id, request.conversation, () => {
    // This is the normal writer's callback, after its locked read and before its atomic write.
    barrier('writer-held');
    return true;
  });
  if (result.kind !== 'written') throw new Error(result.why);
} else if (mode === 'clear') {
  let coordinated = false;
  mock.module('node:fs', () => ({
    ...real,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (!coordinated && args[0] === request.registryLock) {
        coordinated = true;
        barrier('registry-lock');
      }
      return real.openSync(...args);
    }) as typeof fs.openSync,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const copied = Reflect.apply(real.readFileSync, undefined, args) as ReturnType<typeof fs.readFileSync>;
      if (!coordinated && args[0] === request.agentFile) {
        coordinated = true;
        // The old clear copied A without the registry lock. Publish B before returning A.
        barrier('copied-record');
      }
      return copied;
    }) as typeof fs.readFileSync,
  }));
  const { clearModelDrift } = await import('../../src/send/model-drift.ts');
  clearModelDrift(request.clear);
} else {
  throw new Error('unknown synthetic worker mode');
}
