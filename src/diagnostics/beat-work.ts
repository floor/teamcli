// Process-local diagnostics only. The daemon's existing heartbeat consumes the measurements;
// there is no timer, sampling process, threshold or change to the measured operation's result.
import { AsyncLocalStorage } from 'node:async_hooks';

type Row = { ms: number; calls: number; pending: number };
type Span = { name: string; at: number };
export type BeatWork = { begin(name: string): () => void; take(): string };
const observers = new Set<BeatWork>();
const scope = new AsyncLocalStorage<string>();

export function createBeatWork(clock: () => number = () => performance.now()): BeatWork {
  const rows = new Map<string, Row>();
  const active = new Set<Span>();
  const add = (name: string, ms: number, calls: number, pending: number): void => {
    const row = rows.get(name) ?? { ms: 0, calls: 0, pending: 0 };
    row.ms += Math.max(0, ms);
    row.calls += calls;
    row.pending += pending;
    rows.set(name, row);
  };
  return {
    begin(name) {
      const span = { name, at: clock() };
      active.add(span);
      return () => {
        if (!active.delete(span)) return;
        add(name, clock() - span.at, 1, 0);
      };
    },
    take() {
      const at = clock();
      // Split an in-flight wall interval at the beat. Never charge its whole lifetime again.
      for (const span of active) {
        add(span.name, at - span.at, 0, 1);
        span.at = at;
      }
      const ordered = [...rows].sort((a, b) => b[1].ms - a[1].ms || a[0].localeCompare(b[0]));
      rows.clear();
      return ordered.map(([name, row]) =>
        `${name}=${row.ms.toFixed(1)}ms(completed:${row.calls},pending:${row.pending})`).join(', ');
    },
  };
}

/** Installation is tied to the daemon's existing ownership/release, never to a new worker. */
export function observeBeatWork(work: BeatWork): () => void {
  observers.add(work);
  return () => { observers.delete(work); };
}

export function beginBeatWork(name: string): () => void {
  const parent = scope.getStore();
  const label = parent === undefined ? name : `${parent} > ${name}`;
  const ends = [...observers].map((observer) => observer.begin(label));
  return () => { for (const end of ends) end(); };
}

/** Return the exact value/promise and preserve throws/rejections. Wall spans include await;
 * sync subspans are named separately, and nested spans overlap rather than adding to CPU time. */
export function traceBeatWork<T>(name: string, operation: () => T): T {
  if (observers.size === 0) return operation();
  const parent = scope.getStore();
  const label = parent === undefined ? name : `${parent} > ${name}`;
  const end = beginBeatWork(name);
  try {
    const result = scope.run(label, operation);
    if (result instanceof Promise) void result.then(end, end);
    else end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}
