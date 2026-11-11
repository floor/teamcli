// Chores-child diagnostics only: no timer, admission, retry, or liveness decision.
// Begin snapshots cross the existing note pipe before synchronous work, so the parent can
// name an unfinished span even when the child cannot answer before the existing start limit.
import { observeBeatWork, type BeatWork } from './beat-work.ts';

type Row = { name: string; ms: number; calls: number; count: number; outcomes: Record<string, number>; callsDetail?: { ms: number; outcome: string }[] };
type Active = { name: string; at: number };
const observers = new Set<ReturnType<typeof createChildSteps>>();
export const CHILD_STEPS_PREFIX = 'first-cycle steps: ';

export function createChildSteps(log: (text: string) => void, clock: () => number = Date.now) {
  const rows = new Map<string, Row>();
  const active = new Set<Active>();
  let closed = false;
  const row = (name: string): Row => {
    let held = rows.get(name);
    if (!held) { held = { name, ms: 0, calls: 0, count: 0, outcomes: {} }; rows.set(name, held); }
    return held;
  };
  const publish = (): void => {
    if (closed) return;
    try { log(CHILD_STEPS_PREFIX + JSON.stringify({ rows: [...rows.values()], active: [...active] })); }
    catch { /* A diagnostic sink cannot change a measured result. */ }
  };
  const begin = (name: string, announce: boolean): ((outcome?: string, count?: number) => void) => {
    const span = { name, at: clock() };
    active.add(span);
    if (announce) publish();
    return (outcome = 'returned', count = 0) => {
      if (!active.delete(span)) return;
      const held = row(name);
      const ms = Math.max(0, clock() - span.at);
      held.ms += ms; held.calls += 1; held.count += count;
      if (name.startsWith('terminal-host ') || name.startsWith('sidebar ')) {
        (held.callsDetail ??= []).push({ ms, outcome });
      }
      held.outcomes[outcome] = (held.outcomes[outcome] ?? 0) + 1;
      if (announce) publish();
    };
  };
  const work: BeatWork = { begin: (name) => begin(name, false), take: () => '' };
  let release = (): void => {};
  const result = {
    begin: (name: string) => begin(name, true),
    measure(name: string, ms: number, count: number, publishNow: boolean) {
      const held = row(name); held.ms += ms; held.count += count; held.calls += 1;
      if (publishNow) publish();
    },
    complete() { publish(); },
    stop() { closed = true; observers.delete(result); release(); },
  };
  observers.add(result);
  release = observeBeatWork(work);
  return result;
}

export function traceChildStep<T>(name: string, operation: () => T): T {
  if (observers.size === 0) return operation();
  const ends = [...observers].map((observer) => observer.begin(name));
  const finish = (value: unknown, failure?: string): void => {
    const outcome = failure ?? (value === null ? 'null' : value === false ? 'false' : 'ok');
    for (const end of ends) end(outcome, Array.isArray(value) ? value.length : 0);
  };
  try {
    const value = operation();
    if (value instanceof Promise) void value.then((v) => finish(v), () => finish(undefined, 'rejected'));
    else finish(value);
    return value;
  } catch (error) { finish(undefined, 'threw'); throw error; }
}

export function measureChildStore(name: string, ms: number, count: number, publish: boolean): void {
  for (const observer of observers) observer.measure(name, ms, count, publish);
}

/** Only display text, never authority or a heartbeat. Parent time extends pending spans at
 * the existing watch-start/late-heartbeat decision; neither configured limit is changed. */
export function childStepsAt(text: string, now: number): string | null {
  if (!text.startsWith(CHILD_STEPS_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(CHILD_STEPS_PREFIX.length)) as { rows: Row[]; active: Active[] };
    if (!Array.isArray(value.rows) || !Array.isArray(value.active)) return null;
    const rows = value.rows.map((r) => `${r.name}=${Number(r.ms).toFixed(1)}ms/${r.calls}calls/${r.count}items[${JSON.stringify(r.outcomes)}]${r.callsDetail ? ` individual:${JSON.stringify(r.callsDetail)}` : ''}`);
    const active = value.active.map((r) => `${r.name}=${Math.max(0, now - r.at).toFixed(1)}ms pending`);
    return [...rows, ...active].join(', ');
  } catch { return null; }
}
