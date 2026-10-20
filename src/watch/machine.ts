import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import type { TeamFile } from '../file/types.ts';

// The OS's own memory-pressure level, where it offers one: macOS's kernel level, and Linux's PSI
// stalls mapped to the same three names.
export type MemoryPressure = 'normal' | 'warn' | 'critical';

// The machine's figures, each null when it can't be read here: a figure that isn't read is never
// reported as fine or as bad.
export type Machine = {
  loadPerCore: number | null;
  memoryFree: number | null;   // percent
  diskFree: number | null;     // bytes, on the project's volume
  swapTotal: number | null;    // bytes; null when the machine has no swap
  swapFree: number | null;     // bytes; null when the machine has no swap
  swapUsed: number | null;     // bytes
  // The OS's level; null when this platform or this machine has no readable signal. Older
  // readings omit it, and an omitted level is unread too, never normal.
  pressure?: MemoryPressure | null;
};

function command(name: string, args: string[]): string | null {
  try {
    return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return null;
  }
}

// "total = 24576.00M  used = 23261.25M  free = 1314.75M", as macOS's vm.swapusage prints it.
export function parseSwapUsage(text: string): { total: number; used: number; free: number } | null {
  const read = (name: string) => {
    const match = new RegExp(`${name} = ([0-9.]+)([KMG])`).exec(text);
    if (!match) return null;
    return Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[match[2] as string]!;
  };
  const total = read('total');
  const used = read('used');
  const free = read('free');
  return total === null || used === null || free === null ? null : { total, used, free };
}

// "System-wide memory free percentage: 44%", the last line of macOS's memory_pressure.
export function parseMemoryPressure(text: string): number | null {
  const match = /free percentage:\s*([0-9]+)%/.exec(text);
  return match ? Number(match[1]) : null;
}

// "1", as `sysctl -n kern.memorystatus_vm_pressure_level` prints macOS's kernel level: 1 normal,
// 2 warning, 4 critical (the NOTE_MEMORYSTATUS_PRESSURE flags XNU's handler returns). Any other
// value is a level this code doesn't know; an unknown level is unread, never normal.
export function parseVmPressureLevel(text: string): MemoryPressure | null {
  switch (text.trim()) {
    case '1': return 'normal';
    case '2': return 'warn';
    case '4': return 'critical';
    default: return null;
  }
}

// "0.52 0.58 0.59 1/1234 5678", as /proc/loadavg holds it: the one-minute average first.
export function parseLoadavg(text: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s/.exec(text);
  return match ? Number(match[1]) : null;
}

// One file of a /proc tree, or null when this machine doesn't have it. `proc` is the tree's root,
// a parameter so a test can read a captured one.
function procFile(proc: string, name: string): string | null {
  try {
    return readFileSync(`${proc}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

export function parseMeminfo(text: string): { memoryFree: number | null; swapTotal: number | null; swapFree: number | null; swapUsed: number | null } {
  const kb = (name: string) => {
    const match = new RegExp(`^${name}:\\s+([0-9]+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    memoryFree: total && available !== null ? (available / total) * 100 : null,
    swapTotal: swapTotal ? swapTotal : null,
    swapFree: swapTotal ? swapFree : null,
    swapUsed: swapTotal && swapFree !== null ? swapTotal - swapFree : null,
  };
}

// The share of the last ten seconds in which at least one task stalled on memory, from the `some`
// line of Linux's /proc/pressure/memory. PSI gives stalls, not a level, so these two thresholds
// are this tool's mapping to the same names macOS gives: a tenth of the time stalled is a
// warning, half the time is critical. A file without a readable `some avg10` is unread, never
// normal.
const PSI_WARN_AVG10 = 10;
const PSI_CRITICAL_AVG10 = 50;

export function parsePsiMemory(text: string): MemoryPressure | null {
  const match = /^some\s+avg10=([0-9.]+)/m.exec(text);
  if (!match) return null;
  const stalled = Number(match[1]);
  if (!Number.isFinite(stalled)) return null;
  if (stalled >= PSI_CRITICAL_AVG10) return 'critical';
  if (stalled >= PSI_WARN_AVG10) return 'warn';
  return 'normal';
}

// This platform's figures: macOS's commands on darwin, Linux's /proc everywhere Linux runs.
// `platform` and `proc` are parameters for the tests; the command passes neither.
export function readMachine(root: string, platform: string = process.platform, proc = '/proc'): Machine {
  const machine: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null, pressure: null };
  const cores = cpus().length;
  try {
    const volume = statfsSync(root);
    machine.diskFree = volume.bavail * volume.bsize;
  } catch {}
  if (platform === 'darwin') {
    if (cores) machine.loadPerCore = (loadavg()[0] as number) / cores;
    const pressure = command('memory_pressure', []);
    if (pressure) machine.memoryFree = parseMemoryPressure(pressure);
    machine.pressure = parseVmPressureLevel(command('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) ?? '');
    const swap = parseSwapUsage(command('sysctl', ['-n', 'vm.swapusage']) ?? '');
    if (swap && swap.total > 0) {
      machine.swapTotal = swap.total;
      machine.swapFree = swap.free;
      machine.swapUsed = swap.used;
    }
  } else if (platform === 'linux') {
    // /proc is always there, and reading it is what the platform's own tools do.
    const load = procFile(proc, 'loadavg');
    const one = load === null ? null : parseLoadavg(load);
    if (cores && one !== null) machine.loadPerCore = one / cores;
    const info = procFile(proc, 'meminfo');
    if (info !== null) Object.assign(machine, parseMeminfo(info));
    // PSI is a kernel option: a kernel built or booted without it has no file, and the level is
    // unread rather than normal.
    const psi = procFile(proc, 'pressure/memory');
    if (psi !== null) machine.pressure = parsePsiMemory(psi);
  } else if (cores) {
    machine.loadPerCore = (loadavg()[0] as number) / cores;
  }
  return machine;
}

/** A size as the file writes it: 1 GB is 1e9 bytes, the same spelling the watch uses. */
export function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * The gate's readings as one sentence, for the log: the same figures and level the gate
 * compares, in a fixed order, `unread` where one wasn't taken — a line in the log never guesses
 * a reading. Disk and swap print the bytes the gate compared, never a rounded-GB spelling of
 * them: a later launch seeds its growth samples from the newest line's swap figures and must
 * read the figure that was compared, not prose about it (the rounded sentence is for people;
 * the log is also read by the tool). Any of the three swap figures missing makes the whole swap
 * reading unread: a used figure without the total it was taken with is not a reading that was
 * taken.
 */
export function readingsText(machine: Machine): string {
  const load = machine.loadPerCore === null ? 'unread' : `${machine.loadPerCore.toFixed(1)}/core`;
  const memory = machine.memoryFree === null ? 'unread' : `${Math.round(machine.memoryFree)}%`;
  const disk = machine.diskFree === null ? 'unread' : `${machine.diskFree} B free`;
  // An omitted level (an older reading object) is unread like an unreadable one: a missing
  // signal is never printed as `normal`.
  const pressure = machine.pressure ?? 'unread';
  const swap = machine.swapTotal === null || machine.swapUsed === null || machine.swapFree === null
    ? 'unread'
    : `used ${machine.swapUsed} B of ${machine.swapTotal} B (free ${machine.swapFree} B)`;
  return `load ${load}, memory ${memory}, disk ${disk}, pressure ${pressure}, swap ${swap}`;
}

export type SwapSample = { at: number; used: number };

/**
 * Records `used` and returns how far it sits above the smallest sample still inside the window.
 * The watch and a launch share this, so a figure means the same thing in both places.
 */
export function recordSwap(samples: SwapSample[], used: number, now: number, windowSeconds: number): number {
  samples.push({ at: now, used });
  const kept = samples.filter((sample) => now - sample.at <= windowSeconds * 1000);
  samples.splice(0, samples.length, ...kept);
  return used - Math.min(...kept.map((sample) => sample.used));
}

/**
 * The first `machine:` start limit this reading crosses, or null. A figure that was not read
 * (null) is neither fine nor a refusal, and neither is a pressure level that wasn't read. Free
 * swap is not a launch limit: macOS keeps swap nearly full while physical memory is free, so
 * `swap_free_min` belongs to the watch and never refuses a launch on its own; the OS's pressure
 * level does, at `critical`. Swap growth uses the samples this command has already taken; one
 * reading on its own never crosses it.
 */
export function launchLimit(
  machine: Machine,
  limits: TeamFile['machine'],
  samples: SwapSample[],
  now: number,
): string | null {
  if (machine.loadPerCore !== null && machine.loadPerCore > limits.loadStart) {
    return `the load is ${machine.loadPerCore.toFixed(1)} per core, above ${limits.loadStart}`;
  }
  if (machine.memoryFree !== null && machine.memoryFree < limits.memoryStart) {
    return `free memory is ${Math.round(machine.memoryFree)}%, below ${limits.memoryStart}%`;
  }
  if (machine.diskFree !== null && machine.diskFree < limits.diskMin) {
    return `free disk is ${gb(machine.diskFree)}, below ${gb(limits.diskMin)}`;
  }
  if (machine.pressure === 'critical') {
    return 'memory pressure is critical';
  }
  if (machine.swapUsed !== null) {
    const growth = recordSwap(samples, machine.swapUsed, now, limits.swapGrowthWindow);
    const minutes = Math.floor((limits.swapGrowthWindow * 1000) / 60_000);
    if (growth > limits.swapGrowthMax) {
      return `swap grew by ${gb(growth)} in ${minutes} minutes, above ${gb(limits.swapGrowthMax)}`;
    }
  }
  return null;
}

/**
 * The swap the watch check asks for, when this reading cannot meet it: more free swap than the
 * machine has in total. Within one reading free is never above total, so the `swap-free` check
 * cannot pass against this reading; the warning says what this reading holds, never what a later
 * pass will. Free swap is not a launch limit, so this is a configuration the watch reports, not
 * a launch that refused. Null when either figure wasn't read, and when the check can pass in
 * principle: a machine with no swap at all is not this case, and neither is one that merely lacks
 * free swap right now.
 */
export function swapTotalProblem(machine: Machine, limits: TeamFile['machine']): string | null {
  if (machine.swapTotal === null || machine.swapFree === null) return null;
  if (limits.swapFreeMin <= machine.swapTotal) return null;
  return `the machine check asks for ${gb(limits.swapFreeMin)} free swap; at this reading the machine has ${gb(machine.swapTotal)} in total, so this reading cannot meet it; set \`machine.swap_free_min\` to a figure this machine can keep`;
}

/**
 * How many seats `team up` may launch and wait on concurrently.
 *
 * `--serial` (or an unreadable load or memory figure, which never counts as fine) runs one seat
 * at a time (`1`). When `launchLimit` passes but the machine is already under load — load per
 * core above 70% of `load_start`, free memory within 10 percentage points of `memory_start`, free
 * swap below 1.5x `swap_free_min`, or the OS's pressure level at `warn` — it falls back to `1` so
 * `allow` re-reads after each seat settles. When headroom is present, concurrency scales between
 * `2` and `8` from both remaining load and remaining free memory.
 */
export function launchConcurrency(
  machine: Machine | undefined,
  limits: TeamFile['machine'],
  serial = false,
): number {
  if (serial || !machine) return 1;
  if (machine.loadPerCore === null || machine.memoryFree === null) return 1;
  if (machine.loadPerCore > limits.loadStart * 0.7) return 1;
  if (machine.memoryFree < limits.memoryStart + 10) return 1;
  if (machine.swapFree !== null && machine.swapFree < limits.swapFreeMin * 1.5) return 1;
  // A warning level does not refuse a launch, but it is no weather for several at once.
  if (machine.pressure === 'warn' || machine.pressure === 'critical') return 1;
  const loadSlots = Math.floor((limits.loadStart - machine.loadPerCore) * 4);
  const memorySlots = Math.floor((machine.memoryFree - limits.memoryStart) / 3);
  return Math.max(2, Math.min(8, loadSlots, memorySlots));
}

