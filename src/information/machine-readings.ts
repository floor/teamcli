// Screen observations are informational, independent of the launch gate's confirmed readings.
// No team names, seats, paths or screen text are retained in this machine-wide store.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../state.ts';
import { WINDOWS, type QuotaFigure } from '../profiles/quota.ts';

export type MachineFigure = QuotaFigure & { pool?: 'gemini' | 'claude-gpt' };
export type MachineReading = Omit<MachineFigure, 'resets'> & { observedAt: number; resetsAt: number | null };

export function machineReadingsPath(home: string): string {
  return join(home, '.config', 'team', 'usage', 'readings.json');
}

export function readMachineReadings(home: string): MachineReading[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(machineReadingsPath(home), 'utf8')); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is MachineReading => r !== null && typeof r === 'object'
    && typeof r.account === 'string' && r.account.length > 0 && WINDOWS.includes(r.window)
    && Number.isFinite(r.left) && r.left >= 0 && r.left <= 100 && r.used === 100 - r.left
    && Number.isSafeInteger(r.observedAt) && r.observedAt >= 0 && r.observedAt <= 8640000000000000
    && (r.resetsAt === null || (Number.isSafeInteger(r.resetsAt) && r.resetsAt >= 0 && r.resetsAt <= 8640000000000000))
    && (r.pool === undefined || r.pool === 'gemini' || r.pool === 'claude-gpt'));
}

/** One lock protects the read/merge/write across every team's watch. Latest observation wins. */
export function saveMachineReadings(home: string, figures: readonly MachineFigure[], now: number): void {
  if (figures.length === 0) return;
  const folder = join(home, '.config', 'team', 'usage');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  withLock(folder, () => {
    const readings = readMachineReadings(home);
    for (const figure of figures) {
      const at = readings.findIndex((r) => r.account === figure.account && r.window === figure.window && r.pool === figure.pool);
      const previous = readings[at];
      if (previous && previous.observedAt > now) continue;
      const duration = figure.resets === null ? null : /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(figure.resets);
      const resetsAt = duration === null ? null : now + (Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0)) * 60000;
      const reading: MachineReading = { account: figure.account, window: figure.window, left: figure.left,
        used: figure.used, observedAt: now, resetsAt, ...(figure.pool ? { pool: figure.pool } : {}) };
      if (at === -1) readings.push(reading); else readings[at] = reading;
    }
    const path = machineReadingsPath(home);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(readings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  });
}
