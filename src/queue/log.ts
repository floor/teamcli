// The queue's evidence line: what an append skipped, recovered or voided goes to the team's own
// log (src/log.ts), never to the caller's output. A folder that is not a seat drop folder logs
// nothing.
import { dirname } from 'node:path';
import { logLine } from '../log.ts';
import { queueBaseOf } from './append.ts';

export function queueLog(dropDir: string, now: () => Date = () => new Date()): (line: string) => void {
  if (queueBaseOf(dropDir) === null) return () => {};
  const agents = dirname(dirname(dirname(dropDir)));
  return (line) => logLine(agents, 'queue', 'queue', line, now());
}
